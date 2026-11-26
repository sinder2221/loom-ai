import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fields } from '../input.ts';
import { snapshotLastRemaining, snapshotQuota } from '../read-snapshots.ts';
import { serializeUsage, type LocalUsage } from '../serialize.ts';
import { readUsageSnapshot } from '../sources/store.ts';
import { withUsageCache, type Usage, type UsageCache } from './cache.ts';
import { projectMatcher, scanProvider } from './files.ts';
import type { Provider } from './parse.ts';

function periods(now: number) {
  return ([['today', 0], ['last7', 6], ['last30', 29]] as const).map(([period, days]) => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - days);
    return { period, start: start.getTime() };
  });
}

function counter(unattributed: number) {
  let observations = unattributed;
  let unreadableReadings = unattributed;
  let pricedObservations = 0;
  let tokens = 0n;
  let pricedTokens = 0n;
  let numerator = 0n;
  return {
    add(count: bigint | null, price: bigint | null) {
      observations++;
      if (count === null) unreadableReadings++;
      else {
        tokens += count;
        if (price !== null) {
          pricedObservations++;
          pricedTokens += count;
          numerator += price;
        }
      }
    },
    result() {
      const pricedMicros = pricedObservations ? (numerator + 500_000n) / 1_000_000n : null;
      return {
        tokens: observations > unreadableReadings ? tokens : null,
        estimatedMicros: pricedObservations === observations ? pricedMicros : null,
        pricedMicros, pricedTokens, pricedObservations, observations, unreadableReadings,
      };
    },
  };
}

function group(unattributed: number) {
  const total = counter(unattributed);
  const models = new Map<string, ReturnType<typeof counter>>();
  return {
    add(row: Usage, count: bigint | null, price: bigint | null) {
      let model = models.get(row.model);
      if (!model) {
        model = counter(unattributed);
        models.set(row.model, model);
      }
      model.add(count, price);
      total.add(count, price);
    },
    result() {
      return { ...total.result(), models: [...models.keys()].sort().map(model => ({ model, ...models.get(model)!.result() })) };
    },
  };
}

function rollup(provider: Provider, cache: UsageCache, projectCount: number, now: number, oversized: number) {
  // A discarded oversized line has no trustworthy timestamp, model or project.
  const ranges = periods(now).map(range => ({
    ...range, total: group(oversized), projects: Array.from({ length: projectCount }, () => group(oversized)),
  }));
  for (const row of cache.rows(provider, ranges.at(-1)!.start, now)) {
    const count = row.tokens === null ? null : BigInt(row.tokens);
    const price = row.price === null ? null : BigInt(row.price);
    for (const range of ranges) {
      if (row.at < range.start) continue;
      range.total.add(row, count, price);
      if (row.project !== null) range.projects[row.project]?.add(row, count, price);
    }
  }
  return ranges.map(({ period, total, projects }) => ({ period, ...total.result(), projects: projects.map(project => project.result()) }));
}

function localDocument(
  provider: Provider, scan: ReturnType<typeof scanProvider>, cache: UsageCache, projectCount: number, now: number, snapshotDirectory: string,
) {
  const { allowance, ...stats } = scan;
  const snapshot = provider === 'claude'
    ? readUsageSnapshot(snapshotDirectory, 'claude-statusline') : allowance ?? undefined;
  const reconciled = snapshotQuota(snapshot, now, provider === 'codex' ? 'Local rollout files' : undefined);
  const quota = { ...reconciled, entries: reconciled.entries.map(entry => ({
    ...entry, lastRemaining: snapshotLastRemaining(snapshot, entry.bucket),
  })) };
  const local: LocalUsage = {
    ...stats,
    allowanceReason: quota.entries.length ? null : provider === 'claude' ? 'no-statusline' : 'no-rate-limits',
    periods: rollup(provider, cache, projectCount, now, stats.skipReasons.oversizedLine),
  };
  return serializeUsage({
    harness: provider, quota, local,
    totals: { label: 'measured', byScope: {}, rows: [] },
    estimate: { outcome: 'estimated', label: 'estimated-api-value', scopes: [] },
  });
}

function directory(variable: string, fallback: string) {
  const path = process.env[variable] ?? fallback;
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('invalid-directory');
  return path;
}

function run() {
  const args = process.argv.slice(2);
  let projects: (string | null)[] = [];
  if (args.length) {
    if (args.length !== 1 || args[0] !== '--project-folders-stdin') throw new Error('invalid-arguments');
    const input: unknown = JSON.parse(readFileSync(0, 'utf8'));
    if (!fields(input, ['folders']) || !Array.isArray(input.folders)
      || !input.folders.every(path => path === null || (typeof path === 'string' && isAbsolute(path) && !path.includes('\0')))) {
      throw new Error('invalid-folders');
    }
    projects = input.folders;
  }
  const base = join(homedir(), 'Library', 'Application Support', 'dev.loom.desktop');
  const cacheDirectory = directory('LOOM_USAGE_CACHE_DIR', join(base, 'local-usage'));
  const snapshots = directory('LOOM_DATA_DIR', base);
  const projectFor = projectMatcher(projects);
  return withUsageCache(cacheDirectory, cache => {
    const claude = scanProvider('claude', directory('LOOM_CLAUDE_PROJECTS', join(homedir(), '.claude', 'projects')), cache, projectFor);
    const codex = scanProvider('codex', directory('LOOM_CODEX_SESSIONS', join(homedir(), '.codex', 'sessions')), cache, projectFor);
    const now = Date.now();
    const documents = {
      claude: localDocument('claude', claude, cache, projects.length, now, snapshots),
      codex: localDocument('codex', codex, cache, projects.length, now, snapshots),
    };
    if (!('schema' in documents.claude) || !('schema' in documents.codex)) throw new Error('invalid-document');
    cache.save();
    return { status: 'ready', observedAt: now, documents };
  });
}

try {
  process.stdout.write(JSON.stringify(run()) + '\n');
} catch {
  process.stdout.write('{"status":"unavailable"}\n');
}
