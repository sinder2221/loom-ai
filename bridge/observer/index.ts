import { sameConnection, type ConnectionBinding } from '../adapters/binding.ts';
import { list, object, requiredText, type CodexTransport } from '../adapters/codex-protocol.ts';
import type { CodexLocator } from '../src/codex-input.ts';
import type { openBridge } from '../src/index.ts';

export type { CodexLocator } from '../src/codex-input.ts';

type Bridge = ReturnType<typeof openBridge>;
export type CodexAnswerClaim = NonNullable<ReturnType<Bridge['reconcileCodexHistory']>['claim']>;

export interface CodexHistoryItem {
  id: string;
  type: string;
  content?: unknown;
}

interface CodexHistoryTurn {
  id: string;
  status: 'inProgress' | 'completed' | 'failed' | 'interrupted';
  items: readonly CodexHistoryItem[];
}

function userText(content: unknown) {
  if (!Array.isArray(content)) return;
  return content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n');
}

export interface CodexHistory {
  readonly binding: ConnectionBinding;
  // Each page belongs to the requested thread. Turns are newest first, with full items.
  listTurns(threadId: string, cursor?: string): Promise<{
    threadId: string;
    turns: readonly CodexHistoryTurn[];
    nextCursor?: string;
  }>;
}

// The trusted host supplies independent, item-specific evidence. Linking an answer also needs a verified question ID.
type VerifyHuman = (binding: ConnectionBinding, locator: CodexLocator) => Promise<{
  locator: CodexLocator;
  questionId?: string;
} | undefined>;

export interface CodexAnswerWriter {
  readonly binding: ConnectionBinding;
  // Reserve the exact thread across both the history read and post, including against native writers.
  // If that coordination is unavailable, return without invoking the operation.
  // The post callback sends through codex.startTurn using the claim's turnId and runId.
  withExclusiveTurn<T>(threadId: string, operation: (post: (claim: CodexAnswerClaim) => Promise<void>) => Promise<T>):
    Promise<T | undefined>;
}

export function codexHistory(transport: CodexTransport): CodexHistory {
  return {
    binding: transport.binding,
    async listTurns(threadId, cursor) {
      const page = object(await transport.request({
        method: 'thread/turns/list', params: {
          threadId, sortDirection: 'desc', itemsView: 'full', limit: 20, ...(cursor ? { cursor } : {}),
        },
      }));
      if (page.threadId !== undefined && page.threadId !== threadId) throw new Error('Codex returned another thread');
      const turns = list(page.data).map((value): CodexHistoryTurn => {
        const { id, status, items } = object(value);
        if (status !== 'inProgress' && status !== 'completed' && status !== 'failed' && status !== 'interrupted') {
          throw new Error('Unknown Codex turn status');
        }
        return {
          id: requiredText(id), status, items: list(items).map(value => {
            const { id, type, content } = object(value);
            return { id: requiredText(id), type: requiredText(type), content };
          }),
        };
      });
      return { threadId, turns, nextCursor: page.nextCursor == null ? undefined : requiredText(page.nextCursor) };
    },
  };
}

export function codexObserver(bridge: Bridge, history: CodexHistory, verifyHuman: VerifyHuman = async () => undefined) {
  function boundRun(runId: string) {
    const run = bridge.getCodexRun(runId);
    if (!sameConnection(run, history.binding)) throw new Error('Codex history connection mismatch');
    return run;
  }

  async function readHistory(threadId: string) {
    const turns: CodexHistoryTurn[] = [];
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const page = await history.listTurns(threadId, cursor);
      if (page.threadId !== threadId) throw new Error('Codex returned another thread');
      turns.push(...page.turns);
      cursor = page.nextCursor;
      if (cursor !== undefined) {
        requiredText(cursor);
        if (cursors.has(cursor)) throw new Error('Codex repeated a turn history cursor');
        cursors.add(cursor);
      }
    } while (cursor !== undefined);
    return turns;
  }

  async function reconcile(runId: string, threadId: string, answerDeliveryId?: number) {
    const turns = [];
    for (const turn of await readHistory(threadId)) {
      const items = [];
      for (const item of turn.items) {
        if (item.type !== 'userMessage') continue;
        const locator = { threadId, turnId: turn.id, itemId: item.id };
        const proof = await verifyHuman(history.binding, { ...locator });
        const human = proof?.locator.threadId === threadId && proof.locator.turnId === turn.id &&
          proof.locator.itemId === item.id;
        items.push({
          id: item.id, human, questionId: human ? proof.questionId : undefined,
          text: human ? userText(item.content) : undefined,
        });
      }
      turns.push({ id: turn.id, inProgress: turn.status === 'inProgress', items });
    }
    return bridge.reconcileCodexHistory(runId, { binding: history.binding, threadId, turns }, answerDeliveryId);
  }

  return {
    async poll(runId: string) {
      const { threadId } = boundRun(runId);
      return (await reconcile(runId, threadId)).eventIds;
    },

    async resolve(runId: string, locator: CodexLocator) {
      const { threadId } = boundRun(runId);
      if (locator.threadId !== threadId) return undefined;
      const turns = (await readHistory(threadId)).filter(turn => turn.id === locator.turnId);
      if (turns.length !== 1) return undefined;
      const matches = turns[0].items.filter(item => item.id === locator.itemId);
      return matches.length === 1 && matches[0].type === 'userMessage' ? matches[0] : undefined;
    },

    async dispatchAnswer(runId: string, deliveryId: number, writer: CodexAnswerWriter) {
      const run = boundRun(runId);
      if (!sameConnection(run, writer.binding)) throw new Error('Codex answer connection mismatch');
      const outcome = await writer.withExclusiveTurn(run.threadId, async post => {
        const { claim } = await reconcile(runId, run.threadId, deliveryId);
        if (!claim) return 'blocked';
        await post(claim);
        return 'attempted';
      });
      return outcome ?? 'coordination-unavailable';
    },
  };
}
