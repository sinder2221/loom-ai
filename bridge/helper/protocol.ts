import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { projectActivityInput } from '../src/activity.ts';
import {
  approvalInput, approvalRequest, credentialToken, fields as structure, identifier, message as text, nonceValue,
  positiveInt as positive,
} from '../src/approval-input.ts';
import type { EventOrigin, openBridge } from '../src/index.ts';
import { delegationStatusInput, enableDelegationInput, projectFolderInput, projectInput } from '../src/projects.ts';
import { readUsageSnapshots } from '../usage/read-snapshots.ts';
import type { claudeConnections } from './claude-connection.ts';
import { hasCode, Refusal } from './files.ts';

export const maxRequestBytes = 64 * 1024;
const maxResponseBytes = 1024 * 1024;
const maxRequestIdLength = 64;
const maxPageRowsBytes = maxResponseBytes - Buffer.byteLength(JSON.stringify({
  v: 1, id: 'x'.repeat(maxRequestIdLength), ok: true, result: { rows: [], more: false },
}));
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type Bridge = ReturnType<typeof openBridge>;
type Request = { v: 1; id: string; op: string; args?: unknown[] };

function pageOptions(after: unknown = 0, limit: unknown = 200) {
  if ((after === 0 || positive(after)) && positive(limit) && limit <= 1000) return { after, limit };
}

function page<T extends { id: number }>(allRows: T[], { after, limit }: { after: number; limit: number }) {
  const first = allRows.findIndex(row => row.id > after);
  if (first === -1) return { rows: [], more: false };

  const rows: T[] = [];
  let bytes = 0;
  for (const row of allRows.slice(first, first + limit)) {
    bytes += Buffer.byteLength(JSON.stringify(row)) + (rows.length === 0 ? 0 : 1);
    // End the page before exceeding the wire budget. A single oversize row gets the normal frame error.
    if (rows.length > 0 && bytes > maxPageRowsBytes) break;
    rows.push(row);
  }
  return { rows, more: first + rows.length < allRows.length };
}

function origin(value: unknown): value is EventOrigin {
  return structure(value, ['actor', 'scope', 'source', 'sourceId'])
    && Object.values(value).every(text);
}

function recordEvent(value: unknown): value is Parameters<Bridge['recordEvent']>[0] {
  if (!structure(value, ['handoffId', 'origin', 'kind'], ['payload', 'intent', 'runId'])
    || !text(value.handoffId) || !origin(value.origin) || (value.kind !== 'observation' && value.kind !== 'result')
    || (Object.hasOwn(value, 'runId') && !identifier(value.runId))) return false;
  if (!Object.hasOwn(value, 'intent')) return true;
  if (!structure(value.intent, ['destinationChatId', 'correlationId']) || !Object.values(value.intent).every(text)) return false;
  try {
    // Check the JSON returned by a claim before admitting the intent. Leave room for request-supplied IDs and fixed metadata.
    const payload = JSON.stringify({ result: { payload: value.payload } });
    return Buffer.byteLength(payload) <= maxResponseBytes - 2 * maxRequestBytes;
  } catch {
    return false;
  }
}

function transport(value: unknown): value is Parameters<Bridge['recordTransport']>[1] {
  return structure(value, ['attempt', 'state', 'evidence', 'origin']) && positive(value.attempt)
    && (value.state === 'Accepted by transport' || value.state === 'Held for approval' || value.state === 'Refused')
    && text(value.evidence) && origin(value.origin);
}

function receipt(value: unknown): value is Parameters<Bridge['recordReceipt']>[1] {
  return structure(value, ['attempt', 'kind', 'correlationId', 'destinationChatId', 'evidence', 'origin']) && positive(value.attempt)
    && (value.kind === 'Received' || value.kind === 'Acted') && text(value.correlationId)
    && text(value.destinationChatId) && text(value.evidence) && origin(value.origin);
}

