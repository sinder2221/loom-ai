import { setTimeout as sleep } from 'node:timers/promises';
import { openBridge } from '../src/index.ts';
import { openStorage } from '../src/storage.ts';
import type { ClaudeTransport } from './claude.ts';
import type { CodexTransport } from './codex-protocol.ts';
import { codexAdapter } from './codex.ts';
import { deliveryPump, type AdapterClock } from './pump.ts';

export type { ChatTarget, ConnectionBinding, Lookup } from './binding.ts';
export type { ClaudeRegistration, ClaudeReceipt, ClaudeTransport, DeliveryMarker } from './claude.ts';
export type { CodexMarker, CodexPermissions, CodexTransport } from './codex-protocol.ts';
export type { AdapterClock } from './pump.ts';

interface AdapterOptions {
  clock?: AdapterClock;
  claude?: () => ClaudeTransport | undefined;
  codex?: () => CodexTransport | undefined;
}

export function openAdapters(path: string, options: AdapterOptions = {}) {
  const { clock = { now: Date.now, sleep }, claude = () => undefined, codex = () => undefined } = options;
  const now = () => clock.now();
  const bridge = openBridge(path, { now });
  try {
    // Reuse the bridge database and its transactions for durable provider evidence.
    const storage = openStorage(path);
    return {
      bridge,
      pumpDeliveries: deliveryPump(bridge, storage, clock, claude),
      codex: codexAdapter(bridge, { storage, now, receiptWindowMs: 60_000, automaticTurnLimit: 5 }, codex),
      close() {
        try {
          storage.close();
        } finally {
          bridge.close();
        }
      },
    };
  } catch (error) {
    bridge.close();
    throw error;
  }
}
