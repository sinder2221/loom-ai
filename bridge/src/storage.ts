import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

type Parameter = string | number | null;

export interface Storage {
  run(sql: string, ...parameters: Parameter[]): number;
  get<Row>(sql: string, ...parameters: Parameter[]): Row | undefined;
  all<Row>(sql: string, ...parameters: Parameter[]): Row[];
  registerScalar(name: string, map: (value: unknown) => number | string | null): void;
  transaction<Result>(operation: () => Result): Result;
  close(): void;
}

const migrations = [
  '001-work.sql', '002-outbox.sql', '003-approvals.sql', '004-ownership.sql', '005-capture-consent.sql',
  '006-delegate-launch.sql', '007-project-registration.sql', '008-project-folder-change.sql', '009-delegate-runtime.sql',
];
export const schemaVersion = migrations.length;

export function openStorage(path: string): Storage {
  const database = new DatabaseSync(path, { timeout: 5000 });
  const storage: Storage = {
    run: (sql, ...parameters) => Number(database.prepare(sql).run(...parameters).lastInsertRowid),
    get: <Row>(sql: string, ...parameters: Parameter[]) => {
      const row = database.prepare(sql).get(...parameters);
      return row === undefined ? undefined : { ...row } as Row;
    },
    all: <Row>(sql: string, ...parameters: Parameter[]) =>
      database.prepare(sql).all(...parameters).map(row => ({ ...row }) as Row),
    registerScalar(name, map) {
      database.function(name, { deterministic: true }, value => map(value));
    },
    transaction(operation) {
      // Take the write lock before reading anything that informs a mutation.
      database.exec('BEGIN IMMEDIATE');
      try {
        const result = operation();
        database.exec('COMMIT');
        return result;
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    },
    close: () => database.close(),
  };

  try {
    storage.transaction(() => {
      const { user_version: version } = storage.get<{ user_version: number }>('PRAGMA user_version')!;
      if (version > schemaVersion) throw new Error(`Unsupported bridge schema version ${version}`);
      for (const [offset, migration] of migrations.slice(version).entries()) {
        database.exec(readFileSync(new URL(`../migrations/${migration}`, import.meta.url), 'utf8'));
        database.exec(`PRAGMA user_version = ${version + offset + 1}`);
      }
    });
    return storage;
  } catch (error) {
    database.close();
    throw error;
  }
}
