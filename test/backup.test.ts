import assert from 'node:assert/strict';
import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm, unlink } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type { ServiceContext, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { openReadonlyDatabase, verifyRecoveryDatabase } from '../src/diagnostics/verify-recovery.js';
import { BackupManager, DEFAULT_BACKUP_POLICY, retainedBackupIds, type BackupManifest, type BackupOptions } from '../src/ops/backup.js';
import { ProcessLock } from '../src/runtime/process-lock.js';
import { readBackupOptions, runBackupCli } from '../src/ops/backup-cli.js';
import { canonicalEconomyJson } from '../src/economy/repository.js';

function directory(t: TestContext, beforeClean?: () => Promise<void>): string {
  // Atomic renames in Windows AppContainer TEMP are denied; use the writable task directory.
  const root = resolve(process.cwd()), path = mkdtempSync(join(root, '.papermarket-backup-'));
  t.after(async () => { await beforeClean?.(); if (dirname(resolve(path)) !== root || !basename(path).startsWith('.papermarket-backup-')) throw new Error('Unsafe cleanup'); await rm(path, { recursive: true, force: true }); }); return path;
}
const guild = '111111111111111111', user = '222222222222222222', other = '222222222222222223';
function kind<K extends ServiceResponse['kind']>(value: ServiceResponse, expected: K): Extract<ServiceResponse, { kind: K }> { assert.equal(value.kind, expected); return value as Extract<ServiceResponse, { kind: K }>; }
function fixture(t: TestContext, economic = true) {
  let close = async () => {};
  const root = directory(t,()=>close()), path = join(root, 'source.sqlite'), db = openDatabase(path);
  const clock = new FakeClock('2026-10-09T00:00:00.000Z'), identityKey = randomBytes(32), economySeed = Buffer.alloc(32, 17), backupKey = randomBytes(32);
  new FoundationRepository(db,clock).createMarket({marketId:'actions-test-market',guildId:guild,listings:createInitialListings()});
  const broker = new BrokerRepository(db, clock, { identityKey, ...(economic ? { economySeed } : {}) });
  let commandId = 333333333333333333n;
  const context = (uid = user): ServiceContext => ({ guildId: guild, discordUserId: uid, interactionId: (++commandId).toString(), receivedAt: clock.now(), guildPermissions: '32' });
  const execute = (request: object, uid = user) => broker.dispatch({ ...request, context: context(uid) } as ServiceRequest);
  const market = kind(execute({ type: 'setup', channelId: '444444444444444444' }), 'SETUP').market;
  const account = kind(execute({ type: 'open', age14Plus: true, agreeTerms: true }), 'ACCOUNT').account;
  const trade = (symbol = 'HGI', quantity = '1', conditional = false) => {
    const quote = kind(execute({ type: 'quote', symbol, side: 'BUY', quantity, ...(conditional ? { orderType: 'LIMIT', conditionPrice: '1', timeInForce: 'UNTIL_CANCELLED' } : {}) }), 'QUOTE').quote;
    return execute({ type: 'confirm', token: quote.token });
  };
  const tick = () => { clock.advanceBy(300_000); kind(broker.dispatch({ type: 'tick', now: clock.now() }), 'TICKED'); };
  const options: BackupOptions = { databasePath: path, backupDirectory: join(root, 'backups'), backupKey, identityKey, ...(economic ? { economySeed } : {}), now: () => clock.now() };
  const managers: BackupManager[] = [];
  const manager = (overrides: Partial<BackupOptions> = {}) => { const value = new BackupManager({ ...options, ...overrides }); managers.push(value); return value; };
  close = async () => { for (const value of managers) await value.stop(); if(db.open)db.close(); };
  return { root, path, db, clock, options, manager, execute, trade, tick, marketId: market.marketId, accountId: account.accountId };
}
function fingerprint(path: string, options: BackupOptions) {
  const db = openReadonlyDatabase(path); try { return verifyRecoveryDatabase(db, options); } finally { db.close(); }
}

test('online encrypted backup captures committed WAL, reservations and performance exactly without checkpointing source', async t => {
  const f = fixture(t); kind(f.trade('DNL', '2'), 'FILLED'); kind(f.trade('HGI','1',true), 'ORDER_OPENED'); f.tick();
  kind(f.execute({ type: 'open', age14Plus: true, agreeTerms: true }, other), 'ACCOUNT'); kind(f.execute({ type: 'close', confirmed: true }, other), 'CLOSED');
  assert.ok(existsSync(`${f.path}-wal`));
  const expected = fingerprint(f.path, f.options), sourceRows = f.db.prepare('SELECT * FROM markets').all();
  const manager = f.manager(), manifest = await manager.create(); assert.deepEqual(manifest.fingerprint, expected);
  const encrypted = readFileSync(join(f.options.backupDirectory, manifest.filename));
  assert.notEqual(encrypted.subarray(0, 16).toString(), 'SQLite format 3\0');
  for (const secret of [user, f.options.identityKey.toString('hex'), f.options.backupKey.toString('hex'), f.options.economySeed!.toString('hex')]) assert.ok(!encrypted.includes(Buffer.from(secret)) && !JSON.stringify(manifest).includes(secret));
  assert.deepEqual((await manager.verify(manifest.backupId)).fingerprint, expected);
  const target = join(f.root, 'recovered.sqlite'); await manager.restoreToNewFile(manifest.backupId, target);
  assert.deepEqual(fingerprint(target, f.options), expected); assert.deepEqual(f.db.prepare('SELECT * FROM markets').all(), sourceRows);
  assert.ok(!readdirSync(f.options.backupDirectory).some(name => name.startsWith('.pm-work-')));
});

test('backup and restore preserve an unpaid ex-dividend right including immutable reporting sources', async t => {
  const f = fixture(t); kind(f.trade('DNL','2'), 'FILLED');
  for (let tick = 0; tick < 67; tick++) f.tick();
  assert.ok((f.db.prepare('SELECT count(*) AS n FROM rights_journal').get() as { n: number }).n > 0);
  const manager = f.manager(), manifest = await manager.create(), target = join(f.root, 'rights.sqlite');
  await manager.restoreToNewFile(manifest.backupId, target); assert.deepEqual(fingerprint(target, f.options), manifest.fingerprint);
  const restored = openReadonlyDatabase(target);
  try {
    assert.deepEqual(restored.prepare('SELECT * FROM rights_journal ORDER BY sequence_no').all(), f.db.prepare('SELECT * FROM rights_journal ORDER BY sequence_no').all());
    assert.deepEqual(restored.prepare('SELECT * FROM benchmark_snapshots ORDER BY rowid').all(), f.db.prepare('SELECT * FROM benchmark_snapshots ORDER BY rowid').all());
  } finally { restored.close(); }
});

test('ciphertext and authenticated manifest tampering fail before any restore target is published', async t => {
  const f = fixture(t, false), manager = f.manager(), manifest = await manager.create(), cipher = join(f.options.backupDirectory, manifest.filename), original = readFileSync(cipher);
  const corrupted = Buffer.from(original); corrupted[0] = corrupted[0]! ^ 1; writeFileSync(cipher, corrupted);
  await assert.rejects(manager.verify(manifest.backupId)); await assert.rejects(manager.restoreToNewFile(manifest.backupId, join(f.root,'bad.sqlite')));
  assert.equal(existsSync(join(f.root,'bad.sqlite')), false); writeFileSync(cipher, original);
  const path = join(f.options.backupDirectory, `${manifest.backupId}.json`); writeFileSync(path, JSON.stringify({ ...manifest, createdAt: '2026-10-10T00:00:00.000Z' }));
  await assert.rejects(manager.verify(manifest.backupId)); assert.ok(!readdirSync(f.options.backupDirectory).some(name => name.startsWith('.pm-work-')));
});

test('changed backup, identity and economic keys reject retained snapshots', async t => {
  const f = fixture(t), manifest = await f.manager().create();
  for (const override of [{ backupKey: randomBytes(32) }, { identityKey: randomBytes(32) }, { economySeed: randomBytes(32) }]) await assert.rejects(f.manager(override).verify(manifest.backupId));
  assert.throws(() => f.manager({ backupKey: f.options.identityKey }));
  assert.throws(() => f.manager({ backupKey: Buffer.alloc(31) }));
});

test('restore refuses a live worker, existing target and source WAL/SHM paths', async t => {
  const f = fixture(t, false), manager = f.manager(), manifest = await manager.create();
  const lock = new ProcessLock(f.path); lock.acquire();
  try { await assert.rejects(manager.restoreToNewFile(manifest.backupId, join(f.root,'live.sqlite')), /BACKUP_RESTORE_REQUIRES_STOP/); } finally { lock.release(); }
  for (const path of [f.path, `${f.path}-wal`, `${f.path}-shm`, join(f.root,'..','outside.sqlite'), join(f.root,'nested','file.sqlite'), ...(process.platform==='win32'?[`${f.path}:copy.sqlite`,join(f.root,'CON.sqlite'),join(f.root,'COM¹.sqlite'),join(f.root,'recovered.sqlite.'),join(f.root,'control\n.sqlite')]:[])]) await assert.rejects(manager.restoreToNewFile(manifest.backupId, path));
  const target = join(f.root,'existing.sqlite'); writeFileSync(target,'existing'); await assert.rejects(manager.restoreToNewFile(manifest.backupId,target)); assert.equal(readFileSync(target,'utf8'),'existing');
  const conflicted = join(f.root,'conflicted.sqlite'); writeFileSync(`${conflicted}-wal`,'wal'); await assert.rejects(manager.restoreToNewFile(manifest.backupId,conflicted)); assert.equal(existsSync(conflicted),false);
});

test('backup paths reject non-directories and relative inputs, and junctions where supported by the host', async t => {
  const f = fixture(t, false), outside = join(directory(t),'outside'), link = join(f.root,'link');
  // Junction creation is available without symlink privileges on Windows.
  const file = join(f.root,'file'); writeFileSync(file,'file'); await assert.rejects(f.manager({backupDirectory:file}).create());
  assert.throws(()=>f.manager({backupDirectory:'relative'})); mkdirSync(outside);
  try { symlinkSync(outside,link,process.platform === 'win32' ? 'junction' : 'dir'); }
  catch(error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EPERM' || process.platform !== 'win32') throw error;
    t.diagnostic('Windows sandbox denies junction creation; file and relative-path rejection verified.'); return;
  }
  await assert.rejects(f.manager({ backupDirectory: link }).create()); assert.deepEqual(readdirSync(outside),[]);
});

test('hourly scheduler persists receipts across restart, prevents overlap and rehearses and mirrors only when due', async t => {
  const f = fixture(t, false), mirror = join(directory(t),'mirror'), manager = f.manager({ mirrorDirectory: mirror });
  const pending = manager.runDue(); assert.equal((await manager.runDue()).status,'BUSY');
  const first = await pending; assert.equal(first.status,'RUN'); assert.ok(first.backup && first.mirrored && first.rehearsed);
  assert.equal((await manager.runDue()).status,'IDLE'); await manager.stop();
  const reopened = f.manager({ mirrorDirectory: mirror }); assert.equal((await reopened.runDue()).status,'IDLE');
  f.clock.advanceBy(3_600_000); const hourly = await reopened.runDue(); assert.ok(hourly.backup); assert.equal(hourly.mirrored,undefined); assert.equal(hourly.rehearsed,undefined);
  f.clock.advanceBy(24 * 3_600_000); const daily = await reopened.runDue(); assert.ok(daily.mirrored); assert.equal(daily.rehearsed,undefined);
  f.clock.advanceBy(30 * 24 * 3_600_000); assert.ok((await reopened.runDue()).rehearsed);
  assert.ok(readdirSync(mirror).filter(name => name.endsWith('.json')).length >= 3);
  await reopened.stop(); assert.equal((await reopened.runDue()).status,'STOPPED');
});

test('retention keeps seven daily and four weekly representatives in addition to bounded hourly copies', async t => {
  const f = fixture(t, false), manager = f.manager(), template = await manager.create();
  const manifests: BackupManifest[] = Array.from({ length: 24 * 35 }, (_, index) => ({ ...template, backupId: `backup-${index}`, createdAt: new Date(Date.UTC(2026,9,1) + index * 3_600_000).toISOString() }));
  const policy = { ...DEFAULT_BACKUP_POLICY, hourlyCopies: 24, dailyCopies: 7, weeklyCopies: 4 }, keep = retainedBackupIds(manifests,policy);
  assert.ok(keep.size >= 30 && keep.size <= 35); for (const item of manifests.slice(-24)) assert.ok(keep.has(item.backupId));
  const kept = manifests.filter(item => keep.has(item.backupId)); assert.ok(new Set(kept.map(item => item.createdAt.slice(0,10))).size >= 7);
});

test('retention deletes only authenticated owned bundles and preserves unmanaged or tampered files', async t => {
  const f = fixture(t, false), manager = f.manager({ policy: { hourlyCopies: 1, dailyCopies: 1, weeklyCopies: 1 } });
  const first = await manager.runDue(); assert.ok(first.backup); const unmanaged = join(f.options.backupDirectory,'operator-notes.txt'); writeFileSync(unmanaged,'retain');
  const invalid = join(f.options.backupDirectory,'pm-0000000000000-00000000-0000-0000-0000-000000000000.json'); writeFileSync(invalid,'{}');
  f.clock.advanceBy(3_600_000); const second = await manager.runDue(); assert.ok(second.backup); assert.equal(existsSync(join(f.options.backupDirectory,first.backup!.filename)),false);
  assert.equal(readFileSync(unmanaged,'utf8'),'retain'); assert.equal(readFileSync(invalid,'utf8'),'{}'); assert.equal(second.retained,1);
});

test('failed backup does not publish a bundle or advance successful scheduler receipt', async t => {
  const f = fixture(t, false); f.db.exec('DROP TRIGGER cash_journal_no_update');
  const manager = f.manager(); await assert.rejects(manager.runDue());
  assert.ok(!readdirSync(f.options.backupDirectory).some(name => name.endsWith('.aes') || name.endsWith('.json') || name.startsWith('.pm-work-')));
});

test('operator CLI validates project-local paths and emits aggregate results without Discord configuration or secrets', async t => {
  const f = fixture(t, false), environment = { ACCOUNT_IDENTITY_KEY: f.options.identityKey.toString('hex'), BACKUP_KEY: f.options.backupKey.toString('hex'), PAPERMARKET_DATABASE_PATH:'source.sqlite', PAPERMARKET_BACKUP_DIRECTORY:'backups' };
  const output: string[] = []; await runBackupCli(['create'], environment, f.root, value => output.push(value));
  assert.equal(JSON.parse(output[0]!).code,'BACKUP_CREATED');
  for (const secret of Object.values(environment)) if (secret.length >= 32) assert.ok(!output[0]!.includes(secret));
  assert.throws(() => readBackupOptions({ ...environment, PAPERMARKET_DATABASE_PATH:'../outside.sqlite' },f.root));
  assert.throws(() => readBackupOptions({ ...environment, PAPERMARKET_BACKUP_MIRROR_DIRECTORY:'relative' },f.root));
  await assert.rejects(runBackupCli(['restore'],environment,f.root,()=>{}));
});

test('read-only recovery audit cannot adopt missing baselines or modify source during validation', t => {
  const f = fixture(t, false); const before = f.db.prepare('SELECT * FROM benchmark_snapshots').all();
  assert.throws(() => verifyRecoveryDatabase(f.db,f.options), /read-only/); fingerprint(f.path,f.options);
  assert.deepEqual(f.db.prepare('SELECT * FROM benchmark_snapshots').all(),before);
});

test('maintenance removes authenticated stale plaintext stages and preserves unknown or altered directories',async t=>{
  const f=fixture(t,false),manager=f.manager();const manifest=await manager.create();
  const temporaryId=`.pm-work-${randomUUID()}`,temp=join(f.options.backupDirectory,temporaryId);mkdirSync(temp);
  const authenticationKey=createHmac('sha256',f.options.backupKey).update('PaperMarket backup manifest authentication v1').digest();
  const owner={formatVersion:1,temporaryId},authentication=createHmac('sha256',authenticationKey).update(canonicalEconomyJson(owner)).digest('hex');
  writeFileSync(join(temp,'owner.json'),JSON.stringify({...owner,authentication}));writeFileSync(join(temp,'restored.sqlite'),'unpublished plaintext');
  const unknown=join(f.options.backupDirectory,`.pm-work-${randomUUID()}`);mkdirSync(unknown);writeFileSync(join(unknown,'operator.txt'),'preserve');
  await manager.verify(manifest.backupId);assert.equal(existsSync(temp),false);assert.equal(readFileSync(join(unknown,'operator.txt'),'utf8'),'preserve');
});

test('explicit mirrored bundle restores to a new file after the original database is lost',async t=>{
  const f=fixture(t,false),mirror=join(directory(t),'mirror');const result=await f.manager({mirrorDirectory:mirror}).runDue();assert.ok(result.backup&&result.mirrored);
  const expected=result.backup!.fingerprint;f.db.close();await unlink(f.path);
  const fromMirror=f.manager({backupDirectory:mirror}),target=join(f.root,'from-mirror.sqlite');
  await fromMirror.restoreToNewFile(result.backup!.backupId,target);assert.deepEqual(fingerprint(target,f.options),expected);
});

test('primary mirror publication and retention respect an active mirror verification process lock',async t=>{
  const f=fixture(t,false),mirror=join(f.root,'mirror');mkdirSync(mirror);
  const lock=new ProcessLock(join(mirror,'backup-maintenance'));lock.acquire();
  const manager=f.manager({mirrorDirectory:mirror});
  try{await assert.rejects(manager.runDue(),/BACKUP_BUSY/);}finally{lock.release();}
  const result=await manager.runDue();assert.ok(result.backup&&result.mirrored);
});
