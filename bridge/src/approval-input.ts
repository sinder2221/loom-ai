import { isAbsolute } from 'node:path';

export interface ApprovalOrigin {
  projectId: string;
  connectionId: string;
  originChatId: string;
}

export interface LaunchRequest {
  kind: 'launch';
  brief: string;
  folder: string;
  model?: string;
}

export type ApprovalRequest = LaunchRequest
  | { kind: 'answer'; questionId: string; answer: string }
  | { kind: 'approval'; handoffId: string; extraTurns: number };

export interface LaunchPlan {
  destinationChatId: string;
  resolvedModel: string;
}

export interface ApprovalInput extends ApprovalOrigin {
  token: string;
  handoffId: string;
  runId: string;
  expiresAt: number;
  request: ApprovalRequest;
  launchPlan?: LaunchPlan;
}

export function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && required.every(key => Object.hasOwn(value, key))
    && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}

export const identifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
export const credentialToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
export const positiveInt = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
export const message = (value: unknown): value is string =>
  typeof value === 'string' && value.trim() !== '';
export const nonceValue = (value: unknown): value is string =>
  message(value) && value.length <= 256 && value.isWellFormed();
export const modelName = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(value);

function launchFields(value: Record<string, unknown>) {
  return message(value.brief) && typeof value.folder === 'string' && value.folder.length <= 4096
    && isAbsolute(value.folder) && !/[\x00-\x1f\x7f]/.test(value.folder)
    && (!Object.hasOwn(value, 'model') || modelName(value.model));
}

export function approvalRequest(value: unknown): value is ApprovalRequest {
  if (!fields(value, ['kind'], ['brief', 'folder', 'model', 'questionId', 'answer', 'handoffId', 'extraTurns'])) return false;
  switch (value.kind) {
    case 'launch': return fields(value, ['kind', 'brief', 'folder'], ['model']) && launchFields(value);
    case 'answer': return fields(value, ['kind', 'questionId', 'answer']) && identifier(value.questionId) && message(value.answer);
    case 'approval': return fields(value, ['kind', 'handoffId', 'extraTurns'])
      && identifier(value.handoffId) && positiveInt(value.extraTurns);
    default: return false;
  }
}

export function approvalInput(value: unknown): value is ApprovalInput {
  const ids = ['projectId', 'connectionId', 'originChatId', 'handoffId', 'runId'];
  if (!fields(value, [...ids, 'token', 'expiresAt', 'request'], ['launchPlan'])
    || !ids.every(id => identifier(value[id])) || !credentialToken(value.token)
    || !positiveInt(value.expiresAt) || !approvalRequest(value.request)) return false;
  if (value.request.kind !== 'launch') return !Object.hasOwn(value, 'launchPlan');
  return fields(value.launchPlan, ['destinationChatId', 'resolvedModel'])
    && identifier(value.launchPlan.destinationChatId) && modelName(value.launchPlan.resolvedModel);
}