export function operations(bridge: Bridge, status: () => object, issuer?: string, dataDirectory?: string,
  claude?: ReturnType<typeof claudeConnections>) {
  const issuerBytes = credentialToken(issuer) ? Buffer.from(issuer) : undefined;
  const issuedByHost = (proof: unknown) => issuerBytes !== undefined && credentialToken(proof)
    && timingSafeEqual(issuerBytes, Buffer.from(proof));
  const hostProjectCall = (call?: (projectId: string) => object) => (...args: unknown[]) => {
    const [proof, input] = args;
    if (call && args.length === 2 && issuedByHost(proof) && delegationStatusInput(input)) {
      return () => call(input.projectId);
    }
  };
  return {
    previewClaudeConnection: hostProjectCall(claude?.preview),
    applyClaudeConnection: hostProjectCall(claude?.apply),
    removeClaudeConnection: hostProjectCall(claude?.remove),
    claudeConnectionStatus: hostProjectCall(claude?.status),
    ping: (...args: unknown[]) => args.length === 0 ? () => ({ pong: true }) : undefined,
    status: (...args: unknown[]) => args.length === 0 ? status : undefined,
    recordEvent: (...args: unknown[]) => {
      const [input] = args;
      if (args.length === 1 && recordEvent(input)) return () => bridge.recordEvent(input);
    },
    listPendingDeliveries: (...args: unknown[]) => {
      const options = pageOptions(args[0], args[1]);
      if (args.length <= 2 && options) return () => page(bridge.listPendingDeliveries(), options);
    },
    claimDelivery: (...args: unknown[]) => {
      const [id, ready] = args;
      if (args.length === 2 && positive(id) && typeof ready === 'boolean') return () => bridge.claimDelivery(id, ready);
    },
    recordTransport: (...args: unknown[]) => {
      const [id, input] = args;
      if (args.length === 2 && positive(id) && transport(input)) return () => bridge.recordTransport(id, input);
    },
    recordReceipt: (...args: unknown[]) => {
      const [id, input] = args;
      if (args.length === 2 && positive(id) && receipt(input)) return () => bridge.recordReceipt(id, input);
    },
    resendDelivery: (...args: unknown[]) => {
      const [id, input] = args;
      if (args.length === 2 && positive(id) && origin(input)) return () => bridge.resendDelivery(id, input);
    },
    expireDeliveries: (...args: unknown[]) => args.length === 0 ? () => bridge.expireDeliveries() : undefined,
    registerProject: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && projectInput(input)) return () => bridge.registerProject(input);
    },
    relinkProject: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && projectFolderInput(input)) return () => bridge.relinkProject(input);
    },
    projectStatus: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && projectFolderInput(input)) {
        return () => bridge.projectRegistrationStatus(input);
      }
    },
    projectActivity: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && projectActivityInput(input)) {
        return () => bridge.projectActivity(input);
      }
    },
    enableDelegation: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && enableDelegationInput(input)) {
        return () => bridge.enableDelegation(input);
      }
    },
    delegationStatus: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && delegationStatusInput(input)) {
        return () => bridge.delegationStatus(input);
      }
    },
    usageSnapshot: (...args: unknown[]) => {
      if (args.length === 1 && issuedByHost(args[0])) return () => readUsageSnapshots(dataDirectory);
    },
    openQuestion: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof)
        && structure(input, ['handoffId', 'runId', 'questionId', 'nonce', 'prompt', 'expiresAt'])
        && identifier(input.handoffId) && identifier(input.runId) && identifier(input.questionId)
        && nonceValue(input.nonce) && text(input.prompt) && positive(input.expiresAt)) {
        const { handoffId, runId, questionId, nonce, prompt, expiresAt } = input;
        return () => {
          const { event } = bridge.openQuestion({ handoffId, runId, questionId, nonce, prompt, expiresAt,
            origin: { actor: 'provider', scope: 'handoff', source: 'helper-question', sourceId: randomUUID() } });
          return { outcome: event.outcome, ...(event.reason && { reason: event.reason }) };
        };
      }
    },
    answerQuestion: (...args: unknown[]) => {
      const [credential, questionId, nonce, answer] = args;
      if (args.length === 4 && typeof credential === 'string' && identifier(questionId)
        && nonceValue(nonce) && text(answer)) return () => bridge.answerFromOrigin(credential, questionId, nonce, answer);
    },
    queueAutomaticReply: (...args: unknown[]) => {
      const [credential, handoffId, runId, questionId] = args;
      if (args.length === 4 && typeof credential === 'string' && identifier(handoffId) && identifier(runId)
        && identifier(questionId)) return () => bridge.queueReplyFromOrigin(credential, handoffId, runId, questionId);
    },
    queueDelegateLaunch: (...args: unknown[]) => {
      const [credential, input] = args;
      if (args.length === 2 && typeof credential === 'string' && input && typeof input === 'object'
        && !Array.isArray(input)) return () => bridge.queueDelegateLaunch(credential, input);
    },
    createApproval: (...args: unknown[]) => {
      const [proof, input] = args;
      if (args.length === 2 && issuedByHost(proof) && approvalInput(input) && input.request.kind !== 'launch') {
        return () => bridge.createApproval(input);
      }
    },
    consumeApproval: (...args: unknown[]) => {
      const [credential, token, input] = args;
      if (args.length === 3 && typeof credential === 'string' && credentialToken(token) && approvalRequest(input)
        && input.kind !== 'launch') {
        return () => bridge.consumeApproval(credential, token, input);
      }
    },
    projectReplyStatus: (...args: unknown[]) => {
      const [credential, handoffId, after] = args;
      if (args.length === 3 && typeof credential === 'string'
        && (handoffId === null || identifier(handoffId)) && (after === null || identifier(after))
        && (handoffId === null || after === null)) {
        return () => bridge.replyStatusFromOrigin(credential, handoffId ?? undefined, after ?? undefined);
      }
    },
    inspectHandoff: (...args: unknown[]) => {
      const [credential, handoffId] = args;
      if (args.length === 2 && typeof credential === 'string' && identifier(handoffId)) {
        return () => bridge.inspectFromOrigin(credential, handoffId);
      }
    },
    audit: (...args: unknown[]) => {
      const [id] = args;
      const options = pageOptions(args[1], args[2]);
      if (args.length <= 3 && text(id) && options) return () => page(bridge.audit(id), options);
    },
  };
}

