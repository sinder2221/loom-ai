import {
  appendEvent, appendWithIntent, applyEvent, bridgeOrigin, getHandoff, requireText,
  type Context, type EventOrigin, type Json, type OutboundIntent,
} from './events.ts';
import { skipDelivery } from './deliveries.ts';
import type { Storage } from './storage.ts';

interface ConsentScope {
  projectId: string;
  connectionId: string;
}

interface SourceTarget extends ConsentScope {
  sourceChatId: string;
  itemRef: string;
}

function sourceLink(storage: Storage, handoffId: string, linkId: number) {
  return storage.get<SourceTarget & { deletedAt: number | null }>(`
    SELECT h.project_id AS projectId, c.connection_id AS connectionId, l.source_chat_id AS sourceChatId,
           l.item_ref AS itemRef, l.deleted_at AS deletedAt
    FROM source_link l JOIN handoff h ON h.id = l.handoff_id
    JOIN chat_reference c ON c.id = l.source_chat_id
    WHERE l.handoff_id = ? AND l.id = ?
  `, handoffId, linkId);
}

export function captureGrant(storage: Storage, scope: ConsentScope) {
  const { projectId, connectionId } = scope;
  return storage.get<{ granted: number; generation: number; changedAt: number }>(`
    SELECT granted, generation, changed_at AS changedAt FROM capture_consent
    WHERE project_id = ? AND connection_id = ?
  `, projectId, connectionId);
}

export function linkSourceItem(storage: Storage, handoffId: string, sourceChatId: string, itemRef: string) {
  storage.run(`
    INSERT INTO source_link (handoff_id, source_chat_id, item_ref) VALUES (?, ?, ?)
    ON CONFLICT (handoff_id, source_chat_id, item_ref) DO NOTHING
  `, handoffId, sourceChatId, itemRef);
  return storage.get<{ id: number }>(`
    SELECT id FROM source_link WHERE handoff_id = ? AND source_chat_id = ? AND item_ref = ?
  `, handoffId, sourceChatId, itemRef)!.id;
}

export function attachCapturedCopy(storage: Storage, eventId: number, sourceLinkId: number, generation: number) {
  storage.run(`
    INSERT INTO captured_delivery (delivery_id, source_link_id, consent_generation)
    SELECT id, ?, ? FROM delivery WHERE event_id = ?
  `, sourceLinkId, generation, eventId);
}

const directInput = `
  FROM delivery d JOIN event e ON e.id = d.event_id JOIN handoff h ON h.id = e.handoff_id
  JOIN run r ON r.id = e.run_id
  JOIN chat_reference c ON c.id = r.destination_chat_id
  WHERE e.kind = 'native-input'`;

export function revokedCapture(storage: Storage, deliveryId: number) {
  return !!storage.get(`
    SELECT 1 FROM captured_delivery d JOIN source_link l ON l.id = d.source_link_id
    JOIN handoff h ON h.id = l.handoff_id JOIN chat_reference c ON c.id = l.source_chat_id
    LEFT JOIN capture_consent g ON g.project_id = h.project_id AND g.connection_id = c.connection_id
    WHERE d.delivery_id = ? AND (g.generation IS NULL OR g.generation <> d.consent_generation OR g.granted = 0)
    UNION ALL
    SELECT 1 ${directInput} AND d.id = ? AND EXISTS (
      SELECT 1 FROM capture_consent g
      WHERE g.project_id = h.project_id AND g.connection_id = c.connection_id AND g.granted = 0
    )
  `, deliveryId, deliveryId);
}

