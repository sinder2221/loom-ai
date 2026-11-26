import { fields, identifier } from './approval-input.ts';
import type { DeliveryState } from './deliveries.ts';
import type { Context } from './events.ts';
import { credentialPatternReason } from './export.ts';
import { delegationIds, userNamedPrefix } from './projects.ts';

const chatLimit = 200;
const questionLimit = 50;
const excerptLimit = 160;
const promptPrefixCharacters = 4096;
const promptPrefixBytes = promptPrefixCharacters * 4;

interface ActivityChat {
  id: string;
  provider: 'codex' | 'claude' | 'openclaw' | 'antigravity' | null;
  role: 'origin' | 'destination' | null;
  placeholder: boolean;
  runState: 'Starting' | 'Running' | 'Completed' | 'Interrupted' | null;
  createdAt: number | null;
  lastActivityAt: number | null;
  parentChatId: string | null;
  deliveryState: DeliveryState | null;
}

interface QuestionRow {
  id: string;
  chatId: string;
  expiresAt: number;
  prompt: unknown;
}

interface SnapshotRow {
  runningRuns: number;
  openQuestions: number;
  omittedChats: number;
  omittedQuestions: number;
  chats: string;
  questions: string;
}

export function projectActivityInput(value: unknown): value is { projectId: string } {
  return fields(value, ['projectId']) && identifier(value.projectId);
}

