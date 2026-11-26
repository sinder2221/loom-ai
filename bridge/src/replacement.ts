import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { sameConnection, chatRoute, providerOrigin } from '../adapters/binding.ts';
import type { CodexPermissions } from '../adapters/codex-protocol.ts';
import { skipDelivery } from './deliveries.ts';
import { appendEvent, applyEvent, getHandoff, requireText, type Context, type EventOrigin, type Json } from './events.ts';
import { activeRunId, codexRun, codexTurnOwnership, providerLaunch } from './ownership.ts';
import type { Storage } from './storage.ts';

type ReplacementTarget = { handoffId: string; previousRunId: string; origin: EventOrigin };
type StopObservation = { status: 'unresolved' } | {
  status: 'interrupted'; threadId: string; workspace: string; evidence: string;
};

interface ReplacementPlan {
  id: string;
  destinationChatId: string;
  workspace: string;
  model: string;
  permissions: CodexPermissions;
}

// The trusted host issues this only after authorizing the exact plan and fencing the new workspace.
interface IsolationAuthorization extends ReplacementPlan {
  previousRunId: string;
  stopRequestId: number;
  evidence: string;
}

function workspacePath(path: string) {
  if (!isAbsolute(path)) throw new Error('Workspace must be an absolute directory');
  const canonical = realpathSync(path);
  if (!statSync(canonical).isDirectory() || canonical === resolve(canonical, '..')) {
    throw new Error('Invalid workspace directory');
  }
  return canonical;
}

function sameDirectory(left: string, right: string) {
  const first = statSync(left, { bigint: true });
  const second = statSync(right, { bigint: true });
  return first.dev === second.dev && first.ino === second.ino;
}

function contains(parent: string, child: string) {
  const name = relative(parent, child);
  return !isAbsolute(name) && name !== '..' && !name.startsWith(`..${sep}`);
}

function overlaps(first: string, second: string) {
  // Check ancestor identities too, including case aliases on case-insensitive volumes.
  function containsIdentity(parent: string, child: string) {
    for (let current = child; current !== resolve(current, '..'); current = resolve(current, '..')) {
      if (sameDirectory(parent, current)) return true;
    }
    return false;
  }
  return contains(first, second) || contains(second, first) ||
    containsIdentity(first, second) || containsIdentity(second, first);
}

function currentOwner(storage: Storage, { handoffId, previousRunId }: ReplacementTarget) {
  if (activeRunId(storage, handoffId) !== previousRunId) return;
  return storage.get<{
    chatId: string; state: string; stopState: string | null; requestId: number | null; workspace: string | null;
  }>(`
    SELECT destination_chat_id AS chatId, state, stop_state AS stopState, workspace,
           stop_requested_event_id AS requestId FROM run WHERE id = ? AND handoff_id = ?
  `, previousRunId, handoffId);
}

function permissionPair(permissions: CodexPermissions) {
  const { sandbox, approvalPolicy } = permissions;
  if ((sandbox !== 'read-only' && sandbox !== 'workspace-write') ||
      (approvalPolicy !== 'never' && approvalPolicy !== 'on-request')) throw new Error('Invalid replacement permissions');
  return { sandbox, approvalPolicy };
}

export function assertReplacementLaunchIntent(
  storage: Storage, handoffId: string, origin: EventOrigin, payload?: Json,
) {
  const run = storage.get<{ id: string; chatId: string; workspace: string }>(`
    SELECT r.id, r.destination_chat_id AS chatId, r.workspace FROM handoff h
    JOIN run r ON r.id = h.active_run_id WHERE h.id = ? AND r.reason = 'replacement-prepared'
  `, handoffId);
  if (!run) return;
  const marker = JSON.stringify(['launch', run.id]);
  const expected = providerOrigin(chatRoute(storage, run.chatId), 'launch-intent', marker);
  if (origin.source !== expected.source || origin.sourceId !== marker) return;
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || payload.cwd !== run.workspace ||
      workspacePath(run.workspace) !== run.workspace) throw new Error('Launch differs from the prepared replacement');
}

