import type { Json } from '../src/index.ts';
import type { ChatTarget, ConnectionBinding, Lookup } from './binding.ts';

export interface ClaudeRegistration {
  readonly sessionRef: string;
  readonly generation: string;
  readonly registeredAt: number;
  readonly live: boolean;
}

export interface DeliveryMarker {
  correlationId: string;
  attempt: number;
}

// Normalized by the probe-level transcript observer. An item ID is stable across reads.
// Received is a peer inbound turn. Acted is a reply echoing the same marker.
export interface ClaudeReceipt extends DeliveryMarker {
  kind: 'Received' | 'Acted';
  sessionRef: string;
  itemId: string;
}

export interface ClaudeTransport {
  // An instance only operates under this authenticated connection, including after a switch.
  readonly binding: ConnectionBinding;
  // Returns the most recent registration, including a stale generation if available.
  lookupRegistration(target: ChatTarget): ClaudeRegistration | undefined;
  // Initiates the wake request. Registration observation supplies confirmation.
  startChatTurn(target: ChatTarget, marker: DeliveryMarker): void;
  // Revalidate the target and generation at write time. Socket failure can be ambiguous.
  send(target: ChatTarget, registration: ClaudeRegistration, frame: string): Promise<'written' | 'unconfirmed'>;
  readReceipts(target: ChatTarget, correlationId: string): Promise<Lookup<readonly ClaudeReceipt[]>>;
}

export function inboxFrame(marker: DeliveryMarker, payload: Json): string {
  const content = `Loom delivery ${JSON.stringify(marker)}\n${JSON.stringify(payload)}`;
  return JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n';
}
