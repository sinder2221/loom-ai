import { createHash } from 'node:crypto';
import {
  closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readSync, type Stats,
} from 'node:fs';
import { join, posix, win32 } from 'node:path';
import { decode, git, gitList } from './git.ts';

export const maxFiles = 200;
export const maxBytes = 1024 * 1024;

export type PathReason = 'symlink' | 'nested-repo' | 'submodule' | 'outside-source'
  | 'binary' | 'too-large' | 'not-regular' | 'missing' | 'ignored';

export interface FileRecord {
  path: string;
  sha256: string;
  size: number;
}

type FileLocation = { absolute: string; stat: Stats } | { reason: PathReason };
type SelectionRead = { bytes: Buffer; mode: '100644' | '100755'; file: FileRecord }
  | { reason: PathReason } | { changed: true };

export function relativeFile(path: string) {
  const parts = path.split('/');
  if (posix.isAbsolute(path) || win32.isAbsolute(path)
    || parts.some(part => part === '..' || part.toLowerCase() === '.git')) return;
  const normalized = posix.normalize(path).replace(/\/$/, '');
  if (normalized && normalized !== '.') return normalized;
}

export function sha256(bytes: Buffer) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function locateFile(root: string, path: string, gitlinks?: ReadonlySet<string>): FileLocation {
  const parts = path.split('/');
  let absolute = root;
  for (const [index, part] of parts.entries()) {
    if (gitlinks?.has(parts.slice(0, index + 1).join('/'))) return { reason: 'submodule' };
    absolute = join(absolute, part);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return { reason: 'missing' };
    if (stat.isSymbolicLink()) return { reason: 'symlink' };
    if (stat.isDirectory() && isRepositoryDirectory(absolute)) return { reason: 'nested-repo' };
    if (index === parts.length - 1 && stat.isFile()) return { absolute, stat };
    if (!stat.isDirectory() || index === parts.length - 1) return { reason: 'not-regular' };
  }
  return { reason: 'missing' };
}

function isRepositoryDirectory(path: string) {
  const stat = (name: string) => lstatSync(join(path, name), { throwIfNoEntry: false });
  return Boolean(stat('.git') || (stat('HEAD')?.isFile() && stat('objects')?.isDirectory() && stat('refs')?.isDirectory()));
}

export function readSelected(path: string, location: FileLocation): SelectionRead {
  if ('reason' in location) return location;
  if (location.stat.size > maxBytes) return { reason: 'too-large' } as const;

  const fd = openSync(location.absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd);
    if (!before.isFile()) return { reason: 'not-regular' } as const;
    if (before.dev !== location.stat.dev || before.ino !== location.stat.ino) return { changed: true } as const;

    // Read at most one byte beyond the limit, even if a writer grows the file.
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    const after = fstatSync(fd);
    if (size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      return { changed: true } as const;
    }
    if (size > maxBytes) return { reason: 'too-large' } as const;
    const bytes = buffer.subarray(0, size);
    if (bytes.includes(0)) return { reason: 'binary' } as const;
    try {
      decode(bytes);
    } catch {
      return { reason: 'binary' } as const;
    }
    return {
      bytes: Buffer.from(bytes), mode: before.mode & 0o111 ? '100755' : '100644',
      file: { path, size, sha256: sha256(bytes) },
    };
  } finally {
    closeSync(fd);
  }
}

export function gitlinkPaths(source: string, base: string) {
  const entries = [
    ...gitList(source, ['ls-tree', '-rz', '--full-tree', base]),
    ...gitList(source, ['ls-files', '--stage', '-z']),
  ];
  return new Set(entries.filter(entry => entry.startsWith('160000 ')).map(entry => entry.slice(entry.indexOf('\t') + 1)));
}

export function gitlinkHasData(workspace: string, path: string) {
  if (relativeFile(path) !== path) return true;
  let absolute = workspace;
  for (const part of path.split('/')) {
    absolute = join(absolute, part);
    const stat = lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat) return false;
    if (!stat.isDirectory()) return true;
  }
  return readdirSync(absolute).length > 0;
}

export function seedablePaths(source: string) {
  const status = gitList(source, [
    'status', '--porcelain=v2', '-z', '--untracked-files=all', '--renames', '--ignore-submodules=dirty',
  ]);
  const paths = new Set<string>();
  const renames = new Set<string>();
  for (let index = 0; index < status.length; index++) {
    const entry = status[index];
    if (entry.startsWith('? ')) paths.add(entry.slice(2));
    if (entry.startsWith('1 ')) {
      const path = ordinaryStatusPath(entry);
      if (!path) throw new Error('git-failed');
      paths.add(path);
    }
    if (entry.startsWith('2 ')) {
      const path = /^2 (?:[^ ]+ ){8}([\s\S]+)$/.exec(entry)?.[1];
      if (!path || index + 1 === status.length) throw new Error('git-failed');
      renames.add(path);
      renames.add(status[++index]);
    }
  }
  for (const path of renames) paths.delete(path);
  return paths;
}

export function ordinaryStatusPath(entry: string) {
  return /^1 (?:[^ ]+ ){7}([\s\S]+)$/.exec(entry)?.[1];
}

export function isIgnored(source: string, path: string) {
  // check-ignore rejects literal pathspec magic. The ./ prefix keeps a leading colon in the name literal.
  return git(source, ['check-ignore', '-q', '--', './' + path], {
    env: { GIT_LITERAL_PATHSPECS: '0' }, allowOne: true,
  }).matched;
}
