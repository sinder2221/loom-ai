import { createHash } from 'node:crypto';
import { message } from './approval-input.ts';
import {
  appendEvent, appendWithIntent, applyEvent, getHandoff, positiveInteger, requireText,
  type Context, type EventOrigin,
} from './events.ts';
import type { Storage } from './storage.ts';

interface QuestionKey {
  handoffId: string;
  runId: string;
  questionId: string;
  origin: EventOrigin;
}

function hashNonce(nonce: string) {
  return createHash('sha256').update(nonce).digest('hex');
}

export function pullAnswers(answer: string, count: number): string[] | undefined {
  if (count === 1) return [answer];
  try {
    const values: unknown = JSON.parse(answer);
    if (Array.isArray(values) && values.length === count && values.every(message)) return values;
  } catch {
    // The caller returns a fixed validation reason.
  }
}

export function getQuestion(storage: Storage, handoffId: string, id: string) {
  return storage.get<{
    runId: string; nonceHash: string; expiresAt: number; answerEventId: number | null;
    replyEventId: number | null; payload: string; runState: string; destinationChatId: string;
    answerKind: string | null; pullTurnId: string | null; pullQuestionCount: number | null; turnState: string | null;
  }>(`
    SELECT q.run_id AS runId, q.nonce_hash AS nonceHash, q.expires_at AS expiresAt,
           q.answer_event_id AS answerEventId, q.reply_event_id AS replyEventId, e.payload,
           CASE WHEN r.stop_state IS NULL THEN r.state ELSE 'Interrupted' END AS runState,
           r.destination_chat_id AS destinationChatId, a.kind AS answerKind, q.pull_turn_id AS pullTurnId,
           q.pull_question_count AS pullQuestionCount, t.state AS turnState
    FROM question q JOIN event e ON e.id = q.opened_event_id JOIN run r ON r.id = q.run_id
    LEFT JOIN event a ON a.id = q.answer_event_id LEFT JOIN turn t ON t.id = q.pull_turn_id
    WHERE q.handoff_id = ? AND q.id = ?
  `, handoffId, id);
}

