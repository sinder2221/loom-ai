import { isAbsolute } from 'node:path';
import { realpathSync } from 'node:fs';
import { directoryPath, readPrivateToken, runtimePaths } from '../helper/files.ts';
import { requestHelper } from '../helper/protocol.ts';
import { serveMcp } from './server.ts';

async function main() {
  const file = process.env.LOOM_ORIGIN_CREDENTIAL_FILE;
  let credential = process.env.LOOM_ORIGIN_CREDENTIAL ?? '';
  if (file !== undefined) {
    if (!isAbsolute(file) || realpathSync.native(file) !== file) throw new Error('Invalid credential file');
    const token = readPrivateToken(file);
    if (!token) throw new Error('Invalid credential file');
    credential = token;
  }
  await serveMcp(process.stdin, process.stdout, async (operation, args) => {
    const { socket } = runtimePaths(directoryPath('LOOM_DATA_DIR'));
    return requestHelper(socket, operation, args);
  }, credential);
}

main().catch(() => {
  process.stderr.write('loom-mcp-failed\n');
  process.exitCode = 1;
});
