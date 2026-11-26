import { chatRoute, providerOrigin } from '../adapters/binding.ts';
import type { Storage } from './storage.ts';

export function activeRunId(storage: Storage, handoffId: string) {
  return storage.get<{ id: string | null }>('SELECT active_run_id AS id FROM handoff WHERE id = ?', handoffId)?.id;
}

export function providerLaunch(storage: Storage, chatId: string, id: string) {
  const route = chatRoute(storage, chatId);
  const marker = JSON.stringify(['launch', id]);
  const outcome = providerOrigin(route, 'launch-outcome', marker);
  const intent = providerOrigin(route, 'launch-intent', marker);
  const decision = providerOrigin(route, 'launch-decision', marker);
  const launch = storage.get<{ threadId: string; cwd: string }>(`
    SELECT json_extract(payload, '$.threadId') AS threadId, json_extract(payload, '$.cwd') AS cwd
    FROM event WHERE source = ? AND source_id = ? AND kind = 'launch-finished' AND subject_id = ?
  `, outcome.source, marker, id);
  const requested = storage.get<{ cwd: string }>(`
    SELECT json_extract(payload, '$.cwd') AS cwd FROM event
    WHERE source = ? AND source_id = ? AND kind = 'observation'
  `, intent.source, marker);
  const started = storage.get(`
    SELECT 1 FROM event WHERE source = ? AND source_id = ? AND kind = 'launch-started' AND subject_id = ?
  `, decision.source, marker, id) !== undefined;
  return { route, launch, requested, started };
}

export function codexRun(storage: Storage, runId: string) {
  const run = storage.get<{ handoffId: string; chatId: string; state: string; supersededBy: string | null }>(`
    SELECT handoff_id AS handoffId, destination_chat_id AS chatId, state, superseded_by AS supersededBy
    FROM run WHERE id = ?
  `, runId);
  if (!run) throw new Error('Unknown run');
  const { route, launch } = providerLaunch(storage, run.chatId, runId);
  if (route.provider !== 'codex' || !launch) throw new Error('Codex run has no bound thread');
  return { ...run, ...route, threadId: launch.threadId };
}

export function codexTurnOwnership(storage: Storage, runId: string, run: ReturnType<typeof codexRun>) {
  const source = providerOrigin(run, 'turn-outcome', '').source;
  const turns = storage.all<{ turnId: string | null; threadId: string | null; state: string; reason: string | null }>(`
    SELECT json_extract(e.payload, '$.turnId') AS turnId, json_extract(e.payload, '$.threadId') AS threadId,
           t.state, t.reason
    FROM turn t LEFT JOIN event e ON e.source = ? AND e.source_id = json_array('turn', t.id)
      AND e.kind = 'turn-accepted' AND e.subject_id = t.id
    WHERE t.run_id = ?
  `, source, runId);
  const owned = new Set<string>();
  let conflict = false;
  for (const { turnId, threadId, state, reason } of turns) {
    if (turnId === null) {
      if (state === 'In flight' || reason === 'restart-before-turn-outcome') conflict = true;
    } else if (threadId !== run.threadId || owned.has(turnId)) {
      conflict = true;
    } else {
      owned.add(turnId);
    }
  }
  const otherOwner = storage.get(`
    SELECT 1 FROM event e JOIN run r ON r.id = e.subject_id AND r.id <> ?
    JOIN chat_reference c ON c.id = r.destination_chat_id AND c.connection_id = ?
    WHERE e.kind = 'launch-finished' AND e.actor = 'codex' AND json_extract(e.payload, '$.threadId') = ?
    LIMIT 1
  `, runId, run.connectionId, run.threadId);
  return { owned, conflict: conflict || otherOwner !== undefined };
}
