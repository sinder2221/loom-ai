import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import type { Readable, Writable } from 'node:stream';
import type { Json } from '../src/index.ts';
import {
  CodexToolIsolationError, confirmRunnerConfig, confirmRunnerFeatures, emptyRegistrations, runnerConfigArgs, unsafeRegistrations,
} from './codex-runner-policy.ts';
import type { ConnectionBinding, Lookup } from './binding.ts';
import {
  list, object, questionFromEvent, requiredText, type CodexMarker, type CodexPermissions, type CodexQuestion, type CodexTransport,
} from './codex-protocol.ts';

export type CodexLookupEvidence =
  | { cwd: string; model: string; permissions: CodexPermissions }
  | { threadId: string };

export interface ScopedCodexTransport extends CodexTransport {
  readonly readProfile?: string;
  interruptTurn?(threadId: string, turnId: string): Promise<void>;
  answerQuestion?(threadId: string, turnId: string, question: CodexQuestion, answers: string[]): Promise<boolean>;
  lookup(marker: CodexMarker, evidence?: CodexLookupEvidence): Promise<Lookup<unknown>>;
}

interface Options {
  binary?: string;
  privateData?: string;
  onDeclinedRequest?: (reason: RequestRefusal) => void;
  canHandleQuestion?: (threadId: string, turnId: string) => boolean;
  launcherArgs?: readonly string[];
  serverArgs?: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  maxFrameBytes?: number;
  delay?: (ms: number) => Promise<void>;
}

type RequestRefusal = 'unsupported-request' | 'invalid-user-input' | 'unbound-user-input' | 'concurrent-user-input' | 'question-capacity';
type Frame = Record<string, unknown>;
type Server = ChildProcessByStdio<Writable, Readable, null>;
type Pending = { finish(error?: Error, result?: unknown): void };
const unknown = { status: 'unknown' } as const;
const pageSize = 20;
const pageLimit = 10;
const decoder = new TextDecoder('utf-8', { fatal: true });

export function launchThreadSource(id: string) {
  return 'loom-launch-' + createHash('sha256').update(id, 'utf16le').digest('hex');
}

export class CodexRpcError extends Error {
  readonly code?: number;
  readonly threadMissing: boolean;
  readonly historyUnavailable: boolean;
  readonly historyTransient: boolean;

  constructor(value: unknown) {
    super('Codex App Server returned an RPC error');
    const error = object(value);
    if (Number.isSafeInteger(error.code)) this.code = error.code as number;
    const message = (this.code === -32600 || this.code === -32602) && typeof error.message === 'string' ? error.message : '';
    this.threadMissing = /^(?:thread not found\b|thread not loaded: \S+|no (?:saved )?rollout found for thread\b)/i.test(message);
    this.historyTransient = this.code === -32601 && error.message === 'list_turns is not supported yet';
    this.historyUnavailable = this.historyTransient || /^thread \S+ is not materialized yet; thread\/turns\/list is unavailable before first user message$/.test(message);
  }
}

class Session {
  private child: Server;
  private onDeclinedRequest?: Options['onDeclinedRequest'];
  private canHandleQuestion?: Options['canHandleQuestion'];
  private pending = new Map<number, Pending>();
  private questionReplies = new Map<number | string, { threadId: string; turnId: string; finish: (closed: boolean) => void }>();
  readonly questions = new Map<number | string, Frame>();
  private chunks: Buffer[] = [];
  private frameBytes = 0;
  private sequence = 0;
  private stopped?: Error;
  readonly closed: Promise<void>;
  readonly ready: Promise<void>;

