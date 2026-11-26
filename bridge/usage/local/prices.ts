import { createHash } from 'node:crypto';

// Copied from Ponytail Forge 5.3.2-forge.2, hooks/ponytail-band-import.js.
export const priceSource = 'https://platform.claude.com/docs/en/about-claude/pricing';
export const priceChecked = '2026-10-17';

// USD per million tokens: input, 5-minute write, 1-hour write, read, output.
const opus = [5, 6.25, 10, 0.5, 25];
const prices = new Map(Object.entries({
  'claude-fable-5-1': [10, 12.5, 20, 0.25, 50],
  'claude-fable-5': [10, 12.5, 20, 1, 50],
  'claude-opus-5-5': [4, 5, 8, 0.2, 20],
  'claude-opus-5': opus,
  'claude-opus-4-8': opus,
  'claude-opus-4-7': opus,
  'claude-opus-4-6': opus,
  'claude-opus-4-5': opus,
  'claude-sonnet-5-5': [2, 2.5, 4, 0.1, 10],
  'claude-sonnet-5': [2, 2.5, 4, 0.2, 10],
  'claude-sonnet-4-6': [3, 3.75, 6, 0.3, 15],
  'claude-sonnet-4-5': [3, 3.75, 6, 0.3, 15],
  'claude-haiku-5-5': [0.1, 0.125, 0.2, 0.01, 0.5],
  'claude-haiku-4-5': [1, 1.25, 2, 0.1, 5],
}));
const haikuLong = [0.5, 0.625, 1, 0.05, 2.5];
const searchMicros = 10_000n; // USD 10 per 1,000 searches.
const haikuThreshold = 100_000;
export const priceVersion = createHash('sha256')
  .update(JSON.stringify([[...prices], haikuLong, haikuThreshold, String(searchMicros), priceSource, priceChecked]))
  .digest('hex');

// Only release-shaped display labels travel beyond the parser. Do not echo
// private model aliases or arbitrary strings from the logs.
export const unknownModel = 'Unknown model';
const claudeModel = /^claude-(?:fable|opus|sonnet|haiku)-[1-9](?:-\d{1,2}){0,2}$/;
const codexModel = /^gpt-(?:[3-6](?:\.\d{1,2}){0,2}|4o)(?:-(?:codex|mini|nano|max|spark|sol|astra|terra|luna)){0,3}$/;
export function modelLabel(provider: 'claude' | 'codex', value: unknown) {
  if (typeof value !== 'string') return unknownModel;
  const model = value.replace(/\[(?:1m|200k)\]$/i, '').replace(/-\d{8}$/, '');
  return (provider === 'claude' ? claudeModel.test(model) : codexModel.test(model)) ? model : unknownModel;
}

export function claudePrice(model: string, tokens: number[], searches: number) {
  let rates = prices.get(model);
  if (!rates) return null;
  if (model === 'claude-haiku-5-5' && tokens.slice(0, 4).reduce((total, count) => total + count, 0) > haikuThreshold) {
    rates = haikuLong;
  }
  // Exact numerator in millionths of a currency micro-unit. Round at display aggregation.
  return tokens.reduce((total, count, index) => total + BigInt(count) * BigInt(rates[index] * 1_000_000),
    BigInt(searches) * searchMicros * 1_000_000n).toString();
}