// One SELECT keeps all sections on the same SQLite snapshot without acquiring a write lock.
const snapshotQuery = `
  WITH registered AS (
    SELECT project_id FROM project_registration WHERE project_id = ?1
  ), project_chats AS MATERIALIZED (
    SELECT c.id,
           CASE WHEN n.provider IN ('codex', 'claude', 'openclaw', 'antigravity') THEN n.provider END AS provider,
           activity_valid_id(CAST(c.id AS BLOB)) AS valid_id,
           (c.id = ?2 AND instr(n.account_ref, ?3) = 1 AND EXISTS (
             SELECT 1 FROM delegate_project d WHERE d.project_id = p.project_id AND d.destination_chat_id = c.id
           )) AS placeholder
    FROM registered p JOIN connection n ON n.project_id = p.project_id
    JOIN chat_reference c ON c.connection_id = n.id
  ), handoffs AS (
    SELECT h.id, h.origin_chat_id, h.active_run_id
    FROM registered p JOIN handoff h ON h.project_id = p.project_id
    JOIN project_chats c ON c.id = h.origin_chat_id
  ), runs AS (
    SELECT r.id, r.handoff_id, r.destination_chat_id, r.state, r.stop_state, r.rowid AS sequence,
           h.origin_chat_id, h.active_run_id
    FROM handoffs h JOIN run r ON r.handoff_id = h.id
    JOIN project_chats c ON c.id = r.destination_chat_id
  ), running AS (
    SELECT id, handoff_id, destination_chat_id
    FROM runs WHERE state = 'Running' AND stop_state IS NULL AND id = active_run_id
  ), open_questions AS (
    SELECT q.id, r.destination_chat_id AS chat_id, q.expires_at, q.opened_event_id, q.handoff_id,
           (c.valid_id AND activity_valid_id(CAST(q.id AS BLOB))) AS valid_id
    FROM running r JOIN question q ON q.run_id = r.id AND q.handoff_id = r.handoff_id
    JOIN project_chats c ON c.id = r.destination_chat_id
    WHERE q.answer_event_id IS NULL AND q.expires_at > ?4
  ), roles (id, role, parent_id, state, priority, created_event_id, sequence) AS (
    SELECT r.destination_chat_id, 'destination', r.origin_chat_id,
           CASE WHEN r.stop_state IS NULL THEN r.state ELSE 'Interrupted' END, 3,
           (SELECT min(e.id) FROM event e WHERE e.handoff_id = r.handoff_id
            AND e.destination_chat_id = r.destination_chat_id AND (
              (e.kind = 'launch-started' AND e.subject_id = r.id)
              OR (e.kind = 'replacement' AND e.outcome = 'activated' AND e.run_id = r.id)
            )), r.sequence
    FROM runs r
    UNION ALL
    SELECT d.destination_chat_id, 'destination', h.origin_chat_id, NULL, 3,
           (SELECT min(e.id) FROM event e WHERE e.handoff_id = d.handoff_id
            AND e.kind = 'launch-authorized' AND e.outcome = 'queued'
            AND e.subject_id = d.run_id AND e.destination_chat_id = d.destination_chat_id), d.rowid
    FROM delegate_launch d JOIN handoffs h ON h.id = d.handoff_id
    WHERE NOT EXISTS (SELECT 1 FROM run r WHERE r.handoff_id = d.handoff_id AND r.id = d.run_id)
    UNION ALL
    SELECT d.destination_chat_id, 'destination', NULL, NULL, 2, NULL, 0
    FROM registered p JOIN delegate_project d ON d.project_id = p.project_id
    UNION ALL
    SELECT origin_chat_id, 'origin', NULL, NULL, 1, NULL, 0 FROM handoffs
    UNION ALL
    SELECT a.chat_id, 'origin', NULL, NULL, 1, NULL, 0
    FROM project_chats c JOIN approval_origin a ON a.chat_id = c.id
  ), ranked_roles AS (
    SELECT id, role, parent_id, state,
           row_number() OVER (
             PARTITION BY id ORDER BY priority DESC, created_event_id DESC, (state IS NOT NULL) DESC, sequence DESC
           ) AS rank
    FROM roles
  ), project_events AS (
    SELECT e.id, e.handoff_id, e.occurred_at, e.destination_chat_id, e.run_id,
           e.kind IN ('handoff-requested', 'launch-authorized', 'launch-started')
             OR (e.kind = 'replacement' AND e.outcome = 'activated') AS establishes_role
    FROM handoffs h JOIN event e ON e.handoff_id = h.id
  ), chat_events (chat_id, occurred_at, establishes_role) AS (
    SELECT destination_chat_id, occurred_at, establishes_role FROM project_events WHERE destination_chat_id IS NOT NULL
    UNION ALL
    SELECT r.destination_chat_id, e.occurred_at, e.establishes_role
    FROM project_events e JOIN runs r ON r.id = e.run_id AND r.handoff_id = e.handoff_id
    UNION ALL
    SELECT r.destination_chat_id, e.occurred_at, 0
    FROM project_events e JOIN question q ON q.opened_event_id = e.id AND q.handoff_id = e.handoff_id
    JOIN runs r ON r.id = q.run_id AND r.handoff_id = q.handoff_id
  ), chat_times AS (
    SELECT chat_id,
           min(CASE WHEN establishes_role THEN occurred_at END) AS created_at,
           max(occurred_at) AS last_activity_at
    FROM chat_events GROUP BY chat_id
  ), activity_chats AS (
    SELECT c.id, c.provider, c.placeholder, c.valid_id, r.role, r.state,
           CASE WHEN parent.valid_id THEN nullif(r.parent_id, c.id) END AS parent_id,
           t.created_at, t.last_activity_at
    FROM project_chats c LEFT JOIN ranked_roles r ON r.id = c.id AND r.rank = 1
    LEFT JOIN project_chats parent ON parent.id = r.parent_id
    LEFT JOIN chat_times t ON t.chat_id = c.id
    WHERE r.id IS NOT NULL OR EXISTS (
      SELECT 1 FROM delivery d JOIN handoffs h ON h.id = d.handoff_id WHERE d.destination_chat_id = c.id
    )
  ), recent_chats AS (
    SELECT id, provider, placeholder, role, state, parent_id, created_at, last_activity_at
    FROM activity_chats WHERE valid_id ORDER BY last_activity_at DESC, id
    LIMIT ${chatLimit + 1}
  ), recent_questions AS (
    SELECT id, chat_id, expires_at, opened_event_id, handoff_id
    FROM open_questions WHERE valid_id ORDER BY opened_event_id DESC LIMIT ${questionLimit + 1}
  )
  SELECT
    (SELECT count(*) FROM running) AS runningRuns,
    (SELECT count(*) FROM open_questions) AS openQuestions,
    (SELECT count(*) FROM activity_chats WHERE NOT valid_id) AS omittedChats,
    (SELECT count(*) FROM open_questions WHERE NOT valid_id) AS omittedQuestions,
    (SELECT json_group_array(json_object(
      'id', c.id,
      'provider', c.provider,
      'role', c.role,
      'placeholder', json(CASE WHEN c.placeholder THEN 'true' ELSE 'false' END),
      'runState', c.state,
      'createdAt', c.created_at,
      'lastActivityAt', c.last_activity_at,
      'parentChatId', c.parent_id,
      'deliveryState', (
        SELECT d.state FROM delivery d JOIN handoffs h ON h.id = d.handoff_id
        WHERE d.destination_chat_id = c.id ORDER BY d.id DESC LIMIT 1
      )
    ) ORDER BY c.last_activity_at DESC, c.id) FROM recent_chats c) AS chats,
    (SELECT json_group_array(json_object(
      'id', q.id, 'chatId', q.chat_id, 'expiresAt', q.expires_at, 'prompt',
        CASE WHEN json_type(e.payload, '$.prompt') = 'text' THEN activity_prompt_prefix(
          substr(CAST(json_extract(e.payload, '$.prompt') AS BLOB), 1, ${promptPrefixBytes})
        ) END
    ) ORDER BY q.opened_event_id DESC)
    FROM recent_questions q LEFT JOIN event e ON e.id = q.opened_event_id AND e.handoff_id = q.handoff_id
      AND e.kind = 'question-opened') AS questions
  FROM registered
`;

