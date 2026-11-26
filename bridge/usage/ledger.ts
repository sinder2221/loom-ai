import { eachTier, fields, isScope, natural, text, tiers, usageInput } from './input.ts';
import type { Scope, Usage } from './input.ts';

export interface UsageTotal {
  source: string;
  scope: Scope;
  model: string;
  observedAt: number;
  usage: Usage;
}

interface Observation extends UsageTotal {
  counterId: string;
  kind: 'delta' | 'cumulative';
  seq: number;
  reset: boolean;
}

const measuredFields = ['source', 'scope', 'model', 'observedAt', 'usage'] as const;

type UsageTotalInput = Omit<UsageTotal, 'usage'> & { usage: Record<keyof Usage, bigint | number> };

function measuredInput(value: Record<string, unknown>): value is Record<string, unknown> & UsageTotalInput {
  return text(value.source) && isScope(value.scope) && text(value.model)
    && natural(value.observedAt) && usageInput(value.usage);
}

export function totalInput(value: unknown): value is UsageTotalInput {
  return fields(value, measuredFields) && measuredInput(value);
}

function readObservation(value: unknown): Observation | null {
  if (!fields(value, [...measuredFields, 'counterId', 'kind', 'seq'], ['reset']) || !measuredInput(value)
    || !text(value.counterId) || !natural(value.seq)
    || (value.kind !== 'delta' && value.kind !== 'cumulative')
    || (Object.hasOwn(value, 'reset') && typeof value.reset !== 'boolean')
    || (value.kind === 'delta' && value.reset === true)) return null;
  const { source, scope, model, observedAt, usage, counterId, kind, seq, reset } = value;
  return { source, scope, model, observedAt, usage: eachTier(tier => BigInt(usage[tier])),
    counterId, kind, seq, reset: reset === true };
}

type QuarantineReason = 'conflicting-observation' | 'counter-mismatch' | 'undeclared-reset' | 'uncertain-baseline';

interface Entry {
  observation: Observation;
  increment: Usage | null;
  quarantine: QuarantineReason | null;
}

interface Counter {
  source: string;
  scope: Scope;
  kind: Observation['kind'];
  lastSeq: number;
  baseline: Observation | null;
  blocked: boolean;
  entries: Map<number, Entry>;
}

export interface Ledger {
  totals(): {
    label: 'measured';
    rows: UsageTotal[];
    byScope: Partial<Record<Scope, { model: string; usage: Usage }[]>>;
  };
}

const ledgers = new WeakMap<Ledger, Map<string, Counter>>();

export function createLedger(): Ledger {
  const counters = new Map<string, Counter>();
  const ledger: Ledger = {
    totals() {
      const rows: UsageTotal[] = [];
      const summaries = new Map<Scope, Map<string, Usage>>();
      for (const counter of counters.values()) {
        for (const { observation, increment } of counter.entries.values()) {
          if (increment === null) continue;
          const { source, scope, model, observedAt } = observation;
          rows.push({ source, scope, model, observedAt, usage: { ...increment } });
          const models = summaries.get(scope) ?? new Map<string, Usage>();
          const previous = models.get(model);
          models.set(model, eachTier(tier => (previous?.[tier] ?? 0n) + increment[tier]));
          summaries.set(scope, models);
        }
      }
      const byScope = Object.fromEntries([...summaries].map(([scope, models]) => [
        scope, [...models].map(([model, usage]) => ({ model, usage })),
      ]));
      return { label: 'measured', rows, byScope };
    },
  };
  ledgers.set(ledger, counters);
  return ledger;
}

type ApplyResult = { outcome: 'applied'; reset: boolean } | { outcome: 'replayed' }
  | { outcome: 'ignored'; reason: 'out-of-order' }
  | { outcome: 'quarantined'; reason: QuarantineReason }
  | { outcome: 'refused'; reason: 'invalid-observation' | 'invalid-ledger' };

function invalidate(counter: Counter, seq: number) {
  const entry = counter.entries.get(seq)!;
  entry.quarantine = 'conflicting-observation';
  entry.increment = null;
  if (counter.kind === 'delta') return;

  for (const [laterSeq, later] of counter.entries) {
    if (laterSeq <= seq) continue;
    if (later.observation.reset && later.increment !== null) return;
    later.increment = null;
    later.quarantine ??= 'uncertain-baseline';
  }
  counter.baseline = null;
  counter.blocked = true;
}

export function applyObservation(ledger: unknown, value: unknown): ApplyResult {
  const counters = ledgers.get(ledger as Ledger);
  if (!counters) return { outcome: 'refused', reason: 'invalid-ledger' };
  const observation = readObservation(value);
  if (!observation) return { outcome: 'refused', reason: 'invalid-observation' };

  const { counterId, source, scope, kind, seq, model, observedAt, usage, reset } = observation;
  let counter = counters.get(counterId);
  if (!counter) {
    counter = { source, scope, kind, lastSeq: -1, baseline: null, blocked: false, entries: new Map() };
    counters.set(counterId, counter);
  }
  const bindingMatches = counter.source === source && counter.scope === scope && counter.kind === kind;
  const prior = counter.entries.get(seq);
  if (prior) {
    if (prior.quarantine === 'conflicting-observation') return { outcome: 'quarantined', reason: prior.quarantine };
    const recorded = prior.observation;
    const countsDiffer = tiers.some(tier => usage[tier] !== recorded.usage[tier]);
    const metadataDiffers = recorded.model !== model || recorded.observedAt !== observedAt || recorded.reset !== reset;
    if (countsDiffer || (bindingMatches && metadataDiffers)) {
      invalidate(counter, seq);
      return { outcome: 'quarantined', reason: 'conflicting-observation' };
    }
    if (bindingMatches) {
      return prior.quarantine ? { outcome: 'quarantined', reason: prior.quarantine } : { outcome: 'replayed' };
    }
  }
  if (!bindingMatches) {
    return { outcome: 'quarantined', reason: 'counter-mismatch' };
  }
  if (seq <= counter.lastSeq) return { outcome: 'ignored', reason: 'out-of-order' };

  const entry: Entry = { observation, increment: null, quarantine: null };
  counter.entries.set(seq, entry);
  counter.lastSeq = seq;
  const baseline = kind === 'cumulative' && !reset ? counter.baseline : null;
  if (kind === 'cumulative' && counter.blocked && !reset) {
    entry.quarantine = 'uncertain-baseline';
    return { outcome: 'quarantined', reason: entry.quarantine };
  }
  if (baseline && (baseline.model !== model || tiers.some(tier => usage[tier] < baseline.usage[tier]))) {
    counter.baseline = null;
    counter.blocked = true;
    entry.quarantine = baseline.model !== model ? 'counter-mismatch' : 'undeclared-reset';
    return { outcome: 'quarantined', reason: entry.quarantine };
  }

  entry.increment = baseline ? eachTier(tier => usage[tier] - baseline.usage[tier]) : usage;
  if (kind === 'cumulative') {
    counter.baseline = observation;
    counter.blocked = false;
  }
  return { outcome: 'applied', reset };
}
