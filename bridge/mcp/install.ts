import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const configFile = 'claude-mcp-fragment.json';
const skillFile = '.claude/skills/delegate/SKILL.md';

function install() {
  const args = process.argv.slice(2);
  const apply = args.length === 1 && args[0] === '--apply';
  if (args.length && !apply) {
    process.stderr.write('usage: node bridge/mcp/install.ts [--apply]\n');
    process.exitCode = 2;
    return;
  }
  const config = {
    mcpServers: {
      loom: {
        command: process.execPath,
        args: [fileURLToPath(new URL('./main.ts', import.meta.url))],
        env: { LOOM_DATA_DIR: '<absolute private bridge data directory>' },
      },
    },
  };
  if (!apply) {
    process.stdout.write(JSON.stringify({ mode: 'dry-run', configFile, config, projectSkill: skillFile }, null, 2) + '\n');
    return;
  }

  const staging = mkdtempSync('/tmp/loom-mcp-install-');
  mkdirSync(join(staging, '.claude/skills/delegate'), { recursive: true, mode: 0o700 });
  writeFileSync(join(staging, configFile), JSON.stringify(config, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  copyFileSync(new URL('../skill/delegate/SKILL.md', import.meta.url), join(staging, skillFile));
  process.stdout.write(JSON.stringify({ mode: 'staged', directory: staging, configFile, projectSkill: skillFile }) + '\n');
}

try { install(); } catch {
  process.stderr.write('loom-install-staging-failed\n');
  process.exitCode = 1;
}