export function questionOperations(context: Context) {
  const { storage } = context;

  return {
    openQuestion(input: QuestionKey & {
      nonce: string; prompt: string; expiresAt: number; pull?: { turnId: string; count: number };
    }) {
      const { handoffId, runId, questionId, origin, nonce, prompt, expiresAt, pull } = input;
      return applyEvent(context, handoffId, origin, now => {
        requireText(questionId, 'question ID');
        requireText(nonce, 'question nonce');
        requireText(prompt, 'question prompt');
        const fields = { kind: 'question-opened', subjectId: questionId };
        const nonceHash = hashNonce(nonce);
        const rejection = pull && !storage.get(
          "SELECT 1 FROM turn WHERE id = ? AND run_id = ? AND state = 'In flight'", pull.turnId, runId,
        ) ? 'inactive-run' : !storage.get(`
          SELECT 1 FROM run WHERE id = ? AND handoff_id = ? AND state = 'Running' AND stop_state IS NULL
        `, runId, handoffId) ? 'inactive-run'
          : getQuestion(storage, handoffId, questionId) ? 'question-id-already-used'
          : storage.get('SELECT 1 FROM question WHERE nonce_hash = ?', nonceHash) ? 'nonce-already-used'
          : !Number.isSafeInteger(expiresAt) || expiresAt <= now ? 'invalid-question-expiry' : undefined;
        if (rejection) return appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: rejection,
        });

        const eventId = appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: 'opened', payload: { questionId, nonce, prompt },
        });
        storage.run(`
          INSERT INTO question (handoff_id, id, run_id, nonce_hash, expires_at, opened_event_id, pull_turn_id, pull_question_count)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `, handoffId, questionId, runId, nonceHash, expiresAt, eventId, pull?.turnId ?? null, pull?.count ?? null);
        return eventId;
      });
    },

    queueAutomaticReply(input: QuestionKey & { correlationId: string }) {
      const { handoffId, runId, questionId, origin, correlationId } = input;
      return applyEvent(context, handoffId, origin, now => {
        const handoff = getHandoff(storage, handoffId);
        const question = getQuestion(storage, handoffId, questionId);
        const fields = { kind: 'automatic-reply', subjectId: questionId };
        const rejection = !question || question.runId !== runId || question.runState !== 'Running'
          ? 'inactive-question'
          : question.pullTurnId ? 'question-uses-pull'
          : question.replyEventId !== null ? 'automatic-reply-already-queued'
          : question.answerEventId !== null || now >= question.expiresAt ? 'question-closed'
          : handoff.automaticTurns >= handoff.automaticTurnLimit ? 'automatic-turn-cap' : undefined;
        if (rejection || !question) return appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: 'rejected', reason: rejection,
        });

        const eventId = appendWithIntent(storage, handoffId, origin, now, {
          ...fields, outcome: 'queued', payload: JSON.parse(question.payload),
        }, { destinationChatId: handoff.originChatId, correlationId });
        storage.run('UPDATE question SET reply_event_id = ? WHERE handoff_id = ? AND id = ?',
          eventId, handoffId, questionId);
        storage.run('UPDATE handoff SET automatic_turns = automatic_turns + 1 WHERE id = ?', handoffId);
        return eventId;
      });
    },

    answerQuestion(input: QuestionKey & {
      originChatId: string; nonce: string; answer: string; correlationId: string;
    }) {
      const { handoffId, runId, questionId, origin, originChatId, nonce, answer, correlationId } = input;
      return applyEvent(context, handoffId, origin, now => {
        const handoff = getHandoff(storage, handoffId);
        const question = getQuestion(storage, handoffId, questionId);
        const fields = { kind: 'answer-observed', subjectId: questionId };
        const reason = !question ? 'unknown-question'
          : handoff.originChatId !== originChatId ? 'origin-mismatch'
          : question.runId !== runId || question.runState !== 'Running' ? 'inactive-run'
          : typeof nonce !== 'string' || hashNonce(nonce) !== question.nonceHash ? 'nonce-mismatch'
          : question.answerKind === 'native-answer' ? 'native-answer-already-resumed'
          : question.answerEventId !== null ? 'duplicate-answer'
          : now >= question.expiresAt ? 'late-answer'
          : question.pullTurnId && (question.turnState !== 'In flight' || storage.get(`
              SELECT 1 FROM delegate_runtime WHERE run_id = ?
            `, runId)) ? 'inactive-run'
          : question.pullTurnId && handoff.automaticTurns >= handoff.automaticTurnLimit ? 'automatic-turn-cap'
          : question.pullQuestionCount && !pullAnswers(answer, question.pullQuestionCount) ? 'invalid-question-answer'
          : undefined;
        if (reason || !question) return appendEvent(storage, handoffId, origin, now, {
          ...fields, outcome: reason === 'native-answer-already-resumed' ? 'skipped'
            : reason === 'duplicate-answer' || reason === 'late-answer' ? 'ignored' : 'rejected',
          reason,
        });

        requireText(answer, 'answer');
        const accepted = { ...fields, outcome: 'accepted', payload: { questionId, runId, answer } };
        const eventId = question.pullTurnId
          ? appendEvent(storage, handoffId, origin, now, accepted)
          : appendWithIntent(storage, handoffId, origin, now, accepted,
            { destinationChatId: question.destinationChatId, correlationId });
        if (question.pullTurnId) {
          storage.run('UPDATE handoff SET automatic_turns = automatic_turns + 1 WHERE id = ?', handoffId);
        }
        storage.run('UPDATE question SET answer_event_id = ? WHERE handoff_id = ? AND id = ?',
          eventId, handoffId, questionId);
        return eventId;
      });
    },

    resumeAutomaticReplies(handoffId: string, extraTurns: number, origin: EventOrigin) {
      return applyEvent(context, handoffId, origin, now => {
        positiveInteger(extraTurns, 'additional turns');
        const handoff = getHandoff(storage, handoffId);
        const newLimit = handoff.automaticTurnLimit + extraTurns;
        positiveInteger(newLimit, 'new turn limit');
        storage.run('UPDATE handoff SET automatic_turn_limit = ? WHERE id = ?', newLimit, handoffId);
        return appendEvent(storage, handoffId, origin, now, {
          kind: 'automatic-replies-resumed', outcome: 'resumed',
          fromState: String(handoff.automaticTurnLimit), toState: String(newLimit),
        });
      });
    },
  };
}
