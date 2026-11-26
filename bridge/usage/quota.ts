import { fields, natural, text } from './input.ts';

interface QuotaSnapshot {
  provider: string;
  account: string;
  plan: string;
  bucket: string;
  windowSeconds?: number | null;
  resetAt?: number | null;
  remaining?: number | null;
  total?: number | null;
  units: string;
  semantics: 'remaining' | 'used';
  source: string;
  harness: string;
  observedAt: number;
  state: 'ok' | 'unavailable' | 'unsupported';
  credits?: number | null;
  earnedResets?: number | null;
}

const identity = ['provider', 'account', 'plan', 'bucket'] as const;
const required = [...identity, 'units', 'semantics', 'source', 'harness', 'observedAt', 'state'] as const;
const quantities = ['windowSeconds', 'resetAt', 'remaining', 'total', 'credits', 'earnedResets'] as const;
const accountingFields = [...quantities, 'semantics', 'units', 'state'] as const;
const freshnessLimitMs = 15 * 60_000;

function quantity(value: unknown): value is number | null | undefined {
  return value == null || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function wholeQuantity(value: unknown): boolean {
  return value == null || natural(value);
}

function snapshotInput(value: unknown): value is QuotaSnapshot {
  return fields(value, required, quantities)
    && [...identity, 'units', 'source', 'harness'].every(key => text(value[key]))
    && natural(value.observedAt)
    && (value.state === 'ok' || value.state === 'unavailable' || value.state === 'unsupported')
    && (value.semantics === 'remaining' || value.semantics === 'used')
    && wholeQuantity(value.windowSeconds) && wholeQuantity(value.resetAt) && wholeQuantity(value.earnedResets)
    && quantity(value.credits) && quantity(value.remaining) && quantity(value.total)
    && (value.state !== 'ok' || value.remaining == null || value.total == null || value.remaining <= value.total);
}

interface Bucket {
  latest: QuotaSnapshot[];
  sources: Set<string>;
  harnesses: Set<string>;
}

function reconcileBucket(bucket: Bucket, now: number) {
  const latest = bucket.latest[0]!;
  const agreed = <K extends keyof QuotaSnapshot>(key: K) => {
    const value = latest[key] ?? null;
    return bucket.latest.every(snapshot => (snapshot[key] ?? null) === value) ? value : null;
  };
  const resetAt = agreed('resetAt');
  const total = agreed('total');
  const semantics = agreed('semantics');
  const units = agreed('units');
  const conflict = bucket.latest.some(snapshot =>
    accountingFields.some(key => (snapshot[key] ?? null) !== (latest[key] ?? null)));
  const state = conflict ? 'conflict' as const : latest.state;
  const freshness = now - latest.observedAt > freshnessLimitMs
    || bucket.latest.some(snapshot => snapshot.resetAt != null && now >= snapshot.resetAt)
    ? 'stale' as const : 'fresh' as const;
  const raw = agreed('remaining');
  let remaining = null;
  if (state === 'ok' && freshness === 'fresh' && raw !== null) {
    if (semantics === 'remaining') remaining = raw;
    if (semantics === 'used' && total !== null) remaining = total - raw;
  }
  const remainingPercent = remaining !== null && total !== null && total > 0
    ? Math.round(remaining <= Number.MAX_VALUE / 100 ? (remaining * 100) / total : remaining / (total / 100))
    : null;
  return {
    label: 'plan-allowance' as const,
    provider: latest.provider, account: latest.account, plan: latest.plan, bucket: latest.bucket,
    windowSeconds: agreed('windowSeconds'), resetAt, remaining, remainingPercent, total, units, semantics,
    observedAt: latest.observedAt, state, freshness,
    sources: [...bucket.sources].sort(), harnesses: [...bucket.harnesses].sort(),
    credits: agreed('credits'), earnedResets: agreed('earnedResets'),
  };
}

export function reconcileQuota(snapshots: unknown, now: unknown) {
  if (!Array.isArray(snapshots) || !natural(now)) return { outcome: 'refused', reason: 'invalid-quota' } as const;
  const buckets = new Map<string, Bucket>();
  for (const snapshot of snapshots) {
    if (!snapshotInput(snapshot) || snapshot.observedAt > now) {
      return { outcome: 'refused', reason: 'invalid-quota' } as const;
    }
    const key = JSON.stringify(identity.map(field => snapshot[field]));
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { latest: [], sources: new Set(), harnesses: new Set() };
      buckets.set(key, bucket);
    }
    const observedAt = bucket.latest[0]?.observedAt;
    if (observedAt === undefined || snapshot.observedAt > observedAt) bucket.latest = [snapshot];
    else if (snapshot.observedAt === observedAt) bucket.latest.push(snapshot);
    bucket.sources.add(snapshot.source);
    bucket.harnesses.add(snapshot.harness);
  }
  return { outcome: 'reconciled' as const, entries: [...buckets.values()].map(bucket => reconcileBucket(bucket, now)) };
}