  constructor(binary: string, args: string[], options: Options, timeoutMs: number, maxFrameBytes: number) {
    this.onDeclinedRequest = options.onDeclinedRequest;
    this.canHandleQuestion = options.canHandleQuestion;
    this.timeoutMs = timeoutMs;
    this.maxFrameBytes = maxFrameBytes;
    try {
      this.child = spawn(binary, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'ignore'] });
    } catch {
      throw new Error('Codex App Server could not start');
    }
    const exited = () => this.stop(new Error('Codex App Server disconnected'), true);
    this.closed = new Promise(resolve => this.child.once('close', () => { exited(); resolve(); }));
    this.child.once('exit', exited).once('error', exited);
    this.child.stdin.on('error', exited);
    this.child.stdout.on('error', exited).on('data', (data: Buffer) => this.collect(data));
    this.ready = this.request('initialize', {
      clientInfo: { name: 'loom', version: '1.0' }, capabilities: { experimentalApi: true },
    }).then(() => this.write(this.encode({ method: 'initialized' }))).catch(error => {
      this.stop(error, true);
      throw error;
    });
  }

  private timeoutMs: number;
  private maxFrameBytes: number;

  get available() { return !this.stopped; }

  private encode(frame: Frame) {
    let line: string;
    try { line = JSON.stringify(frame); } catch { throw new Error('Invalid Codex request frame'); }
    if (Buffer.byteLength(line) > this.maxFrameBytes) throw new Error('Codex request frame is too large');
    return line + '\n';
  }

  private write(line: string) {
    if (this.stopped) return Promise.reject(this.stopped);
    return new Promise<void>((resolve, reject) => this.child.stdin.write(line, error => {
      if (error) reject(new Error('Codex App Server write failed'));
      else resolve();
    }));
  }

  async request(method: string, params: unknown): Promise<unknown> {
    if (this.stopped) throw this.stopped;
    const id = ++this.sequence;
    const line = this.encode({ id, method, params });
    return new Promise((resolve, reject) => {
      const finish = (error?: Error, value?: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (error) reject(error);
        else resolve(value);
      };
      const timer = setTimeout(() => finish(new Error('Codex App Server request timed out')), this.timeoutMs);
      this.pending.set(id, { finish });
      void this.write(line).catch(error => finish(error));
    });
  }

  async answerQuestion(threadId: string, turnId: string, question: CodexQuestion, answers: string[]) {
    const { requestId, itemId } = question;
    const pending = this.questions.get(requestId);
    if (!pending || this.questionReplies.has(requestId)) return false;
    const params = object(pending.params);
    if (params.threadId !== threadId || params.turnId !== turnId || params.itemId !== itemId
      || question.frame !== pending || answers.length !== question.questions.length) return false;

    const line = this.encode({ id: requestId, result: { answers: Object.fromEntries(
      question.questions.map(({ id }, index) => [id, { answers: [answers[index]] }]),
    ) } });
    return new Promise<boolean>(resolve => {
      let finished = false;
      const finish = (requestClosed: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        this.questionReplies.delete(requestId);
        resolve(requestClosed);
      };
      const timer = setTimeout(() => finish(false), Math.min(this.timeoutMs, 5_000));
      this.questionReplies.set(requestId, { threadId, turnId, finish });
      void this.write(line).catch(() => finish(false));
    });
  }

  private collect(data: Buffer) {
    let offset = 0;
    while (!this.stopped && offset < data.length) {
      const end = data.indexOf(10, offset);
      const part = data.subarray(offset, end === -1 ? data.length : end);
      this.frameBytes += part.length;
      if (this.frameBytes > this.maxFrameBytes) {
        this.stop(new Error('Codex response frame is too large'), true);
        return;
      }
      this.chunks.push(part);
      if (end === -1) return;
      try {
        const bytes = Buffer.concat(this.chunks, this.frameBytes);
        this.chunks = [];
        this.frameBytes = 0;
        this.receive(object(JSON.parse(decoder.decode(bytes))));
      } catch {
        this.stop(new Error('Invalid Codex response frame'), true);
      }
      offset = end + 1;
    }
  }

  private decline(id: string | number, reason: RequestRefusal) {
    const code = reason === 'unsupported-request' ? -32601 : -32602;
    this.onDeclinedRequest?.(reason);
    void this.write(this.encode({ id, error: { code, message: 'Loom declined the App Server request' } }))
      .catch(() => this.stop(new Error('Codex request refusal could not be written'), true));
  }

  private receiveQuestion(id: string | number, frame: Frame) {
    let threadId: string;
    let turnId: string;
    try {
      const params = object(frame.params);
      threadId = requiredText(params.threadId);
      turnId = requiredText(params.turnId);
      questionFromEvent(frame, threadId, turnId);
    } catch {
      this.decline(id, 'invalid-user-input');
      return;
    }
    if (this.canHandleQuestion && !this.canHandleQuestion(threadId, turnId)) {
      this.decline(id, 'unbound-user-input');
      return;
    }
    if (this.questions.has(id)) {
      // A duplicate ID must not redirect the outstanding request.
      this.questions.delete(id);
      this.decline(id, 'concurrent-user-input');
      return;
    }
    if ([...this.questions.values()].some(existing => {
      const target = object(existing.params);
      return target.threadId === threadId && target.turnId === turnId;
    })) {
      this.decline(id, 'concurrent-user-input');
      return;
    }
    if (this.questions.size >= 64) {
      this.decline(id, 'question-capacity');
      return;
    }
    this.questions.set(id, frame);
  }

  readQuestion(threadId: string, turnId: string) {
    let matching: Frame | undefined;
    for (const [id, frame] of this.questions) {
      const params = object(frame.params);
      const targetThread = requiredText(params.threadId);
      const targetTurn = requiredText(params.turnId);
      // A request can arrive in the same stdio read as turn/start's response.
      // Check its binding again once the adapter has persisted that response.
      if (this.canHandleQuestion && !this.canHandleQuestion(targetThread, targetTurn)) {
        this.questions.delete(id);
        if (!this.questionReplies.has(id)) this.decline(id, 'unbound-user-input');
      } else if (targetThread === threadId && targetTurn === turnId) {
        matching = frame;
      }
    }
    return matching;
  }

  private receive(frame: Frame) {
    if (typeof frame.method === 'string') {
      const id = frame.id;
      if (typeof id === 'string' || (typeof id === 'number' && Number.isSafeInteger(id))) {
        if (frame.method === 'item/tool/requestUserInput') this.receiveQuestion(id, frame);
        else this.decline(id, 'unsupported-request');
      } else if (frame.method === 'serverRequest/resolved') {
        const params = object(frame.params);
        const requestId = params.requestId as number | string;
        const reply = this.questionReplies.get(requestId);
        if (reply?.threadId === params.threadId) reply.finish(true);
        const question = this.questions.get(requestId);
        if (question && object(question.params).threadId === params.threadId) this.questions.delete(requestId);
      } else if (frame.method === 'turn/completed' || frame.method === 'thread/closed') {
        const params = object(frame.params);
        const turnId = frame.method === 'turn/completed' ? object(params.turn).id : undefined;
        for (const reply of this.questionReplies.values()) {
          if (reply.threadId === params.threadId && (turnId === undefined || turnId === reply.turnId)) {
            reply.finish(false);
          }
        }
        for (const [requestId, question] of this.questions) {
          const target = object(question.params);
          if (target.threadId === params.threadId && (turnId === undefined || turnId === target.turnId)) {
            this.questions.delete(requestId);
          }
        }
      }
      return;
    }
    const pending = typeof frame.id === 'number' ? this.pending.get(frame.id) : undefined;
    if (!pending) return;
    if (Object.hasOwn(frame, 'error')) pending.finish(new CodexRpcError(frame.error));
    else if (Object.hasOwn(frame, 'result')) pending.finish(undefined, frame.result);
    else throw new Error('Missing Codex response result');
  }

  stop(error: Error, kill: boolean) {
    if (this.stopped) return;
    this.stopped = error;
    this.questions.clear();
    for (const reply of this.questionReplies.values()) reply.finish(false);
    this.chunks = [];
    for (const pending of this.pending.values()) pending.finish(error);
    if (kill) {
      this.child.stdin.destroy();
      this.child.kill('SIGKILL');
    } else {
      this.child.stdin.end();
      const timeout = setTimeout(() => this.child.kill('SIGKILL'), 2_000);
      void this.closed.then(() => clearTimeout(timeout));
    }
  }
}

