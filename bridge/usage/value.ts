import { count, data, eachTier, fields, natural, text, tiers } from './input.ts';
import type { Scope, Tier } from './input.ts';
import { totalInput } from './ledger.ts';

interface RateProvenance {
  currency: string;
  source: string;
  effectiveFrom: number;
}

interface Rate extends RateProvenance {
  model: string;
  perMillion: Partial<Record<Tier, number | bigint>>;
}

interface ValueOptions {
  providerBySource: Record<string, string>;
  inputIncludesCache: Record<string, boolean>;
  outputIncludesReasoning?: Record<string, boolean>;
  handoffCoverage?: boolean;
}

function rateInput(value: unknown): value is Rate {
  if (!fields(value, ['model', 'currency', 'effectiveFrom', 'source', 'perMillion'])) return false;
  const { model, currency, effectiveFrom, source, perMillion } = value;
  return text(model) && typeof currency === 'string' && /^[A-Z]{3}$/.test(currency)
    && natural(effectiveFrom) && text(source)
    && fields(perMillion, [], tiers) && Object.getOwnPropertyNames(perMillion).every(tier => count(perMillion[tier]));
}

function booleanMap(value: unknown): value is Record<string, boolean> {
  return data(value) && Object.getOwnPropertyNames(value).every(key => text(key) && typeof value[key] === 'boolean');
}

function optionsInput(value: unknown): value is ValueOptions {
  if (!fields(value, ['providerBySource', 'inputIncludesCache'], ['outputIncludesReasoning', 'handoffCoverage'])) return false;
  const { providerBySource } = value;
  return data(providerBySource)
    && Object.getOwnPropertyNames(providerBySource).every(key => text(key) && text(providerBySource[key]))
    && booleanMap(value.inputIncludesCache)
    && (!Object.hasOwn(value, 'outputIncludesReasoning') || booleanMap(value.outputIncludesReasoning))
    && (!Object.hasOwn(value, 'handoffCoverage') || typeof value.handoffCoverage === 'boolean');
}

const million = 1_000_000n;

type PricePart = {
  tokens: bigint;
  value: { numerator: bigint; denominator: bigint } | null;
  reason: 'unknown-model' | 'missing-rate' | 'missing-tier' | null;
};

interface ValueRow {
  source: string;
  model: string;
  observedAt: number;
  rate: RateProvenance | null;
  tiers: Record<Tier, PricePart>;
}

interface ScopeValue {
  rows: ValueRow[];
  pricedTokens: bigint;
  totalTokens: bigint;
  currencies: Map<string, { numerator: bigint; rates: Map<string, RateProvenance> }>;
}

export function estimateValue(totals: unknown, rates: unknown, options: unknown) {
  if (!Array.isArray(totals) || !Array.isArray(rates) || !optionsInput(options)) {
    return { outcome: 'refused', reason: 'invalid-estimate' } as const;
  }

  const histories = new Map<string, Rate[]>();
  for (const rate of rates) {
    if (!rateInput(rate)) return { outcome: 'refused', reason: 'invalid-rate' } as const;
    const history = histories.get(rate.model) ?? [];
    if (history.some(prior => prior.effectiveFrom === rate.effectiveFrom)) {
      return { outcome: 'refused', reason: 'ambiguous-rate' } as const;
    }
    history.push(rate);
    histories.set(rate.model, history);
  }
  for (const history of histories.values()) {
    history.sort((a, b) => b.effectiveFrom - a.effectiveFrom);
  }

  const scopes = new Map<Scope, ScopeValue>();
  for (const row of totals) {
    if (!totalInput(row)) return { outcome: 'refused', reason: 'invalid-total' } as const;
    const { source, scope, observedAt, model, usage } = row;
    if (!Object.hasOwn(options.providerBySource, source)) {
      return { outcome: 'refused', reason: 'missing-token-semantics' } as const;
    }
    const provider = options.providerBySource[source]!;
    if (!Object.hasOwn(options.inputIncludesCache, provider)) {
      return { outcome: 'refused', reason: 'missing-token-semantics' } as const;
    }

    const tokens = eachTier(tier => BigInt(usage[tier]));
    if (options.inputIncludesCache[provider]) tokens.input -= tokens.cacheRead + tokens.cacheWrite;
    const reasoningFlags = options.outputIncludesReasoning;
    if (reasoningFlags && Object.hasOwn(reasoningFlags, provider) && reasoningFlags[provider]) {
      tokens.output -= tokens.reasoning;
    }
    if (tokens.input < 0n || tokens.output < 0n) {
      return { outcome: 'refused', reason: 'invalid-token-subcounts' } as const;
    }

    const history = histories.get(model);
    const rate = history?.find(candidate => candidate.effectiveFrom <= observedAt);
    const provenance = rate ? { currency: rate.currency, source: rate.source, effectiveFrom: rate.effectiveFrom } : null;
    const unpricedReason = !history ? 'unknown-model' : rate ? 'missing-tier' : 'missing-rate';
    const group: ScopeValue = scopes.get(scope) ?? { rows: [], pricedTokens: 0n, totalTokens: 0n, currencies: new Map() };
    scopes.set(scope, group);
    const parts = eachTier<PricePart>(tier => {
      const amount = tokens[tier];
      const price = rate && Object.hasOwn(rate.perMillion, tier) ? rate.perMillion[tier] : undefined;
      const value = price === undefined ? null : { numerator: amount * BigInt(price), denominator: million };
      return { tokens: amount, value, reason: value === null ? unpricedReason : null };
    });
    group.rows.push({ source, model, observedAt, rate: provenance, tiers: parts });

    for (const { tokens: amount, value } of Object.values(parts)) {
      group.totalTokens += amount;
      if (value === null || provenance === null || amount === 0n) continue;
      group.pricedTokens += amount;
      const { currency, source: rateSource, effectiveFrom } = provenance;
      const sum = group.currencies.get(currency) ?? { numerator: 0n, rates: new Map() };
      sum.numerator += value.numerator;
      sum.rates.set(JSON.stringify([rateSource, effectiveFrom]), provenance);
      group.currencies.set(currency, sum);
    }
  }

  return {
    outcome: 'estimated' as const,
    label: 'estimated-api-value' as const,
    scopes: [...scopes].map(([scope, { rows, pricedTokens, totalTokens, currencies }]) => ({
      scope,
      coverage: {
        kind: scope === 'account' ? 'account' as const
          : options.handoffCoverage ? 'handoff-coverage' as const : 'observed-scope' as const,
        pricedTokens, totalTokens,
      },
      rows,
      currencies: [...currencies].map(([currency, { numerator, rates: applied }]) => ({
        currency, value: (numerator + million / 2n) / million, rates: [...applied.values()],
      })),
    })),
  };
}
