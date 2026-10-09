import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';
import { canonicalEconomyJson } from '../economy/repository.js';
import { openReadonlyDatabase, recoveryFingerprintSchema, verifyRecoveryDatabase, type RecoveryFingerprint, type RecoveryKeys } from '../diagnostics/verify-recovery.js';
import { ProcessLock } from '../runtime/process-lock.js';

const HOUR = 3_600_000, DAY = HOUR * 24;
export const DEFAULT_BACKUP_POLICY = Object.freeze({ intervalMs: HOUR, dailyMirrorMs: DAY, rehearsalMs: DAY * 30, hourlyCopies: 24, dailyCopies: 7, weeklyCopies: 4 });
const policySchema = z.strictObject({
  intervalMs: z.number().int().min(60_000).max(DAY * 7), dailyMirrorMs: z.number().int().min(HOUR).max(DAY * 31),
  rehearsalMs: z.number().int().min(DAY).max(DAY * 366), hourlyCopies: z.number().int().min(1).max(168),
  dailyCopies: z.number().int().min(1).max(366), weeklyCopies: z.number().int().min(1).max(104),
});
export type BackupPolicy = z.infer<typeof policySchema>;
export interface BackupOptions extends RecoveryKeys {
  readonly databasePath: string; readonly backupDirectory: string; readonly mirrorDirectory?: string;
  readonly backupKey: Buffer; readonly now?: () => string; readonly policy?: Partial<BackupPolicy>;
}
const hash = z.string().regex(/^[a-f0-9]{64}$/), instant = z.string().datetime({ offset: false });
const backupIdSchema = z.string().regex(/^pm-[0-9]{13}-[a-f0-9-]{36}$/);
const unsignedManifestSchema = z.strictObject({
  formatVersion: z.literal(1), backupId: backupIdSchema, createdAt: instant,
  filename: z.string().regex(/^pm-[0-9]{13}-[a-f0-9-]{36}\.sqlite\.aes$/),
  encryption: z.literal('AES-256-GCM'), nonce: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/),
  bytes: z.number().int().positive().max(64 * 1024 ** 3), cipherSha256: hash, fingerprint: recoveryFingerprintSchema,
});
const manifestSchema = unsignedManifestSchema.extend({ authentication: hash });
export type BackupManifest = z.infer<typeof manifestSchema>;
export interface BackupRunResult { readonly status: 'RUN' | 'IDLE' | 'BUSY' | 'STOPPED'; readonly backup?: BackupManifest; readonly mirrored?: string; readonly rehearsed?: string; readonly retained?: number }
export class BackupError extends Error {
  constructor(readonly code: 'BACKUP_PATH_INVALID' | 'BACKUP_BUSY' | 'BACKUP_STOPPED' | 'BACKUP_INVALID' | 'BACKUP_VERIFY_FAILED' | 'BACKUP_RESTORE_REQUIRES_STOP' | 'BACKUP_TARGET_EXISTS' | 'BACKUP_IO_FAILED') { super(code); this.name = 'BackupError'; }
}
interface ScheduleState { formatVersion: 1; lastBackup: string | null; lastMirror: string | null; lastRehearsal: string | null }
const stateSchema = z.strictObject({ formatVersion: z.literal(1), lastBackup: instant.nullable(), lastMirror: instant.nullable(), lastRehearsal: instant.nullable() });
const signedStateSchema = stateSchema.extend({ authentication: hash });
const temporaryOwnerSchema = z.strictObject({ formatVersion: z.literal(1), temporaryId: z.string().regex(/^\.pm-work-[a-f0-9-]{36}$/u), authentication: hash });
const temporaryFiles = new Set(['owner.json','snapshot.sqlite','snapshot.sqlite-wal','snapshot.sqlite-shm','snapshot.sqlite.aes','manifest.json','restored.sqlite','restored.sqlite-wal','restored.sqlite-shm']);

