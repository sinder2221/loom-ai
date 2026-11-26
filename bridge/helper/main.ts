import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
  directoryPath, hasCode, lockOwner, pidAlive, prepareRuntime, Refusal, runtimePaths, type Paths,
} from './files.ts';
import { launchAgent } from './launch-agent.ts';
import { queryStatus, socketAnswers } from './protocol.ts';

type Outcome = { code: number; reason: string };

function result(error: unknown): Outcome {
  return error instanceof Refusal ? { code: error.exitCode, reason: error.message }
    : { code: 1, reason: 'helper-failed' };
}

function reportToStarter(outcome: Outcome) {
  if (process.connected && process.send) {
    process.send(outcome, () => {});
  }
}

async function start(options: string[]) {
  const child = spawn(process.execPath, ['--experimental-sqlite', fileURLToPath(import.meta.url), 'serve', ...options], {
    detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const outcome = await new Promise<Outcome>((resolve, reject) => {
    timeout = setTimeout(() => reject(new Refusal('helper-start-timed-out')), 15_000);
    child.once('message', message => resolve(message as Outcome));
    child.once('error', () => reject(new Refusal('helper-spawn-failed')));
    child.once('exit', () => reject(new Refusal('helper-exited-before-ready')));
  }).finally(() => {
    clearTimeout(timeout);
    child.unref();
    if (child.connected) child.disconnect();
  });
  if (outcome.code !== 0) throw new Refusal(outcome.reason, outcome.code);
  process.stdout.write('started\n');
}

async function status(paths: Paths) {
  const owner = prepareRuntime(paths, false) ? lockOwner(paths) : undefined;
  if (!owner || !pidAlive(owner.pid)) return undefined;
  const running = await queryStatus(paths.socket);
  if (running.pid !== owner.pid) throw new Refusal('helper-owner-mismatch');
  return running;
}

async function stop(paths: Paths) {
  if (!prepareRuntime(paths, false)) return;
  const owner = lockOwner(paths);
  if (!owner) return;
  if (!pidAlive(owner.pid)) {
    if (await socketAnswers(paths.socket)) throw new Refusal('helper-owner-mismatch');
    return;
  }
  if (!(await status(paths)) || lockOwner(paths)?.marker !== owner.marker) return;
  try { process.kill(owner.pid, 'SIGTERM'); } catch (error) {
    if (!hasCode(error, 'ESRCH')) throw error;
  }
  const deadline = Date.now() + 10_000;
  while (lockOwner(paths)?.marker === owner.marker && pidAlive(owner.pid)) {
    if (Date.now() > deadline) throw new Refusal('helper-stop-timed-out');
    await delay(25);
  }
}

async function main() {
  const [command, ...options] = process.argv.slice(2);
  const management = command === 'install' || command === 'uninstall';
  const runner = ['start', 'restart', 'serve'].includes(command)
    && options.length === 3 && options[0] === '--runner' && options[1] === '--codex-bin';
  if ((!management && !['start', 'stop', 'restart', 'status', 'serve'].includes(command))
    || (options.length !== 0 && !runner && !(management && options.length === 1 && options[0] === '--apply'))) {
    throw new Refusal('usage: main.ts start|restart|serve [--runner --codex-bin /absolute/path]|stop|status|install [--apply]|uninstall [--apply]', 2);
  }

  const binary = runner ? options[2] : undefined;
  if (binary !== undefined) {
    try {
      if (!isAbsolute(binary) || !statSync(binary).isFile()) throw new Error();
      accessSync(binary, constants.X_OK);
    } catch { throw new Refusal('invalid-codex-executable', 2); }
  }
  const data = directoryPath('LOOM_DATA_DIR');
  if (management) return launchAgent(command, options.length === 1, data);
  const paths = runtimePaths(data);
  if (command === 'serve') {
    process.umask(0o077);
    prepareRuntime(paths, true);
    const { serve } = await import('./daemon.ts');
    return serve(paths, () => reportToStarter({ code: 0, reason: 'ready' }), binary);
  }
  if (command === 'status') {
    const running = await status(paths);
    process.stdout.write(JSON.stringify(running ?? { running: false }) + '\n');
    if (!running) process.exitCode = 4;
    return;
  }
  if (command === 'stop' || command === 'restart') await stop(paths);
  if (command === 'stop') process.stdout.write('stopped\n');
  else await start(options);
}

main().catch(error => {
  const outcome = result(error);
  reportToStarter(outcome);
  process.stderr.write(outcome.reason + '\n');
  process.exitCode = outcome.code;
});
