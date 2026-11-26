import { createHash } from 'node:crypto';
import { constants, realpathSync, statSync } from 'node:fs';
import { open, lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { ClaudeReceipt, ClaudeTransport, DeliveryMarker } from './claude.ts';

const peerHeading = 'Another Claude session sent a message';
const markerPrefix = 'Loom delivery ';
const teardownTypes = new Set([
  'last-prompt', 'cost-state', 'agent-name', 'mode', 'atis-latch',
  'data-flow-records', 'tools-used', 'relocated',
]);

function object(value: unknown): Record<string, unknown> | undefined {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
}

export function deliveryMarker(line: string): DeliveryMarker | undefined {
  if (!line.startsWith(markerPrefix)) return;
  try {
    const marker = object(JSON.parse(line.slice(markerPrefix.length)));
    if (typeof marker?.correlationId === 'string' && marker.correlationId.trim() &&
        typeof marker.attempt === 'number' && Number.isSafeInteger(marker.attempt) && marker.attempt > 0) {
      return { correlationId: marker.correlationId, attempt: marker.attempt };
    }
  } catch {
    // An incomplete or quoted marker is not a receipt.
  }
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : [])
    .join('\n');
}

function scan(text: string, sessionRef: string, correlationId: string) {
  const parents = new Map<string, string>();
  const inbounds = new Map<string, DeliveryMarker>();
  const receipts: ClaudeReceipt[] = [];
  const seen = new Set<string>();

  function nearestInbound(parent: string | undefined) {
    const visited = new Set<string>();
    while (parent && !visited.has(parent)) {
      const marker = inbounds.get(parent);
      if (marker) return marker;
      visited.add(parent);
      parent = parents.get(parent);
    }
  }

  function add(kind: ClaudeReceipt['kind'], itemId: string, marker: DeliveryMarker) {
    if (marker.correlationId !== correlationId) return;
    const key = JSON.stringify([kind, itemId, marker.attempt]);
    if (seen.has(key)) return;
    seen.add(key);
    receipts.push({ kind, itemId, sessionRef, ...marker });
  }

  for (const line of text.slice(0, -1).split('\n')) {
    const entry = object(JSON.parse(line));
    if (!entry || typeof entry.type !== 'string') throw new Error('Invalid Claude transcript record');
    if (teardownTypes.has(entry.type) || entry.sessionId !== sessionRef || entry.isSidechain) continue;
    const itemId = entry.uuid;
    if (typeof itemId !== 'string' || !itemId) continue;
    const parent = typeof entry.parentUuid === 'string' ? entry.parentUuid : undefined;
    if (parent) parents.set(itemId, parent);
    const message = object(entry.message);
    if (!message || message.role !== entry.type) continue;
    const content = messageText(message.content);

    if (entry.type === 'user' && content.startsWith(peerHeading)) {
      const marker = content.split(/\r?\n/).map(deliveryMarker).find(Boolean);
      if (marker) {
        inbounds.set(itemId, marker);
        add('Received', itemId, marker);
      }
    } else if (entry.type === 'assistant') {
      const inbound = nearestInbound(parent);
      if (!inbound || inbound.correlationId !== correlationId) continue;
      const echoed = content.split(/\r?\n/).map(deliveryMarker).some(marker =>
        marker?.correlationId === inbound.correlationId && marker.attempt === inbound.attempt);
      if (echoed) add('Acted', itemId, inbound);
    }
  }
  return receipts;
}

// Claude Code's internal JSONL format is isolated behind the transport observer interface.
export function claudeTranscriptObserver(directory: string): ClaudeTransport['readReceipts'] {
  const snapshots = new Map<string, { dev: bigint; ino: bigint; size: number; hash: string }>();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
  const secure = (info: { uid: bigint; mode: bigint }) =>
    info.uid === BigInt(process.getuid!()) && (info.mode & 0o022n) === 0n;
  let root: string;
  let rootIdentity: { dev: bigint; ino: bigint };
  try {
    if (!isAbsolute(directory)) throw new Error('Invalid transcript directory');
    root = realpathSync(directory);
    const info = statSync(root, { bigint: true });
    if (root !== resolve(directory) || !info.isDirectory() || !secure(info)) throw new Error('Invalid transcript directory');
    rootIdentity = { dev: info.dev, ino: info.ino };
  } catch {
    return async () => ({ status: 'unknown' });
  }
  async function validRoot(path: string) {
    const parent = dirname(path);
    const info = await stat(parent, { bigint: true });
    return await realpath(parent) === root && info.isDirectory() && secure(info) &&
      info.dev === rootIdentity.dev && info.ino === rootIdentity.ino;
  }
  return async ({ sessionRef }, correlationId) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(sessionRef)) return { status: 'unknown' };
    const path = join(root, `${sessionRef}.jsonl`);
    try {
      if (!await validRoot(path)) return { status: 'unknown' };
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const before = await file.stat({ bigint: true });
        const prior = snapshots.get(sessionRef);
        if (!before.isFile() || !secure(before) || before.size === 0n ||
            (prior && (prior.dev !== before.dev || prior.ino !== before.ino || BigInt(prior.size) > before.size))) {
          return { status: 'unknown' };
        }
        const bytes = await file.readFile();
        const after = await lstat(path, { bigint: true });
        if (!await validRoot(path) || !after.isFile() || !secure(after) ||
            before.dev !== after.dev || before.ino !== after.ino || after.size < before.size ||
            BigInt(bytes.length) < before.size || BigInt(bytes.length) > after.size ||
            bytes.at(-1) !== 0x0a) return { status: 'unknown' };
        if (prior && digest(bytes.subarray(0, prior.size)) !== prior.hash) return { status: 'unknown' };

        const value = scan(decoder.decode(bytes), sessionRef, correlationId);
        // Concurrent observations must not move the high-water mark backwards.
        const current = snapshots.get(sessionRef);
        const size = bytes.length;
        if (current && (current.dev !== before.dev || current.ino !== before.ino || current.size > size ||
            digest(bytes.subarray(0, current.size)) !== current.hash)) {
          return { status: 'unknown' };
        }
        snapshots.set(sessionRef, { dev: before.dev, ino: before.ino, size, hash: digest(bytes) });
        return value.length ? { status: 'found', value } : { status: 'not-found' };
      } finally {
        await file.close();
      }
    } catch {
      return { status: 'unknown' };
    }
  };
}
