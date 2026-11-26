import {
  appendEvent, applyEvent, bridgeOrigin, type Context, type EventOrigin, type Json,
} from './events.ts';
import { revokedCapture } from './capture.ts';
import type { Storage } from './storage.ts';
import { hasOperationInFlight } from './work.ts';

export type DeliveryState =
  | 'Queued' | 'Accepted by transport' | 'Held for approval'
  | 'Delivered to chat' | 'Refused' | 'Needs verification';

type TransportState = 'Accepted by transport' | 'Held for approval' | 'Refused';
type ReceiptKind = 'Received' | 'Acted';

interface Delivery {
  id: number;
  handoffId: string;
  eventId: number;
  destinationChatId: string;
  correlationId: string;
  state: DeliveryState;
  attempts: number;
  inFlight: number;
  deadlineAt: number | null;
  lastError: string | null;
  skipReason: string | null;
}

const columns = `id, handoff_id AS handoffId, event_id AS eventId,
  destination_chat_id AS destinationChatId, correlation_id AS correlationId,
  state, attempts, in_flight AS inFlight, deadline_at AS deadlineAt, last_error AS lastError, skip_reason AS skipReason`;

const transportTransitions: Partial<Record<DeliveryState, readonly TransportState[]>> = {
  Queued: ['Accepted by transport', 'Held for approval', 'Refused'],
  'Accepted by transport': ['Held for approval', 'Refused'],
  'Held for approval': ['Refused'],
};

function hasEvidence(evidence: string) {
  return typeof evidence === 'string' && evidence.trim() !== '';
}

function getDelivery(storage: Storage, id: number): Delivery {
  const delivery = storage.get<Delivery>(`SELECT ${columns} FROM delivery WHERE id = ?`, id);
  if (!delivery) throw new Error('Unknown delivery');
  return delivery;
}

function deliveryEvent(delivery: Delivery) {
  return {
    deliveryId: delivery.id,
    destinationChatId: delivery.destinationChatId,
    correlationId: delivery.correlationId,
    fromState: delivery.state,
    attempt: delivery.attempts,
  };
}

function settleDelivery(
  storage: Storage, delivery: Delivery, state: DeliveryState, reason: string | null,
) {
  storage.run('UPDATE delivery SET state = ?, in_flight = 0, last_error = ? WHERE id = ?',
    state, reason, delivery.id);
}

function markUnverified(storage: Storage, delivery: Delivery, now: number, restart = false) {
  const reason = restart ? 'restart-before-delivery-outcome' : 'receipt-window-elapsed';
  settleDelivery(storage, delivery, 'Needs verification', reason);
  appendEvent(storage, delivery.handoffId, bridgeOrigin, now, {
    ...deliveryEvent(delivery), kind: restart ? 'delivery-interrupted' : 'delivery-timeout',
    toState: 'Needs verification', outcome: 'needs-verification', reason,
  });
}

function observeDeadline(storage: Storage, id: number, now: number): Delivery {
  const delivery = getDelivery(storage, id);
  if (delivery.inFlight && delivery.deadlineAt !== null && now >= delivery.deadlineAt) {
    markUnverified(storage, delivery, now);
    return getDelivery(storage, id);
  }
  return delivery;
}

export function expireDeliveries(storage: Storage, now: number, restart = false) {
  const candidates = storage.all<Delivery>(`
    SELECT ${columns} FROM delivery WHERE in_flight = 1 AND (? = 1 OR deadline_at <= ?) ORDER BY id
  `, Number(restart), now);
  for (const delivery of candidates) markUnverified(storage, delivery, now, restart);
  return candidates.length;
}

export function skipDelivery(storage: Storage, id: number, now: number, reason: string) {
  const delivery = getDelivery(storage, id);
  if (delivery.skipReason || delivery.state === 'Delivered to chat') return;
  storage.run('UPDATE delivery SET skip_reason = ? WHERE id = ?', reason, id);
  appendEvent(storage, delivery.handoffId, bridgeOrigin, now, {
    ...deliveryEvent(delivery), kind: 'delivery-skipped', outcome: 'skipped', reason,
  });
}

