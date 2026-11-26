import { constants, closeSync, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import type { Duplex } from 'node:stream';
import { sameConnection, type ChatTarget, type ConnectionBinding } from './binding.ts';
import { deliveryMarker } from './claude-transcript.ts';
import type { ClaudeRegistration, ClaudeTransport, DeliveryMarker } from './claude.ts';

type RegistrationReason = 'live' | 'unknown-registration' | 'stale-registration' | 'socket-changed';
type Decision = RegistrationReason | 'invalid-frame' | 'prior-attempt-unknown' | 'already-attempted'
  | 'written' | 'unconfirmed';
type Fingerprint = readonly [bigint, bigint, bigint];
type Signal = Awaited<ReturnType<ClaudeTransport['send']>>;

interface HookRow {
  session_id: string;
  generation: string;
  registered_ns: bigint;
  address: string;
  fingerprint: Fingerprint | null;
}

interface InboxOptions {
  binding: ConnectionBinding;
  sessionRefs: readonly string[];
  readReceipts: ClaudeTransport['readReceipts'];
  registrationsDirectory?: string;
  startChatTurn?: ClaudeTransport['startChatTurn'];
  onDecision?: (operation: 'lookup' | 'send', reason: Decision) => void;
  connect?: (address: string) => Duplex;
  socketFingerprint?: (address: string) => Fingerprint | undefined;
  socketPathStat?: (path: string) => { uid: number; mode: number; isDirectory(): boolean; isSymbolicLink(): boolean };
  registrationFileStat?: (fd: number) => { uid: number; mode: number; isFile(): boolean };
}

const writeTimeoutMs = 2_000;
const maxSocketPathBytes = process.platform === 'darwin' ? 103 : 107;

function safeOwner(stat: { uid: number; mode: number }) {
  return stat.uid === process.getuid!() && (stat.mode & 0o022) === 0;
}

function readRow(path: string, fileStat: NonNullable<InboxOptions['registrationFileStat']>): HookRow {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fileStat(fd);
    if (!stat.isFile() || !safeOwner(stat)) throw new Error('Invalid Claude registration file');
    // The hook writes Python integers. Preserve nanoseconds and inode numbers exactly.
    const row = JSON.parse(readFileSync(fd, 'utf8'), (_key, value, context) =>
      typeof value === 'number' && /^\d+$/.test(context.source) ? BigInt(context.source) : value);
    if (!row || typeof row.session_id !== 'string' || !row.session_id ||
        typeof row.generation !== 'string' || !row.generation ||
        typeof row.registered_ns !== 'bigint' || row.registered_ns <= 0n ||
        row.registered_ns / 1_000_000n > BigInt(Number.MAX_SAFE_INTEGER) ||
        typeof row.address !== 'string' || (row.fingerprint !== null &&
          (!Array.isArray(row.fingerprint) || row.fingerprint.length !== 3 ||
            row.fingerprint.some((value: unknown) => typeof value !== 'bigint')))) {
      throw new Error('Invalid Claude registration row');
    }
    return row;
  } finally {
    closeSync(fd);
  }
}

function latestRow(directory: string, sessionRef: string, fileStat: NonNullable<InboxOptions['registrationFileStat']>) {
  if (!isAbsolute(directory)) return;
  try {
    const directoryStat = statSync(directory);
    if (!directoryStat.isDirectory() || !safeOwner(directoryStat)) return;
    let latest: HookRow | undefined;
    let tied = false;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.name.endsWith('.json')) continue;
      if (!entry.isFile()) return;
      const row = readRow(join(directory, entry.name), fileStat);
      if (row.session_id !== sessionRef) continue;
      if (!latest || row.registered_ns > latest.registered_ns) {
        latest = row;
        tied = false;
      } else if (row.registered_ns === latest.registered_ns) {
        tied = true;
      }
    }
    if (!tied) return latest;
  } catch {
    // A partial view might omit the newest generation.
  }
}

function localFingerprint(address: string): Fingerprint | undefined {
  const stat = lstatSync(address, { bigint: true });
  if (stat.isSocket() && stat.uid === BigInt(process.getuid!())) return [stat.dev, stat.ino, stat.ctimeNs];
}