function pathValue(input: string): string {
  if (typeof input !== 'string' || input.length < 1 || input.length > 4_096 || /[\u0000-\u001f]/u.test(input) || !isAbsolute(input) || input.startsWith('\\\\') || input.startsWith('//') || input.startsWith('file:') || input.split(/[\\/]/u).some(part => part === '.' || part === '..')) throw new BackupError('BACKUP_PATH_INVALID');
  if (process.platform === 'win32') {
    const local = input.slice(parse(input).root.length);
    if (local.includes(':') || local.split(/[\\/]/u).some(part => /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part))) throw new BackupError('BACKUP_PATH_INVALID');
  }
  return resolve(input);
}
function samePath(a: string, b: string): boolean { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }
function inside(parent: string, child: string): boolean { const part = relative(parent, child); return part !== '' && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`); }
async function exists(path: string): Promise<boolean> { try { await lstat(path); return true; } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error; } }
async function regular(path: string): Promise<void> { const info = await lstat(path); if (!info.isFile() || info.isSymbolicLink()) throw new BackupError('BACKUP_PATH_INVALID'); }
/** Reject symbolic links and Windows junctions in every existing path component. */
async function secureDirectory(path: string, create: boolean): Promise<string> {
  const absolute = pathValue(path), root = parse(absolute).root;
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!await exists(current)) { if (!create) throw new BackupError('BACKUP_PATH_INVALID'); await mkdir(current, { mode: 0o700 }); }
    const info = await lstat(current);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('BACKUP_PATH_INVALID');
    if (!samePath(await realpath(current), current)) throw new BackupError('BACKUP_PATH_INVALID');
  }
  return absolute;
}
async function flush(path: string): Promise<void> { const file = await open(path, 'r+'); try { await file.sync(); } finally { await file.close(); } }
async function flushDirectory(path: string): Promise<void> {
  // Directory handles/fsync are not supported by Windows. File fsync remains mandatory.
  if (process.platform === 'win32') return;
  const directory = await open(path, 'r'); try { await directory.sync(); } finally { await directory.close(); }
}
async function writePrivate(path: string, value: unknown): Promise<void> {
  const file = await open(path, 'wx', 0o600);
  try { await file.writeFile(canonicalEconomyJson(value), 'utf8'); await file.sync(); } finally { await file.close(); }
}
/** Atomic rename replaces only the empty filename reservation made by this operation. */
async function publishExclusive(stage: string, target: string): Promise<void> {
  const reservation = await open(target, 'wx', 0o600), owned = await reservation.stat(); await reservation.close();
  let published = false;
  const stillOwned = async () => {
    if (!await exists(target)) return false;
    const current = await lstat(target); return current.isFile() && !current.isSymbolicLink() && current.dev === owned.dev && current.ino === owned.ino && current.size === 0;
  };
  try {
    if (!await stillOwned()) throw new BackupError('BACKUP_TARGET_EXISTS');
    await rename(stage, target); published = true;
  } finally { if (!published && await stillOwned()) await unlink(target); }
}
async function checksum(path: string): Promise<string> { const digest = createHash('sha256'); for await (const chunk of createReadStream(path)) digest.update(chunk as Buffer); return digest.digest('hex'); }
function authentic(expected: string, actual: string): boolean { return /^[a-f0-9]{64}$/.test(actual) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex')); }
function fingerprintEqual(a: RecoveryFingerprint, b: RecoveryFingerprint): boolean { return canonicalEconomyJson(a) === canonicalEconomyJson(b); }

/** Newest hourly copies plus one per UTC day and ISO-like seven-day bucket. */
export function retainedBackupIds(manifests: readonly BackupManifest[], policy: BackupPolicy): ReadonlySet<string> {
  const sorted = [...manifests].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.backupId.localeCompare(a.backupId));
  const kept = new Set(sorted.slice(0, policy.hourlyCopies).map(item => item.backupId));
  const days = new Set<string>(), weeks = new Set<number>();
  for (const item of sorted) {
    const day = item.createdAt.slice(0, 10), week = Math.floor((Date.parse(item.createdAt) + 3 * DAY) / (7 * DAY));
    if (!days.has(day) && days.size < policy.dailyCopies) { days.add(day); kept.add(item.backupId); }
    if (!weeks.has(week) && weeks.size < policy.weeklyCopies) { weeks.add(week); kept.add(item.backupId); }
  }
  return kept;
}

/** Server-local operational service. Paths and keys never come from a Discord request. */
export class BackupManager {
  readonly #source: string; readonly #directory: string; readonly #mirror: string | undefined;
  readonly #key: Buffer; readonly #authenticationKey: Buffer; readonly #keys: RecoveryKeys;
  readonly #clock: () => string; readonly #policy: BackupPolicy;
  #pending: Promise<unknown> | undefined; #stopped = false;
  constructor(options: BackupOptions) {
    this.#source = pathValue(options.databasePath); this.#directory = pathValue(options.backupDirectory);
    this.#mirror = options.mirrorDirectory === undefined ? undefined : pathValue(options.mirrorDirectory);
    if (samePath(this.#directory, dirname(this.#source)) || inside(this.#directory, this.#source) || this.#mirror && (samePath(this.#mirror, this.#directory) || inside(this.#mirror, this.#directory) || inside(this.#directory, this.#mirror) || inside(this.#mirror, this.#source) || samePath(this.#mirror, dirname(this.#source)))) throw new BackupError('BACKUP_PATH_INVALID');
    if (!Buffer.isBuffer(options.backupKey) || options.backupKey.length !== 32 || !Buffer.isBuffer(options.identityKey) || options.identityKey.length < 32 || options.identityKey.length > 512 || options.backupKey.equals(options.identityKey) || options.economySeed && options.backupKey.equals(options.economySeed)) throw new BackupError('BACKUP_INVALID');
    this.#key = Buffer.from(options.backupKey); this.#authenticationKey = createHmac('sha256', this.#key).update('PaperMarket backup manifest authentication v1').digest();
    this.#keys = { identityKey: Buffer.from(options.identityKey), ...(options.economySeed ? { economySeed: Buffer.from(options.economySeed) } : {}) };
    this.#clock = options.now ?? (() => new Date().toISOString()); this.#policy = policySchema.parse({ ...DEFAULT_BACKUP_POLICY, ...options.policy });
  }
  #time(): string { return instant.parse(this.#clock()); }
  #sign(value: unknown): string { return createHmac('sha256', this.#authenticationKey).update(canonicalEconomyJson(value)).digest('hex'); }
  #aad(backupId: string, createdAt: string): Buffer { return Buffer.from(canonicalEconomyJson({ formatVersion: 1, backupId, createdAt })); }
  async #ready(sourceRequired: boolean): Promise<void> { await secureDirectory(dirname(this.#source), false); if (sourceRequired) await regular(this.#source); await secureDirectory(this.#directory, true); if (this.#mirror) await secureDirectory(this.#mirror, true); }
  #operate<T>(action: () => Promise<T>, sourceRequired = false): Promise<T> {
    if (this.#stopped) return Promise.reject(new BackupError('BACKUP_STOPPED'));
    if (this.#pending) return Promise.reject(new BackupError('BACKUP_BUSY'));
    const lock = new ProcessLock(join(this.#directory, 'backup-maintenance'));
    const mirrorLock = this.#mirror ? new ProcessLock(join(this.#mirror,'backup-maintenance')) : undefined;
    const pending = (async () => { try {
      await this.#ready(sourceRequired);
      const lockPath = join(this.#directory, 'backup-maintenance.writer-lock');
      if (await exists(lockPath)) await regular(lockPath);
      try { lock.acquire(); } catch { throw new BackupError('BACKUP_BUSY'); }
      if (this.#mirror && mirrorLock) {
        const mirrorLockPath=join(this.#mirror,'backup-maintenance.writer-lock');
        if(await exists(mirrorLockPath))await regular(mirrorLockPath);
        try {mirrorLock.acquire();} catch {throw new BackupError('BACKUP_BUSY');}
      }
      await this.#clearOrphans();
      return await action();
    } catch (error) { if (error instanceof BackupError) throw error; throw new BackupError('BACKUP_VERIFY_FAILED'); }
    finally { mirrorLock?.release(); lock.release(); this.#pending = undefined; } })();
    this.#pending = pending; return pending;
  }
  create(): Promise<BackupManifest> { return this.#operate(() => this.#create(), true); }
  verify(backupId: string): Promise<BackupManifest> { return this.#operate(async () => { const manifest = await this.#manifest(backupId, this.#directory); await this.#validate(manifest, this.#directory); return manifest; }); }
  rehearse(backupId: string): Promise<BackupManifest> { return this.verify(backupId); }
  async stop(): Promise<void> { this.#stopped = true; try { await this.#pending; } catch { /* caller already receives the failure */ } finally { this.#key.fill(0); this.#authenticationKey.fill(0); this.#keys.identityKey.fill(0); this.#keys.economySeed?.fill(0); } }
  async #temporary(): Promise<string> {
    const temporaryId = `.pm-work-${randomUUID()}`, temp = join(this.#directory, temporaryId); await mkdir(temp, { mode: 0o700 });
    const owner = { formatVersion: 1, temporaryId }; await writePrivate(join(temp, 'owner.json'), { ...owner, authentication: this.#sign(owner) }); return temp;
  }
  async #clearOrphans(): Promise<void> {
    // The directory-wide process lock proves no cooperating backup is still using these.
    for (const name of await readdir(this.#directory)) {
      if (!/^\.pm-work-[a-f0-9-]{36}$/u.test(name)) continue;
      const temp = join(this.#directory, name);
      await secureDirectory(temp, false);
      const ownerPath = join(temp, 'owner.json');
      if (!await exists(ownerPath)) continue;
      await regular(ownerPath); if ((await stat(ownerPath)).size > 1_024) continue;
      let owner: z.infer<typeof temporaryOwnerSchema>;
      try { owner = temporaryOwnerSchema.parse(JSON.parse(await readFile(ownerPath,'utf8'))); } catch { continue; }
      const { authentication, ...unsigned } = owner;
      if (owner.temporaryId !== name || !authentic(this.#sign(unsigned),authentication)) continue;
      const files = await readdir(temp);
      if (files.some(file => !temporaryFiles.has(file))) continue;
      for (const file of files) await regular(join(temp,file));
      await this.#clean(temp);
    }
  }
  async #clean(temp: string): Promise<void> {
    if (dirname(temp) !== this.#directory || !/^\.pm-work-[a-f0-9-]{36}$/u.test(basename(temp))) throw new BackupError('BACKUP_PATH_INVALID');
    if (!await exists(temp)) return;
    await secureDirectory(temp, false); await rm(temp, { recursive: true, force: true });
  }
  async #create(): Promise<BackupManifest> {
    const createdAt = this.#time(), backupId = `pm-${String(Date.parse(createdAt)).padStart(13, '0')}-${randomUUID()}`;
    backupIdSchema.parse(backupId);
    const temp = await this.#temporary(), plain = join(temp, 'snapshot.sqlite'), encrypted = join(temp, 'snapshot.sqlite.aes');
    const filename = `${backupId}.sqlite.aes`, published = join(this.#directory, filename), manifestPath = join(this.#directory, `${backupId}.json`);
    let publishedCipher = false;
    try {
      const source = openReadonlyDatabase(this.#source);
      try { await source.backup(plain); } finally { source.close(); }
      await chmod(plain, 0o600); await flush(plain);
      const snapshot = openReadonlyDatabase(plain);
      let fingerprint: RecoveryFingerprint;
      try { fingerprint = verifyRecoveryDatabase(snapshot, this.#keys); } finally { snapshot.close(); }
      const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.#key, nonce);
      cipher.setAAD(this.#aad(backupId, createdAt));
      await pipeline(createReadStream(plain), cipher, createWriteStream(encrypted, { flags: 'wx', mode: 0o600 })); await flush(encrypted);
      const unsigned = unsignedManifestSchema.parse({ formatVersion: 1, backupId, createdAt, filename, encryption: 'AES-256-GCM', nonce: nonce.toString('hex'), tag: cipher.getAuthTag().toString('hex'), bytes: (await stat(encrypted)).size, cipherSha256: await checksum(encrypted), fingerprint });
      const manifest: BackupManifest = { ...unsigned, authentication: this.#sign(unsigned) };
      await writePrivate(join(temp, 'manifest.json'), manifest);
      // Verify encrypted round trip before publishing. Manifest is the commit marker.
      await this.#validate(manifest, temp, encrypted);
      if (await exists(published) || await exists(manifestPath)) throw new BackupError('BACKUP_TARGET_EXISTS');
      await publishExclusive(encrypted, published); publishedCipher = true;
      await publishExclusive(join(temp, 'manifest.json'), manifestPath); await flushDirectory(this.#directory);
      return manifest;
    } catch (error) {
      if (publishedCipher && !await exists(manifestPath)) { await regular(published); await unlink(published); }
      throw error;
    } finally { await this.#clean(temp); }
  }
  async #manifest(backupId: string, directory: string): Promise<BackupManifest> {
    backupIdSchema.parse(backupId); const path = join(directory, `${backupId}.json`); await regular(path);
    if ((await stat(path)).size > 65_536) throw new BackupError('BACKUP_INVALID');
    const manifest = manifestSchema.parse(JSON.parse(await readFile(path, 'utf8'))), { authentication, ...unsigned } = manifest;
    if (manifest.backupId !== backupId || manifest.filename !== `${backupId}.sqlite.aes` || !authentic(this.#sign(unsigned), authentication)) throw new BackupError('BACKUP_INVALID');
    return manifest;
  }
  async #decrypt(manifest: BackupManifest, encrypted: string, plain: string): Promise<void> {
    await regular(encrypted); const info = await stat(encrypted);
    if (info.size !== manifest.bytes || info.size > 64 * 1024 ** 3 || await checksum(encrypted) !== manifest.cipherSha256) throw new BackupError('BACKUP_INVALID');
    const decipher = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(manifest.nonce, 'hex'));
    decipher.setAAD(this.#aad(manifest.backupId, manifest.createdAt)); decipher.setAuthTag(Buffer.from(manifest.tag, 'hex'));
    await pipeline(createReadStream(encrypted), decipher, createWriteStream(plain, { flags: 'wx', mode: 0o600 })); await flush(plain);
  }
  async #validate(manifest: BackupManifest, directory: string, encryptedPath?: string): Promise<void> {
    const temp = await this.#temporary();
    try {
      const plain = join(temp, 'restored.sqlite'); await this.#decrypt(manifest, encryptedPath ?? join(directory, manifest.filename), plain);
      const db = openReadonlyDatabase(plain); let fingerprint: RecoveryFingerprint;
      try { fingerprint = verifyRecoveryDatabase(db, this.#keys); } finally { db.close(); }
      if (!fingerprintEqual(fingerprint, manifest.fingerprint)) throw new BackupError('BACKUP_VERIFY_FAILED');
    } finally { await this.#clean(temp); }
  }
  restoreToNewFile(backupId: string, targetPath: string): Promise<BackupManifest> {
    return this.#operate(async () => {
      const target = pathValue(targetPath), parent = dirname(target);
      if ((!samePath(parent, dirname(this.#source)) && !samePath(parent, this.#directory)) || samePath(target, this.#source) || /(?:-wal|-shm|\.writer-lock|\.acquire|\.aes|\.json)$/iu.test(target) || !/\.(?:sqlite|db)$/iu.test(target)) throw new BackupError('BACKUP_PATH_INVALID');
      await secureDirectory(parent, false);
      for (const candidate of [target, `${target}-wal`, `${target}-shm`, `${target}.writer-lock`, `${target}.writer-lock.acquire`]) if (await exists(candidate)) throw new BackupError('BACKUP_TARGET_EXISTS');
      const sourceLock = new ProcessLock(this.#source), targetLock = new ProcessLock(target);
      try { sourceLock.acquire(); } catch { throw new BackupError('BACKUP_RESTORE_REQUIRES_STOP'); }
      let heldTarget = false; let temp: string | undefined;
      try {
        temp = await this.#temporary();
        targetLock.acquire(); heldTarget = true;
        const manifest = await this.#manifest(backupId, this.#directory), plain = join(temp, 'restored.sqlite');
        await this.#decrypt(manifest, join(this.#directory, manifest.filename), plain);
        const db = openReadonlyDatabase(plain); let fingerprint: RecoveryFingerprint;
        try { fingerprint = verifyRecoveryDatabase(db, this.#keys); } finally { db.close(); }
        if (!fingerprintEqual(fingerprint, manifest.fingerprint)) throw new BackupError('BACKUP_VERIFY_FAILED');
        if (await exists(target) || await exists(`${target}-wal`) || await exists(`${target}-shm`)) throw new BackupError('BACKUP_TARGET_EXISTS');
        // Stage on the target filesystem before atomic publication; never replace an old DB.
        const stage = join(parent, `.pm-restore-${randomUUID()}.sqlite`);
        try { await copyFile(plain, stage, 1); await flush(stage); await publishExclusive(stage, target); await flushDirectory(parent); }
        finally { if (await exists(stage)) { await regular(stage); await unlink(stage); } }
        return manifest;
      } finally { if (heldTarget) targetLock.release(); sourceLock.release(); if (temp) await this.#clean(temp); }
    });
  }
  async #list(directory: string): Promise<BackupManifest[]> {
    const manifests: BackupManifest[] = [];
    for (const name of await readdir(directory)) {
      if (!/^pm-[0-9]{13}-[a-f0-9-]{36}\.json$/u.test(name)) continue;
      // Invalid or unmanaged bundles stay untouched. They never count as a success.
      try { const manifest = await this.#manifest(name.slice(0, -5), directory); await regular(join(directory, manifest.filename)); manifests.push(manifest); } catch { /* preserve for operator inspection */ }
    }
    return manifests.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.backupId.localeCompare(a.backupId));
  }
  async #prune(directory: string): Promise<number> {
    const manifests = await this.#list(directory), keep = retainedBackupIds(manifests, this.#policy);
    for (const manifest of manifests) if (!keep.has(manifest.backupId)) {
      // Authentication and file types checked again immediately before exact deletion.
      await this.#manifest(manifest.backupId, directory); await regular(join(directory, manifest.filename));
      await unlink(join(directory, `${manifest.backupId}.json`)); await unlink(join(directory, manifest.filename));
    }
    await flushDirectory(directory); return keep.size;
  }
  async #mirrorBundle(manifest: BackupManifest): Promise<void> {
    if (!this.#mirror) return;
    await this.#validate(manifest, this.#directory);
    if (await exists(join(this.#mirror, `${manifest.backupId}.json`))) { const existing = await this.#manifest(manifest.backupId, this.#mirror); if (!fingerprintEqual(existing.fingerprint, manifest.fingerprint)) throw new BackupError('BACKUP_INVALID'); await this.#validate(existing, this.#mirror); return; }
    const temporary = join(this.#mirror, `.pm-mirror-${randomUUID()}`); await mkdir(temporary, { mode: 0o700 });
    let cipherPublished = false;
    try {
      const cipher = join(temporary, manifest.filename), record = join(temporary, 'manifest.json');
      await copyFile(join(this.#directory, manifest.filename), cipher, 1); await flush(cipher); await writePrivate(record, manifest);
      await this.#validate(manifest, temporary);
      if (await exists(join(this.#mirror, manifest.filename))) throw new BackupError('BACKUP_TARGET_EXISTS');
      await publishExclusive(cipher, join(this.#mirror, manifest.filename)); cipherPublished = true;
      await publishExclusive(record, join(this.#mirror, `${manifest.backupId}.json`)); await flushDirectory(this.#mirror);
    } catch (error) { if (cipherPublished && !await exists(join(this.#mirror, `${manifest.backupId}.json`))) { await regular(join(this.#mirror, manifest.filename)); await unlink(join(this.#mirror, manifest.filename)); } throw error; }
    finally { await secureDirectory(temporary, false); await rm(temporary, { recursive: true, force: true }); }
  }
  async #schedule(): Promise<ScheduleState> {
    const path = join(this.#directory, 'schedule-v1.json');
    if (!await exists(path)) return { formatVersion: 1, lastBackup: null, lastMirror: null, lastRehearsal: null };
    await regular(path); if ((await stat(path)).size > 1_024) throw new BackupError('BACKUP_INVALID');
    const { authentication, ...state } = signedStateSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    if (!authentic(this.#sign(state), authentication)) throw new BackupError('BACKUP_INVALID'); return state;
  }
  async #saveSchedule(state: ScheduleState): Promise<void> {
    const path = join(this.#directory, 'schedule-v1.json'), temporary = join(this.#directory, `.pm-state-${randomUUID()}.json`);
    if (await exists(path)) await regular(path);
    try { await writePrivate(temporary, { ...state, authentication: this.#sign(state) }); await rename(temporary, path); await flushDirectory(this.#directory); }
    finally { if (await exists(temporary)) { await regular(temporary); await unlink(temporary); } }
  }
  runDue(): Promise<BackupRunResult> {
    if (this.#stopped) return Promise.resolve({ status: 'STOPPED' });
    if (this.#pending) return Promise.resolve({ status: 'BUSY' });
    return this.#operate(async () => {
      const now = this.#time(), nowMs = Date.parse(now), state = await this.#schedule();
      const due = (last: string | null, interval: number) => last === null || nowMs - Date.parse(last) >= interval;
      let backup: BackupManifest | undefined, mirrored: string | undefined, rehearsed: string | undefined;
      if (due(state.lastBackup, this.#policy.intervalMs)) { backup = await this.#create(); state.lastBackup = now; await this.#saveSchedule(state); }
      const latest = backup ?? (await this.#list(this.#directory))[0];
      if (latest && this.#mirror && due(state.lastMirror, this.#policy.dailyMirrorMs)) { await this.#mirrorBundle(latest); state.lastMirror = now; mirrored = latest.backupId; await this.#saveSchedule(state); await this.#prune(this.#mirror); }
      if (latest && due(state.lastRehearsal, this.#policy.rehearsalMs)) { await this.#validate(latest, this.#directory); state.lastRehearsal = now; rehearsed = latest.backupId; await this.#saveSchedule(state); }
      const retained = await this.#prune(this.#directory);
      return { status: backup || mirrored || rehearsed ? 'RUN' : 'IDLE', ...(backup ? { backup } : {}), ...(mirrored ? { mirrored } : {}), ...(rehearsed ? { rehearsed } : {}), retained };
    }, true);
  }
}
