import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type Database from 'better-sqlite3';
import type { MarketView, ServiceContext, ServiceResponse } from '../application/contracts.js';
import { BrokerRepository } from '../broker/repository.js';
import { FakeClock } from '../domain/clock.js';
import { accumulateCashInterest, settleTickCashInterest } from '../domain/cash-interest.js';
import { fraction, parseMoney } from '../domain/numeric.js';
import { createInitialListings } from '../fixtures/initial-companies.js';
import { openDatabase } from '../storage/database.js';
import { FoundationRepository } from '../storage/repository.js';

/** Two real SQLite branches share a private seed; only one branch accepts investor activity. */
function branch(databasePath: string, seed: Buffer, identityKey: Buffer) {
  const clock = new FakeClock('2026-10-04T00:00:00.000Z');
  let db = openDatabase(databasePath);
  new FoundationRepository(db, clock).createMarket({ marketId: 'economic-diagnostic-market',
    guildId: '100000000000000001', listings: createInitialListings() });
  let broker = new BrokerRepository(db, clock, { identityKey, economySeed: seed });
  let interaction = 100000000000000100n;
  const context = (): ServiceContext => ({ guildId: '100000000000000001', discordUserId: '100000000000000002',
    interactionId: (++interaction).toString(), receivedAt: clock.now(), guildPermissions: '32' });
  assert.equal(broker.dispatch({ type: 'setup', context: context(), channelId: '100000000000000003' }).kind, 'SETUP');
  const market = (): MarketView => {
    const result = broker.dispatch({ type: 'market', context: context() });
    assert.equal(result.kind, 'MARKET'); if (result.kind !== 'MARKET') throw new Error('Market unavailable');
    return result.market;
  };
  const hash = (): string => (db.prepare('SELECT current_hash FROM economy_markets').get() as { current_hash: string }).current_hash;
  return { clock, context, market, hash,
    get db(): Database.Database { return db; }, get broker() { return broker; },
    tick(milliseconds = 300000) {
      clock.advanceBy(milliseconds);
      const result = broker.dispatch({ type: 'tick', now: clock.now() });
      assert.equal(result.kind, 'TICKED'); if (result.kind !== 'TICKED' || result.markets.length !== 1) throw new Error('Tick failed');
      return result.markets[0]!;
    },
    restartAfterOfflineDay() {
      db.close(); clock.advanceBy(86400000); db = openDatabase(databasePath);
      broker = new BrokerRepository(db, clock, { identityKey, economySeed: seed });
      assert.equal(broker.dispatch({ type: 'recover', now: clock.now() }).kind, 'RECOVERED');
    },
    close() { if (db.open) db.close(); },
  };
}

