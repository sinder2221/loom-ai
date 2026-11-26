import { appendEvent, applyEvent, bridgeOrigin, type Context } from '../src/events.ts';
import type { openBridge } from '../src/index.ts';
import { hasOperationInFlight } from '../src/work.ts';
import { chatRoute, providerOrigin, sameConnection, type ChatRoute } from './binding.ts';
import { confirmsReadProfile, type ScopedCodexTransport } from './codex-app-server.ts';
import {
  list, object, questionFromEvent, requiredText, resultFromTurn, resultSchema,
  type CodexMarker, type CodexPermissions,
} from './codex-protocol.ts';

type Bridge = ReturnType<typeof openBridge>;
interface LaunchInput {
  id: string;
  handoffId: string;
  destinationChatId: string;
  cwd: string;
  model: string;
  permissions: CodexPermissions;
}

interface ThreadOutcome {
  threadId: string;
  cwd: string;
  model: string;
  permissions: CodexPermissions;
}

export class CodexLaunchSettingsError extends Error {}
export class CodexQuestionError extends Error {}

export function codexAdapter(bridge: Bridge, context: Context, active: (route: ChatRoute) => ScopedCodexTransport | undefined) {
  const { storage } = context;
  const launchRoute = (id: string) => chatRoute(storage, bridge.getRun(id).destinationChatId);
  const markerFor = (marker: CodexMarker) => JSON.stringify([marker.kind, marker.id]);

  function connection(route: ChatRoute) {
    const transport = route.provider === 'codex' ? active(route) : undefined;
    if (route.provider === 'codex' && transport && sameConnection(route, transport.binding)) return transport;
  }

  function evidence<T>(route: ChatRoute, kind: string, marker: CodexMarker): T | undefined {
    const origin = providerOrigin(route, kind, markerFor(marker));
    const event = storage.get<{ payload: string }>(
      'SELECT payload FROM event WHERE source = ? AND source_id = ?', origin.source, origin.sourceId,
    );
    return event && JSON.parse(event.payload) as T;
  }

  function launchStatus(id: string) {
    const run = bridge.getRun(id);
    return { ...run, provider: evidence<ThreadOutcome>(launchRoute(id), 'launch-outcome', { kind: 'launch', id }) };
  }

  function turnStatus(id: string) {
    const turn = bridge.getTurn(id);
    const route = launchRoute(turn.runId);
    return {
      ...turn, provider: evidence<{ threadId: string; turnId: string }>(route, 'turn-outcome', { kind: 'turn', id }),
    };
  }

  function saveLaunch(id: string, result: unknown) {
    const route = launchRoute(id), marker = { kind: 'launch', id } as const;
    const { cwd } = evidence<{ cwd: string }>(route, 'launch-intent', marker)!;
    const response = object(result);
    const thread = object(response.thread);
    const threadId = requiredText(thread.id);
    const run = bridge.getRun(id);
    const permissions = object(run.permissions);
    const sandbox = object(response.sandbox);
    const profile = connection(route)?.readProfile;
    const sandboxType = permissions.sandbox === 'read-only' ? 'readOnly' : 'workspaceWrite';
    if (response.cwd !== cwd || thread.cwd !== cwd || response.model !== run.model ||
        sandbox.type !== sandboxType || (sandboxType === 'readOnly' && sandbox.networkAccess !== false) ||
        response.approvalPolicy !== permissions.approvalPolicy ||
        (profile && (response.modelProvider !== 'openai' || !confirmsReadProfile(response, profile, cwd)))) {
      throw new CodexLaunchSettingsError('Effective Codex launch settings differ from the request');
    }

    applyEvent(context, run.handoffId, providerOrigin(route, 'launch-outcome', markerFor(marker)), now => {
      const current = bridge.getRun(id);
      if (current.state !== 'Starting' && (current.state !== 'Interrupted' ||
          current.reason !== 'restart-before-launch-outcome' ||
          hasOperationInFlight(storage, current.handoffId, current.destinationChatId) ||
          storage.get("SELECT 1 FROM run WHERE handoff_id = ? AND state = 'Running'", current.handoffId))) {
        throw new Error('Codex launch cannot be reconciled into the current handoff');
      }
      storage.run("UPDATE run SET state = 'Running', reason = NULL WHERE id = ?", id);
      return appendEvent(storage, current.handoffId, providerOrigin(route, 'launch-outcome', markerFor(marker)), now, {
        kind: 'launch-finished', subjectId: id, destinationChatId: route.chatId,
        fromState: current.state, toState: 'Running', outcome: 'completed',
        payload: { threadId, cwd, model: run.model, permissions: run.permissions },
      });
    });
    return launchStatus(id);
  }

  function saveTurn(id: string, threadId: string, result: unknown) {
    const turn = object(result);
    const turnId = requiredText(turn.id);
    const status = turn.status;
    if (status !== 'inProgress' && status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
      throw new Error('Unknown Codex turn status');
    }

    storage.transaction(() => {
      const current = turnStatus(id);
      const run = launchStatus(current.runId);
      const route = launchRoute(current.runId);
      if (run.provider?.threadId !== threadId || (current.provider && current.provider.turnId !== turnId)) {
        throw new Error('Codex turn outcome belongs to another thread or turn');
      }
      const marker = { kind: 'turn', id } as const;
      const now = context.now();
      if (!current.provider) appendEvent(storage, run.handoffId, providerOrigin(route, 'turn-outcome', markerFor(marker)), now, {
        kind: 'turn-accepted', subjectId: id, destinationChatId: route.chatId,
        outcome: 'accepted', payload: { threadId, turnId },
      });
      const state = status === 'inProgress' ? 'In flight' : status === 'completed' ? 'Completed' : 'Interrupted';
      const reason = state === 'Interrupted' ? `provider-turn-${status}` : null;
      if (current.state === state && current.reason === reason) return;
      if (current.state === 'Completed' ||
          (current.state === 'Interrupted' && current.reason !== 'restart-before-turn-outcome')) {
        throw new Error('Codex turn is already settled');
      }
      if (state === 'In flight' && (run.state !== 'Running' ||
          hasOperationInFlight(storage, run.handoffId, run.destinationChatId, null, id))) {
        throw new Error('Codex turn cannot be reattached to the current handoff');
      }
      storage.run('UPDATE turn SET state = ?, reason = ? WHERE id = ?', state, reason, id);
      appendEvent(storage, run.handoffId, bridgeOrigin, now, {
        kind: state === 'In flight' ? 'turn-reattached' : state === 'Completed' ? 'turn-finished' : 'turn-interrupted',
        subjectId: id, destinationChatId: route.chatId, fromState: current.state, toState: state,
        outcome: status, reason: reason ?? undefined,
      });
    });
    return turnStatus(id);
  }

  return {
    getLaunch: launchStatus,
    getTurn: turnStatus,

    async startLaunch(input: LaunchInput) {
      const { id, handoffId, destinationChatId, model, permissions } = input;
      const cwd = requiredText(input.cwd);
      const route = chatRoute(storage, destinationChatId);
      const transport = connection(route);
      if (!transport) throw new Error('Codex connection unavailable');
      if (!['read-only', 'workspace-write'].includes(permissions.sandbox) ||
          !['never', 'on-request'].includes(permissions.approvalPolicy)) {
        throw new Error('Invalid Codex launch permissions');
      }
      const marker = { kind: 'launch', id } as const;
      const intent = evidence<{ cwd: string }>(route, 'launch-intent', marker);
      if (intent && intent.cwd !== cwd) throw new Error('Codex launch marker already has a working directory');
      bridge.recordEvent({
        handoffId, kind: 'observation', payload: { cwd },
        origin: providerOrigin(route, 'launch-intent', markerFor(marker)),
      });
      const decision = bridge.startLaunch({
        id, handoffId, destinationChatId, model,
        permissions: { sandbox: permissions.sandbox, approvalPolicy: permissions.approvalPolicy },
        origin: providerOrigin(route, 'launch-decision', markerFor(marker)),
      });
      if (decision.replayed) return launchStatus(id);
      return saveLaunch(id, await transport.request({
        method: 'thread/start', marker, params: {
          cwd, runtimeWorkspaceRoots: [cwd], model, allowProviderModelFallback: false,
          ...(transport.readProfile ? { permissions: transport.readProfile } : { sandbox: permissions.sandbox }),
          approvalPolicy: permissions.approvalPolicy, ephemeral: false, historyMode: 'paginated',
        },
      }));
    },

    async startTurn(id: string, runId: string, prompt: string, collaborationMode?: Json) {
      const run = launchStatus(runId);
      const route = launchRoute(runId);
      const transport = connection(route);
      if (!transport || !run.provider) throw new Error('Codex thread unavailable');
      const { threadId, cwd, permissions } = run.provider;
      const sandboxPolicy = permissions.sandbox === 'read-only'
        ? { type: 'readOnly', networkAccess: false } as const
        : { type: 'workspaceWrite', networkAccess: false, writableRoots: [cwd] } as const;
      const marker = { kind: 'turn', id } as const;
      const decision = bridge.startTurn(id, runId, providerOrigin(route, 'turn-decision', markerFor(marker)));
      if (decision.replayed) {
        const turn = turnStatus(id);
        if (turn.runId !== runId) throw new Error('Codex turn marker belongs to another run');
        return turn;
      }
      const response = object(await transport.request({
        method: 'turn/start', marker, params: {
          threadId, cwd, runtimeWorkspaceRoots: [cwd], approvalPolicy: permissions.approvalPolicy,
          ...(transport.readProfile ? { permissions: transport.readProfile } : { sandboxPolicy }),
          input: [{ type: 'text', text: `Loom turn ${JSON.stringify(id)}\n${prompt}`, text_elements: [] }],
          outputSchema: resultSchema,
          ...(collaborationMode === undefined ? {} : { collaborationMode }),
        },
      }));
      return saveTurn(id, threadId, response.turn);
    },

    async reconcile(inScope: (runId: string) => boolean = () => true) {
      const launches = storage.all<{ id: string }>(`
        SELECT id FROM run WHERE reason = 'restart-before-launch-outcome' ORDER BY id
      `).filter(({ id }) => inScope(id));
      for (const { id } of launches) {
        const route = launchRoute(id);
        const transport = connection(route);
        const marker = { kind: 'launch', id } as const;
        const intent = evidence<{ cwd: string }>(route, 'launch-intent', marker);
        if (!transport || !intent) continue;
        const run = bridge.getRun(id);
        const lookup = await transport.lookup(marker, {
          cwd: intent.cwd, model: run.model, permissions: run.permissions as unknown as CodexPermissions,
        });
        if (lookup.status === 'found') saveLaunch(id, lookup.value);
      }

      const turns = storage.all<{ id: string; runId: string }>(`
        SELECT id, run_id AS runId FROM turn WHERE reason = 'restart-before-turn-outcome' ORDER BY id
      `).filter(({ runId }) => inScope(runId));
      for (const { id, runId } of turns) {
        const route = launchRoute(runId);
        const transport = connection(route);
        const marker = { kind: 'turn', id } as const;
        const decision = providerOrigin(route, 'turn-decision', markerFor(marker));
        const threadId = launchStatus(runId).provider?.threadId;
        if (!transport || !threadId || !storage.get('SELECT 1 FROM event WHERE source = ? AND source_id = ?',
          decision.source, decision.sourceId)) continue;
        const lookup = await transport.lookup(marker, { threadId });
        if (lookup.status === 'found') {
          const response = object(lookup.value);
          saveTurn(id, requiredText(response.threadId), response.turn);
        }
      }
      return { launches: launches.map(({ id }) => launchStatus(id)), turns: turns.map(({ id }) => turnStatus(id)) };
    },

    async readQuestion(id: string) {
      const turn = turnStatus(id);
      const transport = connection(launchRoute(turn.runId));
      if (!transport || !turn.provider || turn.state !== 'In flight') return;
      const { threadId, turnId } = turn.provider;
      const request = await transport.readQuestion(threadId, turnId);
      try { return questionFromEvent(request, threadId, turnId); } catch (error) {
        throw new CodexQuestionError(error instanceof Error ? error.message : 'Invalid Codex question');
      }
    },

    async answerBlockingQuestion(id: string, question: NonNullable<ReturnType<typeof questionFromEvent>>, answers: string[]) {
      const turn = turnStatus(id);
      const transport = connection(launchRoute(turn.runId));
      if (!transport?.answerQuestion || !turn.provider || turn.state !== 'In flight'
        || question.questions.length !== answers.length) return false;
      const { threadId, turnId } = turn.provider;
      return transport.answerQuestion(threadId, turnId, question, answers);
    },

    async interruptTurn(id: string) {
      const turn = turnStatus(id);
      const transport = connection(launchRoute(turn.runId));
      if (!turn.provider || !transport?.interruptTurn) return false;
      await transport.interruptTurn(turn.provider.threadId, turn.provider.turnId);
      return true;
    },

    async readResult(id: string) {
      const turn = turnStatus(id);
      const route = launchRoute(turn.runId);
      const transport = connection(route);
      if (!transport || !turn.provider) return;
      const { threadId, turnId } = turn.provider;
      const cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        if (connection(route) !== transport) return;
        const response = await transport.request({
          method: 'thread/turns/list', params: {
            threadId, limit: 20, sortDirection: 'desc', itemsView: 'full', ...(cursor ? { cursor } : {}),
          },
        });
        if (response === undefined) return;
        const page = object(response);
        const entry = list(page.data).map(object).find(item => item.id === turnId);
        if (entry) {
          saveTurn(id, threadId, entry);
          return entry.status === 'completed' ? resultFromTurn(entry) : undefined;
        }
        cursor = page.nextCursor == null ? undefined : requiredText(page.nextCursor);
        if (cursor && cursors.has(cursor)) throw new Error('Codex repeated a turn history cursor');
        if (cursor) cursors.add(cursor);
      } while (cursor);
    },
  };
}
