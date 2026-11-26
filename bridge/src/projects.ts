import { createHash } from 'node:crypto';
import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { approvalRequest, fields, identifier, message, modelName } from './approval-input.ts';
import type { Context } from './events.ts';
import type { Storage } from './storage.ts';

interface ProjectFolder {
  projectId: string;
  folder: string;
}

interface ProjectInput extends ProjectFolder {
  name: string;
}

export interface DelegateProject {
  folder: string;
  destinationChatId: string;
  defaultModel: string;
}

interface EnableDelegationInput {
  projectId: string;
  accountLabel: string;
  model: string;
}

interface DelegationSetup {
  folder: string;
  delegateFolder: string | null;
  destinationChatId: string | null;
  model: string | null;
  sessionRef: string | null;
  connectionId: string | null;
  accountRef: string | null;
}

type RegistrationResult = { outcome: 'registered' | 'already-registered' }
  | { outcome: 'refused'; reason: 'invalid-request' | 'folder-unavailable' | 'project-conflict' | 'folder-already-registered' };
type RegistrationStatus = 'registered' | 'not-registered' | 'folder-changed' | 'folder-unavailable';
type RelinkResult = { outcome: 'relinked' | 'unchanged' }
  | { outcome: 'refused'; reason: 'invalid-request' | 'not-registered' | 'folder-unavailable' | 'folder-already-registered' };
type DelegationRefusal = 'invalid-request' | 'not-registered' | 'folder-unavailable' | 'delegation-conflict';
type EnableDelegationResult = { outcome: 'enabled' | 'already-enabled' }
  | { outcome: 'refused'; reason: DelegationRefusal | 'sensitive-label' };
type DelegationStatus = { outcome: 'not-enabled' }
  | { outcome: 'enabled'; accountLabel: string; model: string; accountCheck: 'not-verified' }
  | { outcome: 'refused'; reason: DelegationRefusal };

function folderPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 4096 && isAbsolute(value) && value.isWellFormed()
    && !value.includes('\0') && !value.split('/').includes('..');
}

export function projectFolderInput(value: unknown): value is ProjectFolder {
  return fields(value, ['projectId', 'folder']) && identifier(value.projectId) && folderPath(value.folder);
}

export function projectInput(value: unknown): value is ProjectInput {
  return fields(value, ['projectId', 'name', 'folder']) && identifier(value.projectId) && folderPath(value.folder)
    && typeof value.name === 'string' && value.name.length <= 160 && message(value.name)
    && value.name.isWellFormed() && !/\p{Cc}/u.test(value.name) && [...value.name].length <= 80;
}

function validAccountLabel(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 120 && message(value)
    && value.isWellFormed() && !/\p{Cc}/u.test(value) && [...value].length <= 60;
}

const driveLetterPath = /^[a-z]:/i;