function verify(): void {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'papermarket-economy-check-'));
  let quiet: ReturnType<typeof branch> | undefined;
  let busy: ReturnType<typeof branch> | undefined;
  try {
    const seed = randomBytes(32); const identityKey = randomBytes(32);
    quiet = branch(join(directory, 'quiet.sqlite'), seed, identityKey);
    busy = branch(join(directory, 'busy.sqlite'), seed, identityKey);
    assert.equal(busy.market().priceSource, 'ECONOMY');
    assert.equal(busy.market().listings.every(listing => listing.price === '1000'), true);
    assert.equal(busy.broker.dispatch({ type: 'open', context: busy.context(), age14Plus: true, agreeTerms: true }).kind, 'ACCOUNT');
    busy.clock.advanceBy(150000);
    const buy = busy.broker.dispatch({ type: 'quote', context: busy.context(), symbol: 'HGI', side: 'BUY', quantity: '5' });
    assert.equal(buy.kind, 'QUOTE'); if (buy.kind !== 'QUOTE') throw new Error('Quote failed');
    assert.equal(busy.broker.dispatch({ type: 'confirm', context: busy.context(), token: buy.quote.token }).kind, 'FILLED');
    const rate = (busy.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no = ?').get(0) as { daily_cash_rate: string }).daily_cash_rate;
    const expected = settleTickCashInterest(accumulateCashInterest(
      accumulateCashInterest(fraction(0n), parseMoney('10000'), rate, 150000), parseMoney('4995'), rate, 150000));
    quiet.tick(); busy.tick(150000);
    const payout = busy.db.prepare('SELECT paid_atoms FROM interest_payouts WHERE tick_no = ?').get(0) as { paid_atoms: string };
    assert.equal(payout.paid_atoms, expected.money.toString()); assert.equal(busy.hash(), quiet.hash());
    let pendingOrderId: string | undefined;
    for (let tick = 2; tick <= 67; tick++) {
      // Reads and trades are deliberately absent from the quiet branch's economy inputs.
      busy.market(); busy.broker.dispatch({ type: 'portfolio', context: busy.context() });
      if (tick === 10) {
        const symbol = busy.market().listings[0]!.symbol;
        const preview: ServiceResponse = busy.broker.dispatch({ type: 'quote', context: busy.context(), symbol, side: 'BUY', quantity: '1',
          orderType: 'LIMIT', conditionPrice: '1', timeInForce: 'UNTIL_CANCELLED' });
        assert.equal(preview.kind, 'QUOTE'); if (preview.kind !== 'QUOTE') throw new Error('Conditional preview failed');
        const accepted: ServiceResponse = busy.broker.dispatch({ type: 'confirm', context: busy.context(), token: preview.quote.token });
        assert.equal(accepted.kind, 'ORDER_OPENED'); if (accepted.kind !== 'ORDER_OPENED') throw new Error('Conditional acceptance failed');
        pendingOrderId = accepted.order.orderId;
      }
      if (tick === 11) {
        if (!pendingOrderId) throw new Error('Conditional order missing');
        assert.equal(busy.broker.dispatch({ type: 'orders', context: busy.context() }).kind, 'ORDERS');
        assert.equal(busy.broker.dispatch({ type: 'cancel-order', context: busy.context(), orderId: pendingOrderId }).kind, 'SCHEDULED_CANCELLED');
      }
      if (tick === 20) {
        const sell: ServiceResponse = busy.broker.dispatch({ type: 'quote', context: busy.context(), symbol: 'HGI', side: 'SELL', all: true });
        assert.equal(sell.kind, 'QUOTE'); if (sell.kind !== 'QUOTE') throw new Error('Sell failed');
        assert.equal(busy.broker.dispatch({ type: 'confirm', context: busy.context(), token: sell.quote.token }).kind, 'FILLED');
      }
      quiet.tick(); busy.tick(); assert.equal(busy.hash(), quiet.hash());
      if (tick === 31) {
        const before = busy.hash(); busy.restartAfterOfflineDay();
        assert.equal(busy.hash(), before); assert.equal(busy.market().economy?.economyTick, 31);
      }
    }
    const publicMarket = busy.market();
    assert.equal(publicMarket.economy?.companies.filter(company => company.reportKind === 'ACTUAL' && company.closedTick === 63).length, 8);
    assert.equal(publicMarket.listings.some(listing => listing.price !== '1000'), true);
    const publicJson = JSON.stringify(publicMarket);
    for (const forbidden of ['privateSeed', 'sealedQuarters', 'subatomCarries', 'corporateJournal', 'trueState']) assert.equal(publicJson.includes(forbidden), false);
    console.log(JSON.stringify({ milestone: 2, result: 'PASS', engineVersion: '0.4.0', companies: 8, economicTicks: 67,
      actualQuarterReports: 8, priceFormation: 'PASS', cashTimeInterest: 'PASS', investorIndependentPath: 'PASS',
      restartAndOfflineExclusion: 'PASS', publicInformationBoundary: 'PASS', discordConnection: 'NOT_RUN' }, null, 2));
  } finally {
    quiet?.close(); busy?.close();
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('papermarket-economy-check-')) throw new Error('Unsafe cleanup target');
    rmSync(directory, { recursive: true, force: true });
  }
}
try { verify(); } catch { console.error(JSON.stringify({ milestone: 2, result: 'FAIL', code: 'LOCAL_ECONOMY_CHECK_FAILED' })); process.exitCode = 1; }