export function replacementOperations(context: Context) {
  const { storage } = context;
  return {
    beginReplacement(input: ReplacementTarget) {
      const { handoffId, previousRunId, origin } = input;
      return applyEvent(context, handoffId, origin, now => {
        const old = currentOwner(storage, input);
        const fields = { kind: 'replacement-stop-requested', runId: previousRunId };
        if (!old || old.stopState) return appendEvent(storage, handoffId, origin, now, {
          ...fields, runId: old ? previousRunId : undefined, outcome: 'rejected',
          reason: old ? 'stop-already-requested' : 'owner-changed',
        });
        const { route, launch, requested, started } = providerLaunch(storage, old.chatId, previousRunId);
        const cwd = old.workspace ?? launch?.cwd ?? (started ? requested?.cwd : undefined);
        if (route.provider !== 'codex' || !cwd) return appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: 'workspace-unverified',
        });
        const workspace = workspacePath(cwd);
        const id = appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: 'pending', destinationChatId: old.chatId,
        });
        storage.run(`
          UPDATE run SET stop_requested_event_id = ?, stop_state = 'pending', workspace = ? WHERE id = ?
        `, id, workspace, previousRunId);
        return id;
      });
    },

    recordReplacementStop(input: ReplacementTarget & { stopRequestId: number; observation: StopObservation }) {
      const { handoffId, previousRunId, origin, stopRequestId, observation } = input;
      return applyEvent(context, handoffId, origin, now => {
        const old = currentOwner(storage, input);
        const fields = { kind: 'replacement-stop-observed', runId: old ? previousRunId : undefined };
        if (!old || old.requestId !== stopRequestId || old.stopState === 'verified') {
          return appendEvent(storage, handoffId, origin, now, {
            ...fields, outcome: 'rejected', reason: 'stop-request-mismatch',
          });
        }
        const { launch } = providerLaunch(storage, old.chatId, previousRunId);
        if (observation.status === 'interrupted') {
          requireText(observation.evidence, 'stop evidence');
          const unresolvedDispatch = storage.get(`
            SELECT 1 FROM delivery d JOIN event e ON e.id = d.event_id
            JOIN question q ON q.answer_event_id = e.id WHERE q.run_id = ? AND d.attempts > 0
              AND d.state NOT IN ('Delivered to chat', 'Refused')
          `, previousRunId);
          if (!launch || observation.threadId !== launch.threadId || observation.workspace !== old.workspace ||
              unresolvedDispatch || codexTurnOwnership(storage, previousRunId, codexRun(storage, previousRunId)).conflict) {
            return appendEvent(storage, handoffId, origin, now, {
            ...fields, outcome: 'rejected', reason: 'stop-evidence-mismatch',
            });
          }
        } else if (observation.status !== 'unresolved') {
          throw new Error('Unknown stop observation');
        }
        const stopState = observation.status === 'interrupted' ? 'verified' : 'unresolved';
        storage.run('UPDATE run SET stop_state = ? WHERE id = ?', stopState, previousRunId);
        return appendEvent(storage, handoffId, origin, now, {
          ...fields, destinationChatId: old.chatId, outcome: stopState,
          reason: stopState === 'unresolved' ? 'interruption-unverified' : undefined,
          payload: observation.status === 'interrupted' ? { evidence: observation.evidence } : undefined,
        });
      });
    },

    replaceRun(input: ReplacementTarget & { plan: ReplacementPlan; isolation?: IsolationAuthorization }) {
      const { handoffId, previousRunId, origin, plan, isolation } = input;
      return applyEvent(context, handoffId, origin, now => {
        const old = currentOwner(storage, input);
        const reject = (reason: string) => appendEvent(storage, handoffId, origin, now, {
          kind: 'replacement', runId: old ? previousRunId : undefined, outcome: 'rejected', reason,
        });
        if (!old) return reject('owner-changed');
        if (!old.workspace || !old.stopState || old.stopState === 'pending') return reject('stop-outcome-pending');
        const oldRoute = chatRoute(storage, old.chatId);
        const newRoute = chatRoute(storage, plan.destinationChatId);
        if (!sameConnection(oldRoute, newRoute) || storage.get(`
          SELECT 1 FROM run WHERE id = ? OR destination_chat_id = ?
        `, plan.id, plan.destinationChatId)) return reject('replacement-chat-or-run-conflict');
        requireText(plan.id, 'replacement run ID');
        requireText(plan.model, 'replacement model');
        const permissions = permissionPair(plan.permissions);
        const workspace = workspacePath(plan.workspace);
        if (workspace !== plan.workspace) return reject('workspace-path-not-canonical');

        const existing = storage.all<{ workspace: string }>(`
          SELECT workspace FROM run WHERE handoff_id = ? AND stop_state = 'unresolved'
        `, handoffId);
        if (existing.some(run => overlaps(workspacePath(run.workspace), workspace))) {
          return reject('interruption-unverified-workspace-overlap');
        }
        const unresolved = old.stopState === 'unresolved';
        if (unresolved) {
          if (!isolation || isolation.stopRequestId !== old.requestId || isolation.previousRunId !== previousRunId ||
              isolation.id !== plan.id || isolation.destinationChatId !== plan.destinationChatId ||
              isolation.workspace !== workspace || isolation.model !== plan.model ||
              isolation.permissions?.sandbox !== permissions.sandbox ||
              isolation.permissions?.approvalPolicy !== permissions.approvalPolicy) return reject('isolation-approval-required');
          requireText(isolation.evidence, 'isolation evidence');
        }

        // Release the old scheduling slot before reserving the new owner, under the same write lock.
        storage.run("UPDATE run SET state = CASE WHEN state = 'Completed' THEN state ELSE 'Interrupted' END, reason = ? WHERE id = ?",
          old.stopState === 'verified' ? 'superseded' : 'interruption-unverified', previousRunId);
        storage.run(`
          INSERT INTO run (id, handoff_id, destination_chat_id, model, permissions, state, reason, workspace)
          VALUES (?, ?, ?, ?, ?, 'Interrupted', 'replacement-prepared', ?)
        `, plan.id, handoffId, plan.destinationChatId, plan.model, JSON.stringify(permissions), workspace);
        storage.run('UPDATE run SET superseded_by = ? WHERE id = ?', plan.id, previousRunId);
        storage.run('UPDATE handoff SET active_run_id = ? WHERE id = ?', plan.id, handoffId);

        const queued = storage.all<{ id: number }>(`
          SELECT d.id FROM delivery d JOIN event e ON e.id = d.event_id WHERE d.handoff_id = ?
            AND (e.kind = 'result' AND (e.run_id = ? OR e.run_id IS NULL) OR EXISTS (
              SELECT 1 FROM question q WHERE q.run_id = ? AND (q.reply_event_id = e.id OR q.answer_event_id = e.id)
            )) ORDER BY d.id
        `, handoffId, previousRunId, previousRunId);
        for (const { id } of queued) skipDelivery(storage, id, now, 'run-superseded');
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'replacement', runId: plan.id, subjectId: previousRunId, destinationChatId: plan.destinationChatId,
          fromState: old.state, toState: 'Interrupted', outcome: 'activated',
          reason: unresolved ? 'authorized-isolated-workspace' : 'verified-interruption',
          payload: unresolved ? { evidence: isolation!.evidence } : undefined,
        });
      });
    },
  };
}
