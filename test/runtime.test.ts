import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readRuntimeConfig } from '../src/runtime/config.js';
import { ProcessLock, WriterAlreadyRunningError } from '../src/runtime/process-lock.js';
import { RequestGate } from '../src/runtime/backpressure.js';
import { WorkerBackend } from '../src/runtime/backend.js';
import { MarketBoardPublisher } from '../src/runtime/boards.js';
import type { MarketView } from '../src/application/contracts.js';
import type { ServiceContext, ServiceRequest } from '../src/application/contracts.js';

function directory(context: test.TestContext): string {
  const root = resolve(tmpdir());
  const path = mkdtempSync(join(root, 'papermarket-runtime-'));
  context.after(() => {
    if (dirname(resolve(path)) !== root || !basename(path).startsWith('papermarket-runtime-')) throw new Error('Unsafe test cleanup');
    rmSync(path, { recursive: true, force: true });
  });
  return path;
}
function serverContext(index: bigint): ServiceContext {
  return { guildId: '100000000000000001', discordUserId: '100000000000000002',
    interactionId: (100000000000000100n + index).toString(), receivedAt: new Date().toISOString(), guildPermissions: '32' };
}

test('startup requires secrets/operator identity and a project-local database', () => {
  const environment = {
    DISCORD_BOT_TOKEN: randomBytes(48).toString('base64url'),
    DISCORD_APPLICATION_ID: '100000000000000001', DISCORD_GUILD_ID: '100000000000000002',
    ACCOUNT_IDENTITY_KEY: randomBytes(32).toString('hex'),
    MARKET_SEED: randomBytes(32).toString('hex'),
    BACKUP_KEY:randomBytes(32).toString('hex'),
    PAPERMARKET_OPERATOR_NAME: '시험 운영자', PAPERMARKET_SUPPORT_CONTACT: 'support@example.invalid',
  };
  const configuration = readRuntimeConfig(environment);
  assert.equal(configuration.identityKey.length, 32);
  assert.equal(configuration.economySeed.length, 32);
  assert.equal(configuration.operator.operatorName, '시험 운영자');
  assert.throws(() => readRuntimeConfig({}));
  for (const field of ['DISCORD_BOT_TOKEN', 'DISCORD_GUILD_ID', 'ACCOUNT_IDENTITY_KEY', 'MARKET_SEED', 'BACKUP_KEY','PAPERMARKET_SUPPORT_CONTACT']) {
    const invalid = { ...environment, [field]: '' }; assert.throws(() => readRuntimeConfig(invalid));
  }
  for (const path of ['../other.sqlite', '\\\\server\\data.sqlite']) {
    assert.throws(() => readRuntimeConfig({ ...environment, PAPERMARKET_DATABASE_PATH: path }));
  }
  assert.throws(()=>readRuntimeConfig({...environment,BACKUP_KEY:environment.ACCOUNT_IDENTITY_KEY}));
  assert.throws(()=>readRuntimeConfig({...environment,PAPERMARKET_BACKUP_DIRECTORY:'../outside'}));
  assert.throws(()=>readRuntimeConfig({...environment,PAPERMARKET_BACKUP_MIRROR_DIRECTORY:'relative/mirror'}));
  if(process.platform==='win32'){
    for(const path of ['data/trial.sqlite:alternate','data/CON.sqlite','data/COM1.sqlite','data/LPT².sqlite','data/alias. /trial.sqlite','data/trial.sqlite.'])assert.throws(()=>readRuntimeConfig({...environment,PAPERMARKET_DATABASE_PATH:path}));
    assert.throws(()=>readRuntimeConfig({...environment,PAPERMARKET_BACKUP_DIRECTORY:'data/backups:alternate'}));
    assert.throws(()=>readRuntimeConfig({...environment,PAPERMARKET_BACKUP_MIRROR_DIRECTORY:'C:/mirror./backups'}));
  }
});

