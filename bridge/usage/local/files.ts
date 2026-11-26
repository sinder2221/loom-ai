import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { data, natural } from '../input.ts';
import type { UsageCache } from './cache.ts';
import { newSkips, skipReasons } from './diagnostics.ts';
import { claudeParser, codexParser, type FileMetadata, type Position, type Provider, type Sink } from './parse.ts';

export const maxLineBytes = 64 * 1024 * 1024;
const readFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const missing = (error: unknown) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

function within(folder: string, path: string) {
  const part = relative(folder, path);
  return part !== '..' && !part.startsWith('..' + sep) && !isAbsolute(part);
}

function isFolderPath(path: unknown): path is string {
  return typeof path === 'string' && isAbsolute(path) && !path.includes('\0');
}

function resolvedFolder(path: string) {
  try { return realpathSync.native(path); } catch { return resolve(path); }
}

export function projectMatcher(paths: (string | null)[]) {
  const folders = paths.map(path => path === null ? null : resolvedFolder(path));
  if (folders.every(folder => folder === null)) return null;
  return (path: string) => {
    const resolved = resolvedFolder(path);
    let best: number | null = null;
    for (const [index, folder] of folders.entries()) {
      if (folder !== null && within(folder, resolved)
        && (best === null || folder.length > folders[best]!.length)) best = index;
    }
    return best;
  };
}