type Operations = ReturnType<typeof operations>;
type FrameError = 'malformed-frame' | 'frame-too-large' | 'frame-timeout';

// One request and one response per connection. Bound the first line before decoding.
function readFrame(socket: Socket, maxBytes: number, frame: (data: Buffer) => void, reject: (code: FrameError) => void) {
  const chunks: Buffer[] = [];
  let size = 0;
  const deadline = setTimeout(() => finish(() => reject('frame-timeout')), 5000);
  const incomplete = () => finish(() => reject('malformed-frame'));
  function finish(done?: () => void) {
    clearTimeout(deadline);
    socket.off('data', collect).off('end', incomplete).off('close', finishOnClose);
    done?.();
  }
  function finishOnClose() { finish(); }
  function collect(chunk: Buffer) {
    const newline = chunk.indexOf(0x0a);
    const bytes = newline === -1 ? chunk : chunk.subarray(0, newline);
    size += bytes.length;
    if (size > maxBytes) return finish(() => reject('frame-too-large'));
    chunks.push(bytes);
    if (newline !== -1) finish(() => frame(Buffer.concat(chunks, size)));
  }
  socket.on('data', collect).once('end', incomplete).once('close', finishOnClose);
}

function parseRequest(data: Buffer): Request | undefined {
  let value: unknown;
  try { value = JSON.parse(decoder.decode(data)); } catch { return undefined; }
  if (structure(value, ['v', 'id', 'op'], ['args']) && value.v === 1
    && typeof value.id === 'string' && value.id.length <= maxRequestIdLength && /^[A-Za-z0-9_-]+$/.test(value.id)
    && typeof value.op === 'string' && (!Object.hasOwn(value, 'args') || Array.isArray(value.args))) {
    return value as Request;
  }
}

