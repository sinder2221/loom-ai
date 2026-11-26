import { audit } from './events.ts';
import type { Storage } from './storage.ts';

const actors = new Set(['bridge', 'human', 'claude', 'codex']);
const kinds = new Set([
  'handoff-requested', 'observation', 'result', 'captured-update', 'source-link-unavailable',
  'approval-created', 'approval-consumed', 'launch-authorized', 'launch-dispatch', 'launch-started', 'launch-finished',
  'launch-interrupted', 'turn-started', 'turn-accepted', 'turn-finished', 'turn-interrupted',
  'turn-reattached', 'run-finished', 'question-opened', 'answer-observed', 'automatic-reply',
  'automatic-replies-resumed', 'native-input', 'native-input-review', 'native-answer', 'codex-history-review',
  'replacement-stop-requested', 'replacement-stop-observed', 'replacement', 'delivery-claimed',
  'delivery-resend', 'delivery-skipped', 'delivery-interrupted', 'delivery-timeout', 'transport-observed',
  'receipt-observed', 'late-delivery',
]);
const states = new Set([
  'Starting', 'Running', 'Completed', 'Interrupted', 'In flight', 'Queued', 'Accepted by transport',
  'Held for approval', 'Delivered to chat', 'Refused', 'Needs verification',
]);
const outcomes = new Set([
  'accepted', 'activated', 'claimed', 'completed', 'consumed', 'failed', 'historical', 'ignored',
  'inProgress', 'interrupted', 'issued', 'needs-verification', 'opened', 'pending', 'queued',
  'recorded', 'rejected', 'requeued', 'resumed', 'review', 'skipped', 'started', 'unavailable',
  'unresolved', 'verified', 'Received', 'Acted',
]);
const reasons = new Set([
  'capture-consent-required', 'capture-consent-revoked', 'source-deleted', 'source-link-unknown',
  'approval-required', 'approval-reused', 'approval-expired', 'origin-mismatch', 'request-mismatch',
  'unknown-question', 'nonce-mismatch', 'nonce-already-used', 'late-answer', 'duplicate-answer',
  'automatic-reply-already-queued', 'automatic-turn-cap', 'answer-needs-reconciliation',
  'native-answer-already-resumed', 'loom-answer-already-claimed', 'turn-conflict', 'unknown-authorship',
  'question-binding-mismatch', 'inactive-run', 'run-inactive', 'run-superseded', 'result-run-unbound',
  'receipt-window-elapsed', 'restart-before-delivery-outcome', 'restart-before-launch-outcome',
  'restart-before-turn-outcome', 'provider-turn-failed', 'provider-turn-interrupted', 'duplicate-receipt',
  'receipt-mismatch', 'receipt-attempt-mismatch', 'receipt-attempt-refused', 'unclaimed-delivery',
  'missing-receipt-evidence', 'missing-transport-evidence', 'stale-or-unclaimed-attempt', 'illegal-transition',
  'stop-request-mismatch', 'stop-evidence-mismatch', 'interruption-unverified', 'owner-changed',
  'stop-already-requested', 'stop-outcome-pending', 'workspace-unverified', 'verified-interruption',
  'replacement-chat-or-run-conflict', 'workspace-path-not-canonical', 'interruption-unverified-workspace-overlap',
  'authorized-isolated-workspace', 'isolation-approval-required',
  'launch-folder-outside-project', 'launch-permissions-locked', 'launch-already-authorized', 'invalid-launch-request',
]);

function allowed(values: ReadonlySet<string>, value: string | null) {
  return value !== null && values.has(value) ? value : null;
}

function localIds() {
  const ids = new Map<string, number>();
  return (value: string | null) => {
    if (value === null) return null;
    if (!ids.has(value)) ids.set(value, ids.size + 1);
    return ids.get(value)!;
  };
}

const overviewTextFields = ['title', 'brief'] as const;
const privateKey = /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/iu;
const tokenShape = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:gh[pousr]_|github_pat_|xox[baprs]-|sk-(?:proj-)?|sk_(?:live|test)_|AIza)[A-Za-z0-9_-]{12,}|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/u;
const credentialValue = /\b(?:bearer|basic)\s+\S+|\b(?:api[_ -]?key|access[_ -]?token|secret|password|passwd|credential)\s*[:=]\s*\S+|\b[a-z][a-z0-9+.-]*:\/\/[^/\s@]+:[^/\s@]+@/iu;

export function credentialPatternReason(text: string) {
  if (privateKey.test(text)) return 'private-key';
  if (tokenShape.test(text) || credentialValue.test(text)) return 'credential-pattern';
  return null;
}

function highEntropy(text: string) {
  for (const [word] of text.matchAll(/[A-Za-z0-9+/_=-]{24,}/gu)) {
    const counts = new Map<string, number>();
    for (const char of word) counts.set(char, (counts.get(char) ?? 0) + 1);
    let entropy = 0;
    for (const count of counts.values()) {
      const likelihood = count / word.length;
      entropy -= likelihood * Math.log2(likelihood);
    }
    if (entropy >= 3.5) return true;
  }
  return false;
}

function secretReason(text: unknown, check?: (text: string) => boolean) {
  if (typeof text !== 'string') return 'secret-check-unavailable';
  try {
    const pattern = credentialPatternReason(text);
    if (pattern) return pattern;
    if (highEntropy(text)) return 'high-entropy-text';
    if (check) {
      const flagged = check(text);
      if (flagged === true) return 'secret-check-flagged';
      if (flagged !== false) return 'secret-check-unavailable';
    }
  } catch {
    return 'secret-check-unavailable';
  }
  return null;
}

export function exportHandoff(storage: Storage, id: string, check?: (text: string) => boolean,
  options: { includeText?: boolean } = {}) {
  const handoff = storage.get<{ id: number; title: string; brief: string }>(
    'SELECT rowid AS id, title, brief FROM handoff WHERE id = ?', id);
  if (!handoff) throw new Error('Unknown handoff');
  const run = localIds();
  const chat = localIds();
  const overview: Partial<Record<typeof overviewTextFields[number], string>> = {};
  const withheldFields = [];
  for (const field of overviewTextFields) {
    const reason = options.includeText ? secretReason(handoff[field], check) : 'text-not-requested';
    if (reason) withheldFields.push({ field, reason });
    else overview[field] = handoff[field];
  }
  return {
    handoffId: handoff.id,
    ...overview,
    ...(withheldFields.length > 0 && {
      withheldFields, warning: 'Some handoff text fields were withheld.',
    }),
    events: audit(storage, id).map(row => ({
      eventId: row.id,
      runId: run(row.runId),
      destinationChatId: chat(row.destinationChatId),
      deliveryId: row.deliveryId,
      occurredAt: row.occurredAt,
      actor: allowed(actors, row.actor),
      kind: allowed(kinds, row.kind),
      fromState: allowed(states, row.fromState),
      toState: allowed(states, row.toState),
      attempt: row.attempt,
      outcome: allowed(outcomes, row.outcome),
      // Recorded transport reasons contain verbatim evidence even if they look like a reason code.
      reason: row.kind === 'transport-observed' && row.outcome === 'recorded' ? null : allowed(reasons, row.reason),
    })),
  };
}