test('the real worker persists the economic seed and serves only public economic views after reopen', async (context) => {
  const backends: WorkerBackend[] = [];
  context.after(async () => { for (const backend of backends) await backend.close(); });
  const databasePath = join(directory(context), 'economy.sqlite');
  const identityKey = randomBytes(32); const economySeed = randomBytes(32);
  const create = (seed: Buffer) => {
    const backend = new WorkerBackend({ databasePath, identityKey, economySeed: seed });
    backends.push(backend); return backend;
  };
  const first = create(economySeed); await first.start();
  const setup = await first.execute({ type: 'setup', context: serverContext(700n), channelId: '100000000000000003' });
  assert.equal(setup.kind, 'SETUP'); if (setup.kind !== 'SETUP') throw new Error('Economic setup failed');
  assert.equal(setup.market.priceSource, 'ECONOMY'); assert.equal(setup.market.economy?.engineVersion, '0.4.0');
  assert.equal(setup.market.economy?.companies.length, 8);
  assert.equal(setup.market.listings.every(listing => listing.price === '1000'), true);
  await first.close();
  const restored = create(economySeed); await restored.start();
  const market = await restored.execute({ type: 'market', context: serverContext(701n) });
  assert.equal(market.kind, 'MARKET'); if (market.kind !== 'MARKET') throw new Error('Economic reopen failed');
  assert.deepEqual(market.market.economy, setup.market.economy);
  for (const forbidden of ['sealedQuarters', 'subatomCarries', 'privateSeed']) assert.equal(JSON.stringify(market).includes(forbidden), false);
  await restored.close();
  const changed = create(randomBytes(32)); await assert.rejects(changed.start(), /worker/);
});

test('writer lock denies concurrent owners and safely recovers a dead process', (context) => {
  const path = join(directory(context), 'trial.sqlite');
  const first = new ProcessLock(path); first.acquire();
  const second = new ProcessLock(path);
  assert.throws(() => second.acquire(), WriterAlreadyRunningError);
  first.release(); second.acquire(); second.release();
  const child = spawnSync(process.execPath, ['-e', 'process.stdout.write(process.pid.toString())'], { encoding: 'utf8' });
  assert.equal(child.status, 0);
  writeFileSync(`${path}.writer-lock`, JSON.stringify({ pid: Number(child.stdout), nonce: randomUUID() }));
  const recovered = new ProcessLock(path); recovered.acquire(); recovered.release();
});

test('writer acquisition recovery guard fails closed and cannot be stolen', (context) => {
  const path = join(directory(context), 'trial.sqlite');
  writeFileSync(`${path}.writer-lock.acquire`, JSON.stringify({ pid: process.pid, nonce: randomUUID() }));
  assert.throws(() => new ProcessLock(path).acquire(), WriterAlreadyRunningError);
});

test('malformed writer lock fails closed', (context) => {
  const path = join(directory(context), 'trial.sqlite');
  writeFileSync(`${path}.writer-lock`, '{invalid-json');
  assert.throws(() => new ProcessLock(path).acquire(), WriterAlreadyRunningError);
});

test('worker startup failure signals the host, releases ownership and never accepts work', async (context) => {
  let first: WorkerBackend | undefined;
  let failed: WorkerBackend | undefined;
  let restored: WorkerBackend | undefined;
  context.after(async () => { await restored?.close(); await failed?.close(); await first?.close(); });
  const databasePath = join(directory(context), 'trial.sqlite');
  const identityKey = randomBytes(32);
  first = new WorkerBackend({ databasePath, identityKey }); await first.start(); await first.close();
  let signal!: () => void;
  const exited = new Promise<void>((resolve) => { signal = resolve; });
  failed = new WorkerBackend({ databasePath, identityKey: randomBytes(32), onUnexpectedExit: signal });
  await assert.rejects(failed.start(), /worker/);
  await exited;
  assert.deepEqual(await failed.execute({ type: 'market', context: serverContext(0n) }), { kind: 'ERROR', code: 'INTERNAL_ERROR' });
  restored = new WorkerBackend({ databasePath, identityKey }); await restored.start();
});