export class CodexAppServerTransport implements ScopedCodexTransport {
  readonly binding: ConnectionBinding;
  readonly readProfile?: string;
  private options: Options;
  private session?: Session;
  private closing = false;
  private disabledRegistrations = emptyRegistrations();

  constructor(binding: ConnectionBinding, options: Options = {}) {
    this.binding = Object.freeze({ ...binding });
    this.options = options;
    if (options.privateData) this.readProfile = 'loom-read-' + randomBytes(12).toString('hex');
  }

  async close() {
    this.closing = true;
    this.session?.stop(new Error('Codex transport is closed'), false);
    await this.session?.closed;
  }

  private async liveSession() {
    if (this.session && !this.session.available) await this.session.closed;
    if (this.closing) throw new Error('Codex transport is closed');
    if (!this.session?.available) {
      const binary = this.options.binary ?? process.env.LOOM_CODEX_BIN;
      if (!binary) throw new Error('LOOM_CODEX_BIN is required');
      const { launcherArgs = [], serverArgs = [], timeoutMs = 30_000, maxFrameBytes = 4 * 1024 * 1024 } = this.options;
      const profile = this.readProfile;
      const confinement = profile ? runnerConfigArgs(profile, this.options.privateData!, this.disabledRegistrations) : [];
      this.session = new Session(binary, [...launcherArgs, ...confinement, 'app-server', '--stdio', ...serverArgs],
        this.options, timeoutMs, maxFrameBytes);
    }
    const session = this.session;
    await session.ready;
    return session;
  }