// Called within the caller's transaction, so answer reconciliation and claim are one decision.
export function claimQueuedDelivery(
  context: Context, id: number, now: number, runtimeReady: boolean, reconciledRunId?: string,
) {
  const { storage } = context;
  const delivery = getDelivery(storage, id);
  if (delivery.state !== 'Queued' || delivery.inFlight || delivery.skipReason) return undefined;
  if (revokedCapture(storage, id)) {
    skipDelivery(storage, id, now, 'capture-consent-revoked');
    return undefined;
  }
  if (!runtimeReady || hasOperationInFlight(storage, delivery.handoffId, delivery.destinationChatId)) return undefined;

  const message = storage.get<{
    payload: string | null; runState: string | null; expiresAt: number | null;
    replyEventId: number | null; answerEventId: number | null; runId: string | null;
    stopState: string | null; provider: string | null; activeRunId: string | null;
  }>(`
    SELECT e.payload, r.state AS runState, q.expires_at AS expiresAt,
           q.reply_event_id AS replyEventId, q.answer_event_id AS answerEventId,
           r.id AS runId, r.stop_state AS stopState, n.provider, h.active_run_id AS activeRunId
    FROM event e JOIN handoff h ON e.handoff_id = h.id
    LEFT JOIN question q ON e.id = q.reply_event_id OR e.id = q.answer_event_id
    LEFT JOIN run r ON r.id = q.run_id
    LEFT JOIN chat_reference c ON c.id = r.destination_chat_id
    LEFT JOIN connection n ON n.id = c.connection_id
    WHERE e.id = ?
  `, delivery.eventId)!;
  if (message.runId && (message.runState !== 'Running' || message.runId !== message.activeRunId || message.stopState)) {
    return undefined;
  }
  if (message.replyEventId === delivery.eventId && (
    message.answerEventId !== null || now >= message.expiresAt!
  )) return undefined;
  if (message.answerEventId === delivery.eventId && message.provider === 'codex' && (
    message.runId !== reconciledRunId || now >= message.expiresAt! || delivery.attempts !== 0
  )) return undefined;
  if (reconciledRunId && (message.runId !== reconciledRunId || message.answerEventId !== delivery.eventId)) {
    return undefined;
  }

  storage.run(`
    UPDATE delivery SET attempts = attempts + 1, in_flight = 1, deadline_at = ? WHERE id = ?
  `, now + context.receiptWindowMs, id);
  const claimed = getDelivery(storage, id);
  appendEvent(storage, delivery.handoffId, bridgeOrigin, now, {
    ...deliveryEvent(claimed), kind: 'delivery-claimed', toState: 'Queued', outcome: 'claimed',
  });
  return { ...claimed, payload: message.payload === null ? null : JSON.parse(message.payload) as Json };
}

