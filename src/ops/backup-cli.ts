import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { BackupError, BackupManager, type BackupOptions } from './backup.js';
import { diagnostic } from '../runtime/diagnostics.js';

const secret = z.string().regex(/^[a-fA-F0-9]{64,128}$/u).refine(value => value.length % 2 === 0);
/** Operational CLI needs backup/identity/economy keys, never the Discord token. */
export function readBackupOptions(environment: NodeJS.ProcessEnv, workspace: string, fromMirror = false): BackupOptions {
  const identityKey = Buffer.from(secret.parse(environment['ACCOUNT_IDENTITY_KEY']), 'hex');
  const backupKey = Buffer.from(z.string().regex(/^[a-fA-F0-9]{64}$/u).parse(environment['BACKUP_KEY']), 'hex');
  const economySeed = environment['MARKET_SEED'] ? Buffer.from(secret.parse(environment['MARKET_SEED']), 'hex') : undefined;
  const path = (input: string, local: boolean) => {
    if (input.length > 4_096 || input.includes('\0') || input.startsWith('\\\\') || input.startsWith('//') || input.split(/[\\/]/u).some(part => part === '..' || part === '.')) throw new BackupError('BACKUP_PATH_INVALID');
    const result = resolve(workspace, input), part = relative(resolve(workspace), result);
    if (local && (!part || part.startsWith('..') || isAbsolute(part))) throw new BackupError('BACKUP_PATH_INVALID');
    return result;
  };
  const databasePath = path(environment['PAPERMARKET_DATABASE_PATH'] || 'data/papermarket.sqlite', true);
  const primary = path(environment['PAPERMARKET_BACKUP_DIRECTORY'] || 'data/backups', true);
  const mirrorInput = environment['PAPERMARKET_BACKUP_MIRROR_DIRECTORY'];
  if (mirrorInput && !isAbsolute(mirrorInput)) throw new BackupError('BACKUP_PATH_INVALID');
  const mirror = mirrorInput ? path(mirrorInput, false) : undefined;
  if (fromMirror && !mirror) throw new BackupError('BACKUP_PATH_INVALID');
  return { databasePath, backupDirectory: fromMirror ? mirror! : primary, backupKey, identityKey,
    ...(economySeed ? { economySeed } : {}), ...(!fromMirror && mirror ? { mirrorDirectory: mirror } : {}) };
}

export async function runBackupCli(args: readonly string[], environment: NodeJS.ProcessEnv, workspace: string, output: (value: string) => void): Promise<void> {
  const [command, backupId, target, extra] = args;
  const fromMirror = command === 'verify-mirror' || command === 'restore-mirror';
  if (extra || !command || !['create','run-due','verify','rehearse','restore','verify-mirror','restore-mirror'].includes(command) || (command === 'create' || command === 'run-due' ? backupId !== undefined : backupId === undefined) || (command === 'restore' || command === 'restore-mirror' ? target === undefined : target !== undefined)) throw new BackupError('BACKUP_INVALID');
  const manager = new BackupManager(readBackupOptions(environment, workspace, fromMirror));
  try {
    if (command === 'run-due') {
      const result = await manager.runDue(); output(JSON.stringify({ code: 'BACKUP_SCHEDULE_CHECKED', status: result.status, backupId: result.backup?.backupId, mirrored: result.mirrored, rehearsed: result.rehearsed, retained: result.retained })); return;
    }
    const manifest = command === 'create' ? await manager.create() : command === 'restore' || command === 'restore-mirror' ? await manager.restoreToNewFile(backupId!, target!) : command === 'rehearse' ? await manager.rehearse(backupId!) : await manager.verify(backupId!);
    output(JSON.stringify({ code: command.startsWith('restore') ? 'BACKUP_RESTORED_NEW_FILE' : command === 'create' ? 'BACKUP_CREATED' : 'BACKUP_VERIFIED', backupId: manifest.backupId, createdAt: manifest.createdAt, schemaVersion: manifest.fingerprint.schemaVersion, stateHash: manifest.fingerprint.stateHash, markets: manifest.fingerprint.markets, accounts: manifest.fingerprint.accounts }));
  } finally { await manager.stop(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBackupCli(process.argv.slice(2), process.env, process.cwd(), value => process.stdout.write(`${value}\n`)).catch(error => {
    diagnostic(error instanceof BackupError ? error.code : 'BACKUP_COMMAND_FAILED'); process.exitCode = 1;
  });
}
