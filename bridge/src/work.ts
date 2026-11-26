import { chatRoute, providerOrigin } from '../adapters/binding.ts';
import {
  appendEvent, applyEvent, assertProjectChat, bridgeOrigin, getHandoff, requireText,
  type Context, type EventOrigin, type Json,
} from './events.ts';
import { activeRunId, providerLaunch } from './ownership.ts';
import type { Storage } from './storage.ts';

function getRun(storage: Storage, id: string) {
  const run = storage.get<{
    handoffId: string; destinationChatId: string; model: string; permissions: string; state: string; reason: string | null;
    supersededBy: string | null; stopState: string | null;
  }>(`
    SELECT handoff_id AS handoffId, destination_chat_id AS destinationChatId, model, permissions, state, reason,
           superseded_by AS supersededBy, stop_state AS stopState
    FROM run WHERE id = ?
  `, id);
  if (!run) throw new Error('Unknown run');
  return { id, ...run, permissions: JSON.parse(run.permissions) as Json };
}

function getTurn(storage: Storage, id: string) {
  const turn = storage.get<{ runId: string; state: string; reason: string | null }>(
    'SELECT run_id AS runId, state, reason FROM turn WHERE id = ?', id,
  );
  if (!turn) throw new Error('Unknown turn');
  return { id, ...turn };
}

const answerTurnPrefix = 'loom-answer-delivery-';

export function answerTurnId(deliveryId: number) {
  return answerTurnPrefix + deliveryId;
}

export function hasOperationInFlight(
  storage: Storage, handoffId: string, destinationChatId: string, answerDeliveryId: number | null = null, recoveringTurnId: string | null = null,
) {
  return storage.get(`
    SELECT 1 FROM delivery WHERE in_flight = 1
      AND id IS NOT ?
      AND ((handoff_id = ? AND skip_reason IS NULL) OR destination_chat_id = ?)
    UNION ALL
    SELECT 1 FROM run r
    WHERE ((r.handoff_id = ? AND r.superseded_by IS NULL) OR r.destination_chat_id = ?)
      AND (r.state = 'Starting' OR EXISTS (
        SELECT 1 FROM turn t WHERE t.run_id = r.id AND t.id IS NOT ? AND (
          t.state = 'In flight' OR (
            t.reason = 'restart-before-turn-outcome' AND t.id = 'loom-initial-' || r.id
            AND EXISTS (SELECT 1 FROM delegate_launch d WHERE d.run_id = r.id)
          )
        )
      ))
    LIMIT 1
  `, answerDeliveryId, handoffId, destinationChatId, handoffId, destinationChatId, recoveringTurnId) !== undefined;
}

function assertWorkSlot(storage: Storage, handoffId: string, destinationChatId: string, answerDeliveryId?: number) {
  if (hasOperationInFlight(storage, handoffId, destinationChatId, answerDeliveryId)) {
    throw new Error('Handoff or chat already has work in flight');
  }
}