function secureSocketPath(address: string, pathStat: NonNullable<InboxOptions['socketPathStat']>) {
  if (!isAbsolute(address) || resolve(address) !== address || Buffer.byteLength(address) > maxSocketPathBytes) return;
  let parts = address.split(sep).filter(Boolean);
  let current = sep;
  let links = 0;
  while (parts.length) {
    const part = parts.shift()!;
    if (part === '.') continue;
    if (part === '..') return;
    const component = join(current, part);
    const stat = pathStat(component);
    if (stat.isSymbolicLink()) {
      if (!parts.length || stat.uid !== 0 || (stat.mode & 0o022) !== 0 || ++links > 40) return;
      // The containing directory governs whether another user can replace the link.
      const directory = pathStat(current);
      const ownerWritableOnly = (directory.uid === 0 || directory.uid === process.getuid!()) &&
        (directory.mode & 0o022) === 0;
      const rootStickyDirectory = directory.uid === 0 && (directory.mode & 0o1000) !== 0;
      if (!directory.isDirectory() || (!ownerWritableOnly && !rootStickyDirectory)) return;
      const target = readlinkSync(component);
      parts = [...target.split(sep).filter(Boolean), ...parts];
      if (isAbsolute(target)) current = sep;
    } else {
      current = component;
    }
  }
  const parent = statSync(dirname(address));
  const resolved = realpathSync(address);
  if (parent.isDirectory() && safeOwner(parent) && current === resolved) return resolved;
}

function sameFingerprint(left: Fingerprint | null, right: Fingerprint | null | undefined) {
  return left === right || Boolean(left && right && left.every((value, index) => value === right[index]));
}

function frameMarker(frame: string) {
  if (frame.indexOf('\n') !== frame.length - 1 || !frame.endsWith('\n')) return;
  try {
    const value = JSON.parse(frame);
    if (value?.type === 'user' && value.message?.role === 'user' && typeof value.message.content === 'string') {
      const [first] = value.message.content.split('\n', 1);
      return deliveryMarker(first);
    }
  } catch {
    // Malformed frames cannot be sent.
  }
}

function writeFrame(
  connect: NonNullable<InboxOptions['connect']>, address: string, frame: string,
  validate: () => RegistrationReason,
): Promise<Decision> {
  return new Promise(resolve => {
    let socket: Duplex;
    try { socket = connect(address); } catch { resolve('unconfirmed'); return; }

    const deadline = setTimeout(() => finish('unconfirmed'), writeTimeoutMs);
    function finish(result: Decision) {
      clearTimeout(deadline);
      resolve(result);
      socket.destroy();
    }
    socket.once('error', () => finish('unconfirmed'));
    socket.once('close', () => finish('unconfirmed'));
    socket.once('connect', () => {
      const reason = validate();
      if (reason !== 'live') return finish(reason);
      socket.once('finish', () => finish('written'));
      try { socket.end(frame); } catch { finish('unconfirmed'); }
    });
  });
}

