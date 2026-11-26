import type { openAdapters } from '../adapters/index.ts';

type Adapters = Pick<ReturnType<typeof openAdapters>, 'bridge' | 'codex'>;

// Called by the host that owns the configured Codex transport.
export async function dispatchAuthorizedLaunch({ bridge, codex }: Adapters, handoffId: string, mode?: 'plan') {
  const request = bridge.getAuthorizedLaunch(handoffId);
  if (!request) return false;
  const { brief, ...launch } = request;
  const run = await codex.startLaunch({
    ...launch, permissions: { sandbox: 'read-only', approvalPolicy: 'never' },
  });
  if (run.state === 'Running' && run.provider) {
    await codex.startTurn(initialTurnId(launch.id), launch.id, brief, mode && {
      mode, settings: { model: launch.model, reasoning_effort: null, developer_instructions: null },
    });
  }
  return true;
}

export const initialTurnId = (runId: string) => `loom-initial-${runId}`;
