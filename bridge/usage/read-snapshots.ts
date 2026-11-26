import { reconcileQuota } from './quota.ts';
import { serializeUsage } from './serialize.ts';
import { claudeWindows, codexWindows, unavailable, type UsageSnapshot } from './sources/snapshot.ts';
import { readUsageSnapshot } from './sources/store.ts';

const claudeBuckets = {
  five_hour: { bucket: '5 hours', windowSeconds: 5 * 3600 },
  seven_day: { bucket: 'Weekly', windowSeconds: 7 * 86400 },
};
const codexBuckets = { primary: 'Primary window', secondary: 'Secondary window' };

export function snapshotLastRemaining(snapshot: UsageSnapshot | undefined, bucket: string) {
  if (snapshot?.source === 'claude-statusline') {
    const key = claudeWindows.find(key => claudeBuckets[key].bucket === bucket);
    const used = key === undefined ? undefined : snapshot.windows[key]?.usedPercent;
    return used === undefined ? null : 100 - used;
  }
  const key = codexWindows.find(key => codexBuckets[key] === bucket);
  const used = key === undefined ? undefined : snapshot?.windows[key]?.usedPercent;
  return used === undefined ? null : 100 - used;
}

export function snapshotQuota(snapshot: UsageSnapshot | undefined, now: number, source?: string) {
  if (!snapshot) return { outcome: 'reconciled' as const, entries: [] };
  const claude = snapshot.source === 'claude-statusline';
  const harness = claude ? 'claude' : 'codex';
  const common = {
    provider: harness, harness, account: 'Unknown', plan: 'Unknown',
    source: source ?? (claude ? 'Claude Code status line' : 'Codex App Server'), observedAt: snapshot.observedAt,
    state: 'ok',
  };
  const windows = snapshot.source === 'claude-statusline'
    ? claudeWindows.map(key => ({ ...claudeBuckets[key], reading: snapshot.windows[key] }))
    : codexWindows.map(key => ({
      bucket: codexBuckets[key], windowSeconds: snapshot.windows[key]?.windowSeconds, reading: snapshot.windows[key],
    }));
  const quotas: unknown[] = windows.flatMap(({ bucket, windowSeconds, reading }) => reading ? [{
    ...common, bucket, windowSeconds, units: '%', semantics: 'used', total: 100, remaining: reading.usedPercent,
    resetAt: reading.resetsAt === undefined ? null : reading.resetsAt * 1000,
  }] : []);
  if (snapshot.source === 'codex-rate-limits' && (snapshot.credits !== undefined || snapshot.earnedResets !== undefined)) {
    quotas.push({
      ...common, bucket: 'Credits', units: 'credits', semantics: 'remaining',
      credits: snapshot.credits, earnedResets: snapshot.earnedResets,
    });
  }
  const quota = reconcileQuota(quotas, now);
  return quota.outcome === 'reconciled' ? quota : { outcome: 'reconciled' as const, entries: [] };
}

function document(snapshot: UsageSnapshot | undefined, now: number) {
  const quota = snapshotQuota(snapshot, now);
  if (!snapshot || quota.entries.length === 0) return unavailable;
  const harness = snapshot.source === 'claude-statusline' ? 'claude' : 'codex';
  const result = serializeUsage({
    harness, quota, totals: { label: 'measured', byScope: {}, rows: [] },
    estimate: { outcome: 'estimated', label: 'estimated-api-value', scopes: [] },
  });
  return 'schema' in result ? result : unavailable;
}

export function readUsageSnapshots(directory?: string, now = Date.now()) {
  if (directory === undefined) return { claude: unavailable, codex: unavailable };
  return {
    claude: document(readUsageSnapshot(directory, 'claude-statusline'), now),
    codex: document(readUsageSnapshot(directory, 'codex-rate-limits'), now),
  };
}