export function createClaudeInbox(options: InboxOptions) {
  const {
    registrationsDirectory = process.env.LOOM_CLAUDE_REGISTRATIONS ?? '',
    connect = address => createConnection(address), socketFingerprint = localFingerprint,
    registrationFileStat = fstatSync, socketPathStat = lstatSync,
  } = options;
  const binding = Object.freeze({ ...options.binding });
  const sessions = new Set(options.sessionRefs);
  const belongs = (target: ChatTarget) => sameConnection(binding, target) && sessions.has(target.sessionRef);
  const observed = new Map<string, HookRow>();
  const revoked = new Map<string, bigint>();
  const issued = new WeakMap<ClaudeRegistration, { row: HookRow; resolved?: string }>();
  const attempts = new Map<string, { row: HookRow; attempt: number }>();

  function inspect(target: ChatTarget, selected?: HookRow, expectedPath?: string): { reason: RegistrationReason; row?: HookRow; resolved?: string } {
    if (!belongs(target)) return { reason: 'unknown-registration' };
    const row = latestRow(registrationsDirectory, target.sessionRef, registrationFileStat);
    if (!row) return { reason: 'unknown-registration' };

    const prior = observed.get(target.sessionRef);
    const blockedThrough = revoked.get(target.sessionRef);
    if ((prior && row.registered_ns < prior.registered_ns) ||
        (blockedThrough !== undefined && row.registered_ns <= blockedThrough)) {
      return { reason: 'stale-registration', row: prior ?? row };
    }
    if (prior?.generation === row.generation &&
        (prior.registered_ns !== row.registered_ns || prior.address !== row.address ||
          !sameFingerprint(prior.fingerprint, row.fingerprint))) {
      return { reason: 'socket-changed', row: prior };
    }
    if (prior && prior.registered_ns === row.registered_ns && prior.generation !== row.generation) {
      return { reason: 'unknown-registration' };
    }
    observed.set(target.sessionRef, row);
    if (selected && (selected.generation !== row.generation || selected.registered_ns !== row.registered_ns)) {
      return { reason: 'stale-registration', row };
    }
    if (selected && (selected.address !== row.address || !sameFingerprint(selected.fingerprint, row.fingerprint))) {
      return { reason: 'socket-changed', row };
    }
    try {
      const resolved = secureSocketPath(row.address, socketPathStat);
      if (resolved && (!selected || resolved === expectedPath) &&
          row.fingerprint && sameFingerprint(row.fingerprint, socketFingerprint(row.address))) {
        return { reason: 'live', row, resolved };
      }
    } catch {
      // Missing and inaccessible sockets fail the same fingerprint check.
    }
    return { reason: 'socket-changed', row };
  }

  return {
    binding,
    lookupRegistration(target: ChatTarget) {
      const { reason, row, resolved } = inspect(target);
      options.onDecision?.('lookup', reason);
      if (!row) return;
      const registration = Object.freeze({
        sessionRef: row.session_id, generation: row.generation, registeredAt: Number(row.registered_ns / 1_000_000n),
        live: reason === 'live', reason,
      });
      issued.set(registration, { row, resolved });
      return registration;
    },
    revokeRegistration(target: ChatTarget, registration: ClaudeRegistration) {
      const row = issued.get(registration)?.row;
      if (!belongs(target) || row?.session_id !== target.sessionRef) return;
      const previous = revoked.get(target.sessionRef);
      if (previous === undefined || row.registered_ns > previous) revoked.set(target.sessionRef, row.registered_ns);
    },
    startChatTurn(target: ChatTarget, marker: DeliveryMarker) {
      if (belongs(target)) options.startChatTurn?.(target, marker);
    },
    async send(target: ChatTarget, registration: ClaudeRegistration, frame: string): Promise<Signal> {
      const route = { ...target };
      const result = (reason: Decision) => {
        options.onDecision?.('send', reason);
        return reason === 'written' ? 'written' : 'unconfirmed';
      };
      const issuedRegistration = issued.get(registration);
      const selected = issuedRegistration?.row;
      if (!belongs(route) || selected?.session_id !== route.sessionRef) return result('unknown-registration');
      const marker = frameMarker(frame);
      if (!marker) return result('invalid-frame');
      const key = JSON.stringify([route.sessionRef, marker.correlationId]);
      const previous = attempts.get(key);
      // On restart the bridge increments the attempt. Without its prior generation, fail closed.
      if (!previous && marker.attempt !== 1) return result('prior-attempt-unknown');
      if (previous && (marker.attempt <= previous.attempt || selected.generation === previous.row.generation ||
          selected.registered_ns <= previous.row.registered_ns)) return result('already-attempted');
      attempts.set(key, { row: selected, attempt: marker.attempt });

      const validate = () => inspect(route, selected, issuedRegistration?.resolved).reason;
      const reason = validate();
      if (reason !== 'live') return result(reason);
      return result(await writeFrame(connect, selected.address, frame, validate));
    },
    async readReceipts(target: ChatTarget, correlationId: string) {
      if (!belongs(target)) return { status: 'unknown' } as const;
      return options.readReceipts(target, correlationId);
    },
  } satisfies ClaudeTransport & { revokeRegistration(target: ChatTarget, registration: ClaudeRegistration): void };
}
