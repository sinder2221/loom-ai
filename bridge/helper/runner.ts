import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { chatRoute } from '../adapters/binding.ts';
import { CodexAppServerTransport, CodexRpcError } from '../adapters/codex-app-server.ts';
import { CodexToolIsolationError } from '../adapters/codex-runner-policy.ts';
import { codexAdapter, CodexLaunchSettingsError, CodexQuestionError } from '../adapters/codex.ts';
import { type CodexQuestion } from '../adapters/codex-protocol.ts';
import { dispatchAuthorizedLaunch, initialTurnId } from '../mcp/launch.ts';
import { appendEvent, bridgeOrigin, type Context } from '../src/events.ts';
import type { openBridge } from '../src/index.ts';
import { maxQuestionCharacters } from '../src/reply-status.ts';
import { pullAnswers } from '../src/questions.ts';
import type { Storage } from '../src/storage.ts';
import { hasOperationInFlight } from '../src/work.ts';
import { overlapsPrivateData } from './files.ts';

interface Job {
  projectId: string;
  handoffId: string;
  runId: string;
  chatId: string;
  activeRunId: string | null;
  state: string | null;
  stopState: string | null;
  turnState: string | null;
  runtimeState: string | null;
  runtimeReason: string | null;
}

const permissions = { sandbox: 'read-only', approvalPolicy: 'never' } as const;
const source = { actor: 'bridge', scope: 'handoff', source: 'delegate-runner' };
const questionLifetimeMs = 15 * 60_000;
const interruptInitialDelayMs = 500;
const interruptMaximumDelayMs = 8_000;
const interruptionReasons = new Set(['blocking-question-expired', 'provider-question-too-long', 'provider-question-invalid']);

function blockingPrompt({ questions }: CodexQuestion) {
  return questions.map(({ prompt, options }, index) => {
    const heading = questions.length > 1 ? `${index + 1}. ${prompt}` : prompt;
    return [heading, ...options.map(option => `- ${option.label}: ${option.description}`)].join('\n');
  }).join('\n\n');
}

