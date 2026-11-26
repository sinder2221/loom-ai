import { linkSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { directoryPath, inspect, Refusal, uid } from './files.ts';

const label = 'com.projectloom.bridge';

function xml(value: string) {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function plist(data: string) {
  const program = fileURLToPath(new URL('./main.ts', import.meta.url));
  const args = [process.execPath, '--experimental-sqlite', program, 'serve'];
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array>
${args.map(arg => `    <string>${xml(arg)}</string>`).join('\n')}
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>LOOM_DATA_DIR</key><string>${xml(data)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
</dict>
</plist>
`;
}

export function launchAgent(action: 'install' | 'uninstall', apply: boolean, data: string) {
  const staging = directoryPath('LOOM_LAUNCH_AGENT_DIR');
  const destination = join(staging, `${label}.plist`);
  const contents = plist(data);
  if (apply) {
    const directory = inspect(staging);
    if (!directory?.isDirectory() || directory.uid !== uid || (directory.mode & 0o7777) !== 0o700) {
      throw new Refusal('launch-agent-staging-must-be-owned-and-mode-0700', 2);
    }
    const current = inspect(destination);
    if (current && (!current.isFile() || current.uid !== uid || current.nlink !== 1)) {
      throw new Refusal('unsafe-launch-agent-file');
    }
    if (action === 'install') {
      if (current) {
        if (readFileSync(destination, 'utf8') !== contents) throw new Refusal('launch-agent-file-already-exists');
      } else {
        const temporary = mkdtempSync(join(staging, '.plist-'));
        try {
          const file = join(temporary, 'agent.plist');
          writeFileSync(file, contents, { mode: 0o600 });
          linkSync(file, destination);
        } finally {
          rmSync(temporary, { recursive: true, force: true });
        }
      }
    } else if (current) {
      unlinkSync(destination);
    }
  } else {
    process.stdout.write(contents);
  }
  const verb = action === 'install' ? 'bootstrap' : 'bootout';
  const quoted = "'" + destination.replaceAll("'", "'\"'\"'") + "'";
  process.stdout.write(`launchctl ${verb} gui/${uid} ${quoted}\n`);
}
