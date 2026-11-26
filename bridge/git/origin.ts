import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, type Stats,
} from 'node:fs';
import { join, sep } from 'node:path';
import { absolutePath, directory, git, gitLine, gitList, hasExternalFilters, repository } from './git.ts';
import { relativeFile } from './selection.ts';

function entryFingerprint(path: string | Buffer, stat: Stats) {
  if (stat.isSymbolicLink()) {
    return 'symlink:' + createHash('sha256').update(readlinkSync(path, { encoding: 'buffer' })).digest('hex');
  }
  if (stat.isDirectory()) return 'directory';
  if (!stat.isFile()) return 'special';
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.dev !== stat.dev || before.ino !== stat.ino) throw new Error('snapshot-failed');
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let count: number;
    while ((count = readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
    const after = fstatSync(fd);
    if (before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('snapshot-failed');
    return 'file:' + before.mode + ':' + hash.digest('hex');
  } finally {
    closeSync(fd);
  }
}

function fileFingerprint(source: string, path: string) {
  let absolute = source;
  const parts = path.split('/');
  for (const [index, part] of parts.entries()) {
    absolute = join(absolute, part);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return 'missing';
    if (index < parts.length - 1) {
      if (!stat.isDirectory()) return 'blocked';
      continue;
    }

    return entryFingerprint(absolute, stat);
  }
  throw new Error('snapshot-failed');
}

const pathSeparator = Buffer.from(sep);

function hashHooks(path: Buffer, add: (value: Buffer | string | undefined) => void) {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  add(stat ? entryFingerprint(path, stat) : undefined);
  if (!stat?.isDirectory()) return;
  const names = readdirSync(path, { encoding: 'buffer' }).sort(Buffer.compare);
  add(String(names.length));
  for (const name of names) {
    add(name);
    hashHooks(Buffer.concat([path, pathSeparator, name]), add);
  }
}

function fileOrAbsent(path: string) {
  return lstatSync(path, { throwIfNoEntry: false }) ? readFileSync(path) : undefined;
}

export function snapshotOrigin(source: unknown) {
  if (!absolutePath(source)) return { ok: false, reason: 'invalid-request' } as const;
  try {
    const resolved = directory(source);
    const common = repository(resolved);
    if (hasExternalFilters(resolved)) return { ok: false, reason: 'unsupported-repository' } as const;
    const gitDir = gitLine(resolved, ['rev-parse', '--absolute-git-dir']);
    const hash = createHash('sha256');
    const add = (value: Buffer | string | undefined) => {
      hash.update(value === undefined ? '-:' : Buffer.byteLength(value) + ':');
      if (value !== undefined) hash.update(value);
    };
    add(git(resolved, ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignore-submodules=dirty']).output);
    add(git(resolved, ['for-each-ref', '--sort=refname', '--format=%(refname)%00%(objectname)']).output);
    add(git(resolved, ['rev-parse', '--verify', 'HEAD']).output);
    add(readFileSync(join(gitDir, 'HEAD')));
    add(readFileSync(join(common, 'config')));
    add(fileOrAbsent(join(gitDir, 'config.worktree')));
    add(fileOrAbsent(join(gitDir, 'index')));
    for (const dir of new Set([gitDir, common])) hashHooks(Buffer.from(join(dir, 'hooks')), add);
    const paths = gitList(resolved, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
    for (const entry of [...new Set(paths)].sort()) {
      const path = relativeFile(entry);
      if (!path) throw new Error('snapshot-failed');
      add(path);
      add(fileFingerprint(resolved, path));
    }
    return { ok: true, hash: hash.digest('hex') } as const;
  } catch {
    return { ok: false, reason: 'snapshot-failed' } as const;
  }
}
