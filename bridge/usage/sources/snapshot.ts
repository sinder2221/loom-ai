import { fields, natural } from '../input.ts';

export const claudeWindows = ['five_hour', 'seven_day'] as const;
export const codexWindows = ['primary', 'secondary'] as const;

interface WindowReading {
  usedPercent?: number;
  resetsAt?: number;
  windowSeconds?: number;
}

interface ClaudeSnapshot {
  source: 'claude-statusline';
  observedAt: number;
  windows: Partial<Record<typeof claudeWindows[number], WindowReading>>;
}

interface CodexSnapshot {
  source: 'codex-rate-limits';
  observedAt: number;
  windows: Partial<Record<typeof codexWindows[number], WindowReading>>;
  credits?: number;
  earnedResets?: number;
}

export type UsageSnapshot = ClaudeSnapshot | CodexSnapshot;
export const unavailable = 'unavailable' as const;

export function quantity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function percentage(value: unknown): value is number {
  return quantity(value) && value <= 100;
}

function epochSeconds(value: unknown): value is number {
  return natural(value) && value <= 8_640_000_000_000;
}

function positiveWhole(value: unknown): value is number {
  return natural(value) && value > 0;
}

export function windowReading(usedPercent: unknown, resetsAt: unknown, windowSeconds?: unknown) {
  const window: WindowReading = {};
  if (percentage(usedPercent)) window.usedPercent = usedPercent;
  if (epochSeconds(resetsAt)) window.resetsAt = resetsAt;
  if (positiveWhole(windowSeconds)) window.windowSeconds = windowSeconds;
  if (Object.keys(window).length > 0) return window;
}

function validWindow(value: unknown, codex: boolean) {
  return fields(value, [], codex ? ['usedPercent', 'resetsAt', 'windowSeconds'] : ['usedPercent', 'resetsAt'])
    && Object.keys(value).length > 0
    && (!Object.hasOwn(value, 'usedPercent') || percentage(value.usedPercent))
    && (!Object.hasOwn(value, 'resetsAt') || epochSeconds(value.resetsAt))
    && (!Object.hasOwn(value, 'windowSeconds') || positiveWhole(value.windowSeconds));
}

export function isSnapshot(value: unknown): value is UsageSnapshot {
  if (!fields(value, ['source', 'observedAt', 'windows'], ['credits', 'earnedResets']) || !natural(value.observedAt)) {
    return false;
  }
  const codex = value.source === 'codex-rate-limits';
  return (codex || value.source === 'claude-statusline')
    && (!Object.hasOwn(value, 'credits') || (codex && quantity(value.credits)))
    && (!Object.hasOwn(value, 'earnedResets') || (codex && natural(value.earnedResets)))
    && fields(value.windows, [], codex ? codexWindows : claudeWindows)
    && Object.values(value.windows).every(window => validWindow(window, codex));
}
