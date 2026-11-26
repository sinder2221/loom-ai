import { randomBytes } from 'node:crypto';
import {
  closeSync, constants, fchmodSync, fstatSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readdirSync, readSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, writeSync,
} from 'node:fs';
import { userInfo } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { credentialToken } from '../src/approval-input.ts';

export const uid = process.getuid!();

export class Refusal extends Error {
  constructor(reason: string, exitCode = 1) {
    super(reason);
    this.exitCode = exitCode;
  }

  readonly exitCode: number;
}

export function hasCode(error: unknown, ...codes: string[]) {
  return error instanceof Error && 'code' in error && codes.includes(String(error.code));
}

export function inspect(path: string) {
  try { return lstatSync(path); } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
}

export function directoryPath(variable: string) {
  const value = process.env[variable];
  if (!value || !isAbsolute(value) || /[\x00-\x1f\x7f]/.test(value)) {
    throw new Refusal(`set-${variable}-to-an-absolute-directory`, 2);
  }
  const path = resolve(value);
  // Resolve aliases before checking the boundary, including when the leaf is absent.
  const canonical = inspect(path) ? realpathSync(path) : join(realpathSync(dirname(path)), basename(path));
  const library = join(realpathSync(userInfo().homedir), 'Library').toLowerCase();
  if ([path, canonical].some(candidate => {
    const comparison = candidate.toLowerCase();
    return comparison === library || comparison.startsWith(library + sep);
  })) {
    throw new Refusal('home-library-is-out-of-scope', 2);
  }
  return canonical;
}

function privateDirectory(path: string, create: boolean) {
  if (create) {
    try { mkdirSync(path, { mode: 0o700 }); } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  }
  const stat = inspect(path);
  if (!stat && !create) return false;
  if (!stat?.isDirectory() || stat.uid !== uid || (stat.mode & 0o7777) !== 0o700) {
    throw new Refusal('directory-must-be-owned-and-mode-0700', 2);
  }
  return true;
}

export function overlapsPrivateData(folder: string, data: string) {
  const inside = (root: string, target: string) => {
    const path = relative(root, target);
    return !isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep);
  };
  // APFS is often case-insensitive. Refuse aliases in either direction.
  return inside(folder.toLowerCase(), data.toLowerCase()) || inside(data.toLowerCase(), folder.toLowerCase());
}

export function runtimePaths(data: string) {
  const runtime = join(data, 'run');
  return {
    data, runtime, socket: join(runtime, 'bridge.sock'), lock: join(runtime, 'lock'),
    log: join(runtime, 'helper.log'), database: join(data, 'bridge.sqlite'), issuerToken: join(runtime, 'issuer-token'),
  };
}

export type Paths = ReturnType<typeof runtimePaths>;

export function prepareRuntime(paths: Paths, create: boolean) {
  if (Buffer.byteLength(paths.socket) > 103) throw new Refusal('socket-path-is-too-long', 2);
  return privateDirectory(paths.data, create) && privateDirectory(paths.runtime, create);
}

export function readPrivateToken(path: string) {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, 'ENOENT')) return;
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.isFile() && stat.uid === uid && (stat.mode & 0o7777) === 0o600 && stat.size === 43) {
      const buffer = Buffer.alloc(44);
      const length = readSync(fd, buffer);
      const token = buffer.toString('latin1', 0, length);
      if (credentialToken(token)) return token;
    }
    throw new Refusal('credential-file-invalid');
  } finally {
    closeSync(fd);
  }
}

function publishIssuerToken(paths: Paths) {
  const pending = mkdtempSync(join(paths.runtime, '.issuer-'));
  const file = join(pending, 'token');
  try {
    writeFileSync(file, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
    // Publish the complete file atomically. The link can only create a new name.
    try { linkSync(file, paths.issuerToken); } catch (error) {
      if (!hasCode(error, 'EEXIST')) throw error;
    }
  } finally {
    try { unlinkSync(file); } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    rmdirSync(pending);
  }
}

export function loadIssuerToken(paths: Paths, environmentToken: string | undefined) {
  if (environmentToken !== undefined) return environmentToken;
  try {
    const existing = readPrivateToken(paths.issuerToken);
    if (existing !== undefined) return existing;
    publishIssuerToken(paths);
    const published = readPrivateToken(paths.issuerToken);
    if (published !== undefined) return published;
  } catch {
    // Startup reports the fixed refusal code below.
  }
  throw new Refusal('issuer-token-file-invalid');
}

export function checkDatabaseFiles(database: string) {
  for (const suffix of ['', '-journal', '-shm', '-wal']) {
    const stat = inspect(database + suffix);
    if (stat && (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1)) {
      throw new Refusal('unsafe-database-file');
    }
  }
}

export function logEvent(paths: Paths, event: 'start' | 'stop' | 'refusal' | 'reconcile', fields: object = {}) {
  const fd = openSync(paths.log, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT
    | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.uid !== uid || stat.nlink !== 1) throw new Refusal('unsafe-log-file');
    if ((stat.mode & 0o7777) !== 0o600) fchmodSync(fd, 0o600);
    writeSync(fd, JSON.stringify({ time: new Date().toISOString(), event, ...fields }) + '\n');
  } finally {
    closeSync(fd);
  }
}

interface Owner { marker: string; pid: number }

export function lockOwner(paths: Paths): Owner | undefined {
  const directory = inspect(paths.lock);
  if (!directory) return undefined;
  if (!directory.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700) {
    throw new Refusal('unrecognized-lock');
  }
  let markers: string[];
  try { markers = readdirSync(paths.lock); } catch (error) {
    if (hasCode(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (markers.length === 0) return undefined;
  const match = /^(\d+)\.[a-zA-Z0-9]+$/.exec(markers[0]);
  const pid = Number(match?.[1]);
  if (markers.length !== 1 || !Number.isSafeInteger(pid) || pid < 1 || pid > 0x7fffffff) {
    throw new Refusal('unrecognized-lock');
  }
  return { marker: markers[0], pid };
}

export function pidAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch (error) {
    if (hasCode(error, 'ESRCH')) return false;
    if (hasCode(error, 'EPERM')) return true;
    throw error;
  }
}

export function removeOwner(paths: Paths, { marker }: Owner) {
  try { unlinkSync(join(paths.lock, marker)); } catch (error) {
    if (!hasCode(error, 'ENOENT')) throw error;
  }
  try { rmdirSync(paths.lock); } catch (error) {
    if (!hasCode(error, 'ENOENT', 'ENOTEMPTY', 'EEXIST')) throw error;
  }
}

export async function acquireLock(paths: Paths, socketAnswers: () => Promise<boolean>) {
  const pending = mkdtempSync(join(paths.runtime, `.lock-${process.pid}.`));
  const owner = { pid: process.pid, marker: basename(pending).slice('.lock-'.length) };
  try {
    writeFileSync(join(pending, owner.marker), '', { mode: 0o600 });
    for (;;) {
      try {
        // Publishing a populated directory is atomic. A rename cannot replace a populated lock.
        renameSync(pending, paths.lock);
        return owner;
      } catch (error) {
        if (!hasCode(error, 'EEXIST', 'ENOTEMPTY')) throw error;
      }
      const previous = lockOwner(paths);
      if (!previous) continue;
      if (pidAlive(previous.pid) || await socketAnswers()) throw new Refusal('already-running-or-starting', 3);
      // A competing reaper can only unlink this exact owner marker, never a replacement owner.
      removeOwner(paths, previous);
    }
  } finally {
    try { unlinkSync(join(pending, owner.marker)); } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
    try { rmdirSync(pending); } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error;
    }
  }
}
