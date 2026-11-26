import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { claudeOriginIds, realDirectory } from '../src/projects.ts';
import type { Storage } from '../src/storage.ts';
import { hasCode, inspect, overlapsPrivateData, prepareRuntime, readPrivateToken, Refusal, runtimePaths } from './files.ts';
import { directoryIdentity, makeDirectory, publish, removeDirectory, removeFile, snapshot } from './project-files.ts';

const mcpFile = '.mcp.json';
const skillFile = '.claude/skills/delegate/SKILL.md';
const skillDirectories = ['.claude', '.claude/skills', '.claude/skills/delegate'];
const mcpEntry = fileURLToPath(new URL('../mcp/main.ts', import.meta.url));
const decoder = new TextDecoder('utf-8', { fatal: true });
const hash = (content: string | Buffer) => createHash('sha256').update(content).digest('hex');
const object = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const refused = (reason: string) => ({ outcome: 'refused', reason });
const readAccess = 'Loom requires a named profile for project reads and minimal platform files. macOS also permits reads under /private/tmp. Loom denies reads of its own private data folder. An unconfirmed profile blocks delegation.';

interface Manifest {
  folder: string;
  folderIdentity: string;
  entry: ReturnType<typeof serverEntry>;
  config: 'created' | 'merged' | 'reused';
  beforeConfig?: string;
  beforeConfigMode?: number;
  wroteConfig?: string;
  hadServers?: boolean;
  skillHash: string;
  createdSkill: boolean;
  directories: string[];
  plannedParents: Record<string, string>;
  intendedDirectories: string[];
  stages: Record<string, string>;
  madeDirectories: Record<string, string>;
  credentialHash: string;
}

function serverEntry(data: string, credentialFile: string) {
  return {
    command: process.execPath,
    args: [mcpEntry],
    env: { LOOM_DATA_DIR: data, LOOM_ORIGIN_CREDENTIAL_FILE: credentialFile },
  };
}

function parseConfig(bytes: Buffer) {
  let config: unknown;
  try {
    config = JSON.parse(decoder.decode(bytes), (_key, value, context: { source?: string }) => {
      // Preserve JSON number literals even when they cannot round-trip through a JS Number.
      if (typeof value === 'number' && context.source !== JSON.stringify(value)) return JSON.rawJSON(context.source!);
      return value;
    });
  } catch { throw new Refusal('invalid-mcp-config'); }
  if (!object(config) || (Object.hasOwn(config, 'mcpServers') &&
    (!object(config.mcpServers) || JSON.isRawJSON(config.mcpServers)))) throw new Refusal('invalid-mcp-config');
  return config;
}

const configBytes = (config: object) => Buffer.from(JSON.stringify(config, null, 2) + '\n');