function signature(path: string, stat: ReturnType<typeof fileStat>) {
  return [path, stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(':');
}

function fileStat(path: string) {
  return lstatSync(path, { bigint: true });
}

function withFile<T>(root: string, path: string, mark: string, read: (fd: number, size: bigint) => T) {
  if (!within(root, realpathSync.native(path))) return;
  const fd = openSync(path, readFlags);
  try {
    const stat = fstatSync(fd, { bigint: true });
    const canonical = realpathSync.native(path);
    if (!stat.isFile() || signature(path, stat) !== mark || !within(root, canonical)
      || signature(path, fileStat(canonical)) !== mark) return;
    const result = read(fd, stat.size);
    // Do not publish evidence from a file that changed during the read.
    if (signature(path, fstatSync(fd, { bigint: true })) === mark) return result;
  } finally { closeSync(fd); }
}

function readFileSummary(fd: number, size: bigint, parser: ReturnType<typeof claudeParser>) {
  const chunk = Buffer.alloc(64 * 1024);
  let line = Buffer.allocUnsafe(chunk.length);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let length = 0;
  let offset = 0;
  let position = 0;
  let oversized = false;
  const skips = newSkips();

  function finish() {
    if (oversized) {
      skips.oversizedLine++;
      line = Buffer.allocUnsafe(chunk.length);
    }
    else if (length > 0) {
      let text: string | undefined;
      try { text = decoder.decode(line.subarray(0, length)); }
      catch { skips.invalidUtf8++; }
      if (text?.trim()) {
        let record: unknown;
        try { record = JSON.parse(text); }
        catch { skips.invalidJson++; }
        if (record !== undefined) {
          const reason = parser.line(record, { offset, length });
          if (reason) skips[reason]++;
        }
      }
    }
    offset = position;
    length = 0;
    oversized = false;
  }

  let remaining = size;
  while (remaining > 0n) {
    const read = readSync(fd, chunk, 0, Number(remaining < BigInt(chunk.length) ? remaining : BigInt(chunk.length)), null);
    if (read === 0) break;
    remaining -= BigInt(read);
    let next = 0;
    while (next < read) {
      const newline = chunk.indexOf(10, next);
      const ends = newline >= 0 && newline < read;
      const end = ends ? newline : read;
      const needed = length + end - next;
      if (needed > maxLineBytes) oversized = true;
      if (!oversized) {
        if (needed > line.length) {
          const grown = Buffer.allocUnsafe(Math.min(maxLineBytes, Math.max(needed, line.length * 2)));
          line.copy(grown, 0, 0, length);
          line = grown;
        }
        chunk.copy(line, length, next, end);
        length = needed;
      }
      position += end - next + Number(ends);
      if (ends) finish();
      next = end + 1;
    }
  }
  if (length || oversized) finish(); // Allow a complete record without a trailing newline.
  return { ...parser.result(), skips };
}

function restoreProjects(
  cache: UsageCache, provider: Provider, root: string, path: string, mark: string, file: string,
  projectFor: ReturnType<typeof projectMatcher>,
) {
  if (!projectFor) return true;
  const unresolved = function* () {
    for (const location of cache.locations(file)) {
      if (!cache.knownProject(location.hash)) yield location;
    }
  }();
  const first = unresolved.next();
  if (first.done) return true;
  try {
    return withFile(root, path, mark, (fd, size) => {
      const decoder = new TextDecoder('utf-8', { fatal: true });
      function locate({ hash, offset, length }: Position & { hash: string }) {
        if (!natural(offset) || !natural(length) || length > maxLineBytes || BigInt(offset) + BigInt(length) > size) {
          throw new Error('invalid cached location');
        }
        const record: unknown = JSON.parse(decoder.decode(readRange(fd, offset, length)));
        const candidate = data(record) ? (provider === 'claude' ? record.cwd : data(record.payload) ? record.payload.cwd : null) : null;
        if (!isFolderPath(candidate) || cache.key('cwd', candidate) !== hash) throw new Error('invalid cached location');
        cache.project(hash, projectFor!(candidate));
      }
      locate(first.value);
      for (const location of unresolved) locate(location);
      return true;
    });
  } finally { unresolved.return(undefined); }
}

function readRange(fd: number, offset: number, length: number) {
  const buffer = Buffer.alloc(length);
  let filled = 0;
  while (filled < length) {
    const read = readSync(fd, buffer, filled, length - filled, offset + filled);
    if (!read) throw new Error('short cached location');
    filled += read;
  }
  return buffer;
}

function matches(provider: Provider, parts: string[]) {
  const name = parts.at(-1)!;
  if (provider === 'codex') {
    return parts.length === 4 && /^rollout-.+\.jsonl$/.test(name);
  }
  return (parts.length === 2 && name.endsWith('.jsonl')) || (parts.length >= 3 && /^agent-.+\.jsonl$/.test(name));
}

export function scanProvider(provider: Provider, directory: string, cache: UsageCache, projectFor: ReturnType<typeof projectMatcher>) {
  let allowance: FileMetadata['allowance'] = null;
  const skips = newSkips();
  let reused = 0;
  let scanned = 0;
  let available = false;

  function fileSummary(root: string, path: string, file: string, mark: string) {
    const fingerprint = cache.key('mark', mark);
    const cached = cache.cached(provider, file, fingerprint);
    if (cached && restoreProjects(cache, provider, root, path, mark, file, projectFor)) {
      reused++;
      return cached;
    }
    scanned++;
    return cache.scan(file, provider, fingerprint, () => {
      let seq = 0;
      const recent = new Map<string, string>();
      const sink: Sink = {
        key: cache.key,
        cwd(path, position) {
          if (!isFolderPath(path)) return null;
          const found = recent.get(path);
          if (found) return found;
          const hash = cache.key('cwd', path);
          if (recent.size >= 256) recent.clear();
          recent.set(path, hash);
          cache.cwd(file, hash, position);
          if (projectFor && !cache.knownProject(hash)) cache.project(hash, projectFor(path));
          return hash;
        },
        reply(id, row) { cache.reply(file, id, row); },
        reading(row) { cache.reading(file, seq++, row); },
      };
      const parser = provider === 'claude' ? claudeParser(sink) : codexParser(sink, file);
      return withFile(root, path, mark, (fd, size) => readFileSummary(fd, size, parser));
    });
  }

  function walk(root: string, path: string, parts: string[]) {
    try {
      if (lstatSync(path).isSymbolicLink() || realpathSync.native(path) !== path) {
        skips.symlink++;
        return;
      }
      const dir = opendirSync(path);
      const entries = [];
      try {
        for (let entry = dir.readSync(); entry; entry = dir.readSync()) entries.push(entry);
      } finally { dir.closeSync(); }
      if (parts.length === 0) available = true;
      entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      for (const entry of entries) {
        const names = [...parts, entry.name];
        const child = join(path, entry.name);
        const candidate = matches(provider, names);
        const datePart = names.length === 1 ? /^\d{4}$/ : /^\d{2}$/;
        const folder = provider === 'claude' || (names.length < 4 && datePart.test(entry.name));
        if (entry.isSymbolicLink()) {
          if (candidate || (folder && !entry.name.includes('.'))) skips.symlink++;
          continue;
        }
        if (entry.isDirectory()) {
          if (folder) walk(root, child, names);
          continue;
        }
        if (!candidate) continue;
        try {
          const stat = fileStat(child);
          if (!stat.isFile()) { skips.nonRegularSource++; continue; }
          const file = cache.key(provider, child);
          const summary = fileSummary(root, child, file, signature(child, stat));
          if (!summary) { skips.changedSource++; continue; }
          cache.activate(file, scanned + reused);
          for (const reason of skipReasons) skips[reason] += summary.skips[reason];
          const reading = summary.allowance;
          if (reading && (!allowance || reading.observedAt >= allowance.observedAt)) allowance = reading;
        } catch { skips.unreadableSource++; }
      }
    } catch { skips.unreadableSource++; }
  }

  try {
    const stat = lstatSync(directory);
    if (stat.isSymbolicLink()) skips.symlink++;
    else if (stat.isDirectory()) {
      const root = realpathSync.native(directory);
      walk(root, root, []);
    } else skips.nonRegularSource++;
  } catch (error) {
    if (!missing(error)) skips.unreadableSource++;
  }
  const skipped = Object.values(skips).reduce((total, count) => total + count, 0);
  return { allowance, available, skipped, skipReasons: skips, reused, scanned };
}