export function workOperations(context: Context) {
  const { storage } = context;
  return {
    getRun: (id: string) => getRun(storage, id),
    getActiveRun(handoffId: string) {
      const id = activeRunId(storage, handoffId);
      return id ? getRun(storage, id) : undefined;
    },
    getTurn: (id: string) => getTurn(storage, id),

    startLaunch(input: {
      id: string; handoffId: string; destinationChatId: string; model: string; permissions: Json; origin: EventOrigin;
    }) {
      const { id, handoffId, destinationChatId, model, permissions, origin } = input;
      return applyEvent(context, handoffId, origin, now => {
        requireText(model, 'model');
        assertProjectChat(storage, destinationChatId, getHandoff(storage, handoffId).projectId);
        assertWorkSlot(storage, handoffId, destinationChatId);
        const current = activeRunId(storage, handoffId);
        const prepared = storage.get<{
          workspace: string; permissions: string; model: string; chatId: string; stopState: string | null;
        }>(`
          SELECT workspace, permissions, model, destination_chat_id AS chatId, stop_state AS stopState FROM run
          WHERE id = ? AND handoff_id = ? AND reason = 'replacement-prepared'
        `, id, handoffId);
        if (prepared) {
          const { requested } = providerLaunch(storage, destinationChatId, id);
          if (current !== id || prepared.stopState || prepared.chatId !== destinationChatId || prepared.model !== model ||
              prepared.permissions !== JSON.stringify(permissions) || requested?.cwd !== prepared.workspace) {
            throw new Error('Launch differs from the prepared replacement');
          }
          storage.run("UPDATE run SET state = 'Starting', reason = NULL WHERE id = ?", id);
        } else {
          if (current && chatRoute(storage, getRun(storage, current).destinationChatId).provider === 'codex') {
            throw new Error('Handoff requires a prepared replacement');
          }
          storage.run(`
            INSERT INTO run (id, handoff_id, destination_chat_id, model, permissions, state)
            VALUES (?, ?, ?, ?, ?, 'Starting')
          `, id, handoffId, destinationChatId, model, JSON.stringify(permissions));
          storage.run('UPDATE handoff SET active_run_id = ? WHERE id = ?', id, handoffId);
        }
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'launch-started', subjectId: id, destinationChatId, outcome: 'started', toState: 'Starting',
        });
      });
    },

    finishLaunch(id: string, origin: EventOrigin) {
      const { handoffId } = getRun(storage, id);
      return applyEvent(context, handoffId, origin, now => {
        const run = getRun(storage, id);
        if (run.state !== 'Starting') throw new Error('Launch is not in flight');
        storage.run("UPDATE run SET state = 'Running' WHERE id = ?", id);
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'launch-finished', subjectId: id, destinationChatId: run.destinationChatId,
          outcome: 'completed', fromState: 'Starting', toState: 'Running',
        });
      });
    },

    startTurn(id: string, runId: string, origin: EventOrigin) {
      const { handoffId } = getRun(storage, runId);
      return applyEvent(context, handoffId, origin, now => {
        const run = getRun(storage, runId);
        if (run.state !== 'Running' || run.stopState || activeRunId(storage, handoffId) !== runId) {
          throw new Error('Run is not active');
        }
        let answerDeliveryId: number | undefined;
        if (id.startsWith(answerTurnPrefix)) {
          // The Codex adapter turn and its answer delivery share one scheduling slot.
          const route = chatRoute(storage, run.destinationChatId);
          const decision = providerOrigin(route, 'turn-decision', JSON.stringify(['turn', id]));
          const claim = storage.get<{ id: number }>(`
            SELECT d.id FROM delivery d JOIN question q ON q.answer_event_id = d.event_id
            WHERE d.handoff_id = ? AND q.run_id = ? AND d.destination_chat_id = ?
              AND d.in_flight = 1 AND d.skip_reason IS NULL AND d.deadline_at > ? AND ? = ? || d.id
          `, handoffId, runId, route.chatId, now, id, answerTurnPrefix);
          if (!claim || route.provider !== 'codex' || origin.source !== decision.source || origin.sourceId !== decision.sourceId) {
            throw new Error('Codex answer turn requires a matching delivery claim');
          }
          answerDeliveryId = claim.id;
        }
        assertWorkSlot(storage, handoffId, run.destinationChatId, answerDeliveryId);
        storage.run("INSERT INTO turn (id, run_id, state) VALUES (?, ?, 'In flight')", id, runId);
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'turn-started', subjectId: id, destinationChatId: run.destinationChatId,
          outcome: 'started', toState: 'In flight',
        });
      });
    },

    finishTurn(id: string, origin: EventOrigin) {
      const run = getRun(storage, getTurn(storage, id).runId);
      return applyEvent(context, run.handoffId, origin, now => {
        if (getTurn(storage, id).state !== 'In flight') throw new Error('Turn is not in flight');
        storage.run("UPDATE turn SET state = 'Completed' WHERE id = ?", id);
        return appendEvent(storage, run.handoffId, origin, now, {
          kind: 'turn-finished', subjectId: id, destinationChatId: run.destinationChatId,
          outcome: 'completed', fromState: 'In flight', toState: 'Completed',
        });
      });
    },

    finishRun(id: string, origin: EventOrigin) {
      const { handoffId } = getRun(storage, id);
      return applyEvent(context, handoffId, origin, now => {
        const run = getRun(storage, id);
        if (run.state !== 'Running') throw new Error('Run is not active');
        if (storage.get("SELECT 1 FROM turn WHERE run_id = ? AND state = 'In flight'", id)) {
          throw new Error('Run has a turn in flight');
        }
        storage.run("UPDATE run SET state = 'Completed' WHERE id = ?", id);
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'run-finished', subjectId: id, destinationChatId: run.destinationChatId,
          outcome: 'completed', fromState: 'Running', toState: 'Completed',
        });
      });
    },
  };
}

export function interruptWork(storage: Storage, now: number) {
  const launches = storage.all<{ id: string; handoffId: string; destinationChatId: string }>(`
    SELECT id, handoff_id AS handoffId, destination_chat_id AS destinationChatId
    FROM run WHERE state = 'Starting' ORDER BY id
  `);
  for (const launch of launches) {
    const reason = 'restart-before-launch-outcome';
    storage.run("UPDATE run SET state = 'Interrupted', reason = ? WHERE id = ?", reason, launch.id);
    appendEvent(storage, launch.handoffId, bridgeOrigin, now, {
      kind: 'launch-interrupted', subjectId: launch.id, destinationChatId: launch.destinationChatId,
      fromState: 'Starting', toState: 'Interrupted', outcome: 'interrupted', reason,
    });
  }

  const turns = storage.all<{ id: string; handoffId: string; destinationChatId: string }>(`
    SELECT t.id, r.handoff_id AS handoffId, r.destination_chat_id AS destinationChatId
    FROM turn t JOIN run r ON r.id = t.run_id WHERE t.state = 'In flight' ORDER BY t.id
  `);
  for (const turn of turns) {
    const reason = 'restart-before-turn-outcome';
    storage.run("UPDATE turn SET state = 'Interrupted', reason = ? WHERE id = ?", reason, turn.id);
    appendEvent(storage, turn.handoffId, bridgeOrigin, now, {
      kind: 'turn-interrupted', subjectId: turn.id, destinationChatId: turn.destinationChatId,
      fromState: 'In flight', toState: 'Interrupted', outcome: 'interrupted', reason,
    });
  }
}
