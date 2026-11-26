import { createHash } from 'node:crypto';
import { providerOrigin, sameConnection, type ConnectionBinding } from '../adapters/binding.ts';
import { attachCapturedCopy, captureGrant, linkSourceItem } from './capture.ts';
import { claimQueuedDelivery, skipDelivery } from './deliveries.ts';
import { appendEvent, appendWithIntent, bridgeOrigin, getHandoff, type Context } from './events.ts';
import { activeRunId, codexRun, codexTurnOwnership } from './ownership.ts';
import { getQuestion } from './questions.ts';
import { answerTurnId } from './work.ts';

export type CodexLocator = {
  threadId: string;
  turnId: string;
  itemId: string;
};

interface HistoryObservation {
  binding: ConnectionBinding;
  threadId: string;
  turns: readonly {
    id: string;
    inProgress: boolean;
    items: readonly { id: string; human: boolean; questionId?: string; text?: string }[];
  }[];
}

function plainExcerpt(text: string) {
  const plain = text
    .replace(/<!--[\s\S]*?-->/gu, '')
    .replace(/!\[([^\]]*)\]\([^)\r\n]*\)|\[([^\]]+)\]\([^)\r\n]*\)/gu, '$1$2')
    .replace(/<\/?[a-z][^<>\r\n]*>/giu, '')
    .replace(/^[ \t]*(?:`{3,}|~{3,})[^\r\n]*$/gmu, '')
    .replace(/^[ \t]*(?:>[ \t]*|#{1,6}[ \t]+|[-+*][ \t]+|\d+[.)][ \t]+)/gmu, '')
    .replace(/(?<![\p{L}\p{N}_])(\*{1,3}|_{1,3}|~~)(?=\S)([^\r\n]+?)\1(?![\p{L}\p{N}_])/gu, '$2')
    .replace(/`+([^\r\n`]+)`+/gu, '$1')
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
  return Array.from(plain).slice(0, 100).join('');
}

export function codexInputOperations(context: Context) {
  const { storage } = context;
  return {
    getCodexRun: (runId: string) => codexRun(storage, runId),

    reconcileCodexHistory(runId: string, snapshot: HistoryObservation, answerDeliveryId?: number) {
      return storage.transaction(() => {
        const run = codexRun(storage, runId);
        if (!sameConnection(run, snapshot.binding) || run.threadId !== snapshot.threadId) {
          throw new Error('History belongs to another Codex run');
        }
        const { handoffId, threadId } = run;
        const handoff = getHandoff(storage, handoffId);
        const consent = captureGrant(storage, { projectId: handoff.projectId, connectionId: run.connectionId });
        const now = context.now();
        const { owned, conflict } = codexTurnOwnership(storage, runId, run);
        const turnIds = new Set<string>();
        const itemIds = new Set<string>();
        let duplicate = false;
        for (const turn of snapshot.turns) {
          if (turnIds.has(turn.id)) duplicate = true;
          turnIds.add(turn.id);
          for (const item of turn.items) {
            if (itemIds.has(item.id)) duplicate = true;
            itemIds.add(item.id);
          }
        }
        const active = snapshot.turns.filter(turn => turn.inProgress);
        const turnConflict = conflict || duplicate || active.length > 1;
        const historical = activeRunId(storage, handoffId) !== runId || !!storage.get(`
          SELECT 1 FROM run WHERE id = ? AND stop_state IS NOT NULL
        `, runId);
        const eventIds: number[] = [];

        if (turnConflict) {
          const origin = providerOrigin(run, 'history-conflict', JSON.stringify([runId, threadId]));
          if (!storage.get('SELECT 1 FROM event WHERE source = ? AND source_id = ?', origin.source, origin.sourceId)) {
            eventIds.push(appendEvent(storage, handoffId, origin, now, {
              kind: 'codex-history-review', runId, destinationChatId: run.chatId,
              outcome: 'review', reason: 'turn-conflict',
            }));
          }
        }

        for (const turn of snapshot.turns.toReversed()) {
          // The adapter supplies one initial user input. Other user items on that turn need review.
          const bridgeTurn = owned.has(turn.id);
          const echo = bridgeTurn && !turnConflict && turn.items.slice(1).every(item => item.human)
            ? turn.items[0] : undefined;
          for (const item of turn.items) {
            if (item === echo && !item.human) continue;
            const locator: CodexLocator = { threadId, turnId: turn.id, itemId: item.id };
            const key = JSON.stringify([runId, threadId, turn.id, item.id]);
            const question = item.questionId === undefined ? undefined : getQuestion(storage, handoffId, item.questionId);
            const review = turnConflict || bridgeTurn ? 'turn-conflict'
              : !item.human ? 'unknown-authorship'
              : item.questionId !== undefined && question?.runId !== runId ? 'question-binding-mismatch' : undefined;
            const origin = providerOrigin(run, 'native-item', key);
            const previous = storage.get<{ kind: string }>(`
              SELECT kind FROM event WHERE source = ? AND source_id = ?
            `, origin.source, origin.sourceId);
            if (previous && (!review || review === 'unknown-authorship' || previous.kind === 'native-input-review')) continue;
            const fields = { runId, subjectId: item.id, destinationChatId: run.chatId };
            if (review) {
              const reviewOrigin = previous ? providerOrigin(run, 'native-item-review', key) : origin;
              if (!storage.get('SELECT 1 FROM event WHERE source = ? AND source_id = ?',
                reviewOrigin.source, reviewOrigin.sourceId)) {
                eventIds.push(appendEvent(storage, handoffId, reviewOrigin, now, {
                  ...fields, kind: 'native-input-review', outcome: 'review', reason: review, payload: { locator },
                }));
              }
              continue;
            }

            origin.actor = 'human';
            const update = {
              ...fields, kind: 'native-input', outcome: historical ? 'historical' : 'recorded',
              payload: { runId, summary: 'Human input in Codex.', locator },
            };
            if (historical || consent?.granted === 0) {
              eventIds.push(appendEvent(storage, handoffId, origin, now, {
                ...update, reason: consent?.granted === 0 ? 'capture-consent-revoked' : undefined,
              }));
            } else {
              const excerpt = consent?.granted === 1 && item.text ? plainExcerpt(item.text) : undefined;
              const correlationId = 'native-' + createHash('sha256').update(origin.source).update(key).digest('hex');
              const eventId = appendWithIntent(storage, handoffId, origin, now, {
                ...update, payload: { ...update.payload, ...(excerpt && { excerpt }) },
              }, { destinationChatId: handoff.originChatId, correlationId });
              eventIds.push(eventId);
              if (excerpt && consent) {
                const sourceId = linkSourceItem(storage, handoffId, run.chatId, JSON.stringify(locator));
                attachCapturedCopy(storage, eventId, sourceId, consent.generation);
              }
            }
            if (historical || !question) continue;

            const loom = storage.get<{ id: number; attempts: number }>(`
              SELECT id, attempts FROM delivery WHERE event_id = ?
            `, question.answerEventId);
            const reason = question.runState !== 'Running' ? 'inactive-run'
              : question.answerKind === 'native-answer' ? 'native-answer-already-resumed'
              : loom && loom.attempts > 0 ? 'loom-answer-already-claimed'
              : now >= question.expiresAt ? 'late-answer' : undefined;
            const answer = appendEvent(storage, handoffId, { ...bridgeOrigin, actor: 'human' }, now, {
              runId, kind: 'native-answer', subjectId: item.questionId, destinationChatId: run.chatId,
              outcome: reason ? 'skipped' : 'accepted', reason, payload: { locator },
            });
            eventIds.push(answer);
            if (!reason) {
              storage.run('UPDATE question SET answer_event_id = ? WHERE handoff_id = ? AND id = ?',
                answer, handoffId, item.questionId!);
              if (loom) skipDelivery(storage, loom.id, now, 'native-answer-already-resumed');
              if (question.replyEventId !== null) {
                const notice = storage.get<{ id: number }>('SELECT id FROM delivery WHERE event_id = ?', question.replyEventId);
                if (notice) skipDelivery(storage, notice.id, now, 'native-answer-already-resumed');
              }
            }
          }
        }

        if (answerDeliveryId === undefined) return { eventIds, claim: undefined };
        const reviewPending = storage.get(`
          SELECT 1 FROM event WHERE run_id = ? AND outcome = 'review'
            AND kind IN ('native-input-review', 'codex-history-review') LIMIT 1
        `, runId);
        const claim = historical || active.length || reviewPending ? undefined
          : claimQueuedDelivery(context, answerDeliveryId, now, true, runId);
        return { eventIds, claim: claim && { ...claim, runId, turnId: answerTurnId(claim.id) } };
      });
    },
  };
}