  async rpc(method: string, params: unknown) {
    return (await this.liveSession()).request(method, params);
  }

  private async safeDispatch(method: 'thread/start' | 'thread/resume' | 'turn/start', params: Frame) {
    const profile = this.readProfile;
    if (!profile) return this.rpc(method, params);
    const threadId = method === 'turn/start' ? requiredText(params.threadId) : undefined;
    const cwd = requiredText(params.cwd);
    const data = this.options.privateData!;
    let session: Session;
    try {
      session = await this.liveSession();
      const configAt = async () => object(object(await session.request('config/read', { cwd, includeLayers: false })).config);
      let config = await configAt();
      confirmRunnerConfig(config, profile, data);
      const inherited = unsafeRegistrations(config);
      if (inherited.mcp_servers.size || inherited.plugins.size) {
        // Config tables merge in Codex. Learn names via a config-only session with lazy MCP startup.
        // Once a thread is loaded, a changed configuration fails closed rather than rotating the server.
        if (threadId) throw new CodexToolIsolationError();
        for (const category of ['mcp_servers', 'plugins'] as const) {
          for (const name of inherited[category]) this.disabledRegistrations[category].add(name);
          if (this.disabledRegistrations[category].size > 256) throw new CodexToolIsolationError();
        }
        session.stop(new Error('Applying Codex tool restrictions'), false);
        await session.closed;
        session = await this.liveSession();
        config = await configAt();
        confirmRunnerConfig(config, profile, data);
      }
      const remaining = unsafeRegistrations(config);
      if (remaining.mcp_servers.size || remaining.plugins.size) throw new CodexToolIsolationError();
      confirmRunnerFeatures(await session.request('experimentalFeature/list', {
        limit: 300, ...(threadId && { threadId }),
      }));
    } catch {
      throw new CodexToolIsolationError();
    }
    // Send on the verified session. A disconnect here must not dispatch on a replacement session.
    return session.request(method, {
      ...params,
      ...(method !== 'turn/start' && { modelProvider: 'openai' }),
      ...(method === 'thread/start' && { dynamicTools: [] }),
    });
  }

  request(request: Parameters<CodexTransport['request']>[0]) {
    if (request.method === 'thread/start') {
      if (request.marker.kind !== 'launch') throw new Error('Invalid Codex launch marker');
      return this.safeDispatch(request.method, { ...object(request.params), threadSource: launchThreadSource(request.marker.id) });
    }
    if (request.method === 'thread/turns/list') return this.historyPage(request.params);
    return this.safeDispatch(request.method, object(request.params));
  }

