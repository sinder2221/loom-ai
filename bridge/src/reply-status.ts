import { identifier, nonceValue, type ApprovalOrigin } from './approval-input.ts';
import { credentialPatternReason } from './export.ts';
import type { Storage } from './storage.ts';

const pageSize = 25;
export const maxQuestionCharacters = 16_384;

function screenedText(text: string, limit: number) {
  if (credentialPatternReason(text)) return { text: null, truncated: false, withheld: true };
  const characters = Array.from(text.replace(/[\p{Cc}]/gu, character => ['\n', '\r', '\t'].includes(character) ? character : ' '));
  return { text: characters.slice(0, limit).join(''), truncated: characters.length > limit, withheld: false };
}

function safeReplyId(value: unknown): value is string {
  return identifier(value) && !credentialPatternReason(value);
}

interface ReplyRow {
  id: string;
  automaticTurns: number;
  automaticTurnLimit: number;
  launchId: string | null;
  runState: string | null;
  stopped: string | null;
  restartUnknown: number;
  runtimeState: string | null;
  runtimeReason: string | null;
  resultText: string | null;
  questionId: string | null;
  questionPayload: string | null;
  questionCount: number | null;
}

export function projectReplyStatus(storage: Storage, origin: ApprovalOrigin, now: number, handoffId?: string, after?: string) {
  storage.registerScalar('loom_safe_reply_id', value => Number(safeReplyId(value)));
  const rows = storage.all<ReplyRow>(`
    SELECT h.id, h.automatic_turns AS automaticTurns, h.automatic_turn_limit AS automaticTurnLimit,
      d.run_id AS launchId, r.state AS runState, r.stop_state AS stopped, rt.state AS runtimeState,
      rt.reason AS runtimeReason, rt.result_text AS resultText,
      CASE WHEN r.reason = 'restart-before-launch-outcome' OR initial.reason = 'restart-before-turn-outcome'
        THEN 1 ELSE 0 END AS restartUnknown,
      q.id AS questionId, e.payload AS questionPayload, q.pull_question_count AS questionCount
    FROM handoff h JOIN chat_reference c ON c.id = h.origin_chat_id
    LEFT JOIN delegate_launch d ON d.handoff_id = h.id
    LEFT JOIN run r ON r.id = h.active_run_id
    LEFT JOIN turn initial ON initial.id = 'loom-initial-' || r.id
    LEFT JOIN delegate_runtime rt ON rt.run_id = r.id OR (r.id IS NULL AND rt.run_id = d.run_id)
    LEFT JOIN question q ON q.rowid = (
      SELECT candidate.rowid FROM question candidate
      LEFT JOIN turn t ON t.id = candidate.pull_turn_id
      WHERE candidate.handoff_id = h.id AND candidate.run_id = r.id AND r.state = 'Running'
        AND r.stop_state IS NULL AND rt.state IS NULL
        AND candidate.answer_event_id IS NULL AND candidate.expires_at > ?
        AND (candidate.pull_turn_id IS NULL OR t.state = 'In flight')
        AND loom_safe_reply_id(candidate.id)
      ORDER BY candidate.opened_event_id DESC LIMIT 1
    )
    LEFT JOIN event e ON e.id = q.opened_event_id
    WHERE h.project_id = ? AND h.origin_chat_id = ? AND c.connection_id = ?
      AND loom_safe_reply_id(h.id) AND (? IS NULL OR h.id = ?) AND h.id > ?
    ORDER BY h.id LIMIT ?
  `, now, origin.projectId, origin.originChatId, origin.connectionId,
  handoffId ?? null, handoffId ?? null, after ?? '', pageSize + 1);
  if (handoffId && rows.length === 0) return { outcome: 'rejected', reason: 'handoff-unavailable' };

  const handoffs = rows.slice(0, pageSize).map(row => {
    let question = null;
    if (row.questionPayload && row.questionId) {
      const { nonce, prompt } = JSON.parse(row.questionPayload);
      const screened = screenedText(prompt, handoffId ? maxQuestionCharacters : 2048);
      // A withheld question must not be actionable.
      const actionable = !screened.truncated && !screened.withheld && nonceValue(nonce) && !/\p{Cc}/u.test(nonce)
        && !credentialPatternReason(nonce);
      question = {
        id: row.questionId, nonce: actionable ? nonce : null, ...screened,
        ...(row.questionCount && row.questionCount > 1 && { answerCount: row.questionCount }),
      };
    }
    return {
      id: row.id,
      state: row.runtimeState ?? (row.stopped ? 'interrupted' : row.restartUnknown ? 'unknown' : row.runState?.toLowerCase())
        ?? (row.launchId ? 'queued' : 'pending'),
      reason: row.runtimeReason ?? (row.restartUnknown ? 'restart-outcome-unverified' : null),
      automaticTurns: row.automaticTurns,
      automaticTurnLimit: row.automaticTurnLimit,
      atCap: row.automaticTurns >= row.automaticTurnLimit,
      question,
      result: row.resultText === null ? null : screenedText(row.resultText, 4096),
    };
  });
  return { outcome: 'status', handoffs, next: rows.length > pageSize ? handoffs.at(-1)!.id : null };
}
