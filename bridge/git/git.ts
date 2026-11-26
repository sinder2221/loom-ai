import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';

const env = {
  PATH: process.env.PATH,
  LC_ALL: 'C',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Loom',
  GIT_AUTHOR_EMAIL: 'loom@example.invalid',
  GIT_COMMITTER_NAME: 'Loom',
  GIT_COMMITTER_EMAIL: 'loom@example.invalid',
  GIT_OPTIONAL_LOCKS: '0',
  GIT_LITERAL_PATHSPECS: '1',
  GIT_NO_REPLACE_OBJECTS: '1',
  GIT_NO_LAZY_FETCH: '1',
  GIT_ALLOW_PROTOCOL: '',
};

export function git(cwd: string, args: string[], options: {
  input?: Buffer | string;
  env?: Record<string, string>;
  allowOne?: boolean;
} = {}) {
  const result = spawnSync('git', [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'core.fsmonitor=false',
    '-c', 'core.untrackedCache=false',
    '-c', 'core.splitIndex=false',
    '-c', 'commit.gpgSign=false',
    '-c', 'submodule.recurse=false',
    '-c', 'worktree.useRelativePaths=false',
    '-c', 'maintenance.auto=false',
    '-c', 'gc.auto=0',
    ...args,
  ], {
    cwd, env: { ...env, ...options.env }, input: options.input, maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0 && !(options.allowOne && result.status === 1)) {
    throw new Error('git-failed');
  }
  return { output: result.stdout, matched: result.status === 0 };
}

export function decode(buffer: Buffer) {
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
}

export function gitLine(cwd: string, args: string[]) {
  return decode(git(cwd, args).output).replace(/\n$/, '');
}

export function gitList(cwd: string, args: string[], options?: Parameters<typeof git>[2]) {
  const output = decode(git(cwd, args, options).output);
  return output ? output.slice(0, -1).split('\0') : [];
}

export function pathString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.isWellFormed() && !value.includes('\0');
}

export function absolutePath(value: unknown): value is string {
  return pathString(value) && isAbsolute(value);
}

export function within(parent: string, path: string) {
  const suffix = relative(parent, path);
  return suffix !== '..' && !suffix.startsWith('..' + sep) && !isAbsolute(suffix);
}

export function directory(path: string) {
  const resolved = realpathSync.native(path);
  if (!statSync(resolved).isDirectory()) throw new Error('invalid-request');
  return resolved;
}

export function repository(path: string) {
  if (gitLine(path, ['rev-parse', '--is-inside-work-tree']) !== 'true'
    || directory(gitLine(path, ['rev-parse', '--show-toplevel'])) !== path) {
    throw new Error('invalid-request');
  }
  return directory(gitLine(path, ['rev-parse', '--path-format=absolute', '--git-common-dir']));
}

export function hasExternalFilters(path: string) {
  return gitList(path, ['config', '--null', '--name-only', '--list'])
    .some(key => /^filter\..*\.(clean|smudge|process)$/i.test(key));
}