export function deliveryOperations(context: Context) {
  const { storage } = context;

  return {
    getDelivery: (id: number) => getDelivery(storage, id),
    findDelivery: (correlationId: string) => storage.get<Delivery>(
      `SELECT ${columns} FROM delivery WHERE correlation_id = ?`, correlationId,
    ),
    listPendingDeliveries: () => storage.all<Delivery>(`
      SELECT ${columns} FROM delivery WHERE state = 'Queued' AND in_flight = 0 AND skip_reason IS NULL ORDER BY id
    `),

    claimDelivery(id: number, runtimeReady: boolean) {
      return storage.transaction(() => claimQueuedDelivery(context, id, context.now(), runtimeReady));
    },

    recordTransport(
      id: number,
      observation: { attempt: number; state: TransportState; evidence: string; origin: EventOrigin },
    ) {
      const { state, attempt, evidence, origin } = observation;
      return applyEvent(context, getDelivery(storage, id).handoffId, origin, now => {
        const delivery = observeDeadline(storage, id, now);
        const fields = { ...deliveryEvent(delivery), attempt, kind: 'transport-observed' };
        const rejection = !transportTransitions[delivery.state]?.includes(state) ? 'illegal-transition'
          : !delivery.inFlight || delivery.attempts !== attempt ? 'stale-or-unclaimed-attempt'
          : !hasEvidence(evidence) ? 'missing-transport-evidence' : undefined;
        if (rejection) return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: rejection,
        });

        if (state === 'Refused') {
          settleDelivery(storage, delivery, state, evidence);
        } else {
          storage.run('UPDATE delivery SET state = ?, last_error = NULL WHERE id = ?', state, id);
        }
        return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, toState: state, outcome: 'recorded', reason: evidence,
        });
      });
    },

    recordReceipt(
      id: number,
      receipt: OutboundReceipt,
    ) {
      const { kind, correlationId, destinationChatId, attempt, evidence, origin } = receipt;
      return applyEvent(context, getDelivery(storage, id).handoffId, origin, now => {
        const delivery = observeDeadline(storage, id, now);
        const validAttempt = Number.isSafeInteger(attempt) && attempt > 0 && attempt <= delivery.attempts;
        const terminalState = validAttempt ? storage.get<{ state: 'Needs verification' | 'Refused' }>(`
          SELECT to_state AS state FROM event WHERE delivery_id = ? AND attempt = ?
            AND (to_state = 'Needs verification'
              OR (kind = 'transport-observed' AND outcome = 'recorded' AND to_state = 'Refused'))
        `, id, attempt)?.state : undefined;
        const unverifiedAttempt = terminalState === 'Needs verification';
        const fields = { ...deliveryEvent(delivery), attempt: validAttempt ? attempt : undefined, kind: 'receipt-observed' };
        const rejection = correlationId !== delivery.correlationId || destinationChatId !== delivery.destinationChatId
          ? 'receipt-mismatch'
          : !hasEvidence(evidence) || (kind !== 'Received' && kind !== 'Acted') ? 'missing-receipt-evidence'
          : delivery.attempts === 0 ? 'unclaimed-delivery'
          : terminalState === 'Refused' ? 'receipt-attempt-refused'
          : !validAttempt || (attempt !== delivery.attempts && !unverifiedAttempt) ? 'receipt-attempt-mismatch' : undefined;
        if (rejection) return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: rejection,
        });
        if (storage.get('SELECT 1 FROM receipt WHERE delivery_id = ? AND kind = ?', id, kind)) {
          return appendEvent(storage, delivery.handoffId, origin, now, {
            ...fields, outcome: kind === 'Received' ? 'rejected' : 'ignored', reason: 'duplicate-receipt',
          });
        }

        const late = kind === 'Received' && unverifiedAttempt;
        const eventId = appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, kind: late ? 'late-delivery' : 'receipt-observed',
          outcome: kind, toState: kind === 'Received' ? 'Delivered to chat' : undefined,
        });
        storage.run(`
          INSERT INTO receipt (delivery_id, kind, destination_chat_id, correlation_id, event_id, evidence, late)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `, id, kind, destinationChatId, correlationId, eventId, evidence, Number(late));
        if (kind === 'Received') settleDelivery(storage, delivery, 'Delivered to chat', null);
        return eventId;
      });
    },

    resendDelivery(id: number, origin: EventOrigin) {
      return applyEvent(context, getDelivery(storage, id).handoffId, origin, now => {
        const delivery = observeDeadline(storage, id, now);
        const fields = { ...deliveryEvent(delivery), kind: 'delivery-resend' };
        if (delivery.skipReason) return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: delivery.skipReason,
        });
        if (storage.get(`
          SELECT 1 FROM question q JOIN run r ON r.id = q.run_id
          JOIN chat_reference c ON c.id = r.destination_chat_id JOIN connection n ON n.id = c.connection_id
          WHERE q.answer_event_id = ? AND n.provider = 'codex'
        `, delivery.eventId)) return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: 'answer-needs-reconciliation',
        });
        if (delivery.state !== 'Needs verification' && delivery.state !== 'Refused') {
          return appendEvent(storage, delivery.handoffId, origin, now, {
            ...fields, outcome: 'rejected', reason: 'illegal-transition',
          });
        }
        settleDelivery(storage, delivery, 'Queued', null);
        return appendEvent(storage, delivery.handoffId, origin, now, {
          ...fields, toState: 'Queued', outcome: 'requeued',
        });
      });
    },

    expireDeliveries: () => storage.transaction(() => expireDeliveries(storage, context.now())),
  };
}

interface OutboundReceipt {
  kind: ReceiptKind;
  correlationId: string;
  attempt: number;
  destinationChatId: string;
  evidence: string;
  origin: EventOrigin;
}
