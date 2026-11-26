import { createHmac, randomBytes } from 'node:crypto';
import { closeSync, constants, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { natural } from '../input.ts';
import { isSnapshot } from '../sources/snapshot.ts';
import { newSkips, skipReasons, type Skips } from './diagnostics.ts';
import type { ClaimedUsage, CodexReading, FileMetadata, Position, Provider } from './parse.ts';
import { modelLabel, priceVersion } from './prices.ts';

const version = `3-${priceVersion}`;
const filename = 'usage-local.sqlite';
const schema = `
  CREATE TABLE IF NOT EXISTS version (version TEXT NOT NULL, salt TEXT NOT NULL) STRICT;
  CREATE TABLE IF NOT EXISTS files (
    file TEXT PRIMARY KEY, provider TEXT NOT NULL, mark TEXT NOT NULL, skips TEXT NOT NULL,
    allowance TEXT, session TEXT, forked INTEGER NOT NULL, forkAt INTEGER
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS cwd (
    file TEXT NOT NULL REFERENCES files(file) ON DELETE CASCADE,
    hash TEXT NOT NULL, offset INTEGER NOT NULL, length INTEGER NOT NULL,
    PRIMARY KEY (file, hash)
  ) STRICT, WITHOUT ROWID;
  CREATE TABLE IF NOT EXISTS claude (
    file TEXT NOT NULL REFERENCES files(file) ON DELETE CASCADE,
    id TEXT NOT NULL, at INTEGER NOT NULL, cwd TEXT, model TEXT NOT NULL, tokens TEXT, price TEXT,
    PRIMARY KEY (file, id)
  ) STRICT, WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS claude_id ON claude(id);
  CREATE TABLE IF NOT EXISTS codex (
    file TEXT NOT NULL REFERENCES files(file) ON DELETE CASCADE,
    seq INTEGER NOT NULL, at INTEGER NOT NULL, cwd TEXT, model TEXT NOT NULL, total INTEGER, last INTEGER,
    PRIMARY KEY (file, seq)
  ) STRICT, WITHOUT ROWID;
  CREATE TEMP TABLE active (file TEXT PRIMARY KEY, rank INTEGER NOT NULL) WITHOUT ROWID;
  CREATE TEMP TABLE projects (cwd TEXT PRIMARY KEY, slot INTEGER) WITHOUT ROWID;
`;

function privateDatabase(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.uid !== process.getuid!() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error('unsafe cache directory');
  }
  const path = join(directory, filename);
  try {
    const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { fchmodSync(fd, 0o600); } finally { closeSync(fd); }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
  }
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    try {
      const file = lstatSync(path + suffix);
      if (!file.isFile() || file.uid !== stat.uid || file.nlink !== 1 || (file.mode & 0o7777) !== 0o600) {
        throw new Error('unsafe cache file');
      }
    } catch (error) {
      if (suffix === '' || !(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
    }
  }
  return new DatabaseSync(path, { timeout: 5000 });
}

type ScanMeta = { skips: Skips; allowance: FileMetadata['allowance'] };
export type Usage = { at: number; project: number | null; model: string; tokens: string | null; price: string | null };

function buildCache(db: DatabaseSync) {
  db.exec('PRAGMA foreign_keys=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=-8192; PRAGMA cache_spill=ON; BEGIN IMMEDIATE');
  db.exec(schema);
  let salt = randomBytes(32).toString('hex');
  const existing = db.prepare('SELECT version, salt FROM version').get();
  if (existing?.version === version && typeof existing.salt === 'string' && /^[0-9a-f]{64}$/.test(existing.salt)) {
    salt = existing.salt;
  } else {
    db.exec('DELETE FROM files; DELETE FROM version');
    db.prepare('INSERT INTO version VALUES (?, ?)').run(version, salt);
  }

  const key = (kind: string, value: string) => createHmac('sha256', salt).update(JSON.stringify([kind, value])).digest('hex');
  const cachedFile = db.prepare('SELECT skips, allowance FROM files WHERE file=? AND mark=? AND provider=?');
  const remove = db.prepare('DELETE FROM files WHERE file=?');
  const start = db.prepare("INSERT INTO files VALUES (?, ?, ?, '{}', NULL, NULL, 0, NULL)");
  const finish = db.prepare('UPDATE files SET skips=?, allowance=?, session=?, forked=?, forkAt=? WHERE file=?');
  const activate = db.prepare('INSERT INTO active VALUES (?, ?)');
  const cwd = db.prepare('INSERT OR IGNORE INTO cwd VALUES (?, ?, ?, ?)');
  const locations = db.prepare('SELECT hash, offset, length FROM cwd WHERE file=?');
  const knownProject = db.prepare('SELECT 1 FROM projects WHERE cwd=?');
  const project = db.prepare('INSERT OR IGNORE INTO projects VALUES (?, ?)');
  const reply = db.prepare(`
    INSERT INTO claude VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (file, id) DO UPDATE SET
      at=excluded.at, cwd=excluded.cwd, model=excluded.model, tokens=excluded.tokens, price=excluded.price
  `);
  const reading = db.prepare('INSERT INTO codex VALUES (?, ?, ?, ?, ?, ?, ?)');
  const claudeRows = db.prepare(`
    WITH ranked AS (
      SELECT at, projects.slot AS project, model, tokens, price,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY at DESC, active.rank DESC) AS winner
      FROM claude JOIN active USING (file) LEFT JOIN projects ON projects.cwd=claude.cwd
      WHERE at >= ?
    ) SELECT at, project, model, tokens, price FROM ranked WHERE winner=1 AND at <= ?
  `);
  const codexRows = db.prepare(`
    WITH sessions AS (
      SELECT session, MIN(CASE WHEN forked=1 THEN forkAt END) AS forkAt
      FROM files JOIN active USING (file) WHERE provider='codex' GROUP BY session
    ), readings AS (
      SELECT session, at, projects.slot AS project, model, total, last, active.rank, seq,
        ROW_NUMBER() OVER (PARTITION BY file, at, total ORDER BY seq) AS occurrence
      FROM codex JOIN files USING (file) JOIN active USING (file) LEFT JOIN projects ON projects.cwd=codex.cwd
      WHERE at <= ?
    ), history AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY session, at, total, occurrence ORDER BY rank, seq
      ) AS copy FROM readings
    ) SELECT session, at, project, model, total, last, forkAt
      FROM history JOIN sessions USING (session) WHERE copy=1 ORDER BY session, at, rank, seq
  `);

  return {
    key,
    cached(provider: Provider, file: string, mark: string): ScanMeta | undefined {
      const found = cachedFile.get(file, mark, provider);
      if (!found) return;
      const skips = newSkips();
      try {
        const saved = JSON.parse(String(found.skips));
        if (!saved || skipReasons.some(reason => !natural(saved[reason]))) return;
        for (const reason of skipReasons) skips[reason] = saved[reason];
        const allowance: unknown = found.allowance === null ? null : JSON.parse(String(found.allowance));
        if (allowance === null || (isSnapshot(allowance) && allowance.source === 'codex-rate-limits')) {
          return { skips, allowance };
        }
      } catch { /* Rebuild invalid cached metadata from its source. */ }
    },
    activate(file: string, rank: number) { activate.run(file, rank); },
    locations(file: string) { return locations.iterate(file) as Iterable<Position & { hash: string }>; },
    knownProject(hash: string) { return knownProject.get(hash) !== undefined; },
    project(hash: string, slot: number | null) { project.run(hash, slot); },
    cwd(file: string, hash: string, { offset, length }: Position) { cwd.run(file, hash, offset, length); },
    reply(file: string, id: string, row: ClaimedUsage) {
      reply.run(file, id, row.at, row.cwd, row.model, row.tokens, row.price);
    },
    reading(file: string, seq: number, row: CodexReading) {
      reading.run(file, seq, row.at, row.cwd, row.model, row.total, row.last);
    },
    scan(file: string, provider: Provider, mark: string, run: () => (FileMetadata & { skips: Skips }) | undefined) {
      db.exec('SAVEPOINT scan_file');
      try {
        remove.run(file);
        start.run(file, provider, mark);
        const result = run();
        if (result) {
          const { skips, allowance, session, forked, forkAt } = result;
          finish.run(JSON.stringify(skips), allowance ? JSON.stringify(allowance) : null, session, Number(forked), forkAt, file);
          return { skips, allowance };
        }
        db.exec('ROLLBACK TO scan_file');
      } catch (error) {
        db.exec('ROLLBACK TO scan_file');
        throw error;
      } finally {
        db.exec('RELEASE scan_file');
      }
    },
    *rows(provider: Provider, start: number, end: number): Iterable<Usage> {
      if (provider === 'claude') {
        for (const row of claudeRows.iterate(start, end) as Iterable<Usage>) {
          yield { ...row, model: modelLabel(provider, row.model) };
        }
        return;
      }
      let session: string | undefined;
      let previous: number | null = null;
      let started = false;
      type Reading = Omit<Usage, 'tokens' | 'price'> & {
        session: string; total: number | null; last: number | null; forkAt: number | null;
      };
      for (const row of codexRows.iterate(end) as Iterable<Reading>) {
        if (session !== row.session) {
          session = row.session;
          previous = null;
          started = false;
        }
        const { total, last, forkAt, at } = row;
        // Copied history can establish a baseline without recording new usage.
        if (forkAt !== null && at < forkAt) {
          previous = total;
          continue;
        }
        let tokens: number | null = null;
        if (total !== null) {
          if (previous !== null && total >= previous) tokens = total - previous;
          else if (previous === null && !started && last !== null) tokens = last;
        }
        previous = total;
        started = true;
        if (at < start) continue;
        yield { at, project: row.project, model: modelLabel(provider, row.model),
          tokens: tokens === null ? null : String(tokens), price: null };
      }
    },
    save() {
      db.exec('DELETE FROM files WHERE file NOT IN (SELECT file FROM active); COMMIT');
    },
  };
}

export function withUsageCache<T>(directory: string, run: (cache: ReturnType<typeof buildCache>) => T): T {
  let db: DatabaseSync | undefined;
  let temporary: string | undefined;
  try {
    let cache: ReturnType<typeof buildCache>;
    try {
      db = privateDatabase(directory);
      cache = buildCache(db);
    } catch {
      db?.close();
      db = undefined;
      temporary = mkdtempSync(join(tmpdir(), 'loom-local-usage-'));
      db = privateDatabase(temporary);
      cache = buildCache(db);
    }
    return run(cache);
  } finally {
    db?.close();
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}

export type UsageCache = ReturnType<typeof buildCache>;