export function startRunner(
  bridge: ReturnType<typeof openBridge>, storage: Storage, binary: string, data: string, onError: () => void,
  options: { now?: () => number; timeoutMs?: number; env?: NodeJS.ProcessEnv } = {},
) {
  const now = options.now ?? Date.now;
  const context: Context = { storage, now, automaticTurnLimit: 5, receiptWindowMs: 60_000 };
  const transports = new Map<string, CodexAppServerTransport>();
  const controller = new AbortController();
  const env = { ...process.env, ...options.env };
  for (const name of ['LOOM_DATA_DIR', 'LOOM_APPROVAL_ISSUER_TOKEN', 'LOOM_ORIGIN_CREDENTIAL', 'LOOM_ORIGIN_CREDENTIAL_FILE']) {
    delete env[name];
  }
  const transportFor = (route: ReturnType<typeof chatRoute>) => {
    if (controller.signal.aborted) return;
    let transport = transports.get(route.connectionId);
    if (!transport) {
      transport = new CodexAppServerTransport(route, {
        binary, env, privateData: data, timeoutMs: options.timeoutMs,
        canHandleQuestion: (threadId, turnId) => Boolean(storage.get(`
          SELECT 1 FROM event e JOIN run r ON r.id = e.subject_id
          JOIN delegate_launch d ON d.run_id = r.id JOIN handoff h ON h.active_run_id = r.id
          JOIN turn t ON t.id = 'loom-initial-' || r.id
          LEFT JOIN event a ON a.source = json_array('provider-adapter', 'turn-outcome', ?, r.destination_chat_id)
            AND a.source_id = json_array('turn', t.id)
          WHERE e.source = json_array('provider-adapter', 'launch-outcome', ?, r.destination_chat_id)
            AND e.kind = 'launch-finished' AND json_extract(e.payload, '$.threadId') = ?
            AND r.state = 'Running' AND r.stop_state IS NULL
            AND (t.state = 'In flight' OR t.reason = 'restart-before-turn-outcome')
            AND (a.id IS NULL OR json_extract(a.payload, '$.turnId') = ?)
        `, route.connectionId, route.connectionId, threadId, turnId)),
        onDeclinedRequest: reason => storage.run(
          'INSERT INTO codex_request_refusal (connection_id, occurred_at, reason) VALUES (?, ?, ?)',
          route.connectionId, now(), reason,
        ),
      });
      transports.set(route.connectionId, transport);
    }
    return transport;
  };
  const codex = codexAdapter(bridge, context, transportFor);
  const adapters = { bridge, codex };
  const interruptRetries = new Map<string, { at: number; delay: number }>();
  const reconciled = new Set<string>();
  const projects = new Map<string, Promise<void>>();

  function transition(job: Job, state: 'unknown' | 'failed' | 'completed' | null, reason: string | null, result?: string) {
    if (job.runtimeState === state && job.runtimeReason === reason) return;
    const changed = storage.transaction(() => {
      const current = storage.get<{ activeId: string | null; stopped: string | null }>(`
        SELECT h.active_run_id AS activeId, r.stop_state AS stopped
        FROM handoff h LEFT JOIN run r ON r.id = h.active_run_id WHERE h.id = ?
      `, job.handoffId);
      if (!current || (current.activeId && current.activeId !== job.runId) || current.stopped) return false;
      if (state === null) storage.run('DELETE FROM delegate_runtime WHERE run_id = ?', job.runId);
      else storage.run(`
        INSERT INTO delegate_runtime (run_id, state, reason, result_text) VALUES (?, ?, ?, ?)
        ON CONFLICT(run_id) DO UPDATE SET state = excluded.state, reason = excluded.reason, result_text = excluded.result_text
      `, job.runId, state, reason, result ?? null);
      if (state === 'completed' || state === 'failed') {
        const run = storage.get<{ state: string }>('SELECT state FROM run WHERE id = ?', job.runId);
        if (run) {
          const next = state === 'completed' ? 'Completed' : 'Interrupted';
          storage.run('UPDATE run SET state = ?, reason = ? WHERE id = ?', next, reason, job.runId);

          appendEvent(storage, job.handoffId, bridgeOrigin, now(), {
            kind: state === 'completed' ? 'run-finished' : 'run-interrupted', subjectId: job.runId,
            destinationChatId: job.chatId, fromState: run.state, toState: next, outcome: state, reason: reason ?? undefined,
          });
        }
      }
      appendEvent(storage, job.handoffId, source, now(), {
        kind: result === undefined ? 'delegate-runtime' : 'result', runId: job.state ? job.runId : undefined,
        subjectId: job.runId, outcome: state ?? 'observed', reason: reason ?? undefined,
        ...(result !== undefined && { payload: { text: result } }),
      });
      return true;
    });
    if (changed) {
      job.runtimeState = state;
      job.runtimeReason = reason;
      if (state === 'completed' || state === 'failed') {
        reconciled.delete(job.runId);
        interruptRetries.delete(initialTurnId(job.runId));
      }
    }
  }

  async function observeQuestion(job: Job, question: CodexQuestion) {
    const turnId = initialTurnId(job.runId);
    const questionId = 'question-' + createHash('sha256')
      .update(JSON.stringify([turnId, question.itemId, question.questions.map(({ id }) => id)])).digest('hex');
    const current = storage.get<{ answer: string | null; response: string | null; expiresAt: number }>(`
      SELECT json_extract(a.payload, '$.answer') AS answer, q.pull_response_state AS response, q.expires_at AS expiresAt
      FROM question q LEFT JOIN event a ON a.id = q.answer_event_id
      WHERE q.handoff_id = ? AND q.id = ? AND q.pull_turn_id = ?
    `, job.handoffId, questionId, turnId);
    if (!current) {
      const prompt = blockingPrompt(question);
      if ([...prompt].length > maxQuestionCharacters) {
        transition(job, 'unknown', 'provider-question-too-long');
        return;
      }
      transition(job, null, null);
      bridge.openQuestion({ handoffId: job.handoffId, runId: job.runId, questionId, nonce: randomUUID(),
        origin: { ...source, sourceId: questionId }, prompt,
        expiresAt: now() + questionLifetimeMs, pull: { turnId, count: question.questions.length } });
      return;
    }
    if (current.response === 'claimed' || current.response === 'unverified') {
      transition(job, 'unknown', 'answer-receipt-unverified');
      return;
    }
    if (current.response === 'request-closed') return;
    if (!current.answer) {
      if (current.expiresAt <= now()) transition(job, 'unknown', 'blocking-question-expired');
      else transition(job, null, null);
      return;
    }
    transition(job, null, null);
    const answers = pullAnswers(current.answer, question.questions.length);
    if (!answers) throw new Error('Stored answer is invalid');
    // Commit the claim before writing. A crash on either side of the write leaves the answer unverified.
    const claimed = storage.get<{ id: string }>(`
      UPDATE question SET pull_response_state = 'claimed'
      WHERE handoff_id = ? AND id = ? AND pull_response_state IS NULL AND answer_event_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM handoff h JOIN run r ON r.id = h.active_run_id JOIN turn t ON t.run_id = r.id
          WHERE h.id = question.handoff_id AND r.id = question.run_id AND r.state = 'Running'
            AND r.stop_state IS NULL AND t.id = question.pull_turn_id AND t.state = 'In flight'
        )
      RETURNING id
    `, job.handoffId, questionId);
    if (!claimed) return;
    const requestClosed = await codex.answerBlockingQuestion(turnId, question, answers).catch(() => false);
    // serverRequest/resolved can be emitted for cancellation or teardown. It only proves closure.
    storage.transaction(() => {
      storage.run('UPDATE question SET pull_response_state = ? WHERE handoff_id = ? AND id = ?',
        requestClosed ? 'request-closed' : 'unverified', job.handoffId, questionId);
      appendEvent(storage, job.handoffId, source, now(), {
        kind: 'delegate-answer-unverified', subjectId: questionId, runId: job.runId, outcome: 'unverified',
        reason: requestClosed ? 'request-closed-without-receipt' : 'answer-receipt-unverified',
      });
    });
    if (!requestClosed) transition(job, 'unknown', 'answer-receipt-unverified');
  }

  async function tryInterrupt(turnId: string) {
    const pending = interruptRetries.get(turnId);
    if (controller.signal.aborted || (pending && performance.now() < pending.at)) return;
    try { await codex.interruptTurn(turnId); } catch {
      // Even a rejected or timed-out request may have reached the provider.
    } finally {
      const delay = pending ? Math.min(pending.delay * 2, interruptMaximumDelayMs) : interruptInitialDelayMs;
      interruptRetries.set(turnId, { at: performance.now() + delay, delay });
    }
  }

  async function observe(job: Job) {
    const turnId = initialTurnId(job.runId);
    if ((job.activeRunId && job.activeRunId !== job.runId) || job.stopState) return;
    if (job.state === 'Starting' || job.state === 'Interrupted') {
      transition(job, 'unknown', 'launch-outcome-unverified');
      return;
    }
    if (!job.turnState) {
      if (job.runtimeState === 'unknown' && job.runtimeReason === 'dispatch-outcome-unverified') return;
      if (hasOperationInFlight(storage, job.handoffId, job.chatId)) return;
      const request = bridge.getAuthorizedLaunch(job.handoffId);
      if (!request) return transition(job, 'failed', 'launch-folder-outside-project');
      if (overlapsPrivateData(request.cwd, data)) return transition(job, 'failed', 'project-overlaps-private-data');
      if (job.state === 'Running') {
        const existing = codex.getLaunch(job.runId).provider;
        const transport = transportFor(chatRoute(storage, job.chatId));
        const found = await transport?.lookup({ kind: 'launch', id: job.runId }, { ...request, permissions });
        if (found?.status !== 'found' || (found.value as { thread: { id: string } }).thread.id !== existing?.threadId) {
          return transition(job, 'unknown', 'launch-outcome-unverified');
        }
      }
      try {
        if (!await dispatchAuthorizedLaunch(adapters, job.handoffId, 'plan')) {
          transition(job, 'failed', 'launch-folder-outside-project');
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (error instanceof CodexToolIsolationError) {
          storage.run("UPDATE turn SET state = 'Interrupted', reason = 'provider-tool-isolation-unverified' WHERE id = ?", turnId);
          transition(job, 'failed', 'provider-tool-isolation-unverified');
        } else if (error instanceof CodexLaunchSettingsError) transition(job, 'failed', 'provider-settings-mismatch');
        else if (error instanceof CodexRpcError && !codex.getLaunch(job.runId).provider) {
          transition(job, 'failed', 'provider-dispatch-rejected');
        } else if (error instanceof CodexRpcError) {
          // A rejected turn request has no accepted provider turn. An internal error is ambiguous.
          if (error.code === -32600 || error.code === -32601 || error.code === -32602) {
            storage.run("UPDATE turn SET state = 'Interrupted', reason = 'provider-turn-rejected' WHERE id = ?", turnId);
            transition(job, 'failed', 'provider-turn-rejected');
          } else transition(job, 'unknown', 'dispatch-outcome-unverified');
        } else transition(job, 'unknown', 'dispatch-outcome-unverified');
      }
      return;
    }

    const turn = codex.getTurn(turnId);
    if (turn.reason?.startsWith('provider-turn-')) {
      transition(job, 'failed', job.runtimeReason && interruptionReasons.has(job.runtimeReason) ? job.runtimeReason : turn.reason);
      return;
    }
    if (!turn.provider) {
      transition(job, 'unknown', 'turn-outcome-unverified');
      return;
    }
    let question: CodexQuestion | undefined;
    try { question = await codex.readQuestion(turnId); } catch (error) {
      if (!(error instanceof CodexQuestionError)) throw error;
      transition(job, 'unknown', 'provider-question-invalid');
    }
    if (!interruptionReasons.has(job.runtimeReason ?? '')) {
      if (question) await observeQuestion(job, question);
      else {
        const latest = storage.get<{ answered: number; expiresAt: number }>(`
          SELECT answer_event_id IS NOT NULL AS answered, expires_at AS expiresAt
          FROM question WHERE pull_turn_id = ? ORDER BY opened_event_id DESC LIMIT 1
        `, turnId);
        if (latest && !latest.answered && latest.expiresAt <= now()) {
          transition(job, 'unknown', 'blocking-question-expired');
        }
      }
    }
    if (controller.signal.aborted) return;
    const stopReason = job.runtimeReason && interruptionReasons.has(job.runtimeReason) ? job.runtimeReason : null;
    const stopping = Boolean(stopReason || turn.reason === 'restart-before-turn-outcome');
    const result = await codex.readResult(turnId).catch(error => {
      if (codex.getTurn(turnId).state === 'Completed') {
        transition(job, 'failed', stopReason ?? 'provider-result-invalid');
        return;
      }
      // The session's blocking request is evidence even if history is temporarily unavailable.
      if (!question && !stopping) throw error;
    });
    if (job.runtimeState === 'failed') return;
    if (result) {
      if (stopReason) transition(job, 'failed', stopReason);
      else transition(job, 'completed', null, JSON.stringify(result));
      return;
    }
    const observed = codex.getTurn(turnId);
    if (observed.reason?.startsWith('provider-turn-')) {
      transition(job, 'failed', stopReason ?? observed.reason);
      return;
    }
    if (stopping) {
      await tryInterrupt(turnId);
      return;
    }
    if (question) return;
    const lost = storage.get(`
      SELECT 1 FROM question WHERE pull_turn_id = ? AND pull_response_state IS NOT 'request-closed'
    `, turnId);
    if (lost || observed.reason === 'restart-before-turn-outcome' || job.runtimeState === 'unknown') {
      transition(job, 'unknown', job.runtimeReason ?? (lost ? 'blocking-request-unavailable' : 'turn-outcome-unverified'));
    }
  }

  const jobs = () => storage.all<Job>(`
    SELECT h.project_id AS projectId, d.handoff_id AS handoffId, d.run_id AS runId, d.destination_chat_id AS chatId,
      h.active_run_id AS activeRunId, r.state, r.stop_state AS stopState, t.state AS turnState,
      rt.state AS runtimeState, rt.reason AS runtimeReason
    FROM delegate_launch d JOIN handoff h ON h.id = d.handoff_id
    LEFT JOIN run r ON r.id = d.run_id LEFT JOIN turn t ON t.id = 'loom-initial-' || d.run_id
    LEFT JOIN delegate_runtime rt ON rt.run_id = d.run_id
    WHERE rt.state IS NULL OR rt.state = 'unknown'
    ORDER BY (r.id IS NULL), d.rowid
  `);

  async function pollProject(group: Job[]) {
    for (const job of group) {
      if (controller.signal.aborted) return;
      try {
        if (job.state && !reconciled.has(job.runId)) {
          reconciled.add(job.runId);
          if (job.turnState === 'Interrupted') transition(job, 'unknown', job.runtimeReason ?? 'turn-outcome-unverified');
          await codex.reconcile(id => id === job.runId);
          // Re-read work after reconciling durable evidence.
          const current = jobs().find(candidate => candidate.runId === job.runId);
          if (current) await observe(current);
        } else {
          await observe(job);
        }
      } catch {
        if (!controller.signal.aborted && !interruptionReasons.has(job.runtimeReason ?? '')) {
          transition(job, 'unknown', 'provider-observation-unverified');
        }
      }
    }
  }

  const task = (async () => {
    while (!controller.signal.aborted) {
      const grouped = Map.groupBy(jobs(), job => job.projectId);
      for (const [projectId, group] of grouped) {
        if (projects.has(projectId)) continue;
        const work = pollProject(group)
          .catch(() => { if (!controller.signal.aborted) onError(); })
          .finally(() => projects.delete(projectId));
        projects.set(projectId, work);
      }
      await delay(200, undefined, { signal: controller.signal }).catch(() => {});
    }
  })().catch(() => { if (!controller.signal.aborted) onError(); });
  return {
    async close() {
      controller.abort();
      await Promise.all([...transports.values()].map(transport => transport.close()));
      await task;
      await Promise.all(projects.values());
    },
  };
}
