import {
  chmodSync, closeSync, constants, fstatSync, lstatSync, mkdtempSync, openSync, readSync, renameSync, rmSync, writeFileSync,
  type Stats,
} from 'node:fs';
import { join } from 'node:path';
import { inspect, uid } from '../../helper/files.ts';
import { isSnapshot, type UsageSnapshot } from './snapshot.ts';

const maxSnapshotBytes = 4096;
const filenames = {
  'claude-statusline': 'usage-claude.json',
  'codex-rate-limits': 'usage-codex.json',
};

function privateDataDirectory(directory: string) {
  const stat = lstatSync(directory);
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o7777) === 0o700;
}

function privateFile(stat: Stats) {
  return stat.isFile() && stat.uid === uid && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600;
}

export function writeUsageSnapshot(directory: string, snapshot: UsageSnapshot) {
  if (!isSnapshot(snapshot) || !privateDataDirectory(directory)) throw new Error('invalid-usage-snapshot');
  const target = join(directory, filenames[snapshot.source]);
  function checkTarget() {
    const stat = inspect(target);
    if (stat && !privateFile(stat)) throw new Error('unsafe-usage-snapshot');
  }

  checkTarget();
  const staging = mkdtempSync(join(directory, '.usage-'));
  try {
    const pending = join(staging, 'snapshot');
    writeFileSync(pending, JSON.stringify(snapshot) + '\n', { flag: 'wx', mode: 0o600 });
    chmodSync(pending, 0o600);
    // A simultaneous writer can still publish between this read and the rename.
    const previous = readUsageSnapshot(directory, snapshot.source);
    if (previous && previous.observedAt > snapshot.observedAt) return;
    checkTarget();
    renameSync(pending, target);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

export function readUsageSnapshot(directory: string, source: UsageSnapshot['source']) {
  try {
    if (!privateDataDirectory(directory)) return;
    const fd = openSync(join(directory, filenames[source]), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = fstatSync(fd);
      if (!privateFile(stat) || stat.size > maxSnapshotBytes) return;
      const bytes = Buffer.alloc(maxSnapshotBytes + 1);
      let size = 0;
      while (size < bytes.length) {
        const count = readSync(fd, bytes, size, bytes.length - size, null);
        if (count === 0) break;
        size += count;
      }
      if (size > maxSnapshotBytes) return;
      const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
      if (isSnapshot(value) && value.source === source) return value;
    } finally {
      closeSync(fd);
    }
  } catch {
    // A missing, invalid or inaccessible snapshot is unavailable.
  }
}
