import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import type { ServiceContext } from '../application/contracts.js';
import { WorkerBackend } from '../runtime/backend.js';
import { openDatabase } from '../storage/index.js';

/** Runs the real worker/SQLite path with synthetic identities and no Discord connection. */
async function verify(): Promise<void> {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'papermarket-broker-check-'));
  const databasePath = join(directory, 'trial.sqlite');
  const identityKey = randomBytes(32);
  let backend: WorkerBackend | undefined;
  let interaction = 100_000_000_000_000_100n;
  const context = (): ServiceContext => ({ guildId: '100000000000000001', discordUserId: '100000000000000002',
    interactionId: (++interaction).toString(), receivedAt: new Date().toISOString(), guildPermissions: '32' });
  try {
    backend = new WorkerBackend({ databasePath, identityKey }); await backend.start();
    const setupContext = context();
    const setup = await backend.execute({ type: 'setup', context: setupContext, channelId: '100000000000000003' });
    assert.equal(setup.kind, 'SETUP'); if (setup.kind !== 'SETUP') throw new Error('Setup failed');
    assert.equal(setup.market.listings.length, 8);
    assert.equal((await backend.execute({ type: 'save-board', context: setupContext, channelId: '100000000000000003', messageId: '100000000000000004' })).kind, 'BOARD_SAVED');
    for (let i = 0; i < 2; i++) assert.equal((await backend.execute({ type: 'open', context: context(), age14Plus: true, agreeTerms: true })).kind, 'ACCOUNT');
    const buy = await backend.execute({ type: 'quote', context: context(), symbol: 'HGI', side: 'BUY', quantity: '9.99' });
    assert.equal(buy.kind, 'QUOTE'); if (buy.kind !== 'QUOTE') throw new Error('Quote failed');
    const bought = await backend.execute({ type: 'confirm', context: context(), token: buy.quote.token });
    assert.equal(bought.kind, 'FILLED');
    assert.deepEqual(await backend.execute({ type: 'confirm', context: context(), token: buy.quote.token }), bought);
    const sell = await backend.execute({ type: 'quote', context: context(), symbol: 'HGI', side: 'SELL', all: true });
    assert.equal(sell.kind, 'QUOTE'); if (sell.kind !== 'QUOTE') throw new Error('Sell quote failed');
    assert.equal((await backend.execute({ type: 'confirm', context: context(), token: sell.quote.token })).kind, 'FILLED');
    await backend.close(); backend = undefined;
    const db = openDatabase(databasePath);
    let grants: number;
    try {
      grants = (db.prepare("SELECT count(*) AS n FROM cash_journal WHERE entry_type = 'INITIAL_GRANT'").get() as { n: number }).n;
      assert.equal(grants, 1);
    } finally { db.close(); }
    backend = new WorkerBackend({ databasePath, identityKey }); await backend.start();
    const portfolio = await backend.execute({ type: 'portfolio', context: context() });
    assert.equal(portfolio.kind, 'PORTFOLIO'); if (portfolio.kind !== 'PORTFOLIO') throw new Error('Replay failed');
    assert.equal(portfolio.portfolio.account.cash, '9980.02'); assert.equal(portfolio.portfolio.positions.length, 0);
    const history = await backend.execute({ type: 'history', context: context() });
    assert.equal(history.kind, 'HISTORY'); if (history.kind !== 'HISTORY') throw new Error('History failed');
    assert.equal(history.fills.length, 2);
    console.log(JSON.stringify({ milestone: 1, result: 'PASS', priceSource: 'TRIAL', companies: 8,
      grants, fills: history.fills.length, cashAfterRoundtrip: portfolio.portfolio.account.cash,
      duplicateConfirmation: 'PASS', workerReopenAndReplay: 'PASS', discordConnection: 'NOT_RUN' }, null, 2));
  } finally {
    await backend?.close();
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('papermarket-broker-check-')) throw new Error('Unsafe cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
}
void verify().catch(() => { console.error(JSON.stringify({ milestone: 1, result: 'FAIL', code: 'LOCAL_CHECK_FAILED' })); process.exitCode = 1; });
