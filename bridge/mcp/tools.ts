import {
  credentialToken, fields, identifier, message, nonceValue, positiveInt,
} from '../src/approval-input.ts';

export type HelperCall = (operation: string, args: unknown[]) => Promise<unknown>;

const idSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{1,128}$' };
const tokenSchema = { type: 'string', pattern: '^[A-Za-z0-9_-]{43}$' };
const nonEmptyText = { type: 'string', minLength: 1 };
const replyTurnCount = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };

export const tools = [
  {
    name: 'loom_answer',
    description: 'Submit an answer for an open question in this Loom binding.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { questionId: idSchema, nonce: { ...nonEmptyText, maxLength: 256 }, answer: nonEmptyText },
      required: ['questionId', 'nonce', 'answer'],
    },
  },
  {
    name: 'loom_delegate',
    description: 'Queue one read-only Codex launch for a handoff in the registered project folder itself, not a folder inside it.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: {
        handoffId: idSchema, title: nonEmptyText, brief: nonEmptyText,
        folder: { type: 'string', maxLength: 4096, pattern: '^/' },
        model: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$' },
      },
      required: ['handoffId', 'brief', 'folder'],
    },
  },
  {
    name: 'loom_status',
    description: 'Read handoff states, open questions, and final results within this Loom binding.',
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { handoffId: idSchema, after: idSchema },
    },
  },
  {
    name: 'loom_queue_reply',
    description: 'Queue a notification for an open question within the handoff’s automatic-turn limit.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { handoffId: idSchema, runId: idSchema, questionId: idSchema },
      required: ['handoffId', 'runId', 'questionId'],
    },
  },
  {
    name: 'loom_resume',
    description: 'Raise a handoff’s automatic-turn limit by the approved count.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { handoffId: idSchema, extraTurns: replyTurnCount, approval: tokenSchema },
      required: ['handoffId', 'extraTurns', 'approval'],
    },
  },
];

interface Request {
  op: string;
  args: unknown[];
}

export function toolRequest(name: string, input: unknown, credential: string): Request | undefined {
  switch (name) {
    case 'loom_answer':
      if (fields(input, ['questionId', 'nonce', 'answer']) && identifier(input.questionId)
        && nonceValue(input.nonce) && message(input.answer)) {
        return { op: 'answerQuestion', args: [credential, input.questionId, input.nonce, input.answer] };
      }
      return;
    case 'loom_delegate':
      if (input && typeof input === 'object' && 'folder' in input && typeof input.folder === 'string') {
        // The bridge validates the request and records refusals, including attempts to add permission fields.
        return { op: 'queueDelegateLaunch', args: [credential, input] };
      }
      return;
    case 'loom_status':
      if (fields(input, [], ['handoffId', 'after'])
        && (!Object.hasOwn(input, 'handoffId') || identifier(input.handoffId))
        && (!Object.hasOwn(input, 'after') || identifier(input.after))
        && !(input.handoffId && input.after)) {
        return { op: 'projectReplyStatus', args: [credential, input.handoffId ?? null, input.after ?? null] };
      }
      return;
    case 'loom_queue_reply':
      if (fields(input, ['handoffId', 'runId', 'questionId'])
        && identifier(input.handoffId) && identifier(input.runId) && identifier(input.questionId)) {
        return { op: 'queueAutomaticReply', args: [credential, input.handoffId, input.runId, input.questionId] };
      }
      return;
    case 'loom_resume':
      if (fields(input, ['handoffId', 'extraTurns', 'approval'])
        && identifier(input.handoffId) && positiveInt(input.extraTurns) && credentialToken(input.approval)) {
        return { op: 'consumeApproval', args: [credential, input.approval, {
          kind: 'approval', handoffId: input.handoffId, extraTurns: input.extraTurns,
        }] };
      }
  }
}

const reasons = new Set([
  'approval-required', 'approval-reused', 'approval-expired', 'origin-mismatch', 'request-mismatch',
  'launch-already-authorized', 'inactive-run', 'invalid-turn-limit', 'unknown-question', 'nonce-mismatch',
  'launch-folder-outside-project', 'launch-permissions-locked', 'invalid-launch-request',
  'duplicate-answer', 'late-answer', 'inactive-question', 'automatic-reply-already-queued', 'question-closed',
  'automatic-turn-cap', 'handoff-unavailable', 'question-uses-pull', 'invalid-question-answer',
]);

async function disposition(call: HelperCall, { op, args }: Request) {
  const input = await call(op, args);
  if (input === null || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid helper response');
  const value = input as Record<string, unknown>;
  // The helper owns this bounded, credential-screened projection.
  if (op === 'projectReplyStatus' && value.outcome === 'status'
    && Array.isArray(value.handoffs) && (value.next === null || identifier(value.next))) {
    return { outcome: 'status', handoffs: value.handoffs, next: value.next };
  }
  if (value.outcome === 'queued' || value.outcome === 'accepted' || value.outcome === 'resumed') {
    return { outcome: value.outcome };
  }
  if ((value.outcome === 'ignored' || value.outcome === 'rejected')
    && typeof value.reason === 'string' && reasons.has(value.reason)) {
    return { outcome: value.outcome, reason: value.reason };
  }
  throw new Error('Invalid helper response');
}

export async function callTool(call: HelperCall, request: Request) {
  let result: Awaited<ReturnType<typeof disposition>>;
  try { result = await disposition(call, request); } catch { result = { outcome: 'unavailable' }; }
  const isError = result.outcome === 'rejected' || result.outcome === 'ignored' || result.outcome === 'unavailable';
  return { content: [{ type: 'text', text: JSON.stringify(result) }], ...(isError && { isError }) };
}
