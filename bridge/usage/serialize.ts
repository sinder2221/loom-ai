import { fields, natural, scopes, text, tiers } from './input.ts';
import { skipReasons, type Skips } from './local/diagnostics.ts';
import type { createLedger, estimateValue, reconcileQuota } from './index.ts';

type Quota = Extract<ReturnType<typeof reconcileQuota>, { outcome: 'reconciled' }>;
type Totals = ReturnType<ReturnType<typeof createLedger>['totals']>;
type Estimate = Extract<ReturnType<typeof estimateValue>, { outcome: 'estimated' }>;
type LocalAmounts = {
  tokens: bigint | null;
  estimatedMicros: bigint | null;
  pricedMicros: bigint | null;
  pricedTokens: bigint;
  pricedObservations: number;
  observations: number;
  unreadableReadings: number;
};
type LocalGroup = LocalAmounts & { models: (LocalAmounts & { model: string })[] };
export type LocalUsage = {
  available: boolean;
  skipped: number;
  skipReasons: Skips;
  scanned: number;
  reused: number;
  allowanceReason: 'no-statusline' | 'no-rate-limits' | null;
  periods: (LocalGroup & { period: 'today' | 'last7' | 'last30'; projects: LocalGroup[] })[];
};
type QuotaView = Omit<Quota, 'entries'> & { entries: (Quota['entries'][number] & { lastRemaining?: number | null })[] };
type UsageInput = { harness: string; quota: QuotaView; totals: Totals; estimate: Estimate; local?: LocalUsage };
type JsonSafe<T> = T extends bigint ? string : T extends object ? { [K in keyof T]: JsonSafe<T[K]> } : T;
type UsageView = JsonSafe<{ schema: 1 } & UsageInput>;
type Refusal = { outcome: 'refused'; reason: 'invalid-usage-view' | 'sensitive-label' };
type Check = (value: unknown) => boolean;

function record(required: Record<string, Check>, optional: Record<string, Check> = {}): Check {
  return value => fields(value, Object.keys(required), Object.keys(optional))
    && Object.keys(value).length === Object.getOwnPropertyNames(value).length
    && Object.entries(required).every(([key, check]) => check(value[key]))
    && Object.entries(optional).every(([key, check]) => !Object.hasOwn(value, key) || check(value[key]));
}

function list(check: Check): Check {
  return value => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype
      || Reflect.ownKeys(value).length !== value.length + 1) return false;
    for (let index = 0; index < value.length; index++) {
      const entry = Object.getOwnPropertyDescriptor(value, index);
      if (!entry || !Object.hasOwn(entry, 'value') || !check(entry.value)) return false;
    }
    return true;
  };
}

const oneOf = (...choices: string[]): Check => value => choices.some(choice => choice === value);
const nullable = (check: Check): Check => value => value === null || check(value);
const boolean: Check = value => typeof value === 'boolean';
const quantity: Check = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const integer: Check = value => typeof value === 'bigint' && value >= 0n;
const scope = oneOf(...scopes);
const usage = record(Object.fromEntries(tiers.map(tier => [tier, integer])));
const quotaEntry = record({
  label: oneOf('plan-allowance'),
  provider: text, account: text, plan: text, bucket: text,
  windowSeconds: nullable(natural), resetAt: nullable(natural),
  remaining: nullable(quantity), remainingPercent: nullable(natural), total: nullable(quantity),
  units: nullable(text), semantics: nullable(oneOf('remaining', 'used')), observedAt: natural,
  state: oneOf('ok', 'conflict', 'unavailable', 'unsupported'), freshness: oneOf('fresh', 'stale'),
  sources: list(text), harnesses: list(text), credits: nullable(quantity), earnedResets: nullable(natural),
}, { lastRemaining: nullable(value => quantity(value) && (value as number) <= 100) });
const measuredModel = record({ model: text, usage });
const provenance = { currency: text, source: text, effectiveFrom: natural };
const pricePart = record({
  tokens: integer,
  value: nullable(record({ numerator: integer, denominator: integer })),
  reason: nullable(oneOf('unknown-model', 'missing-rate', 'missing-tier')),
});
const estimateScope = record({
  scope,
  coverage: record({
    kind: oneOf('account', 'observed-scope', 'handoff-coverage'), pricedTokens: integer, totalTokens: integer,
  }),
  rows: list(record({
    source: text, model: text, observedAt: natural, rate: nullable(record(provenance)),
    tiers: record(Object.fromEntries(tiers.map(tier => [tier, pricePart]))),
  })),
  currencies: list(record({ currency: text, value: integer, rates: list(record(provenance)) })),
});
const localAmounts = {
  tokens: nullable(integer), estimatedMicros: nullable(integer), pricedMicros: nullable(integer),
  pricedTokens: integer, pricedObservations: natural, observations: natural, unreadableReadings: natural,
};
const localGroup = { ...localAmounts, models: list(record({ ...localAmounts, model: text })) };
const localUsage = record({
  available: boolean, skipped: natural, scanned: natural, reused: natural,
  skipReasons: record(Object.fromEntries(skipReasons.map(reason => [reason, natural]))),
  allowanceReason: nullable(oneOf('no-statusline', 'no-rate-limits')),
  periods: list(record({ ...localGroup, period: oneOf('today', 'last7', 'last30'), projects: list(record(localGroup)) })),
});
const usageInput = record({
  harness: text,
  quota: record({ outcome: oneOf('reconciled'), entries: list(quotaEntry) }),
  totals: record({
    label: oneOf('measured'),
    byScope: record({}, Object.fromEntries(scopes.map(key => [key, list(measuredModel)]))),
    rows: list(record({ source: text, scope, model: text, observedAt: natural, usage })),
  }),
  estimate: record({ outcome: oneOf('estimated'), label: oneOf('estimated-api-value'), scopes: list(estimateScope) }),
}, { local: localUsage });

function sensitiveLabel(value: string): boolean {
  const label = value.trim();
  return [...value].length > 120
    || /^(?:[~/]|[a-z]:|sk-|ghp_|xox|AKIA|Bearer)/i.test(label)
    || label.includes('\\') || label.includes('://')
    || (label.length >= 32 && /^[a-z0-9+/_-]+={0,2}$/i.test(label));
}

export function serializeUsage(value: unknown): UsageView | Refusal {
  if (!usageInput(value)) return { outcome: 'refused', reason: 'invalid-usage-view' };
  const input = value as UsageInput;
  let sensitive = false;
  const json = JSON.stringify({ schema: 1, ...input }, (_key, field: unknown) => {
    if (typeof field === 'bigint') return field.toString();
    if (typeof field === 'string' && sensitiveLabel(field)) {
      sensitive = true;
      return undefined;
    }
    return field;
  });
  if (sensitive) return { outcome: 'refused', reason: 'sensitive-label' };
  if (input.quota.entries.some(entry => !entry.harnesses.includes(input.harness))) {
    return { outcome: 'refused', reason: 'invalid-usage-view' };
  }
  return JSON.parse(json) as UsageView;
}