function sensitiveAccountLabel(label: string) {
  // A digit distinguishes the sk- shape from ordinary names like Desk-computer.
  return label.startsWith('/') || label.startsWith('~') || driveLetterPath.test(label)
    || label.includes('@') || label.includes('\\') || label.includes('://')
    || /sk-(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{6,}/.test(label)
    || /ghp_[A-Za-z0-9]{6,}|xox[A-Za-z]-[A-Za-z0-9_-]{6,}|AKIA[0-9A-Z]{8,}/.test(label)
    || /bearer\s+(?=\S*[\p{Nd}\p{P}$+<=>^|~\x60])\S{8,}/iu.test(label)
    || /[A-Za-z0-9+/_=-]{32}/.test(label);
}

function delegationModelName(value: unknown): value is string {
  return modelName(value) && !driveLetterPath.test(value) && !value.includes('://');
}

export function enableDelegationInput(value: unknown): value is EnableDelegationInput {
  return fields(value, ['projectId', 'accountLabel', 'model']) && identifier(value.projectId)
    && validAccountLabel(value.accountLabel) && delegationModelName(value.model);
}

export function delegationStatusInput(value: unknown): value is { projectId: string } {
  return fields(value, ['projectId']) && identifier(value.projectId);
}

export function realDirectory(folder: string, { readable = false } = {}) {
  try {
    const resolved = realpathSync.native(folder);
    if (!statSync(resolved).isDirectory()) return;
    if (readable) accessSync(resolved, constants.R_OK | constants.X_OK);
    return resolved;
  } catch {
    // Keep filesystem details out of the result.
  }
}

export const userNamedPrefix = 'user-named:';

export function delegationIds(projectId: string) {
  // Reserve these IDs for this setup flow. A label prefix alone does not identify a row we created.
  const key = createHash('sha256').update(projectId).digest('hex');
  return { connectionId: `user-named-codex-${key}`, destinationChatId: `user-named-slot-${key}`,
    sessionRef: `slot-${projectId}` };
}

export function claudeOriginIds(projectId: string) {
  const key = createHash('sha256').update(projectId).digest('hex');
  return { connectionId: `project-claude-${key}`, originChatId: `project-origin-${key}` };
}

function delegationSetup(storage: Storage, projectId: string) {
  return storage.get<DelegationSetup>(`
    SELECT r.folder, d.folder AS delegateFolder, d.destination_chat_id AS destinationChatId,
      d.default_model AS model, c.session_ref AS sessionRef, n.id AS connectionId, n.account_ref AS accountRef
    FROM project_registration r
    LEFT JOIN delegate_project d ON d.project_id = r.project_id
    LEFT JOIN chat_reference c ON c.id = d.destination_chat_id
    LEFT JOIN connection n ON n.id = c.connection_id AND n.project_id = r.project_id AND n.provider = 'codex'
    WHERE r.project_id = ?
  `, projectId);
}

function userNamedSettings(setup: DelegationSetup, ids: ReturnType<typeof delegationIds>) {
  const { accountRef, model } = setup;
  if (setup.destinationChatId !== ids.destinationChatId || setup.connectionId !== ids.connectionId
    || setup.sessionRef !== ids.sessionRef || setup.delegateFolder !== setup.folder
    || !accountRef?.startsWith(userNamedPrefix) || !delegationModelName(model)) return;
  const accountLabel = accountRef.slice(userNamedPrefix.length);
  if (validAccountLabel(accountLabel) && accountLabel.trim() === accountLabel && !sensitiveAccountLabel(accountLabel)) {
    return { accountLabel, model };
  }
}

function validDelegateSettings(folder: string, defaultModel: string) {
  return approvalRequest({ kind: 'launch', brief: 'Project setup', folder, model: defaultModel });
}

// Both setup paths call this under a write transaction with a resolved folder.
function saveDelegateProject(storage: Storage, projectId: string, { folder, destinationChatId, defaultModel }: DelegateProject) {
  const registration = storage.get<{ folder: string }>(
    'SELECT folder FROM project_registration WHERE project_id = ?', projectId,
  );
  if (registration && registration.folder !== folder) throw new Error('Delegate project folder differs from registration');
  if (!storage.get(`
    SELECT 1 FROM chat_reference c JOIN connection n ON n.id = c.connection_id
    WHERE c.id = ? AND n.project_id = ? AND n.provider = 'codex'
  `, destinationChatId, projectId)) throw new Error('Invalid delegate project destination');
  storage.run(`
    INSERT INTO delegate_project (project_id, folder, destination_chat_id, default_model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(project_id) DO UPDATE SET folder = excluded.folder,
      destination_chat_id = excluded.destination_chat_id, default_model = excluded.default_model
  `, projectId, folder, destinationChatId, defaultModel);
}

export function projectOperations({ storage, now }: Context) {
  return {
    registerProject(input: unknown): RegistrationResult {
      if (!projectInput(input)) return { outcome: 'refused', reason: 'invalid-request' };
      const { projectId, name } = input;
      const folder = realDirectory(input.folder, { readable: true });
      if (!folder) return { outcome: 'refused', reason: 'folder-unavailable' };

      return storage.transaction(() => {
        const project = storage.get<{ name: string; registeredFolder: string | null; delegateFolder: string | null }>(`
          SELECT p.name, r.folder AS registeredFolder, d.folder AS delegateFolder FROM project p
          LEFT JOIN project_registration r ON r.project_id = p.id
          LEFT JOIN delegate_project d ON d.project_id = p.id
          WHERE p.id = ?
        `, projectId);
        if (project && (project.name !== name
          || (project.registeredFolder !== null && project.registeredFolder !== folder)
          || (project.delegateFolder !== null && project.delegateFolder !== folder))) {
          return { outcome: 'refused', reason: 'project-conflict' };
        }
        if (project?.registeredFolder === folder) return { outcome: 'already-registered' };
        if (storage.get('SELECT 1 FROM project_registration WHERE folder = ?', folder)) {
          return { outcome: 'refused', reason: 'folder-already-registered' };
        }
        if (!project) storage.run('INSERT INTO project (id, name) VALUES (?, ?)', projectId, name);
        storage.run('INSERT INTO project_registration (project_id, folder, registered_at) VALUES (?, ?, ?)',
          projectId, folder, now());
        return { outcome: 'registered' };
      });
    },

    relinkProject(input: unknown): RelinkResult {
      if (!projectFolderInput(input)) return { outcome: 'refused', reason: 'invalid-request' };
      const { projectId, folder: requestedFolder } = input;

      return storage.transaction(() => {
        const registration = storage.get<{ folder: string }>(
          'SELECT folder FROM project_registration WHERE project_id = ?', projectId,
        );
        if (!registration) return { outcome: 'refused', reason: 'not-registered' };
        const folder = realDirectory(requestedFolder, { readable: true });
        if (!folder) return { outcome: 'refused', reason: 'folder-unavailable' };
        if (folder === registration.folder) return { outcome: 'unchanged' };
        if (storage.get('SELECT 1 FROM project_registration WHERE folder = ?', folder)) {
          return { outcome: 'refused', reason: 'folder-already-registered' };
        }

        if (storage.get('SELECT 1 FROM claude_project_connection WHERE project_id = ?', projectId)) {
          storage.run(`
            DELETE FROM approval_origin WHERE chat_id = ? AND credential_hash = (
              SELECT json_extract(manifest, '$.credentialHash') FROM claude_project_connection WHERE project_id = ?
            )
          `, claudeOriginIds(projectId).originChatId, projectId);
          storage.run('UPDATE claude_project_connection SET applied = 0 WHERE project_id = ?', projectId);
        }
        storage.run('UPDATE project_registration SET folder = ? WHERE project_id = ?', folder, projectId);
        storage.run('UPDATE delegate_project SET folder = ? WHERE project_id = ?', folder, projectId);
        storage.run(`
          INSERT INTO project_folder_change (project_id, old_folder, new_folder, changed_at) VALUES (?, ?, ?, ?)
        `, projectId, registration.folder, folder, now());
        return { outcome: 'relinked' };
      });
    },

    projectRegistrationStatus(input: unknown): RegistrationStatus {
      if (!fields(input, ['projectId', 'folder']) || !identifier(input.projectId)) return 'not-registered';
      const registration = storage.get<{ folder: string }>(
        'SELECT folder FROM project_registration WHERE project_id = ?', input.projectId,
      );
      if (!registration) return 'not-registered';
      if (realDirectory(registration.folder, { readable: true }) !== registration.folder || !folderPath(input.folder)) {
        return 'folder-unavailable';
      }
      const actual = realDirectory(input.folder, { readable: true });
      if (!actual) return 'folder-unavailable';
      return actual === registration.folder ? 'registered' : 'folder-changed';
    },

    // The trusted host can also set up a delegate with a chat it already owns.
    registerDelegateProject(projectId: string, input: DelegateProject) {
      const { folder, destinationChatId, defaultModel } = input;
      if (!validDelegateSettings(folder, defaultModel)) throw new Error('Invalid delegate project settings');
      const resolved = realDirectory(folder);
      if (!resolved) throw new Error('Delegate project folder unavailable');
      storage.transaction(() => saveDelegateProject(storage, projectId, { folder: resolved, destinationChatId, defaultModel }));
    },

    enableDelegation(input: unknown): EnableDelegationResult {
      if (!enableDelegationInput(input)) return { outcome: 'refused', reason: 'invalid-request' };
      const { projectId, model } = input;
      const accountLabel = input.accountLabel.trim();
      if (sensitiveAccountLabel(accountLabel)) return { outcome: 'refused', reason: 'sensitive-label' };

      try {
        return storage.transaction(() => {
          const setup = delegationSetup(storage, projectId);
          if (!setup) return { outcome: 'refused', reason: 'not-registered' };
          const { folder } = setup;
          if (realDirectory(folder, { readable: true }) !== folder || !validDelegateSettings(folder, model)) {
            return { outcome: 'refused', reason: 'folder-unavailable' };
          }
          const ids = delegationIds(projectId);
          if (setup.destinationChatId !== null) {
            const current = userNamedSettings(setup, ids);
            return current?.accountLabel === accountLabel && current.model === model
              ? { outcome: 'already-enabled' } : { outcome: 'refused', reason: 'delegation-conflict' };
          }

          const { connectionId, destinationChatId, sessionRef } = ids;
          const accountRef = userNamedPrefix + accountLabel;
          if (storage.get(`
            SELECT 1 FROM connection WHERE id IN (?, ?)
              OR (project_id = ? AND provider = 'codex' AND account_ref = ?)
            UNION ALL
            SELECT 1 FROM chat_reference WHERE id IN (?, ?)
            LIMIT 1
          `, connectionId, destinationChatId, projectId, accountRef, connectionId, destinationChatId)) {
            return { outcome: 'refused', reason: 'delegation-conflict' };
          }
          storage.run("INSERT INTO connection (id, project_id, provider, account_ref) VALUES (?, ?, 'codex', ?)",
            connectionId, projectId, accountRef);
          storage.run('INSERT INTO chat_reference (id, connection_id, session_ref) VALUES (?, ?, ?)',
            destinationChatId, connectionId, sessionRef);
          saveDelegateProject(storage, projectId, { folder, destinationChatId, defaultModel: model });
          return { outcome: 'enabled' };
        });
      } catch {
        throw new Error('bridge-call-failed');
      }
    },

    delegationStatus(input: unknown): DelegationStatus {
      if (!delegationStatusInput(input)) return { outcome: 'refused', reason: 'invalid-request' };
      const { projectId } = input;
      const setup = delegationSetup(storage, projectId);
      if (!setup) return { outcome: 'refused', reason: 'not-registered' };
      if (realDirectory(setup.folder, { readable: true }) !== setup.folder) {
        return { outcome: 'refused', reason: 'folder-unavailable' };
      }
      if (setup.destinationChatId === null) return { outcome: 'not-enabled' };
      const current = userNamedSettings(setup, delegationIds(projectId));
      if (!current) return { outcome: 'refused', reason: 'delegation-conflict' };
      return { outcome: 'enabled', ...current, accountCheck: 'not-verified' };
    },
  };
}