export function claudeConnections(storage: Storage, data: string) {
  const paths = runtimePaths(data);
  const backups = join(data, 'mcp-backups');
  const credentialDirectorySafe = () => {
    try { return realDirectory(data) === data && prepareRuntime(paths, false); } catch { return false; }
  };
  const registration = (projectId: string) => storage.get<{ folder: string }>(
    'SELECT folder FROM project_registration WHERE project_id = ?', projectId,
  );

  function record(projectId: string) {
    const row = storage.get<{ manifest: string; applied: number }>(`
      SELECT manifest, applied FROM claude_project_connection WHERE project_id = ?
    `, projectId);
    if (row) return { manifest: JSON.parse(row.manifest) as Manifest, applied: row.applied === 1 };
  }

  function projectFiles(folder: string, root: string) {
    if (realDirectory(folder, { readable: true }) !== folder || directoryIdentity(folder) !== root) {
      throw new Refusal('project-folder-changed');
    }
    return skillDirectories.flatMap(directory => directoryIdentity(join(folder, directory)) ? [] : [directory]);
  }

  function plan(projectId: string) {
    const registered = registration(projectId);
    if (!registered) throw new Refusal('not-registered');
    const { folder } = registered;
    if (overlapsPrivateData(folder, data)) throw new Refusal('project-overlaps-private-data');
    const folderIdentity = directoryIdentity(folder);
    if (!folderIdentity) throw new Refusal('folder-unavailable');
    const directories = projectFiles(folder, folderIdentity);
    if (!credentialDirectorySafe()) throw new Refusal('unsafe-credential-directory');
    const credentialFile = join(paths.runtime, `claude-origin-${hash(projectId)}`);
    if (inspect(credentialFile)) throw new Refusal('credential-file-conflict');
    const entry = serverEntry(data, credentialFile);
    const config = snapshot(join(folder, mcpFile));
    const parsed = config ? parseConfig(config.bytes) : {};
    const hadServers = Object.hasOwn(parsed, 'mcpServers');
    const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
    const hadLoom = Object.hasOwn(servers, 'loom');
    if (hadLoom && !isDeepStrictEqual(servers.loom, entry)) throw new Refusal('loom-server-conflict');
    const nextConfig = !hadLoom ? configBytes({ ...parsed, mcpServers: { ...servers, loom: entry } }) : undefined;
    if (nextConfig && nextConfig.length > 1024 * 1024) throw new Refusal('mcp-config-too-large');

    const skill = readFileSync(new URL('../skill/delegate/SKILL.md', import.meta.url));
    const priorSkill = snapshot(join(folder, skillFile));
    if (priorSkill && !skill.equals(priorSkill.bytes)) throw new Refusal('delegate-skill-conflict');

    const manifest: Omit<Manifest, 'credentialHash'> = {
      folder, folderIdentity, entry, directories, madeDirectories: {}, intendedDirectories: [], stages: {},
      plannedParents: Object.fromEntries(skillDirectories.filter(directory => !directories.includes(directory))
        .map(directory => [join(folder, directory), directoryIdentity(join(folder, directory))!])), hadServers,
      config: hadLoom ? 'reused' : config ? 'merged' : 'created',
      ...(config && !hadLoom && { beforeConfig: config.bytes.toString('base64'), beforeConfigMode: config.mode }),
      ...(nextConfig && { wroteConfig: hash(nextConfig) }),
      skillHash: hash(skill), createdSkill: !priorSkill,
    };
    const changes = {
      readAccess,
      configBackup: {
        directory: backups, mode: '0600',
        when: 'Loom saves the current .mcp.json bytes here before replacing or removing the file.',
      },
      directories: directories.map(directory => join(folder, directory)),
      files: [
        { path: credentialFile, action: 'create', mode: '0600' },
        ...(!priorSkill ? [{ path: join(folder, skillFile), action: 'create', mode: '0600' }] : []),
        ...(nextConfig ? [{ path: join(folder, mcpFile), action: config ? 'merge' : 'create',
          json: { mcpServers: { loom: entry } } }] : []),
      ],
    };
    return { manifest, changes, config, nextConfig, skill };
  }

  function parentAt(manifest: Manifest, path: string) {
    const parent = dirname(path);
    const relativeParent = parent.slice(manifest.folder.length + 1);
    const expected = parent === manifest.folder ? manifest.folderIdentity
      : manifest.madeDirectories[relativeParent] ?? manifest.plannedParents?.[parent];
    if (!expected || directoryIdentity(parent) !== expected) throw new Refusal('unsafe-project-directory');
    return expected;
  }

  function stageFor(projectId: string, manifest: Manifest, path: string) {
    const stage = '.loom-write-' + randomUUID();
    manifest.stages ??= {};
    manifest.stages[join(dirname(path), stage)] = path;
    save(projectId, manifest);
    return stage;
  }

  function save(projectId: string, manifest: Manifest) {
    storage.run('UPDATE claude_project_connection SET manifest = ? WHERE project_id = ?', JSON.stringify(manifest), projectId);
  }

  function backupConfig(projectId: string, current: NonNullable<ReturnType<typeof snapshot>>) {
    try {
      if (!credentialDirectorySafe()) throw new Refusal('unsafe-credential-directory');
      const identity = directoryIdentity(data)!;
      if (!inspect(backups)) makeDirectory(backups, identity);
      const directory = inspect(backups);
      if (!directory?.isDirectory() || directory.uid !== process.getuid!() || (directory.mode & 0o7777) !== 0o700) {
        throw new Refusal('unsafe-backup-directory');
      }
      const suffix = randomUUID();
      publish(join(backups, `${hash(projectId)}-${suffix}.mcp.json`), directoryIdentity(backups)!,
        '.loom-write-' + suffix, current.bytes, 0o600);
    } catch {
      throw new Refusal('mcp-backup-failed');
    }
  }

  function revoke(projectId: string, manifest: Manifest) {
    storage.transaction(() => {
      storage.run('UPDATE claude_project_connection SET applied = 0 WHERE project_id = ?', projectId);
      storage.run('DELETE FROM approval_origin WHERE chat_id = ? AND credential_hash = ?',
        claudeOriginIds(projectId).originChatId, manifest.credentialHash);
    });
  }

  function remove(projectId: string, manifest: Manifest) {
    revoke(projectId, manifest);
    const kept: string[] = [];
    const { folder, folderIdentity, entry } = manifest;
    const credential = entry.env.LOOM_ORIGIN_CREDENTIAL_FILE;
    try {
      if (!credentialDirectorySafe()) kept.push(credential);
      else if (inspect(credential)) {
        const token = readPrivateToken(credential);
        if (token && hash(token) === manifest.credentialHash) {
          const prior = snapshot(credential);
          if (prior && hash(prior.bytes) === manifest.credentialHash) {
            removeFile(credential, directoryIdentity(paths.runtime)!, prior);
          } else kept.push(credential);
        }
        else kept.push(credential);
      }
    } catch (error) {
      if (error instanceof Refusal || hasCode(error, 'ELOOP', 'EISDIR')) kept.push(credential);
      else throw error;
    }

    const config = join(folder, mcpFile);
    const skill = join(folder, skillFile);
    const skillAttempted = manifest.createdSkill &&
      (!manifest.stages || Object.values(manifest.stages).includes(skill));
    const directoryAttempts = [...new Set(Object.keys(manifest.madeDirectories).concat(manifest.intendedDirectories ?? []))];
    let rootSafe = false;
    try { rootSafe = realDirectory(folder) === folder && directoryIdentity(folder) === folderIdentity; } catch {}
    if (!rootSafe) {
      if (manifest.wroteConfig) kept.push(config);
      if (skillAttempted) kept.push(skill);
      kept.push(...directoryAttempts.map(path => join(folder, path)));
      for (const path of Object.keys(manifest.stages ?? {})) {
        if (dirname(path) !== paths.runtime || !credentialDirectorySafe() || inspect(path)) kept.push(path);
      }
      storage.run('DELETE FROM claude_project_connection WHERE project_id = ?', projectId);
      return { outcome: 'removed', kept };
    }
    for (const [stage, target] of Object.entries(manifest.stages ?? {})) {
      try {
        if (dirname(target) !== paths.runtime) parentAt(manifest, target);
        else if (!credentialDirectorySafe()) throw new Refusal('unsafe-credential-directory');
        if (inspect(stage)) kept.push(stage);
      } catch { kept.push(stage); }
    }
    if (manifest.wroteConfig) {
      try {
        const current = snapshot(config);
        if (current) {
          const original = manifest.beforeConfig && Buffer.from(manifest.beforeConfig, 'base64');
          if (hash(current.bytes) === manifest.wroteConfig &&
            current.mode === (manifest.beforeConfigMode ?? 0o600)) {
            backupConfig(projectId, current);
            if (original) publish(config, parentAt(manifest, config), stageFor(projectId, manifest, config),
              original, current.mode, current);
            else removeFile(config, parentAt(manifest, config), current);
          } else if (!original || !original.equals(current.bytes) || current.mode !== manifest.beforeConfigMode) {
            const parsed = parseConfig(current.bytes);
            const servers = parsed.mcpServers as Record<string, unknown> | undefined;
            if (servers && isDeepStrictEqual(servers.loom, entry)) {
              delete servers.loom;
              if (Object.keys(servers).length === 0 && !manifest.hadServers) delete parsed.mcpServers;
              backupConfig(projectId, current);
              publish(config, parentAt(manifest, config), stageFor(projectId, manifest, config),
                configBytes(parsed), current.mode, current);
            }
            kept.push(config);
          }
        }
      } catch (error) {
        if (!(error instanceof Refusal) || error.message === 'mcp-backup-failed') throw error;
        kept.push(config);
      }
    }
    let skillPathSafe = true;
    for (const dir of skillDirectories) {
      try {
        const path = join(folder, dir);
        const existing = directoryIdentity(path);
        const expected = manifest.madeDirectories[dir] ?? manifest.plannedParents?.[path];
        if (existing && existing !== expected) throw new Refusal('unsafe-project-directory');
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        skillPathSafe = false;
        break;
      }
    }
    if (skillAttempted) {
      try {
        if (!skillPathSafe) throw new Refusal('unsafe-project-directory');
        const current = snapshot(skill);
        if (current) {
          if (hash(current.bytes) === manifest.skillHash && current.mode === 0o600) {
            removeFile(skill, parentAt(manifest, skill), current);
          }
          else kept.push(skill);
        }
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        kept.push(skill);
      }
    }
    for (const directory of directoryAttempts.reverse()) {
      const path = join(folder, directory);
      try {
        const identity = manifest.madeDirectories[directory];
        if (!skillPathSafe || !identity || directoryIdentity(path) !== identity) {
          if (!skillPathSafe || inspect(path)) kept.push(path);
          continue;
        }
        removeDirectory(path, parentAt(manifest, path), identity);
      } catch (error) {
        if (!(error instanceof Refusal) && !hasCode(error, 'ENOTEMPTY', 'EEXIST')) throw error;
        kept.push(path);
      }
    }
    storage.run('DELETE FROM claude_project_connection WHERE project_id = ?', projectId);
    return { outcome: 'removed', kept };
  }

  const status = (projectId: string) => {
    const registered = registration(projectId);
    if (!registered) return refused('not-registered');
    const current = record(projectId);
    if (!current) return { outcome: 'not-connected' };
    const { manifest, applied } = current;
    if (!applied || registered.folder !== manifest.folder) return { outcome: 'needs-removal' };
    try {
      if (!credentialDirectorySafe() || projectFiles(manifest.folder, manifest.folderIdentity).length) return { outcome: 'files-changed' };
      const config = snapshot(join(manifest.folder, mcpFile));
      const servers = config && parseConfig(config.bytes).mcpServers as Record<string, unknown> | undefined;
      const skill = snapshot(join(manifest.folder, skillFile));
      const token = readPrivateToken(manifest.entry.env.LOOM_ORIGIN_CREDENTIAL_FILE);
      return servers && isDeepStrictEqual(servers.loom, manifest.entry) && skill &&
        hash(skill.bytes) === manifest.skillHash && token && hash(token) === manifest.credentialHash &&
        storage.get('SELECT 1 FROM approval_origin WHERE chat_id = ? AND credential_hash = ?',
          claudeOriginIds(projectId).originChatId, manifest.credentialHash) ? { outcome: 'connected' } : { outcome: 'files-changed' };
    } catch { return { outcome: 'files-changed' }; }
  };

  return {
    status,
    preview(projectId: string) {
      if (record(projectId)) return status(projectId);
      try { return { outcome: 'preview', ...plan(projectId).changes }; } catch (error) {
        return refused(error instanceof Refusal ? error.message : 'connection-preview-failed');
      }
    },
    apply(projectId: string) {
      if (record(projectId)) return status(projectId);
      let planned: ReturnType<typeof plan>;
      try { planned = plan(projectId); } catch (error) {
        return refused(error instanceof Refusal ? error.message : 'connection-preview-failed');
      }
      const { config, nextConfig, skill } = planned;
      const token = randomBytes(32).toString('base64url');
      const manifest: Manifest = { ...planned.manifest, credentialHash: hash(token) };
      const { folder, entry } = manifest;
      storage.run('INSERT INTO claude_project_connection (project_id, manifest) VALUES (?, ?)',
        projectId, JSON.stringify(manifest));

      try {
        projectFiles(folder, manifest.folderIdentity);
        if (!credentialDirectorySafe()) throw new Refusal('unsafe-credential-directory');
        const credential = entry.env.LOOM_ORIGIN_CREDENTIAL_FILE;
        publish(credential, directoryIdentity(paths.runtime)!, stageFor(projectId, manifest, credential), token, 0o600);
        for (const directory of manifest.directories) {
          const path = join(folder, directory);
          manifest.intendedDirectories.push(directory);
          save(projectId, manifest);
          manifest.madeDirectories[directory] = makeDirectory(path, parentAt(manifest, path));
          save(projectId, manifest);
        }
        if (manifest.createdSkill) {
          const path = join(folder, skillFile);
          publish(path, parentAt(manifest, path), stageFor(projectId, manifest, path), skill, 0o600);
        }
        if (nextConfig) {
          const path = join(folder, mcpFile);
          if (config) backupConfig(projectId, config);
          publish(path, parentAt(manifest, path), stageFor(projectId, manifest, path), nextConfig, config?.mode ?? 0o600, config);
        }
        storage.transaction(() => {
          if (registration(projectId)?.folder !== folder || statusFilesChanged()) throw new Refusal('project-file-changed');
          const { connectionId, originChatId } = claudeOriginIds(projectId);
          const accountRef = 'loom-project-origin';
          storage.run(`
            INSERT INTO connection (id, project_id, provider, account_ref) VALUES (?, ?, 'claude', ?)
            ON CONFLICT(id) DO NOTHING
          `, connectionId, projectId, accountRef);
          storage.run(`
            INSERT INTO chat_reference (id, connection_id, session_ref) VALUES (?, ?, ?)
            ON CONFLICT(id) DO NOTHING
          `, originChatId, connectionId, originChatId);
          if (!storage.get(`
            SELECT 1 FROM chat_reference c JOIN connection n ON n.id = c.connection_id
            WHERE c.id = ? AND c.session_ref = ? AND n.id = ? AND n.project_id = ?
              AND n.provider = 'claude' AND n.account_ref = ?
          `, originChatId, originChatId, connectionId, projectId, accountRef)
            || storage.get('SELECT 1 FROM approval_origin WHERE chat_id = ?', originChatId)) {
            throw new Refusal('project-origin-conflict');
          }
          storage.run('INSERT INTO approval_origin (chat_id, credential_hash) VALUES (?, ?)', originChatId, hash(token));
          storage.run('UPDATE claude_project_connection SET applied = 1 WHERE project_id = ?', projectId);
        });
        return { outcome: 'connected' };
      } catch (error) {
        try {
          const cleanup = remove(projectId, manifest);
          const reason = error instanceof Refusal ? error.message : 'connection-apply-failed';
          return { ...refused(reason), ...(cleanup.kept.length > 0 && { kept: cleanup.kept }) };
        } catch { return refused('connection-cleanup-required'); }
      }

      function statusFilesChanged() {
        projectFiles(folder, manifest.folderIdentity);
        const current = snapshot(join(folder, mcpFile));
        const servers = current && parseConfig(current.bytes).mcpServers as Record<string, unknown> | undefined;
        return !servers || !isDeepStrictEqual(servers.loom, entry)
          || !snapshot(join(folder, skillFile))?.bytes.equals(skill)
          || readPrivateToken(entry.env.LOOM_ORIGIN_CREDENTIAL_FILE) !== token;
      }
    },
    remove(projectId: string) {
      if (!registration(projectId)) return refused('not-registered');
      const current = record(projectId);
      if (!current) return { outcome: 'not-connected' };
      try { return remove(projectId, current.manifest); } catch (error) {
        return refused(error instanceof Refusal && error.message === 'mcp-backup-failed'
          ? error.message : 'connection-cleanup-required');
      }
    },
  };
}
