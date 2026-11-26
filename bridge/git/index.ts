import {
  closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { absolutePath, decode, directory, git, gitLine, gitList, hasExternalFilters, pathString, repository, within } from './git.ts';
import { snapshotOrigin } from './origin.ts';
import {
  gitlinkHasData, gitlinkPaths, isIgnored, locateFile, maxBytes, maxFiles, ordinaryStatusPath, readSelected, relativeFile,
  seedablePaths,
  type FileRecord, type PathReason,
} from './selection.ts';

export { snapshotOrigin } from './origin.ts';

const workspacePrefix = 'loom-edit-';
const seedMessage = 'loom seed';

export interface EditWorkspace {
  source: string;
  base: string;
  workspace: string;
  seedCommit: string;
  files: FileRecord[];
}

interface PrepareRequest {
  source: string;
  base: unknown;
  selection: string[];
  root: string;
}

interface FixtureHooks {
  afterSnapshot?: () => void;
  copyBytes?: (copy: { index: number; fd: number; bytes: Buffer; destination: string }) => void;
}

function refused<const R extends string>(reason: R) {
  return { ok: false as const, reason };
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function commitId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
}

function requestShape(value: unknown): value is PrepareRequest {
  return object(value) && absolutePath(value.source) && absolutePath(value.root)
    && Array.isArray(value.selection) && value.selection.length <= maxFiles
    && Array.from(value.selection).every(pathString);
}

function recordShape(value: unknown): value is EditWorkspace {
  return object(value) && absolutePath(value.source) && absolutePath(value.workspace)
    && commitId(value.base) && commitId(value.seedCommit) && Array.isArray(value.files)
    && value.files.length <= maxFiles && Array.from(value.files).every(file =>
      object(file) && pathString(file.path) && relativeFile(file.path) === file.path
      && typeof file.sha256 === 'string' && /^[a-f\d]{64}$/.test(file.sha256)
      && typeof file.size === 'number' && Number.isInteger(file.size) && file.size >= 0 && file.size <= maxBytes);
}

function registered(source: string, workspace: string) {
  return gitList(source, ['worktree', 'list', '--porcelain', '-z']).includes('worktree ' + workspace);
}

function cleanupPreparation(source: string, workspace: string) {
  if (registered(source, workspace)) git(source, ['worktree', 'remove', '--force', '--force', '--', workspace]);
  else rmSync(workspace, { recursive: true, force: true });
}

function head(source: string) {
  // An unborn HEAD is distinct from an operational error.
  const result = git(source, ['rev-parse', '--verify', '--quiet', 'HEAD'], { allowOne: true });
  return decode(result.output).replace(/\n$/, '');
}

function cacheEntry(workspace: string, path: string, mode: string, blob: string, env?: Record<string, string>) {
  git(workspace, ['update-index', '--add', '--cacheinfo', `${mode},${blob},${path}`], { env });
}

export function prepareEditWorkspace(input: unknown, hooks: FixtureHooks = {}) {
  if (!requestShape(input)) return refused('invalid-request');
  if (!commitId(input.base)) return refused('invalid-base');
  const base = input.base.toLowerCase();
  let source: string;
  let root: string;
  let common: string;
  try {
    source = directory(input.source);
    root = directory(input.root);
    common = repository(source);
  } catch {
    return refused('invalid-request');
  }
  if (within(source, root)) return refused('root-inside-source');
  if (within(common, root)) return refused('invalid-request');

  const issues: { index: number; reason: PathReason }[] = [];
  const paths = input.selection.map((path, index) => {
    const normalized = relativeFile(path);
    if (!normalized) issues.push({ index, reason: 'outside-source' });
    return normalized;
  });
  const validPaths = paths.filter(path => path !== undefined);
  if (new Set(validPaths).size !== validPaths.length) return refused('invalid-request');

  type Selected = Extract<ReturnType<typeof readSelected>, { file: FileRecord }>;
  const selected: Selected[] = [];
  const attempted: FileRecord[] = [];
  let workspace: string | undefined;
  let failure = refused<'prepare-failed' | 'seed-failed' | 'stale-base' | 'stale-selection'>('prepare-failed');
  try {
    const type = git(source, ['cat-file', '--batch-check=%(objecttype)'], { input: base + '\n' });
    if (decode(type.output) !== 'commit\n') return refused('invalid-base');
    if (head(source) !== base) return refused('stale-base');
    if (hasExternalFilters(source)) return refused('unsupported-repository');

    const gitlinks = paths.length ? gitlinkPaths(source, base) : new Set<string>();
    const eligible = paths.length ? seedablePaths(source) : new Set<string>();
    for (const [index, path] of paths.entries()) {
      if (path === undefined) continue;
      const location = locateFile(source, path, gitlinks);
      if ('reason' in location) {
        issues.push({ index, reason: location.reason });
        continue;
      }
      if (!eligible.has(path)) {
        if (isIgnored(source, path)) issues.push({ index, reason: 'ignored' });
        continue;
      }
      const entry = readSelected(path, location);
      if ('reason' in entry) {
        issues.push({ index, reason: entry.reason });
      } else if ('changed' in entry) {
        return refused('stale-selection');
      } else {
        selected.push(entry);
      }
    }
    if (selected.length !== paths.length) {
      return { ...refused('unsupported-selection'), issues: issues.sort((a, b) => a.index - b.index) };
    }
    if (head(source) !== base) return refused('stale-base');
    workspace = mkdtempSync(join(root, workspacePrefix));
    git(source, ['worktree', 'add', '--detach', '--no-checkout', '--', workspace, base]);
    if (repository(workspace) !== common || head(workspace) !== base || hasExternalFilters(workspace)) {
      throw new Error('prepare-failed');
    }
    git(workspace, ['read-tree', '--reset', '-u', base]);

    // Keep review metadata for each write attempted, including a failed write.
    try {
      hooks.afterSnapshot?.();
      for (const [index, entry] of selected.entries()) {
        const { path } = entry.file;
        attempted.push(entry.file);
        const destination = locateFile(workspace, path, gitlinks);
        if ('reason' in destination && destination.reason !== 'missing') throw new Error('seed-failed');
        const absolute = join(workspace, path);
        mkdirSync(dirname(absolute), { recursive: true });
        const fd = openSync(absolute,
          constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW | constants.O_NONBLOCK);
        try {
          if (!fstatSync(fd).isFile()) throw new Error('seed-failed');
          if (hooks.copyBytes) hooks.copyBytes({ index, fd, bytes: entry.bytes, destination: absolute });
          else writeFileSync(fd, entry.bytes);
          // Git's mode is part of the commit even when the origin's core.fileMode is false.
          fchmodSync(fd, entry.mode === '100755' ? 0o755 : 0o644);
        } finally {
          closeSync(fd);
        }
        const blob = decode(git(workspace, ['hash-object', '-w', '--no-filters', '--stdin'], {
          input: entry.bytes,
        }).output).trim();
        cacheEntry(workspace, path, entry.mode, blob);
      }
      const tree = gitLine(workspace, ['write-tree']);
      const seedCommit = gitLine(workspace, ['commit-tree', tree, '-p', base, '-m', seedMessage]);
      git(workspace, ['update-ref', '--no-deref', 'HEAD', seedCommit, base]);

      const unchanged = selected.map(({ file, mode }) => {
        try {
          const current = readSelected(file.path, locateFile(source, file.path, gitlinks));
          return 'file' in current && current.file.sha256 === file.sha256 && current.mode === mode;
        } catch {
          return false;
        }
      });
      if (head(source) !== base) {
        failure = refused('stale-base');
      } else if (unchanged.includes(false)) {
        failure = refused('stale-selection');
      } else {
        return { ok: true as const, record: { source, base, workspace, seedCommit, files: selected.map(entry => entry.file) } };
      }
    } catch {
      failure = refused('seed-failed');
    }
  } catch {
    // Keep filesystem paths and Git diagnostics out of refusals.
  }

  if (workspace !== undefined) {
    try {
      cleanupPreparation(source, workspace);
    } catch {
      return { ...refused('cleanup-failed'), attempted };
    }
  }
  return failure.reason === 'seed-failed' ? { ...refused('seed-failed'), attempted } : failure;
}

function isSeedCommit({ workspace, seedCommit, base }: EditWorkspace) {
  if (gitLine(workspace, ['cat-file', '-t', seedCommit]) !== 'commit') return false;
  const commit = gitLine(workspace, ['cat-file', 'commit', seedCommit]);
  const separator = commit.indexOf('\n\n');
  if (separator < 0 || commit.slice(separator + 2) !== seedMessage) return false;
  const parents = commit.slice(0, separator).split('\n').filter(line => line.startsWith('parent '));
  return parents.length === 1 && parents[0] === 'parent ' + base.toLowerCase();
}

function workspaceRepository(record: EditWorkspace) {
  const { source, workspace } = record;
  try {
    if (!basename(workspace).startsWith(workspacePrefix) || directory(source) !== source
      || directory(workspace) !== workspace || within(source, workspace)
      || !lstatSync(join(workspace, '.git')).isFile() || !registered(source, workspace)) return;
    const common = repository(source);
    if (repository(workspace) === common && isSeedCommit(record)) return common;
  } catch {
    // Invalid workspace records and absent seed objects are refused without Git diagnostics.
  }
}

function withWorkingIndex<T>(record: EditWorkspace, common: string, action: (env: Record<string, string>) => T) {
  const temp = mkdtempSync(join(tmpdir(), 'loom-git-index-'));
  try {
    const objects = join(temp, 'objects');
    mkdirSync(objects);
    // Write review state to a temporary index and object store.
    const env = {
      GIT_INDEX_FILE: join(temp, 'index'),
      GIT_OBJECT_DIRECTORY: objects,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: JSON.stringify(join(common, 'objects')),
    };
    const { workspace, seedCommit } = record;
    const tracked = gitList(workspace, ['ls-files', '--cached', '-z']);
    git(workspace, ['read-tree', seedCommit], { env });
    git(workspace, ['add', '--all', '--', '.'], { env });
    const staged = new Set(gitList(workspace, ['ls-files', '--cached', '-z'], { env }));
    for (const path of new Set(tracked)) {
      if (staged.has(path) || relativeFile(path) !== path) continue;
      const location = locateFile(workspace, path);
      if ('stat' in location || location.reason === 'symlink') {
        git(workspace, ['add', '--force', '--', path], { env });
      }
    }

    // Seed blobs preserve exact bytes, so review selected regular files the same way.
    for (const { path } of record.files) {
      const location = locateFile(workspace, path);
      if (!('stat' in location)) continue;
      const blob = decode(git(workspace, ['hash-object', '-w', '--no-filters', '--', path], { env }).output).trim();
      cacheEntry(workspace, path, location.stat.mode & 0o111 ? '100755' : '100644', blob, env);
    }
    return action(env);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

const diffOptions = [
  '--cached', '--no-renames', '--no-color', '--no-ext-diff', '--no-textconv', '--no-relative', '--ignore-submodules=dirty',
  '--submodule=short',
];

export function captureDiff(input: unknown) {
  if (!object(input) || !recordShape(input.record)) return refused('invalid-request');
  const record = input.record;
  const { workspace, seedCommit, files } = record;
  const common = workspaceRepository(record);
  if (common === undefined) return refused('invalid-request');
  try {
    if (hasExternalFilters(workspace)) return refused('diff-failed');
    const current = head(workspace);
    if (!current || !git(workspace, ['merge-base', '--is-ancestor', seedCommit, current], { allowOne: true }).matched) {
      return refused('workspace-moved');
    }
    return withWorkingIndex(record, common, env => {
      const compare = (options: string[]) =>
        git(workspace, ['diff', ...diffOptions, ...options, seedCommit, '--'], { env }).output;
      return {
        ok: true as const,
        diff: decode(compare(['--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/'])),
        stat: decode(compare(['--stat'])),
        paths: gitList(workspace, ['diff', ...diffOptions, '--name-only', '-z', seedCommit, '--'], { env }),
        seed: files.map(({ path, sha256, size }) => ({ path, sha256, size })),
      };
    });
  } catch {
    return refused('diff-failed');
  }
}

export function verifyOriginPreserved(input: unknown) {
  if (!object(input) || !recordShape(input.record) || !object(input.before) || input.before.ok !== true
    || typeof input.before.hash !== 'string' || !/^[a-f\d]{64}$/.test(input.before.hash)) return refused('invalid-request');
  const after = snapshotOrigin(input.record.source);
  if (!after.ok) return after;
  return after.hash === input.before.hash ? { ok: true as const } : refused('origin-changed');
}

export function removeEditWorkspace(input: unknown) {
  if (!object(input) || !recordShape(input.record) || typeof input.keepIfChanged !== 'boolean') {
    return refused('invalid-request');
  }
  const record = input.record;
  const { source, workspace, seedCommit } = record;
  const common = workspaceRepository(record);
  if (common === undefined) return refused('invalid-request');
  try {
    if (hasExternalFilters(workspace)) return refused('remove-failed');
    const options: string[] = [];
    if (input.keepIfChanged) {
      if (head(workspace) !== seedCommit
        || [...gitlinkPaths(workspace, seedCommit)].some(path => gitlinkHasData(workspace, path))) {
        return refused('unapplied-changes');
      }
      const status = gitList(workspace, [
        'status', '--porcelain=v2', '-z', '--untracked-files=all', '--ignored=matching', '--ignore-submodules=dirty',
      ]);
      const seeded = new Set(record.files.map(file => file.path));
      // Git may report clean-filter normalization of an exact-byte seed as an unstaged change.
      if (status.some(entry => !entry.startsWith('1 .M ') || !seeded.has(ordinaryStatusPath(entry) ?? ''))
        || withWorkingIndex(record, common, env =>
        !git(workspace, ['diff', ...diffOptions, '--quiet', seedCommit, '--'], { env, allowOne: true }).matched)) {
        return refused('unapplied-changes');
      }
      if (status.length) {
        const emptyTree = decode(git(workspace, ['hash-object', '-t', 'tree', '--stdin'], { input: '' }).output).trim();
        options.push('--attr-source=' + emptyTree, '-c', 'core.autocrlf=false');
      }
    }
    git(source, [...options, 'worktree', 'remove', ...(input.keepIfChanged ? [] : ['--force']), '--', workspace]);
    return { ok: true as const };
  } catch {
    return refused('remove-failed');
  }
}