test('slow public delivery coalesces newer versions independently and never retries a commit', async () => {
  const delivered: number[] = [];
  let unblock: (() => void) | undefined;
  const blocked = new Promise<void>((resolve) => { unblock = resolve; });
  let failures = 0;
  const publisher = new MarketBoardPublisher(async (market) => {
    delivered.push(market.marketVersion);
    if (market.marketVersion === 1) await blocked;
    else throw new Error('Synthetic network failure');
  }, () => { failures++; });
  const market: MarketView = { marketId: 'synthetic-market', state: 'OPEN', tickNo: 1, marketVersion: 1,
    sequenceNo: 1, nextBoundaryAt: '2026-10-03T12:00:00.000Z', updatedAt: '2026-10-03T11:55:00.000Z',
    priceSource: 'TRIAL', channelId: null, boardMessageId: null, listings: [] };
  publisher.enqueue([market]);
  publisher.enqueue([{ ...market, marketVersion: 2 }]);
  publisher.enqueue([{ ...market, marketVersion: 3 }]);
  assert.deepEqual(delivered, [1]);
  unblock?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, [1, 3]); assert.equal(failures, 1);
  publisher.stop(); publisher.enqueue([{ ...market, marketVersion: 4 }]);
  assert.deepEqual(delivered, [1, 3]);
});

test('backpressure is a temporary per-user burst/pending limit and refills', () => {
  let now = 0;
  const gate = new RequestGate(() => now);
  const request: ServiceRequest = { type: 'market', context: serverContext(0n) };
  const leaves: Array<() => void> = [];
  for (let i = 0; i < 8; i++) { const leave = gate.enter(request); assert.ok(leave); leaves.push(leave); }
  assert.equal(gate.enter(request), null);
  for (const leave of leaves) { leave(); leave(); }
  for (let i = 0; i < 2; i++) { const leave = gate.enter(request); assert.ok(leave); leave(); }
  assert.equal(gate.enter(request), null);
  now = 200;
  const replenished = gate.enter(request); assert.ok(replenished); replenished();
});

test('actual repository worker commits trades, rejects a second writer and reopens the ledger', async (context) => {
  let backend: WorkerBackend | undefined;
  let restarted: WorkerBackend | undefined;
  // Close native SQLite handles before the later directory cleanup hook runs.
  context.after(async () => { await restarted?.close(); await backend?.close(); });
  const databasePath = join(directory(context), 'trial.sqlite');
  const identityKey = randomBytes(32);
  backend = new WorkerBackend({ databasePath, identityKey });
  await backend.start();
  assert.throws(() => new WorkerBackend({ databasePath, identityKey }), WriterAlreadyRunningError);
  const setup = await backend.execute({ type: 'setup', context: serverContext(1n), channelId: '100000000000000003' });
  assert.equal(setup.kind, 'SETUP');
  const opened = await backend.execute({ type: 'open', context: serverContext(2n), age14Plus: true, agreeTerms: true });
  assert.equal(opened.kind, 'ACCOUNT');
  const buy = await backend.execute({ type: 'quote', context: serverContext(3n), symbol: 'HGI', side: 'BUY', quantity: '9.99' });
  assert.equal(buy.kind, 'QUOTE'); if (buy.kind !== 'QUOTE') return;
  const fill = await backend.execute({ type: 'confirm', context: serverContext(4n), token: buy.quote.token });
  assert.equal(fill.kind, 'FILLED'); if (fill.kind !== 'FILLED') return;
  assert.equal(fill.fill.cashAfter, '0.01');
  const duplicate = await backend.execute({ type: 'confirm', context: serverContext(5n), token: buy.quote.token });
  assert.deepEqual(duplicate, fill);
  const sell = await backend.execute({ type: 'quote', context: serverContext(6n), symbol: 'HGI', side: 'SELL', all: true });
  assert.equal(sell.kind, 'QUOTE'); if (sell.kind !== 'QUOTE') return;
  const sold = await backend.execute({ type: 'confirm', context: serverContext(7n), token: sell.quote.token });
  assert.equal(sold.kind, 'FILLED'); if (sold.kind !== 'FILLED') return;
  assert.equal(sold.fill.cashAfter, '9980.02');
  await backend.close();
  restarted = new WorkerBackend({ databasePath, identityKey });
  await restarted.start();
  const portfolio = await restarted.execute({ type: 'portfolio', context: serverContext(8n) });
  assert.equal(portfolio.kind, 'PORTFOLIO'); if (portfolio.kind !== 'PORTFOLIO') return;
  assert.equal(portfolio.portfolio.account.cash, '9980.02');
  assert.equal(portfolio.portfolio.positions.length, 0);
  const history = await restarted.execute({ type: 'history', context: serverContext(9n) });
  assert.equal(history.kind, 'HISTORY'); if (history.kind !== 'HISTORY') return;
  assert.equal(history.fills.length, 2);
});
