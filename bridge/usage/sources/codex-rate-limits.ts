import { data, natural } from '../input.ts';
import { codexWindows, quantity, unavailable, windowReading, type UsageSnapshot } from './snapshot.ts';

type CodexSnapshot = Extract<UsageSnapshot, { source: 'codex-rate-limits' }>;
type RateLimitsTransport = {
  rpc(method: 'account/rateLimits/read', params: { excludeResetCreditDetails: true }): Promise<unknown>;
};

export function parseCodexRateLimits(reply: unknown, observedAt = Date.now()): CodexSnapshot | typeof unavailable {
  if (!data(reply) || !data(reply.rateLimits) || !natural(observedAt)) return unavailable;
  const limits = reply.rateLimits;
  const snapshot: CodexSnapshot = { observedAt, source: 'codex-rate-limits', windows: {} };
  for (const key of codexWindows) {
    const value = limits[key];
    if (!data(value)) continue;
    const duration = natural(value.windowDurationMins) ? value.windowDurationMins * 60 : undefined;
    const used = natural(value.usedPercent) ? value.usedPercent : undefined;
    const window = windowReading(used, value.resetsAt, duration);
    if (window) snapshot.windows[key] = window;
  }
  const balance = data(limits.credits) ? limits.credits.balance : undefined;
  if (typeof balance === 'string' && /^\d+(?:\.\d+)?$/.test(balance)) {
    const credits = Number(balance);
    if (quantity(credits)) snapshot.credits = credits;
  }
  const resets = reply.rateLimitResetCredits;
  if (data(resets) && natural(resets.availableCount)) snapshot.earnedResets = resets.availableCount;
  if (Object.keys(snapshot.windows).length === 0 && snapshot.credits === undefined && snapshot.earnedResets === undefined) {
    return unavailable;
  }
  return snapshot;
}

export async function readCodexRateLimits(transport: RateLimitsTransport) {
  try {
    const reply = await transport.rpc('account/rateLimits/read', { excludeResetCreditDetails: true });
    return parseCodexRateLimits(reply);
  } catch {
    return unavailable;
  }
}
