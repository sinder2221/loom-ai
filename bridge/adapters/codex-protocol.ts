import type { Json } from '../src/index.ts';
import type { ConnectionBinding, Lookup } from './binding.ts';

export type CodexMarker = { kind: 'launch' | 'turn'; id: string };

export interface CodexPermissions {
  sandbox: 'read-only' | 'workspace-write';
  approvalPolicy: 'never' | 'on-request';
}

type Request =
  | { method: 'thread/start' | 'turn/start'; params: Json; marker: CodexMarker }
  | { method: 'thread/turns/list'; params: Json };

export interface CodexTransport {
  readonly binding: ConnectionBinding;
  request(request: Request): Promise<unknown>;
  // The marker is transport metadata. A found turn includes its threadId alongside the turn.
  lookup(marker: CodexMarker): Promise<Lookup<unknown>>;
  readQuestion(threadId: string, turnId: string): Promise<unknown>;
}

export function object(value: unknown) {
  if (typeof value !== 'object' || !value || Array.isArray(value)) {
    throw new Error('Invalid Codex object');
  }
  return value as Record<string, unknown>;
}

export function list(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Invalid Codex list');
  return value;
}

export function requiredText(value: unknown) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Missing Codex text field');
  return value;
}

const resultFields = ['acceptanceChecks', 'testsRun', 'unresolvedIssues', 'artifactReferences'] as const;
type CodexResult = Record<typeof resultFields[number], string[]>;
export const resultSchema: Json = {
  type: 'object',
  additionalProperties: false,
  required: [...resultFields],
  properties: Object.fromEntries(resultFields.map(field => [field, {
    type: 'array', items: { type: 'string' },
  }])),
};

export function resultFromTurn(turn: Record<string, unknown>): CodexResult {
  const final = list(turn.items).map(object).findLast(item => item.type === 'agentMessage');
  const result = object(JSON.parse(requiredText(final?.text)));
  if (Object.keys(result).length !== resultFields.length) throw new Error('Invalid Codex result fields');
  return Object.fromEntries(resultFields.map(field => [
    field, list(result[field]).map(requiredText),
  ])) as CodexResult;
}

export function questionFromEvent(value: unknown, threadId: string, turnId: string) {
  if (value === undefined) return;
  const event = object(value);
  const params = object(event.params);
  if (event.method !== 'item/tool/requestUserInput' ||
      params.threadId !== threadId || params.turnId !== turnId || params.isBlocking !== true) {
    throw new Error('Codex question does not match the active turn');
  }
  const requestId = typeof event.id === 'number' && Number.isSafeInteger(event.id) ? event.id : requiredText(event.id);
  const itemId = requiredText(params.itemId);
  const questions = list(params.questions).map(value => {
    const question = object(value);
    if (question.isSecret !== false) throw new Error('Secret Codex question');
    const options = list(question.options ?? []).map(value => {
      const option = object(value);
      return { label: requiredText(option.label), description: requiredText(option.description) };
    });
    return { id: requiredText(question.id), prompt: requiredText(question.question), options };
  });
  if (!questions.length || new Set(questions.map(question => question.id)).size !== questions.length) {
    throw new Error('Invalid Codex question IDs');
  }
  const question = { requestId, itemId, questions };
  return Object.defineProperty(question, 'frame', { value: event }) as typeof question & { readonly frame: typeof event };
}

export type CodexQuestion = NonNullable<ReturnType<typeof questionFromEvent>>;
