import { once } from 'node:events';
import { chmodSync, unlinkSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { openBridge } from '../src/index.ts';
import { openStorage } from '../src/storage.ts';
import { claudeConnections } from './claude-connection.ts';
import { startRunner } from './runner.ts';
import {
  acquireLock, checkDatabaseFiles, hasCode, inspect, loadIssuerToken, logEvent, removeOwner, Refusal, uid, type Paths,
} from './files.ts';
import { operations, serveFrame, socketAnswers } from './protocol.ts';

function lastEvent(database: string) {
  if (!inspect(database)) return 0;
  // The first read after a kill may need to recover a hot rollback journal.
  const reader = new DatabaseSync(database, { timeout: 5000 });
  try {
    if (!reader.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = 'event'").get()) return 0;
    return Number(reader.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM event').get()!.id);
  } finally {
    reader.close();
  }
}

function reconciliationCounts(database: string, after: number) {
  const reader = new DatabaseSync(database, { readOnly: true, timeout: 5000 });
  try {
    const row = reader.prepare(`
      SELECT count(CASE WHEN kind = 'launch-interrupted' THEN 1 END) AS launches,
             count(CASE WHEN kind = 'turn-interrupted' THEN 1 END) AS turns,
             count(CASE WHEN kind = 'delivery-interrupted' THEN 1 END) AS deliveries
      FROM event WHERE id > ? AND source = 'bridge' AND source_id IS NULL
    `).get(after)!;
    return { launches: Number(row.launches), turns: Number(row.turns), deliveries: Number(row.deliveries) };
  } finally {
    reader.close();
  }
}

async function checkSocket(paths: Paths) {
  const stat = inspect(paths.socket);
  if (!stat) return false;
  if (!stat.isSocket() || stat.uid !== uid) throw new Refusal('unsafe-socket-file');
  return socketAnswers(paths.socket);
}

export async function serve(paths: Paths, ready: () => void, binary?: string) {
  const clients = new Set<Socket>();
  let bridge: ReturnType<typeof openBridge> | undefined;
  let storage: ReturnType<typeof openStorage> | undefined;
  let runner: ReturnType<typeof startRunner> | undefined;
  let owner: Awaited<ReturnType<typeof acquireLock>> | undefined;
  let calls: ReturnType<typeof operations>;
  let stopReason: Refusal | undefined;
  let wake: () => void;
  const stopped = new Promise<void>(resolve => { wake = resolve; });
  const stop = () => wake();
  const server = createServer({ allowHalfOpen: true }, socket => {
    clients.add(socket);
    socket.on('error', () => socket.destroy()).once('close', () => clients.delete(socket));
    socket.once('finish', () => socket.destroy());
    serveFrame(socket, calls, reason => {
      try { logEvent(paths, 'refusal', { reason }); } catch {
        stopReason = new Refusal('helper-log-failed');
        stop();
      }
    });
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);

  try {
    owner = await acquireLock(paths, () => checkSocket(paths));
    if (await checkSocket(paths)) throw new Refusal('already-running-or-starting', 3);
    const issuer = loadIssuerToken(paths, process.env.LOOM_APPROVAL_ISSUER_TOKEN);
    if (inspect(paths.socket)) unlinkSync(paths.socket);

    const listening = once(server, 'listening');
    server.listen(paths.socket);
    try { await listening; } catch (error) {
      throw new Refusal(hasCode(error, 'EPERM', 'EACCES') ? 'socket-bind-permission-denied' : 'socket-bind-failed');
    }
    server.once('error', () => { stopReason = new Refusal('socket-server-failed'); stop(); });
    chmodSync(paths.socket, 0o600);

    checkDatabaseFiles(paths.database);
    const baseline = lastEvent(paths.database);
    const opened = bridge = openBridge(paths.database);
    const reconciled = reconciliationCounts(paths.database, baseline);
    const local = storage = openStorage(paths.database);
    calls = operations(opened, () => ({
      running: true, pid: process.pid, reconciled, pendingDeliveries: opened.listPendingDeliveries().length,
    }), issuer, paths.data, claudeConnections(local, paths.data));
    logEvent(paths, 'start');
    logEvent(paths, 'reconcile', reconciled);
    if (binary) runner = startRunner(opened, local, binary, paths.data, () => {
      stopReason = new Refusal('runner-failed');
      stop();
    });
    ready();
    await stopped;
    if (stopReason) throw stopReason;
    logEvent(paths, 'stop');
  } catch (error) {
    logEvent(paths, 'refusal', { reason: error instanceof Refusal ? error.message : 'helper-failed' });
    throw error;
  } finally {
    try {
      if (server.listening) {
        const closed = once(server, 'close');
        server.close();
        for (const socket of clients.keys()) {
          if (!socket.writableEnded) socket.destroy();
        }
        await closed;
      }
    } finally {
      process.removeListener('SIGTERM', stop);
      process.removeListener('SIGINT', stop);
      try {
        await runner?.close();
      } finally {
        try { storage?.close(); } finally {
          try { bridge?.close(); } finally {
            if (owner) removeOwner(paths, owner);
          }
        }
      }
    }
  }
}
