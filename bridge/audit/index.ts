import { isDeepStrictEqual } from 'node:util';
import type { AuditRow } from '../src/index.ts';

export type ExpectedAuditRow = Pick<AuditRow,
  'handoffId' | 'kind' | 'actor' | 'subjectId' | 'runId' | 'destinationChatId' | 'correlationId' |
  'deliveryId' | 'fromState' | 'toState' | 'attempt' | 'outcome' | 'reason' | 'receiptEvidence' | 'late'
> & Partial<Pick<AuditRow, 'source' | 'sourceId'>>;

function projection(row: ExpectedAuditRow): ExpectedAuditRow {
  const { handoffId, kind, actor, subjectId, runId, destinationChatId, correlationId, deliveryId,
    fromState, toState, attempt, outcome, reason, receiptEvidence, late } = row;
  return { handoffId, kind, actor, subjectId, runId, destinationChatId, correlationId, deliveryId,
    fromState, toState, attempt, outcome, reason, receiptEvidence, late,
    ...(row.source !== undefined ? { source: row.source } : {}),
    ...(row.sourceId !== undefined ? { sourceId: row.sourceId } : {}) };
}

function matchesIdentity(expected: ExpectedAuditRow, observed: AuditRow) {
  return (expected.source === undefined || expected.source === observed.source) &&
    (expected.sourceId === undefined || expected.sourceId === observed.sourceId);
}

function matchesProjection(expected: ExpectedAuditRow, observed: AuditRow) {
  const actual = projection(observed);
  if (expected.source === undefined) delete actual.source;
  if (expected.sourceId === undefined) delete actual.sourceId;
  return isDeepStrictEqual(expected, actual);
}

function eventKey(row: ExpectedAuditRow) {
  return JSON.stringify([row.handoffId, row.kind, row.runId, row.subjectId, row.correlationId, row.attempt]);
}

export function compareAuditRows(expected: readonly ExpectedAuditRow[], observed: readonly AuditRow[]) {
  const groups = new Map<string, { index: number; row: ExpectedAuditRow; matched: boolean }[]>();
  for (const [index, row] of expected.entries()) {
    const key = eventKey(row);
    const group = groups.get(key) ?? [];
    group.push({ index, row: projection(row), matched: false });
    groups.set(key, group);
  }
  // Prefer specified identities over wildcard rows when both can match.
  for (const group of groups.values()) group.sort((a, b) =>
    Number(b.row.source !== undefined) + Number(b.row.sourceId !== undefined) -
    Number(a.row.source !== undefined) - Number(a.row.sourceId !== undefined));
  const missing: ExpectedAuditRow[] = [];
  const duplicate: AuditRow[] = [];
  const unexpected: AuditRow[] = [];
  const outOfOrder: AuditRow[] = [];
  const wrongDisposition: { expected: ExpectedAuditRow; observed: AuditRow }[] = [];
  const matches = new Map<number, number>();
  const unmatched: { position: number; row: AuditRow; key: string }[] = [];

  // Match exact rows first so repeated decisions with the same key can still be checked for order.
  for (const [position, row] of observed.entries()) {
    const key = eventKey(row);
    const group = groups.get(key);
    if (!group) {
      unexpected.push(row);
      continue;
    }
    const match = group.find(entry => !entry.matched && matchesIdentity(entry.row, row) && matchesProjection(entry.row, row));
    if (match) {
      match.matched = true;
      matches.set(position, match.index);
    } else {
      unmatched.push({ position, row, key });
    }
  }
  for (const { position, row, key } of unmatched) {
    const candidates = groups.get(key)!.filter(entry => matchesIdentity(entry.row, row));
    if (!candidates.length) {
      unexpected.push(row);
      continue;
    }
    const match = candidates.find(entry => !entry.matched);
    if (!match) {
      duplicate.push(row);
      continue;
    }
    match.matched = true;
    matches.set(position, match.index);
    wrongDisposition.push({ expected: match.row, observed: row });
  }
  for (const group of groups.values()) {
    for (const entry of group) if (!entry.matched) missing.push(entry.row);
  }
  let previous = -1;
  for (const [position, row] of observed.entries()) {
    const index = matches.get(position);
    if (index === undefined) continue;
    if (index < previous) outOfOrder.push(row);
    previous = Math.max(previous, index);
  }
  return { missing, duplicate, unexpected, outOfOrder, wrongDisposition };
}

export async function runAuditScenario(
  expected: readonly ExpectedAuditRow[], scenario: () => readonly AuditRow[] | Promise<readonly AuditRow[]>,
) {
  const seeded = expected.map(projection);
  return compareAuditRows(seeded, await scenario());
}