  private async historyPage(params: unknown): Promise<unknown> {
    const delay = this.options.delay ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        return await this.rpc('thread/turns/list', params);
      } catch (error) {
        if (!(error instanceof CodexRpcError) || !error.historyTransient) throw error;
        if (attempt === 4) return undefined;
        await delay(750);
      }
    }
  }

  private async *pages(method: string, params: Json) {
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < pageLimit; page++) {
      const pageParams = { ...object(params), limit: pageSize, ...(cursor ? { cursor } : {}) };
      const raw = method === 'thread/turns/list' ? await this.historyPage(pageParams) : await this.rpc(method, pageParams);
      if (raw === undefined) throw new Error('Codex turn history is temporarily unavailable');
      const response = object(raw);
      const data = list(response.data);
      if (data.length > pageSize) throw new Error('Codex page exceeded its limit');
      yield* data.map(object);
      if (response.nextCursor === null) return;
      cursor = requiredText(response.nextCursor);
      if (seen.has(cursor)) throw new Error('Codex repeated a pagination cursor');
      seen.add(cursor);
    }
    throw new Error('Codex lookup reached its page limit');
  }

  async findLaunchThreads(cwd: string, id: string) {
    const source = launchThreadSource(id);
    const matches = new Set<string>();
    const seen = new Set<string>();
    for await (const candidate of this.pages('thread/list', {
      cwd, sortKey: 'created_at', sortDirection: 'desc', currentAccountOnly: true,
    })) {
      if (candidate.cwd !== cwd) continue;
      const threadId = requiredText(candidate.id);
      if (seen.has(threadId)) throw new Error('Codex thread listing repeated a candidate');
      seen.add(threadId);
      const response = object(await this.rpc('thread/read', { threadId, includeTurns: false }));
      const thread = object(response.thread);
      if (thread.id !== threadId || thread.cwd !== cwd) throw new Error('Codex read returned a different thread');
      if (thread.threadSource === source) matches.add(threadId);
    }
    return [...matches];
  }

  async lookup(marker: CodexMarker, evidence?: CodexLookupEvidence): Promise<Lookup<unknown>> {
    try {
      if (marker.kind === 'launch' && evidence && 'cwd' in evidence) {
        const { cwd, model, permissions } = evidence;
        const matches = await this.findLaunchThreads(cwd, marker.id);
        if (matches.length !== 1) return unknown;
        const [threadId] = matches;
        const response = object(await this.safeDispatch('thread/resume', {
          threadId, cwd, runtimeWorkspaceRoots: [cwd], model,
          ...(this.readProfile ? { permissions: this.readProfile } : { sandbox: permissions.sandbox }),
          approvalPolicy: permissions.approvalPolicy, excludeTurns: true,
        }));
        const thread = object(response.thread);
        const sandbox = object(response.sandbox);
        const sandboxType = permissions.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
        if (thread.id !== threadId || thread.cwd !== cwd || response.cwd !== cwd ||
            response.model !== model || response.approvalPolicy !== permissions.approvalPolicy ||
            sandbox.type !== sandboxType || (sandboxType === 'readOnly' && sandbox.networkAccess !== false) ||
            (this.readProfile && (response.modelProvider !== 'openai' || !confirmsReadProfile(response, this.readProfile, cwd)))) return unknown;
        return { status: 'found', value: response };
      }
      if (marker.kind === 'turn' && evidence && 'threadId' in evidence) {
        const { threadId } = evidence;
        const prefix = `Loom turn ${JSON.stringify(marker.id)}\n`;
        let matched: Frame | undefined;
        for await (const turn of this.pages('thread/turns/list', { threadId, sortDirection: 'desc', itemsView: 'full' })) {
          const hits = list(turn.items).map(object).filter(item => item.type === 'userMessage')
            .flatMap(item => list(item.content).map(object)).filter(content => (
              content.type === 'text' && typeof content.text === 'string' && content.text.startsWith(prefix)
            ));
          if (!hits.length) continue;
          if (matched || hits.length !== 1) return unknown;
          requiredText(turn.id);
          if (typeof turn.status !== 'string' || !['inProgress', 'completed', 'failed', 'interrupted'].includes(turn.status)) {
            return unknown;
          }
          matched = turn;
        }
        if (matched) return { status: 'found', value: { threadId, turn: matched } };
      }
    } catch {
      return unknown;
    }
    return unknown;
  }

  async interruptTurn(threadId: string, turnId: string) {
    await this.rpc('turn/interrupt', { threadId, turnId });
  }

  async answerQuestion(threadId: string, turnId: string, question: CodexQuestion, answers: string[]) {
    return this.session?.answerQuestion(threadId, turnId, question, answers) ?? false;
  }

  async readQuestion(threadId: string, turnId: string) {
    return this.session?.readQuestion(threadId, turnId);
  }
}

export function confirmsReadProfile(response: Frame, id: string, cwd: string) {
  const profile = response.activePermissionProfile;
  const roots = response.runtimeWorkspaceRoots;
  return profile !== null && typeof profile === 'object'
    && (profile as Frame).id === id && (profile as Frame).extends == null
    && Array.isArray(roots) && roots.length === 1 && roots[0] === cwd;
}
