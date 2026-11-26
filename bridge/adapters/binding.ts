import type { EventOrigin } from '../src/index.ts';
import type { Storage } from '../src/storage.ts';

export interface ConnectionBinding {
  readonly connectionId: string;
  readonly accountRef: string;
}

export interface ChatTarget extends ConnectionBinding {
  readonly chatId: string;
  readonly sessionRef: string;
}

export interface ChatRoute extends ChatTarget {
  readonly provider: string;
}

export type Lookup<T> =
  | { status: 'found'; value: T }
  | { status: 'not-found' | 'unknown' };

export function chatRoute(storage: Storage, chatId: string): ChatRoute {
  const route = storage.get<ChatRoute>(`
    SELECT c.id AS chatId, c.session_ref AS sessionRef,
           n.id AS connectionId, n.account_ref AS accountRef, n.provider
    FROM chat_reference c JOIN connection n ON c.connection_id = n.id WHERE c.id = ?
  `, chatId);
  if (!route) throw new Error('Unknown chat route');
  return route;
}

export function sameConnection(left: ConnectionBinding, right: ConnectionBinding) {
  return left.connectionId === right.connectionId && left.accountRef === right.accountRef;
}

export function providerOrigin(route: ChatRoute, kind: string, sourceId: string): EventOrigin {
  return {
    actor: route.provider, scope: 'handoff',
    source: JSON.stringify(['provider-adapter', kind, route.connectionId, route.chatId]), sourceId,
  };
}
