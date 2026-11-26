type Data = Record<string, unknown>;

export function data(value: unknown): value is Data {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return (prototype === Object.prototype || prototype === null)
    && Reflect.ownKeys(value).every(key => typeof key === 'string'
      && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, 'value'));
}

export function fields(value: unknown, required: readonly string[], optional: readonly string[] = []): value is Data {
  return data(value) && required.every(key => Object.hasOwn(value, key))
    && Object.getOwnPropertyNames(value).every(key => required.includes(key) || optional.includes(key));
}

export function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value.isWellFormed() && !/\p{Cc}/u.test(value);
}

export function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function count(value: unknown): value is bigint | number {
  return typeof value === 'bigint' ? value >= 0n : natural(value);
}

export const tiers = ['input', 'cacheRead', 'cacheWrite', 'output', 'reasoning'] as const;
export type Tier = (typeof tiers)[number];
export type Usage = Record<Tier, bigint>;

export function usageInput(value: unknown): value is Record<Tier, bigint | number> {
  return fields(value, tiers) && tiers.every(tier => count(value[tier]));
}

export function eachTier<T>(get: (tier: Tier) => T): Record<Tier, T> {
  return { input: get('input'), cacheRead: get('cacheRead'), cacheWrite: get('cacheWrite'),
    output: get('output'), reasoning: get('reasoning') };
}

export const scopes = ['request', 'turn', 'session', 'account'] as const;
export type Scope = (typeof scopes)[number];

export function isScope(value: unknown): value is Scope {
  return scopes.some(scope => scope === value);
}
