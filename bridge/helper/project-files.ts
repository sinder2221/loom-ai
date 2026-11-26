import { spawnSync } from 'node:child_process';
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync,
  realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync, type BigIntStats,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasCode, inspect, Refusal } from './files.ts';

const maxFile = 1024 * 1024;

export function directoryIdentity(path: string) {
  const entry = inspect(path);
  if (!entry) return;
  if (!entry.isDirectory()) throw new Refusal('unsafe-project-directory');
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (stat.ino !== entry.ino || stat.dev !== entry.dev || realpathSync.native(path) !== path) {
      throw new Refusal('unsafe-project-directory');
    }
    return `${stat.dev}:${stat.ino}`;
  } finally { closeSync(fd); }
}

export interface FileSnapshot {
  bytes: Buffer;
  mode: number;
  revision: string;
}

const revisionOf = (stat: BigIntStats) =>
  `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;

export function snapshot(path: string): FileSnapshot | undefined {
  const entry = inspect(path);
  if (!entry) return;
  if (!entry.isFile()) throw new Refusal('unsafe-project-file');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || Number(stat.dev) !== entry.dev || Number(stat.ino) !== entry.ino || stat.size > maxFile) {
      throw new Refusal('unsafe-project-file');
    }
    const bytes = readFileSync(fd);
    if (bytes.length > maxFile) throw new Refusal('unsafe-project-file');
    const revision = revisionOf(stat);
    const latest = lstatSync(path, { bigint: true });
    if (!latest.isFile() || revisionOf(latest) !== revision) throw new Refusal('project-file-changed');
    return { bytes, mode: Number(stat.mode & 0o777n), revision };
  } finally { closeSync(fd); }
}

type Mutation = { op: 'publish'; bytes: string; mode: number; revision?: string; stage: string }
  | { op: 'unlink'; revision: string } | { op: 'mkdir' } | { op: 'rmdir'; directory: string };
interface Request {
  parent: string;
  identity: string;
  leaf: string;
  mutation: Mutation;
}

function mutate({ parent, identity, leaf, mutation }: Request) {
  if (!leaf || basename(leaf) !== leaf || leaf === '.' || leaf === '..') throw new Refusal('unsafe-project-file');
  // The worker starts with this directory as its OS working directory. All writes use relative,
  // single-component names, so a replaced ancestor cannot redirect them.
  const path = './' + leaf;
  const here = lstatSync('.');
  const verify = () => {
    if (`${here.dev}:${here.ino}` !== identity || directoryIdentity(parent) !== identity) {
      throw new Refusal('unsafe-project-directory');
    }
  };

  verify();
  if (mutation.op === 'mkdir') {
    mkdirSync(path, { mode: 0o700 });
    try { verify(); } catch (error) { rmdirSync(path); throw error; }
    const created = lstatSync(path);
    return `${created.dev}:${created.ino}`;
  }
  if (mutation.op === 'rmdir') {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || `${entry.dev}:${entry.ino}` !== mutation.directory) {
      throw new Refusal('unsafe-project-directory');
    }
    verify();
    rmdirSync(path);
    try { verify(); } catch (error) {
      if (!inspect(path)) mkdirSync(path, { mode: entry.mode & 0o777 });
      throw error;
    }
    return;
  }
  if (mutation.op === 'unlink') {
    const original = snapshot(path);
    if (!original || original.revision !== mutation.revision) throw new Refusal('project-file-changed');
    verify();
    unlinkSync(path);
    try { verify(); } catch (error) {
      if (!inspect(path)) writeFileSync(path, original.bytes, { flag: 'wx', mode: original.mode });
      throw error;
    }
    return;
  }

  if (!/^\.loom-write-[a-f0-9-]+$/.test(mutation.stage)) throw new Refusal('unsafe-project-file');
  const stage = './' + mutation.stage;
  const bytes = Buffer.from(mutation.bytes, 'base64');
  const fd = openSync(stage, 'wx', 0o600);
  try {
    try {
      writeFileSync(fd, bytes);
      fchmodSync(fd, mutation.mode);
      fsyncSync(fd);
    } finally { closeSync(fd); }

    verify();
    const staged = snapshot(stage);
    if (!staged || !staged.bytes.equals(bytes) || staged.mode !== mutation.mode) throw new Refusal('project-file-changed');
    const prior = snapshot(path);
    if (prior?.revision !== mutation.revision) throw new Refusal('project-file-changed');
    // The final revision check and rename cannot be combined in current Node filesystem APIs.
    if (prior) renameSync(stage, path);
    else linkSync(stage, path);
    try {
      verify();
      const parentFd = openSync('.', constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(parentFd); } finally { closeSync(parentFd); }
    } catch (error) {
      const written = snapshot(path);
      if (written?.bytes.equals(bytes) && written.mode === mutation.mode) {
        if (prior) {
          writeFileSync(stage, prior.bytes, { flag: 'wx', mode: prior.mode });
          renameSync(stage, path);
        } else unlinkSync(path);
      }
      throw error;
    }
  } finally {
    if (inspect(stage)) unlinkSync(stage);
  }
}

const worker = fileURLToPath(import.meta.url);

function run(path: string, identity: string, mutation: Mutation) {
  const parent = dirname(path);
  const request: Request = { parent, identity, leaf: basename(path), mutation };
  const result = spawnSync(process.execPath, [worker, '--pinned-mutation'], {
    cwd: parent, input: JSON.stringify(request) + '\n', encoding: 'utf8', env: {}, timeout: 1_500,
  });
  if (result.error && hasCode(result.error, 'ENOENT', 'ENOTDIR')) throw new Refusal('unsafe-project-directory');
  if (result.error || result.status !== 0) throw new Refusal(result.stdout.trim() || 'project-file-operation-failed');
  return result.stdout.trim();
}

export const makeDirectory = (path: string, identity: string) => run(path, identity, { op: 'mkdir' });
export const removeDirectory = (path: string, identity: string, directory: string) =>
  run(path, identity, { op: 'rmdir', directory });
export const removeFile = (path: string, identity: string, original: FileSnapshot) =>
  run(path, identity, { op: 'unlink', revision: original.revision });
export const publish = (path: string, identity: string, stage: string, bytes: Buffer | string, mode: number, prior?: FileSnapshot) =>
  run(path, identity, { op: 'publish', stage, bytes: Buffer.from(bytes).toString('base64'), mode, revision: prior?.revision });

if (process.argv[1] === worker && process.argv[2] === '--pinned-mutation') {
  try {
    process.stdout.write(mutate(JSON.parse(readFileSync(0, 'utf8'))) ?? '');
  } catch (error) {
    const reason = error instanceof Refusal ? error.message
      : hasCode(error, 'ENOTEMPTY', 'EEXIST') ? 'project-path-occupied'
      : hasCode(error, 'ELOOP', 'ENOTDIR') ? 'unsafe-project-directory' : 'project-file-operation-failed';
    process.stdout.write(reason);
    process.exitCode = 1;
  }
}
