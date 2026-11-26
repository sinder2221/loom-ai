import type { Storage } from './storage.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export interface EventOrigin {
  actor: string;
  scope: string;
  source: string;
  sourceId: string;
}

type Origin = EventOrigin | Omit<EventOrigin, 'sourceId'>;
export const bridgeOrigin: Origin = { actor: 'bridge', scope: 'handoff', source: 'bridge' };

export interface OutboundIntent {
  destinationChatId: string;
  correlationId: string;
}

export interface Context {
  storage: Storage;
  now: () => number;
  receiptWindowMs: number;
  automaticTurnLimit: number;
}

interface EventFields {
  kind: string;
  outcome: string;
  reason?: string;
  subjectId?: string;
  fromState?: string;
  toState?: string;
  attempt?: number;
  deliveryId?: number;
  destinationChatId?: string;
  correlationId?: string;
  payload?: Json;
  runId?: string;
}

export interface AuditRow {
  id: number;
  handoffId: string;
  actor: string;
  scope: string;
  source: string;
  sourceId: string | null;
  kind: string;
  occurredAt: number;
  subjectId: string | null;
  destinationChatId: string | null;
  correlationId: string | null;
  deliveryId: number | null;
  fromState: string | null;
  toState: string | null;
  attempt: number | null;
  outcome: string;
  reason: string | null;
  receiptEvidence: string | null;
  late: number | null;
  runId: string | null;
}

const auditSelect = `
  SELECT e.id, e.handoff_id AS handoffId, e.actor, e.scope, e.source, e.source_id AS sourceId,
         e.kind, e.occurred_at AS occurredAt, e.subject_id AS subjectId,
         e.destination_chat_id AS destinationChatId, e.correlation_id AS correlationId,
         COALESCE(e.delivery_id, d.id) AS deliveryId, e.from_state AS fromState, e.to_state AS toState,
         e.attempt, e.outcome, e.reason, r.evidence AS receiptEvidence, r.late, e.run_id AS runId
  FROM event e
  LEFT JOIN delivery d ON d.event_id = e.id AND d.destination_chat_id = e.destination_chat_id
  LEFT JOIN receipt r ON r.event_id = e.id`;

export function audit(storage: Storage, handoffId: string): AuditRow[] {
  return storage.all<AuditRow>(`${auditSelect} WHERE e.handoff_id = ? ORDER BY e.id`, handoffId);
}

// The callback runs under the same lock as source-ID deduplication and the audit write.
export function applyEvent(
  context: Context,
  handoffId: string,
  origin: EventOrigin,
  apply: (now: number) => number,
) {
  requireText(origin.source, 'event source');
  requireText(origin.sourceId, 'source ID');
  requireText(origin.actor, 'actor');
  requireText(origin.scope, 'event scope');

  const { storage } = context;
  return storage.transaction(() => {
    const previous = storage.get<AuditRow>(
      `${auditSelect} WHERE e.source = ? AND e.source_id = ?`, origin.source, origin.sourceId,
    );
    if (previous) {
      if (previous.handoffId !== handoffId) throw new Error('Source ID belongs to a different handoff');
      return { event: previous, replayed: true };
    }

    const id = apply(context.now());
    return { event: storage.get<AuditRow>(`${auditSelect} WHERE e.id = ?`, id)!, replayed: false };
  });
}

export function appendEvent(
  storage: Storage,
  handoffId: string,
  origin: Origin,
  now: number,
  fields: EventFields,
): number {
  return storage.run(`
    INSERT INTO event (
      handoff_id, actor, scope, source, source_id, occurred_at, kind, outcome, reason, subject_id,
      from_state, to_state, attempt, delivery_id, destination_chat_id, correlation_id, payload, run_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `, handoffId, origin.actor, origin.scope, origin.source, 'sourceId' in origin ? origin.sourceId : null,
  now, fields.kind, fields.outcome, fields.reason ?? null, fields.subjectId ?? null,
  fields.fromState ?? null, fields.toState ?? null, fields.attempt ?? null, fields.deliveryId ?? null,
  fields.destinationChatId ?? null, fields.correlationId ?? null,
  fields.payload === undefined ? null : JSON.stringify(fields.payload), fields.runId ?? null);
}

export function appendWithIntent(
  storage: Storage,
  handoffId: string,
  origin: EventOrigin,
  now: number,
  fields: EventFields,
  intent: OutboundIntent,
): number {
  requireText(intent.correlationId, 'correlation ID');
  assertProjectChat(storage, intent.destinationChatId, getHandoff(storage, handoffId).projectId);
  const eventId = appendEvent(storage, handoffId, origin, now, {
    ...fields, ...intent, toState: 'Queued', attempt: 0,
  });
  storage.run(`
    INSERT INTO delivery (handoff_id, event_id, destination_chat_id, correlation_id)
    VALUES (?, ?, ?, ?)
  `, handoffId, eventId, intent.destinationChatId, intent.correlationId);
  return eventId;
}

export function getHandoff(storage: Storage, id: string) {
  const handoff = storage.get<{
    projectId: string; originChatId: string; brief: string; automaticTurns: number; automaticTurnLimit: number;
  }>(`
    SELECT project_id AS projectId, origin_chat_id AS originChatId, brief,
           automatic_turns AS automaticTurns, automatic_turn_limit AS automaticTurnLimit
    FROM handoff WHERE id = ?
  `, id);
  if (!handoff) throw new Error('Unknown handoff');
  return handoff;
}

export function assertProjectChat(storage: Storage, chatId: string, projectId: string) {
  if (!storage.get(`
    SELECT 1 FROM chat_reference c JOIN connection n ON n.id = c.connection_id
    WHERE c.id = ? AND n.project_id = ?
  `, chatId, projectId)) throw new Error('Chat is outside the handoff project');
}

export function requireText(value: string, field: string) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${field}`);
}

export function positiveInteger(value: number, field: string) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${field} must be a positive integer`);
}
