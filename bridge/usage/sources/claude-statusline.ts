import { directoryPath } from '../../helper/files.ts';
import { data } from '../input.ts';
import { claudeWindows, windowReading, type UsageSnapshot } from './snapshot.ts';
import { writeUsageSnapshot } from './store.ts';

const maxInputBytes = 64 * 1024;
const labels = { five_hour: '5h', seven_day: '7d' };

function snapshotFromInput(input: unknown, observedAt: number) {
  if (!data(input)) return;
  const snapshot: Extract<UsageSnapshot, { source: 'claude-statusline' }> = {
    observedAt, source: 'claude-statusline', windows: {},
  };
  if (data(input.rate_limits)) {
    for (const key of claudeWindows) {
      const value = input.rate_limits[key];
      if (!data(value)) continue;
      const window = windowReading(value.used_percentage, value.resets_at);
      if (window) snapshot.windows[key] = window;
    }
  }
  return snapshot;
}

async function statusLine() {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxInputBytes) return '';
    chunks.push(chunk);
  }

  const json = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size));
  const snapshot = snapshotFromInput(JSON.parse(json), Date.now());
  if (!snapshot) return '';
  writeUsageSnapshot(directoryPath('LOOM_DATA_DIR'), snapshot);

  return claudeWindows.flatMap(key => {
    const used = snapshot.windows[key]?.usedPercent;
    return used === undefined ? [] : [`${labels[key]} ${used}% used`];
  }).join(' · ');
}

if (import.meta.main) {
  let line = '';
  try { line = await statusLine(); } catch {
    // Raw input and filesystem errors never reach Claude's status line.
  }
  process.stdout.write(line + '\n');
}
