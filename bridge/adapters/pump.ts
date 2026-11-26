import type { DeliveryState, openBridge } from '../src/index.ts';
import type { Storage } from '../src/storage.ts';
import { hasOperationInFlight } from '../src/work.ts';
import { chatRoute, providerOrigin, sameConnection, type ChatRoute } from './binding.ts';
import { inboxFrame, type ClaudeTransport } from './claude.ts';

export interface AdapterClock {
  now(): number;
  sleep(milliseconds: number): Promise<void>;
}

type Bridge = ReturnType<typeof openBridge>;
type Delivery = ReturnType<Bridge['getDelivery']>;
type PumpResult =
  | { status: 'idle' | 'disconnected' }
  | { status: 'chat-not-active' | 'blocked'; deliveryId: number }
  | { status: 'attempted'; deliveryId: number; state: DeliveryState };

const registrationWindowMs = 60_000;
const registrationPollMs = 1_000;

export function deliveryPump(
  bridge: Bridge, storage: Storage, clock: AdapterClock, active: () => ClaudeTransport | undefined,
) {
  async function observe(transport: ClaudeTransport, route: ChatRoute, delivery: Delivery) {
    const lookup = await transport.readReceipts(route, delivery.correlationId);
    if (lookup.status !== 'found') return;
    for (const receipt of lookup.value) {
      const disposition = bridge.recordReceipt(delivery.id, {
        ...receipt,
        destinationChatId: receipt.sessionRef === route.sessionRef ? route.chatId : '',
        evidence: receipt.itemId,
        origin: providerOrigin(route, 'receipt', JSON.stringify([
          receipt.kind, receipt.itemId, receipt.correlationId, receipt.attempt,
        ])),
      });
      if (!disposition.replayed && disposition.event.outcome === 'rejected') {
        throw new Error(`Claude receipt rejected (${disposition.event.reason})`);
      }
    }
  }

  async function registration(transport: ClaudeTransport, route: ChatRoute, delivery: Delivery) {
    const marker = { correlationId: delivery.correlationId, attempt: delivery.attempts + 1 };
    const origin = providerOrigin(route, 'wake', JSON.stringify(marker));
    const decision = storage.get<{ at: number; baseline: string | null }>(`
      SELECT occurred_at AS at, json_extract(payload, '$.generation') AS baseline
      FROM event WHERE source = ? AND source_id = ?
    `, origin.source, origin.sourceId);
    const lookup = () => {
      const current = transport.lookupRegistration(route);
      if (current && current.sessionRef !== route.sessionRef) {
        throw new Error('Claude registration belongs to another session');
      }
      return current;
    };
    let current = lookup();
    if (active() !== transport) return;
    if (current?.live && (!decision || (
      current.generation !== decision.baseline && current.registeredAt >= decision.at
    ))) return current;

    const startedAt = decision?.at ?? clock.now();
    const baseline = decision ? decision.baseline : current?.generation ?? null;
    if (!decision) {
      const recorded = bridge.recordEvent({
        handoffId: delivery.handoffId, origin, kind: 'observation', payload: { generation: baseline },
      });
      if (!recorded.replayed) transport.startChatTurn(route, marker);
    }

    const deadline = startedAt + registrationWindowMs;
    while (active() === transport && clock.now() < deadline) {
      bridge.expireDeliveries();
      current = lookup();
      const remaining = deadline - clock.now();
      if (remaining <= 0) break;
      if (current?.live && current.generation !== baseline && current.registeredAt >= startedAt) return current;
      await clock.sleep(Math.min(registrationPollMs, remaining));
    }
  }

  async function pump(): Promise<PumpResult> {
    bridge.expireDeliveries();
    const transport = active();
    if (!transport) return { status: 'disconnected' };

    const attempted = storage.all<{ id: number }>(`
      SELECT d.id FROM delivery d JOIN chat_reference c ON d.destination_chat_id = c.id
      WHERE c.connection_id = ? AND d.attempts > 0 ORDER BY d.id
    `, transport.binding.connectionId);
    for (const { id } of attempted) {
      if (active() !== transport) return { status: 'disconnected' };
      const delivery = bridge.getDelivery(id);
      const route = chatRoute(storage, delivery.destinationChatId);
      if (route.provider === 'claude' && sameConnection(route, transport.binding)) {
        await observe(transport, route, delivery);
      }
    }
    bridge.expireDeliveries();

    for (const pending of bridge.listPendingDeliveries()) {
      if (active() !== transport) return { status: 'disconnected' };
      const route = chatRoute(storage, pending.destinationChatId);
      if (route.provider !== 'claude' || !sameConnection(route, transport.binding)) continue;
      // Wake can start a turn, so apply the core's slot and question checks before waking.
      if (hasOperationInFlight(storage, pending.handoffId, pending.destinationChatId)) {
        return { status: 'blocked', deliveryId: pending.id };
      }
      if (storage.get(`
        SELECT 1 FROM question q JOIN run r ON r.id = q.run_id
        WHERE (q.reply_event_id = ? OR q.answer_event_id = ?)
          AND (r.state <> 'Running' OR (q.reply_event_id = ?
            AND (q.answer_event_id IS NOT NULL OR q.expires_at <= ?)))
      `, pending.eventId, pending.eventId, pending.eventId, clock.now())) continue;

      const ready = await registration(transport, route, pending);
      bridge.expireDeliveries();
      if (active() !== transport) return { status: 'disconnected' };
      if (pending.attempts > 0) {
        // The original attempt can arrive while its explicit resend waits for registration.
        await observe(transport, route, pending);
        if (active() !== transport) return { status: 'disconnected' };
        if (bridge.getDelivery(pending.id).state === 'Delivered to chat') continue;
      }
      if (!ready) return { status: 'chat-not-active', deliveryId: pending.id };
      const claim = bridge.claimDelivery(pending.id, true);
      if (!claim) return { status: 'blocked', deliveryId: pending.id };
      const { correlationId, attempts: attempt } = claim;
      const signal = await transport.send(route, ready, inboxFrame({ correlationId, attempt }, claim.payload));
      if (signal !== 'written' && signal !== 'unconfirmed') throw new Error('Unknown Claude transport signal');

      const current = bridge.getDelivery(claim.id);
      if (signal === 'written' && current.inFlight && current.deadlineAt !== null && current.deadlineAt > clock.now()) {
        const recorded = bridge.recordTransport(claim.id, {
          attempt, state: 'Accepted by transport', evidence: 'Claude inbox write completed',
          origin: providerOrigin(route, 'write', JSON.stringify([correlationId, attempt])),
        });
        if (recorded.event.outcome === 'rejected') {
          throw new Error(`Claude transport signal rejected (${recorded.event.reason})`);
        }
      }
      if (active() === transport) await observe(transport, route, claim);
      bridge.expireDeliveries();
      return { status: 'attempted', deliveryId: claim.id, state: bridge.getDelivery(claim.id).state };
    }
    return { status: active() === transport ? 'idle' : 'disconnected' };
  }

  let inFlight: Promise<PumpResult> | undefined;
  return function pumpDeliveries() {
    inFlight ??= pump().finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
