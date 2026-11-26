import { data, natural } from '../input.ts';
import { codexWindows, windowReading, type UsageSnapshot } from '../sources/snapshot.ts';
import { claudePrice, modelLabel, unknownModel } from './prices.ts';
import type { SkipReason } from './diagnostics.ts';

export type Provider = 'claude' | 'codex';
export type CodexSnapshot = Extract<UsageSnapshot, { source: 'codex-rate-limits' }>;
export type Key = (kind: string, value: string) => string;
export type Position = { offset: number; length: number };
export type ClaimedUsage = { at: number; cwd: string | null; model: string; tokens: string | null; price: string | null };
export type CodexReading = Omit<ClaimedUsage, 'tokens' | 'price'> & { total: number | null; last: number | null };
export type FileMetadata = { allowance: CodexSnapshot | null; session: string | null; forked: boolean; forkAt: number | null };
export type Sink = {
  key: Key;
  cwd(value: unknown, position: Position): string | null;
  reply(id: string, row: ClaimedUsage): void;
  reading(row: CodexReading): void;
};

const optionalCount = (value: unknown) => value === undefined ? 0 : natural(value) ? value : null;

function time(value: unknown) {
  // Provider timestamps include a UTC offset. Calendar boundaries are applied separately.
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/i.test(value)) return;
  const at = Date.parse(value);
  if (natural(at)) return at;
}

function claudeCounts(usage: unknown) {
  if (!data(usage) || !natural(usage.input_tokens) || !natural(usage.output_tokens)) return;
  const cache = usage.cache_creation;
  if (cache != null && !data(cache)) return;
  const split = data(cache) && (cache.ephemeral_5m_input_tokens !== undefined || cache.ephemeral_1h_input_tokens !== undefined);
  const write = optionalCount(usage.cache_creation_input_tokens);
  const five = optionalCount(split ? cache.ephemeral_5m_input_tokens : usage.cache_creation_input_tokens);
  const hour = optionalCount(split ? cache.ephemeral_1h_input_tokens : undefined);
  const read = optionalCount(usage.cache_read_input_tokens);
  if (write === null || five === null || hour === null || read === null) return;
  const splitTotal = BigInt(five) + BigInt(hour);
  const aggregate = usage.cache_creation_input_tokens === undefined ? splitTotal : BigInt(write);
  const tokens = BigInt(usage.input_tokens) + aggregate + BigInt(read) + BigInt(usage.output_tokens);
  const tools = usage.server_tool_use;
  const searches = tools == null ? 0 : data(tools) ? optionalCount(tools.web_search_requests) : null;
  return {
    tokens: tokens.toString(),
    counts: [usage.input_tokens, five, hour, read, usage.output_tokens],
    searches,
    priced: splitTotal === aggregate && usage.speed !== 'fast',
  };
}

export function claudeParser(sink: Sink) {
  return {
    line(record: unknown, position: Position): SkipReason | undefined {
      if (!data(record) || typeof record.type !== 'string') return 'invalidRecord';
      if (record.type !== 'assistant') return;
      if (!data(record.message)) return 'invalidRecord';
      const message = record.message;
      // Local synthetic and interim assistant records do not report usage.
      if (message.model === '<synthetic>' || message.usage == null) return;
      const at = time(record.timestamp);
      if (at === undefined) return 'invalidTimestamp';
      if (typeof message.id !== 'string' || !message.id.length) return 'invalidRecord';
      const model = modelLabel('claude', message.model);
      const usage = claudeCounts(message.usage);
      sink.reply(sink.key('claude-message', message.id), {
        at, model, cwd: sink.cwd(record.cwd, position),
        tokens: usage?.tokens ?? null,
        price: usage?.priced && usage.searches !== null ? claudePrice(model, usage.counts, usage.searches) : null,
      });
      if (!usage || usage.searches === null) return 'invalidUsage';
    },
    result(): FileMetadata { return { allowance: null, session: null, forked: false, forkAt: null }; },
  };
}

function codexAllowance(limits: Record<string, unknown>, observedAt: number): CodexSnapshot {
  const snapshot: CodexSnapshot = { source: 'codex-rate-limits', observedAt, windows: {} };
  for (const name of codexWindows) {
    const reading = limits[name];
    if (!data(reading)) continue;
    const seconds = natural(reading.window_minutes) ? reading.window_minutes * 60 : undefined;
    const window = windowReading(reading.used_percent, reading.resets_at, seconds);
    if (window) snapshot.windows[name] = window;
  }
  const raw = data(limits.credits) ? limits.credits.balance : undefined;
  const credits = typeof raw === 'string' && /^\d+(?:\.\d+)?$/.test(raw) ? Number(raw) : raw;
  if (typeof credits === 'number' && Number.isFinite(credits) && credits >= 0) snapshot.credits = credits;
  return snapshot;
}

function inheritedSession(payload: Record<string, unknown>) {
  const source = payload.source;
  const spawn = data(source) && data(source.subagent) ? source.subagent.thread_spawn : undefined;
  return [payload.forked_from_id, payload.parent_thread_id, data(spawn) ? spawn.parent_thread_id : undefined]
    .some(id => typeof id === 'string' && id.length > 0);
}

export function codexParser(sink: Sink, file: string) {
  let cwd: string | null = null;
  let model = unknownModel;
  let session = file;
  let forked = false;
  let forkAt: number | null = null;
  let allowance: CodexSnapshot | null = null;
  return {
    line(record: unknown, position: Position): SkipReason | undefined {
      if (!data(record) || typeof record.type !== 'string') return 'invalidRecord';
      const payload = data(record.payload) ? record.payload : undefined;
      if (record.type === 'session_meta') {
        if (!payload || typeof payload.id !== 'string' || !payload.id.length) return 'invalidRecord';
        const id = sink.key('codex-session', payload.id);
        // An embedded parent record cannot change the rollout's identity.
        if (session !== file && session !== id) return;
        session = id;
        cwd = sink.cwd(payload.cwd, position);
        if (inheritedSession(payload)) {
          forked = true;
          forkAt ??= time(payload.timestamp) ?? time(record.timestamp) ?? null;
        }
        return;
      }
      if (record.type === 'turn_context') {
        if (!payload) return 'invalidRecord';
        model = modelLabel('codex', payload.model);
        return;
      }
      if (payload?.type !== 'token_count') return;
      if (payload.info == null && payload.rate_limits == null) return;
      const at = time(record.timestamp);
      if (at === undefined) return 'invalidTimestamp';
      if (data(payload.rate_limits) && (!allowance || at >= allowance.observedAt)) {
        allowance = codexAllowance(payload.rate_limits, at);
      }
      // Quota-only records do not change the cumulative token baseline.
      if (payload.info == null) return;
      const total = data(payload.info) && data(payload.info.total_token_usage) ? payload.info.total_token_usage.total_tokens : undefined;
      const last = data(payload.info) && data(payload.info.last_token_usage) ? payload.info.last_token_usage.total_tokens : undefined;
      sink.reading({ at, cwd, model, total: natural(total) ? total : null, last: natural(last) ? last : null });
      if (!natural(total)) return 'invalidUsage';
    },
    result(): FileMetadata { return { allowance, session, forked, forkAt }; },
  };
}
