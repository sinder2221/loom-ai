import { createHash, randomUUID } from 'node:crypto';
import { approvalInput, approvalRequest, credentialToken, fields, identifier, message,
  type ApprovalInput, type ApprovalOrigin, type ApprovalRequest } from './approval-input.ts';
import { deliveryOperations } from './deliveries.ts';
import { appendEvent, type Context } from './events.ts';
import { projectReplyStatus } from './reply-status.ts';
import { exportHandoff } from './export.ts';
import { realDirectory, type DelegateProject } from './projects.ts';
import { questionOperations } from './questions.ts';

interface Scope extends ApprovalOrigin {
  handoffId: string;
  runId: string;
}

interface Grant extends Scope {
  kind: ApprovalRequest['kind'];
  requestHash: string;
  expiresAt: number;
  consumedAt: number | null;
}

interface AuthorizedLaunch {
  id: string;
  handoffId: string;
  destinationChatId: string;
  brief: string;
  cwd: string;
  model: string;
}

function delegateFolder(root: string, folder: string) {
  if (realDirectory(root) !== root) return;
  if (folder.split('/').includes('..')) return;
  const cwd = realDirectory(folder);
  if (cwd === root) return cwd;
}

function permissionLike(key: string) {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return /permission|sandbox|approval|bypass|yolo|cwd|path|director|dir|folder|workspace|root|scope/.test(normalized);
}

const sha256 = (input: string) => createHash('sha256').update(input).digest('hex');
const controlOrigin = { actor: 'bridge', scope: 'handoff', source: 'authorization' };
const toolOrigin = () => ({ actor: 'claude', scope: 'handoff', source: 'loom-mcp', sourceId: randomUUID() });

function requestHash(request: Exclude<ApprovalRequest, { kind: 'launch' }>) {
  switch (request.kind) {
    case 'answer': return sha256(JSON.stringify([request.kind, request.questionId, request.answer]));
    case 'approval': return sha256(JSON.stringify([request.kind, request.handoffId, request.extraTurns]));
  }
}

function sameOrigin(left: ApprovalOrigin, right: ApprovalOrigin | undefined) {
  return right !== undefined && left.projectId === right.projectId
    && left.connectionId === right.connectionId && left.originChatId === right.originChatId;
}