// These operations belong to the trusted host that collects consent and verifies exact source items.
export function captureOperations(context: Context) {
  const { storage, now } = context;
  return {
    getCaptureConsent(scope: ConsentScope) {
      const grant = captureGrant(storage, scope);
      return { granted: grant?.granted === 1, changedAt: grant?.changedAt ?? null };
    },

    setCaptureConsent(scope: ConsentScope, granted: boolean) {
      const { projectId, connectionId } = scope;
      if (typeof granted !== 'boolean') throw new Error('Invalid capture consent');
      storage.transaction(() => {
        if (!storage.get('SELECT 1 FROM connection WHERE project_id = ? AND id = ?', projectId, connectionId)) {
          throw new Error('Connection is outside the project');
        }
        const at = now();
        if (!granted || captureGrant(storage, scope)?.granted === 0) {
          // Include older direct updates queued before revocation started marking them.
          const deliveries = storage.all<{ id: number }>(`
            SELECT d.id ${directInput} AND h.project_id = ? AND c.connection_id = ?
              AND d.state <> 'Delivered to chat' AND d.skip_reason IS NULL ORDER BY d.id
          `, projectId, connectionId);
          for (const { id } of deliveries) skipDelivery(storage, id, at, 'capture-consent-revoked');
        }
        // A fresh grant advances the generation so it cannot revive captures from a revoked grant.
        storage.run(`
          INSERT INTO capture_consent (project_id, connection_id, granted, generation, changed_at)
          VALUES (?, ?, ?, 1, ?)
          ON CONFLICT (project_id, connection_id) DO UPDATE SET granted = excluded.granted,
            generation = capture_consent.generation + excluded.granted, changed_at = excluded.changed_at
          WHERE capture_consent.granted <> excluded.granted
        `, projectId, connectionId, Number(granted), at);
      });
    },

    linkSource(input: { handoffId: string; sourceChatId: string; itemRef: string }) {
      const { handoffId, sourceChatId, itemRef } = input;
      requireText(itemRef, 'source item reference');
      return storage.transaction(() => {
        const handoff = getHandoff(storage, handoffId);
        if (sourceChatId !== handoff.originChatId && !storage.get(`
          SELECT 1 FROM run WHERE handoff_id = ? AND destination_chat_id = ?
        `, handoffId, sourceChatId)) throw new Error('Source chat is outside the handoff');
        return linkSourceItem(storage, handoffId, sourceChatId, itemRef);
      });
    },

    markSourceDeleted(handoffId: string, linkId: number) {
      return storage.transaction(() => {
        const link = sourceLink(storage, handoffId, linkId);
        if (!link || link.deletedAt !== null) return false;
        const at = now();
        storage.run('UPDATE source_link SET deleted_at = ? WHERE id = ?', at, linkId);
        appendEvent(storage, handoffId, bridgeOrigin, at, {
          kind: 'source-link-unavailable', subjectId: String(linkId), outcome: 'unavailable', reason: 'source-deleted',
        });
        return true;
      });
    },

    async resolveSourceLink(
      handoffId: string, linkId: number, lookup: (source: SourceTarget) => Json | undefined | Promise<Json | undefined>,
    ) {
      const link = sourceLink(storage, handoffId, linkId);
      if (!link) return { outcome: 'unavailable', reason: 'source-link-unknown' } as const;
      const { deletedAt, ...target } = link;
      if (deletedAt !== null) return { outcome: 'unavailable', reason: 'source-deleted' } as const;
      let content: Json | undefined;
      try {
        content = await lookup(target);
      } catch {
        content = undefined;
      }
      const current = sourceLink(storage, handoffId, linkId);
      if (!current) return { outcome: 'unavailable', reason: 'source-link-unknown' } as const;
      if (current.deletedAt !== null) return { outcome: 'unavailable', reason: 'source-deleted' } as const;
      if (content === undefined) return { outcome: 'unavailable', reason: 'source-unavailable' } as const;
      return { outcome: 'resolved', content } as const;
    },

    recordCapturedUpdate(input: {
      handoffId: string; sourceLinkId: number; payload: Json; intent: OutboundIntent; origin: EventOrigin;
    }) {
      const { handoffId, sourceLinkId, payload, intent, origin } = input;
      return applyEvent(context, handoffId, origin, at => {
        const link = sourceLink(storage, handoffId, sourceLinkId);
        const grant = link && captureGrant(storage, link);
        const fields = { kind: 'captured-update', subjectId: String(sourceLinkId) };
        const reason = !link ? 'source-link-unknown' : link.deletedAt !== null ? 'source-deleted'
          : grant?.granted !== 1 ? 'capture-consent-required' : undefined;
        if (reason) return appendEvent(storage, handoffId, origin, at, {
          ...fields, outcome: 'rejected', reason,
        });
        const id = appendWithIntent(storage, handoffId, origin, at, { ...fields, outcome: 'recorded', payload }, intent);
        attachCapturedCopy(storage, id, sourceLinkId, grant!.generation);
        return id;
      });
    },
  };
}
