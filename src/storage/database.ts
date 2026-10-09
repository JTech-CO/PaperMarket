import Database from 'better-sqlite3';
import { migrateDatabase, MigrationIntegrityError, verifyDatabaseSchema } from './migrations.js';

export const MINIMUM_SQLITE_VERSION = '3.51.3';
export const DATABASE_BUSY_TIMEOUT_MS = 2_000;

function versionTuple(value: string): readonly [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  if (!match) throw new Error('Unsupported SQLite version format.');
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function isSupportedSqliteVersion(value: string): boolean {
  const actual = versionTuple(value);
  const minimum = versionTuple(MINIMUM_SQLITE_VERSION);
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index]! > minimum[index]!) return true;
    if (actual[index]! < minimum[index]!) return false;
  }
  return true;
}

/** Server-internal local path. Discord request data must never supply this path. */
export function openDatabase(path: string): Database.Database {
  if (typeof path !== 'string' || path.length < 1 || path.length > 4_096 || path.includes('\0') ||
      path.startsWith('\\\\') || path.startsWith('//') || path.startsWith('file:')) {
    throw new TypeError('Database requires a bounded local filesystem path.');
  }
  const db = new Database(path, { timeout: DATABASE_BUSY_TIMEOUT_MS });
  try {
    const loaded = db.prepare('SELECT sqlite_version() AS version').get() as { version: string };
    if (!isSupportedSqliteVersion(loaded.version)) {
      throw new Error(`SQLite ${MINIMUM_SQLITE_VERSION} or newer is required.`);
    }
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 2000');
    const journalMode = db.pragma('journal_mode = WAL', { simple: true });
    if (path !== ':memory:' && journalMode !== 'wal') throw new Error('File database must support WAL.');
    db.pragma('synchronous = FULL');
    if (db.pragma('foreign_keys', { simple: true }) !== 1 || db.pragma('synchronous', { simple: true }) !== 2) {
      throw new Error('Required durability settings were not applied.');
    }
    const quickCheck = db.pragma('quick_check') as Array<{ quick_check: string }>;
    if (quickCheck.length !== 1 || quickCheck[0]?.quick_check !== 'ok') throw new MigrationIntegrityError('Database integrity check failed.');
    migrateDatabase(db);
    verifyDatabaseSchema(db);
    const foreignKeyViolations = db.pragma('foreign_key_check') as unknown[];
    if (foreignKeyViolations.length !== 0) throw new MigrationIntegrityError('Database foreign key integrity check failed.');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