export function approvalOperations(context: Context) {
  const { storage } = context;

  function refusal(kind: string, reason: string, now: number, handoffId?: string) {
    if (handoffId && storage.get('SELECT 1 FROM handoff WHERE id = ?', handoffId)) {
      appendEvent(storage, handoffId, controlOrigin, now, { kind, outcome: 'rejected', reason });
    } else {
      storage.run('INSERT INTO unbound_authorization_refusal (occurred_at, kind, reason) VALUES (?, ?, ?)',
        now, kind, reason);
    }
    return { outcome: 'rejected', reason };
  }

  const chatSelect = `
    SELECT n.project_id AS projectId, c.connection_id AS connectionId, c.id AS originChatId
    FROM chat_reference c JOIN connection n ON n.id = c.connection_id`;

  function originFor(credential: string) {
    if (!credentialToken(credential)) return;
    return storage.get<ApprovalOrigin>(`${chatSelect} JOIN approval_origin a ON a.chat_id = c.id
      WHERE a.credential_hash = ?`, sha256(credential));
  }

  function scopedHandoff(handoffId: string, origin: ApprovalOrigin) {
    return storage.get<{ brief: string; title: string; automaticTurns: number; automaticTurnLimit: number }>(`
      SELECT h.brief, h.title, h.automatic_turns AS automaticTurns, h.automatic_turn_limit AS automaticTurnLimit
      FROM handoff h JOIN chat_reference c ON c.id = h.origin_chat_id
      WHERE h.id = ? AND h.project_id = ? AND h.origin_chat_id = ? AND c.connection_id = ?
    `, handoffId, origin.projectId, origin.originChatId, origin.connectionId);
  }

  function activeRun(handoffId: string, runId: string) {
    return storage.get(`
      SELECT 1 FROM run WHERE handoff_id = ? AND id = ? AND state = 'Running' AND stop_state IS NULL
    `, handoffId, runId);
  }

  function launchExists(handoffId: string) {
    return storage.get(`
      SELECT 1 FROM delegate_launch WHERE handoff_id = ?
      UNION ALL SELECT 1 FROM run WHERE handoff_id = ?
      UNION ALL SELECT 1 FROM approval WHERE kind = 'launch' AND consumed_at IS NOT NULL AND handoff_id = ?
      LIMIT 1
    `, handoffId, handoffId, handoffId);
  }

  // The protected operations compose existing core operations under the outer write lock.
  function withinTransaction(now: number): Context {
    return { ...context, now: () => now, storage: { ...storage, transaction: operation => operation() } };
  }

  return {
    // Explicit text export is available only to the trusted local host.
    exportHandoffOverview(handoffId: string, check?: (text: string) => boolean) {
      return exportHandoff(storage, handoffId, check, { includeText: true });
    },

    // These two methods are for the trusted local host and have no IPC operation.
    bindApprovalOrigin(origin: ApprovalOrigin, credential: string) {
      if (![origin.projectId, origin.connectionId, origin.originChatId].every(identifier)
        || !credentialToken(credential)) throw new Error('Invalid origin binding');
      storage.transaction(() => {
        if (!sameOrigin(origin, storage.get<ApprovalOrigin>(`${chatSelect} WHERE c.id = ?`, origin.originChatId))) {
          throw new Error('Invalid origin binding');
        }
        storage.run(`
          INSERT INTO approval_origin (chat_id, credential_hash) VALUES (?, ?)
          ON CONFLICT(chat_id) DO UPDATE SET credential_hash = excluded.credential_hash
        `, origin.originChatId, sha256(credential));
      });
    },

    revokeApprovalOrigin(origin: ApprovalOrigin) {
      storage.run(`
        DELETE FROM approval_origin WHERE chat_id IN (
          SELECT c.id FROM chat_reference c JOIN connection n ON n.id = c.connection_id
          WHERE c.id = ? AND c.connection_id = ? AND n.project_id = ?
        )
      `, origin.originChatId, origin.connectionId, origin.projectId);
    },

    queueDelegateLaunch(credential: string, input: unknown) {
      return storage.transaction(() => {
        const now = context.now();
        const origin = originFor(credential);
        const handoffId = input && typeof input === 'object' && 'handoffId' in input && identifier(input.handoffId)
          ? input.handoffId : undefined;
        const reject = (reason: string) => refusal('launch-authorized', reason, now, handoffId);
        if (!origin || !storage.get("SELECT 1 FROM connection WHERE id = ? AND provider = 'claude'", origin.connectionId)) {
          return reject('origin-mismatch');
        }
        if (input && typeof input === 'object' && Object.keys(input)
          .some(key => !['handoffId', 'brief', 'folder', 'title', 'model'].includes(key) && permissionLike(key))) {
          return reject('launch-permissions-locked');
        }
        if (!handoffId || !fields(input, ['handoffId', 'brief', 'folder'], ['title', 'model'])
          || (Object.hasOwn(input, 'title') && !message(input.title))) return reject('invalid-launch-request');
        const { title, brief, folder, model } = input;
        const request = { kind: 'launch', brief, folder, ...(Object.hasOwn(input, 'model') && { model }) };
        if (!approvalRequest(request) || request.kind !== 'launch') return reject('invalid-launch-request');

        const handoff = scopedHandoff(handoffId, origin);
        if (!handoff && storage.get('SELECT 1 FROM handoff WHERE id = ?', handoffId)) return reject('origin-mismatch');
        const project = storage.get<DelegateProject>(`
          SELECT folder, destination_chat_id AS destinationChatId, default_model AS defaultModel
          FROM delegate_project WHERE project_id = ?
        `, origin.projectId);
        const cwd = project && delegateFolder(project.folder, request.folder);
        if (!project || !cwd) return reject('launch-folder-outside-project');
        if (handoff && handoff.automaticTurns >= handoff.automaticTurnLimit) return reject('automatic-turn-cap');
        if (launchExists(handoffId)) return reject('launch-already-authorized');
        if (handoff && (request.brief !== handoff.brief || (title !== undefined && title !== handoff.title))) {
          return reject('request-mismatch');
        }

        if (!handoff) {
          storage.run(`
            INSERT INTO handoff (id, project_id, origin_chat_id, title, brief, automatic_turn_limit)
            VALUES (?, ?, ?, ?, ?, ?)
          `, handoffId, origin.projectId, origin.originChatId,
          typeof title === 'string' ? title : 'Untitled handoff', request.brief, context.automaticTurnLimit);
          appendEvent(storage, handoffId, toolOrigin(), now, {
            kind: 'handoff-requested', subjectId: handoffId, destinationChatId: origin.originChatId, outcome: 'accepted',
          });
        }
        const runId = randomUUID();
        storage.run(`
          INSERT INTO delegate_launch (handoff_id, run_id, project_folder, cwd, destination_chat_id, model)
          VALUES (?, ?, ?, ?, ?, ?)
        `, handoffId, runId, project.folder, cwd, project.destinationChatId, request.model ?? project.defaultModel);
        appendEvent(storage, handoffId, toolOrigin(), now, {
          kind: 'launch-authorized', outcome: 'queued', subjectId: runId, destinationChatId: project.destinationChatId,
        });
        return { outcome: 'queued' };
      });
    },

    // No tool can issue grants. Legacy launch grants remain in storage for the audit.
    createApproval(input: ApprovalInput) {
      if (!approvalInput(input)) throw new Error('Invalid approval input');
      const { token, handoffId, runId, request, expiresAt } = input;
      return storage.transaction(() => {
        const now = context.now();
        const reject = (reason: string) => refusal('approval-created', reason, now, handoffId);
        if (request.kind === 'launch') return reject('invalid-launch-request');
        if (!scopedHandoff(handoffId, input)) return reject('origin-mismatch');
        if (expiresAt <= now) return reject('approval-expired');
        if (!activeRun(handoffId, runId)) return reject('inactive-run');
        if (request.kind === 'approval' && request.handoffId !== handoffId) return reject('request-mismatch');
        if (request.kind === 'answer' && !storage.get(`
          SELECT 1 FROM question WHERE handoff_id = ? AND run_id = ? AND id = ?
            AND answer_event_id IS NULL AND expires_at > ?
        `, handoffId, runId, request.questionId, now)) return reject('inactive-question');
        const tokenHash = sha256(token);
        if (storage.get('SELECT 1 FROM approval WHERE token_hash = ?', tokenHash)) return reject('approval-already-issued');
        storage.run(`
          INSERT INTO approval (token_hash, kind, project_id, connection_id, origin_chat_id, handoff_id,
            run_id, request_hash, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, tokenHash, request.kind, input.projectId, input.connectionId, input.originChatId, handoffId, runId,
        requestHash(request), expiresAt);
        appendEvent(storage, handoffId, controlOrigin, now, { kind: 'approval-created', outcome: 'issued' });
        return { outcome: 'issued' };
      });
    },

    consumeApproval(credential: string, token: string, request: ApprovalRequest) {
      return storage.transaction(() => {
        const now = context.now();
        const tokenHash = sha256(token);
        const grant = storage.get<Grant>(`
          SELECT kind, project_id AS projectId, connection_id AS connectionId, origin_chat_id AS originChatId,
            handoff_id AS handoffId, run_id AS runId, request_hash AS requestHash,
            expires_at AS expiresAt, consumed_at AS consumedAt FROM approval WHERE token_hash = ?
        `, tokenHash);
        const reject = (reason: string) => refusal('approval-consumed', reason, now, grant?.handoffId);
        if (request.kind === 'launch') return reject('invalid-launch-request');
        if (!grant) return reject('approval-required');
        if (!sameOrigin(grant, originFor(credential))) return reject('origin-mismatch');
        if (grant.consumedAt !== null) return reject('approval-reused');
        if (now >= grant.expiresAt) return reject('approval-expired');
        if (grant.kind !== request.kind || grant.requestHash !== requestHash(request)) return reject('request-mismatch');
        const { handoffId, runId } = grant;
        const handoff = scopedHandoff(handoffId, grant);
        if (!handoff) return reject('origin-mismatch');
        if (!activeRun(handoffId, runId)) return reject('inactive-run');

        if (request.kind === 'approval') {
          if (!Number.isSafeInteger(handoff.automaticTurnLimit + request.extraTurns)) return reject('invalid-turn-limit');
          questionOperations(withinTransaction(now)).resumeAutomaticReplies(handoffId, request.extraTurns, toolOrigin());
        }
        if (request.kind === 'answer' && !storage.get(`
          SELECT 1 FROM question WHERE handoff_id = ? AND run_id = ? AND id = ?
            AND answer_event_id IS NULL AND expires_at > ?
        `, handoffId, runId, request.questionId, now)) return reject('inactive-question');
        storage.run('UPDATE approval SET consumed_at = ? WHERE token_hash = ?', now, tokenHash);
        appendEvent(storage, handoffId, controlOrigin, now, { kind: 'approval-consumed', outcome: 'consumed' });
        return { outcome: request.kind === 'approval' ? 'resumed' : 'consumed' };
      });
    },

    getAuthorizedLaunch(handoffId: string): AuthorizedLaunch | undefined {
      const request = storage.get<AuthorizedLaunch & { folder: string; registeredFolder: string }>(`
        SELECT d.run_id AS id, d.handoff_id AS handoffId, h.brief, d.cwd, d.model,
          d.destination_chat_id AS destinationChatId, d.project_folder AS folder, p.folder AS registeredFolder
        FROM delegate_launch d JOIN handoff h ON h.id = d.handoff_id
        JOIN delegate_project p ON p.project_id = h.project_id WHERE d.handoff_id = ?
      `, handoffId);
      if (!request) return;
      const { folder, registeredFolder, ...launch } = request;
      if (folder !== registeredFolder || delegateFolder(folder, launch.cwd) !== launch.cwd) {
        storage.transaction(() => {
          const reason = 'launch-folder-outside-project';
          if (!storage.get(`
            SELECT 1 FROM event WHERE handoff_id = ? AND kind = 'launch-dispatch' AND subject_id = ? AND reason = ?
          `, handoffId, launch.id, reason)) appendEvent(storage, handoffId, controlOrigin, context.now(), {
            kind: 'launch-dispatch', subjectId: launch.id, outcome: 'rejected', reason,
          });
        });
        return;
      }
      return launch;
    },

    answerFromOrigin(credential: string, questionId: string, nonce: string, answer: string) {
      return storage.transaction(() => {
        const now = context.now();
        const origin = originFor(credential);
        const routeByNonce = storage.get<{ handoffId: string; runId: string; originChatId: string }>(`
          SELECT q.handoff_id AS handoffId, q.run_id AS runId, h.origin_chat_id AS originChatId
          FROM question q JOIN handoff h ON h.id = q.handoff_id WHERE q.nonce_hash = ?
        `, sha256(nonce));
        const reject = (reason: string, handoffId = routeByNonce?.handoffId) =>
          refusal('answer-observed', reason, now, handoffId);
        if (!origin) return reject('origin-mismatch');
        const owned = routeByNonce?.originChatId === origin.originChatId ? [routeByNonce] : storage.all<{
          handoffId: string; runId: string;
        }>(`
          SELECT q.handoff_id AS handoffId, q.run_id AS runId FROM question q
          JOIN handoff h ON h.id = q.handoff_id
          WHERE q.id = ? AND h.project_id = ? AND h.origin_chat_id = ? LIMIT 2
        `, questionId, origin.projectId, origin.originChatId);
        if (owned.length !== 1) {
          return reject(owned.length > 1 ? 'nonce-mismatch' : routeByNonce ? 'origin-mismatch' : 'unknown-question');
        }
        const { handoffId, runId } = owned[0];
        const scoped = withinTransaction(now);
        const { event } = questionOperations(scoped).answerQuestion({
          handoffId, runId, questionId, nonce, answer, originChatId: origin.originChatId,
          origin: toolOrigin(), correlationId: randomUUID(),
        });
        if (event.outcome === 'accepted') {
          // Use the receipt's attempt when available. A retry without a receipt is ambiguous.
          const delivery = storage.get<{ id: number; correlationId: string; attempt: number | null }>(`
            SELECT d.id, d.correlation_id AS correlationId,
              COALESCE(e.attempt, CASE WHEN d.attempts = 1 THEN 1 END) AS attempt
            FROM question q JOIN delivery d ON d.event_id = q.reply_event_id
            LEFT JOIN receipt r ON r.delivery_id = d.id AND r.kind = 'Received'
            LEFT JOIN event e ON e.id = r.event_id
            WHERE q.handoff_id = ? AND q.id = ? AND d.attempts > 0
          `, handoffId, questionId);
          if (delivery?.attempt) {
            deliveryOperations(scoped).recordReceipt(delivery.id, {
              kind: 'Acted', attempt: delivery.attempt, correlationId: delivery.correlationId,
              destinationChatId: origin.originChatId, evidence: 'loom-answer', origin: toolOrigin(),
            });
          }
        }
        // Keep the MCP disposition stable. The audit retains which answer won.
        if (event.reason === 'native-answer-already-resumed') return { outcome: 'ignored', reason: 'duplicate-answer' };
        return { outcome: event.outcome, ...(event.reason && { reason: event.reason }) };
      });
    },

    queueReplyFromOrigin(credential: string, handoffId: string, runId: string, questionId: string) {
      return storage.transaction(() => {
        const now = context.now();
        const origin = originFor(credential);
        if (!origin || !scopedHandoff(handoffId, origin)) {
          return refusal('automatic-reply', 'origin-mismatch', now, handoffId);
        }
        const { event } = questionOperations(withinTransaction(now)).queueAutomaticReply({
          handoffId, runId, questionId, origin: toolOrigin(), correlationId: randomUUID(),
        });
        return { outcome: event.outcome, ...(event.reason && { reason: event.reason }) };
      });
    },

    replyStatusFromOrigin(credential: string, handoffId?: string, after?: string) {
      const origin = originFor(credential);
      if (!origin) return { outcome: 'rejected', reason: 'handoff-unavailable' };
      return projectReplyStatus(storage, origin, context.now(), handoffId, after);
    },

    inspectFromOrigin(credential: string, handoffId: string) {
      const origin = originFor(credential);
      const handoff = origin && scopedHandoff(handoffId, origin);
      if (!handoff) return { outcome: 'rejected', reason: 'handoff-unavailable' };
      return {
        outcome: 'status', automaticTurns: handoff.automaticTurns, automaticTurnLimit: handoff.automaticTurnLimit,
        atCap: handoff.automaticTurns >= handoff.automaticTurnLimit,
      };
    },
  };
}