function questionExcerpt(prompt: unknown) {
  if (typeof prompt !== 'string' || prompt.length === 0) {
    return { excerpt: null, excerptTruncated: null, excerptWithheld: false };
  }

  const printable = prompt.replace(/\p{Cc}/gu, ' ');
  if (credentialPatternReason(prompt) || (printable !== prompt && credentialPatternReason(printable))) {
    return { excerpt: null, excerptTruncated: null, excerptWithheld: true };
  }
  const characters = [...printable];
  return {
    excerpt: characters.slice(0, excerptLimit).join('').toWellFormed(),
    excerptTruncated: characters.length > excerptLimit,
    excerptWithheld: false,
  };
}

function activityIdentifier(value: unknown) {
  // BLOB input preserves embedded NULs across SQLite's JavaScript boundary.
  if (!(value instanceof Uint8Array) || value.length > 128) return false;
  const id = Buffer.from(value).toString('utf8');
  return identifier(id) && !credentialPatternReason(id);
}

function promptPrefix(value: unknown) {
  if (!(value instanceof Uint8Array)) return null;
  // SQLite's text substr stops at NUL. Slice the byte prefix in SQL and trim to code points here.
  const characters = [...Buffer.from(value).toString('utf8')];
  return characters.slice(0, promptPrefixCharacters).join('');
}

export function activityOperations({ storage, now }: Context) {
  storage.registerScalar('activity_valid_id', value => Number(activityIdentifier(value)));
  storage.registerScalar('activity_prompt_prefix', promptPrefix);
  return {
    projectActivity(input: unknown) {
      if (!projectActivityInput(input)) return { outcome: 'refused', reason: 'invalid-request' } as const;
      const { projectId } = input;
      const generatedAt = now();
      const { destinationChatId } = delegationIds(projectId);
      const row = storage.get<SnapshotRow>(snapshotQuery, projectId, destinationChatId, userNamedPrefix, generatedAt);
      if (!row) return { outcome: 'refused', reason: 'not-registered' } as const;

      const chatRows: ActivityChat[] = JSON.parse(row.chats);
      const questionRows: QuestionRow[] = JSON.parse(row.questions);
      return {
        schema: 1 as const,
        generatedAt,
        truncated: { chats: chatRows.length > chatLimit, questions: questionRows.length > questionLimit },
        omitted: { chats: row.omittedChats, questions: row.omittedQuestions },
        counts: { runningRuns: row.runningRuns, openQuestions: row.openQuestions },
        chats: chatRows.slice(0, chatLimit),
        questions: questionRows.slice(0, questionLimit).map(({ id, chatId, expiresAt, prompt }) => ({
          id, chatId, expiresAt, ...questionExcerpt(prompt),
        })),
      };
    },
  };
}
