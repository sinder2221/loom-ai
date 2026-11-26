import { approvalOperations } from './approvals.ts';
import { deliveryOperations, expireDeliveries } from './deliveries.ts';
import {
  appendEvent, appendWithIntent, applyEvent, assertProjectChat, audit, getHandoff, positiveInteger,
  type Context, type EventOrigin, type Json, type OutboundIntent,
} from './events.ts';
import { questionOperations } from './questions.ts';
import { assertReplacementLaunchIntent, replacementOperations } from './replacement.ts';
import { codexInputOperations } from './codex-input.ts';
import { activeRunId } from './ownership.ts';
import { captureOperations } from './capture.ts';
import { exportHandoff } from './export.ts';
import { activityOperations } from './activity.ts';
import { projectOperations } from './projects.ts';
import { openStorage } from './storage.ts';
import { interruptWork, workOperations } from './work.ts';

export type { DeliveryState } from './deliveries.ts';
export type { AuditRow, EventOrigin, Json, OutboundIntent } from './events.ts';

interface BridgeOptions {
  now?: () => number;
  receiptWindowMs?: number;
  automaticTurnLimit?: number;
  exportSecretCheck?: (text: string) => boolean;
}

export function openBridge(path: string, options: BridgeOptions = {}) {
  const { now = Date.now, receiptWindowMs = 60_000, automaticTurnLimit = 5 } = options;
  positiveInteger(receiptWindowMs, 'receipt window');
  positiveInteger(automaticTurnLimit, 'automatic turn limit');
  const storage = openStorage(path);
  const context: Context = { storage, now, receiptWindowMs, automaticTurnLimit };

  try {
    storage.transaction(() => {
      const startupTime = now();
      interruptWork(storage, startupTime);
      expireDeliveries(storage, startupTime, true);
    });
  } catch (error) {
    storage.close();
    throw error;
  }

  return {
    close: storage.close,
    ...projectOperations(context),
    ...activityOperations(context),
    createProject(id: string, name: string) {
      storage.run('INSERT INTO project (id, name) VALUES (?, ?)', id, name);
    },
    createConnection(id: string, projectId: string, provider: string, accountRef: string) {
      storage.run(
        'INSERT INTO connection (id, project_id, provider, account_ref) VALUES (?, ?, ?, ?)',
        id, projectId, provider, accountRef,
      );
    },
    registerChat(id: string, connectionId: string, sessionRef: string) {
      storage.run(
        'INSERT INTO chat_reference (id, connection_id, session_ref) VALUES (?, ?, ?)',
        id, connectionId, sessionRef,
      );
    },
    createHandoff(input: {
      id: string; projectId: string; originChatId: string; title?: string; brief: string; origin: EventOrigin;
    }) {
      const { id, projectId, originChatId, title = 'Untitled handoff', brief, origin } = input;
      return applyEvent(context, id, origin, now => {
        assertProjectChat(storage, originChatId, projectId);
        storage.run(`
          INSERT INTO handoff (id, project_id, origin_chat_id, title, brief, automatic_turn_limit)
          VALUES (?, ?, ?, ?, ?, ?)
        `, id, projectId, originChatId, title, brief, context.automaticTurnLimit);
        return appendEvent(storage, id, origin, now, {
          kind: 'handoff-requested', subjectId: id, destinationChatId: originChatId, outcome: 'accepted',
        });
      });
    },
    getHandoff: (id: string) => getHandoff(storage, id),
    audit: (handoffId: string) => audit(storage, handoffId),
    exportHandoff: (handoffId: string) => exportHandoff(storage, handoffId, options.exportSecretCheck),

    recordEvent(input: {
      handoffId: string; origin: EventOrigin; kind: 'observation' | 'result'; payload?: Json;
      intent?: OutboundIntent; runId?: string;
    }) {
      const { handoffId, origin, kind, payload, intent, runId } = input;
      return applyEvent(context, handoffId, origin, now => {
        if (kind !== 'observation' && kind !== 'result') throw new Error('Unsupported event kind');
        if (kind === 'observation') assertReplacementLaunchIntent(storage, handoffId, origin, payload);
        if (runId && !storage.get('SELECT 1 FROM run WHERE id = ? AND handoff_id = ?', runId, handoffId)) {
          throw new Error('Run is outside the handoff');
        }
        if (kind === 'result' && !runId && storage.get(`
          SELECT 1 FROM run WHERE handoff_id = ? AND superseded_by IS NOT NULL
        `, handoffId)) return appendEvent(storage, handoffId, origin, now, {
          kind, payload, outcome: 'review', reason: 'result-run-unbound',
        });
        const fields = { kind, payload, runId, outcome: 'recorded' };
        if (kind === 'result' && runId && runId !== activeRunId(storage, handoffId)) {
          return appendEvent(storage, handoffId, origin, now, {
            ...fields, outcome: 'historical', reason: 'run-inactive',
          });
        }
        return intent
          ? appendWithIntent(storage, handoffId, origin, now, fields, intent)
          : appendEvent(storage, handoffId, origin, now, fields);
      });
    },
    ...deliveryOperations(context),
    ...questionOperations(context),
    ...workOperations(context),
    ...approvalOperations(context),
    ...replacementOperations(context),
    ...codexInputOperations(context),
    ...captureOperations(context),
  };
}