export function serveFrame(socket: Socket, calls: Operations, onRefusal: (code: string) => void) {
  function reply(response: string) {
    socket.setTimeout(5000, () => socket.destroy());
    socket.end(response + '\n');
  }
  function refuse(code: string, id: string | null = null, log = true) {
    if (log) onRefusal(code);
    reply(JSON.stringify({ v: 1, id, ok: false, error: code }));
  }
  readFrame(socket, maxRequestBytes, data => {
    const request = parseRequest(data);
    if (!request) return refuse('malformed-frame');
    const { op, id, args = [] } = request;
    // The usage read leaves the data directory untouched, including on a refusal.
    const refuseRequest = (code: string) => refuse(code, id, op !== 'usageSnapshot');
    if (!Object.hasOwn(calls, op)) return refuseRequest('operation-not-allowed');
    const invoke = calls[op as keyof Operations](...args);
    if (!invoke) return refuseRequest('invalid-arguments');

    let response: string;
    try {
      response = JSON.stringify({ v: 1, id, ok: true, result: invoke() ?? null });
    } catch {
      return refuseRequest('bridge-call-failed');
    }
    if (Buffer.byteLength(response) > maxResponseBytes) return refuseRequest('response-too-large');
    reply(response);
  }, refuse);
}

export function socketAnswers(path: string) {
  return new Promise<boolean>((resolve, reject) => {
    const socket = createConnection(path);
    socket.setTimeout(1000, () => socket.destroy(new Refusal('socket-probe-timed-out')));
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', error => {
      if (hasCode(error, 'ENOENT', 'ECONNREFUSED')) resolve(false);
      else reject(new Refusal('socket-probe-failed'));
    });
  });
}

export function requestHelper(path: string, op: string, args: unknown[]): Promise<unknown> {
  const id = randomUUID();
  const frame = JSON.stringify({ v: 1, id, op, args });
  if (Buffer.byteLength(frame) > maxRequestBytes) return Promise.reject(new Refusal('frame-too-large'));
  return new Promise((resolve, reject) => {
    const socket = createConnection(path);
    const fail = () => { socket.destroy(); reject(new Refusal('helper-unavailable')); };
    socket.on('error', fail).once('close', fail);
    socket.once('connect', () => socket.end(frame + '\n'));
    readFrame(socket, maxResponseBytes, data => {
      try {
        const answer: unknown = JSON.parse(decoder.decode(data));
        if (!structure(answer, ['v', 'id', 'ok', 'result']) || answer.v !== 1 || answer.id !== id || answer.ok !== true) {
          return fail();
        }
        resolve(answer.result);
        socket.destroy();
      } catch { fail(); }
    }, fail);
  });
}

export function queryStatus(path: string) {
  type Counts = { launches: number; turns: number; deliveries: number };
  type Status = { running: true; pid: number; reconciled: Counts; pendingDeliveries: number };
  return new Promise<Status>((resolve, reject) => {
    const socket = createConnection(path);
    const fail = () => { socket.destroy(); reject(new Refusal('helper-status-unavailable')); };
    socket.on('error', fail).once('close', fail);
    socket.once('connect', () => socket.write('{"v":1,"id":"status","op":"status"}\n'));
    readFrame(socket, maxResponseBytes, data => {
      try {
        const answer = JSON.parse(decoder.decode(data));
        if (answer.v !== 1 || answer.id !== 'status' || answer.ok !== true
          || answer.result?.running !== true || !positive(answer.result.pid)) return fail();
        const { pid, reconciled, pendingDeliveries } = answer.result;
        const { launches, turns, deliveries } = reconciled;
        if (![launches, turns, deliveries, pendingDeliveries].every(n => Number.isSafeInteger(n) && n >= 0)) return fail();
        resolve({ running: true, pid, reconciled: { launches, turns, deliveries }, pendingDeliveries });
        socket.destroy();
      } catch { fail(); }
    }, fail);
  });
}
