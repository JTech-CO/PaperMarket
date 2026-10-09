import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import type Database from 'better-sqlite3';
import type { MarketView, QuoteView, ServiceContext } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { MONEY_SCALE, decimalFraction, multiplyFractions, fraction, parseMoney,parseOrderQuantity,parsePrice, quantizeMoney } from '../src/domain/numeric.js';
import {settleBuy} from '../src/domain/settlement.js';
import {STANDARD_RULESET} from '../src/domain/ruleset.js';
import { validateEconomyState } from '../src/economy/engine.js';
import { validatePublicEconomy } from '../src/economy/public.js';
import { EconomyRepository, canonicalEconomyJson, economySnapshotHash, type EconomySnapshot } from '../src/economy/repository.js';
import type { CorporateAction } from '../src/economy/types.js';
import { createInitialListings, INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { RightsRepository } from '../src/rights/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';

const guildId = '111111111111111111'; const userId = '222222222222222222';
const marketId = 'actions-test-market';
function fixture(t: TestContext,initialHolding:{symbol:'HGI'|'DNL';quantity:string;distressTick:number}) {
  const directory = mkdtempSync(join(resolve(tmpdir()), 'papermarket-actions-runtime-'));
  const path = join(directory, 'market.sqlite'); const identityKey = randomBytes(32);
  // Synthetic reproducible test RNG, unrelated to a configured production secret.
  const seed = Buffer.alloc(32, 17); const clock = new FakeClock('2026-10-04T00:00:00.000Z');
  let db = openDatabase(path); let interaction = 333333333333333333n;
  const foundation=new FoundationRepository(db,clock);foundation.createMarket({ marketId, guildId, listings: createInitialListings() });
  const context = (): ServiceContext => ({ guildId, discordUserId: userId, interactionId: (++interaction).toString(), receivedAt: clock.now(), guildPermissions: '32' });
  db.prepare("INSERT INTO market_settings(market_id,market_channel_id,board_message_id,quote_provider,configured_at,checkpoint_at,remaining_ms) VALUES(?,?,NULL,'STATIC_TRIAL',?,?,300000)")
    .run(marketId,'444444444444444444',clock.now(),clock.now());
  const opened=foundation.openAccount({marketId,discordUserId:userId,interactionId:context().interactionId});const accountId=opened.accountId;
  const listingId=INITIAL_COMPANIES.find(company=>company.symbol===initialHolding.symbol)!.listingId;
  const quantity=parseOrderQuantity(initialHolding.quantity);const initialBuy={quantity};const purchase=settleBuy(parsePrice('1000'),quantity,STANDARD_RULESET.tradeFeeRate);
  db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('pre-m5-cash','pre-m5-event','pre-m5-cause',?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',0,0,2,'0.0.0','1.0.0',?,NULL)")
    .run(marketId,accountId,(-purchase.money).toString(),purchase.money.toString(),clock.now());
  db.prepare("INSERT INTO position_journal(journal_id,event_id,cause_id,market_id,account_id,listing_id,quantity_delta,system_quantity_delta,cost_delta_atoms,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('pre-m5-position','pre-m5-event','pre-m5-cause',?,?,?,?,?,?,0,0,2,'0.0.0','1.0.0',?,NULL)")
    .run(marketId,accountId,listingId,quantity,`-${quantity}`,purchase.money.toString(),clock.now());
  db.prepare('UPDATE markets SET sequence_no=2 WHERE market_id=?').run(marketId);db.prepare('UPDATE accounts SET account_version=account_version+1 WHERE market_id=? AND account_id=?').run(marketId,accountId);
  const economy=new EconomyRepository(db,seed);
  const metadata=()=>db.prepare('SELECT * FROM markets WHERE market_id=?').get(marketId) as Parameters<EconomyRepository['initialize']>[0];
  economy.initialize(metadata(),clock.now());
  // This is genuine pre-M5 history, produced by the real economic repositories.
  // Build the controlled distress source before reporting adopts its immutable
  // hashes; rewriting an already benchmarked source correctly fails integrity.
  for(let tick=1;tick<=initialHolding.distressTick;tick++) {
    clock.advanceBy(300000);
    db.transaction(()=>{
      const prior=metadata();const sequence=prior.sequence_no+1;
      db.prepare('UPDATE markets SET sequence_no=? WHERE market_id=?').run(sequence,marketId);
      economy.settleInterest(prior,tick,tick,sequence,clock.now());economy.advance(prior,tick,tick,clock.now());
      db.prepare('UPDATE markets SET tick_no=?,market_version=?,next_boundary_at=? WHERE market_id=?').run(tick,tick,new Date(Date.parse(clock.now())+300000).toISOString(),marketId);
      db.prepare('UPDATE market_settings SET checkpoint_at=?,remaining_ms=300000 WHERE market_id=?').run(clock.now(),marketId);
      economy.settleRights(metadata(),clock.now());
    }).immediate();
  }
  assert.equal((db.prepare('SELECT count(*) n FROM benchmark_snapshots').get() as {n:number}).n,0);
  forceLiquidityFailure(db,economy.load(marketId),initialHolding.symbol);
  let broker = new BrokerRepository(db, clock, { identityKey, economySeed: seed });
  assert.ok((db.prepare('SELECT count(*) n FROM benchmark_snapshots').get() as {n:number}).n>0);
  function market(): MarketView {
    const result = broker.dispatch({ type: 'market', context: context() }); assert.equal(result.kind, 'MARKET', JSON.stringify(result)); if (result.kind !== 'MARKET') throw new Error('Market unavailable'); return result.market;
  }
  function quote(symbol: string, quantity = '2'): QuoteView {
    const result = broker.dispatch({ type: 'quote', context: context(), symbol, side: 'BUY', quantity }); assert.equal(result.kind, 'QUOTE', JSON.stringify(result)); if (result.kind !== 'QUOTE') throw new Error('Quote failed'); return result.quote;
  }
  function buy(symbol: string, quantity = '2') {
    const offered = quote(symbol, quantity); const result = broker.dispatch({ type: 'confirm', context: context(), token: offered.token }); assert.equal(result.kind, 'FILLED', JSON.stringify(result)); return offered;
  }
  function tick(): MarketView {
    clock.advanceBy(300000); const result = broker.dispatch({ type: 'tick', now: clock.now() }); assert.equal(result.kind, 'TICKED', JSON.stringify(result)); if (result.kind !== 'TICKED' || result.markets.length !== 1) throw new Error('Boundary failed'); return result.markets[0]!;
  }
  function toTick(target: number) { while (market().tickNo < target) tick(); }
  function snapshot(): EconomySnapshot { return new EconomyRepository(db, seed).load(marketId); }
  function replay() { return new FoundationRepository(db).replayAccount({ marketId, discordUserId: userId }); }
  function rights() { return new RightsRepository(db).view(marketId, accountId); }
  function restartOffline() {
    db.close(); clock.advanceBy(86400000 * 14); db = openDatabase(path); broker = new BrokerRepository(db, clock, { identityKey, economySeed: seed });
    assert.deepEqual(broker.dispatch({ type: 'recover', now: clock.now() }), { kind: 'RECOVERED' });
  }
  t.after(() => {
    if (db.open) db.close();
    if (dirname(resolve(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('papermarket-actions-runtime-')) throw new Error('Unexpected fixture cleanup path');
    rmSync(directory, { recursive: true, force: true });
  });
  return { get db() { return db; }, get broker() { return broker; }, clock, context, accountId,initialBuy, market, quote, buy, tick, toTick, snapshot, replay, rights, restartOffline };
}

/** Controlled test fixture only: a balanced cash loss and an external overdue obligation.
 * The production immutable trigger is restored in the same transaction before any broker/reporting adoption.
 */
function forceLiquidityFailure(db: Database.Database, snapshot: EconomySnapshot, symbol: string): void {
  const target = snapshot.economy.companies.find((company) => company.symbol === symbol)!; const overdue = parseMoney('2000000000');
  const economy = validateEconomyState({ ...snapshot.economy, companies: snapshot.economy.companies.map((company) => company.issuerId === target.issuerId ? {
    ...company, lifecycle: 'DISTRESSED', lifecycleSinceTick: 1, status: 'STRESSED',
    balances: { ...company.balances, cash: '0', trade_payables: (BigInt(company.balances.trade_payables) + overdue).toString(), retained_earnings: (BigInt(company.balances.retained_earnings) - BigInt(company.balances.cash) - overdue).toString() },
    workingCapital: [...company.workingCapital, { id: `${target.issuerId}_forced_payable`, causeId: 'runtime_test_failure', contractId: null, counterparty: 'EXTERNAL', counterpartyIssuerId: null, kind: 'AP', amountAtoms: overdue.toString(), dueTick: 1, overdueSinceTick: 1 }],
  } : company) });
  // The warning is already public in this fixture, so the next lifecycle action has a matching predecessor.
  const publicState = validatePublicEconomy({ ...snapshot.public, companies: snapshot.public.companies.map((company) => company.issuerId === target.issuerId ? { ...company, lifecycle: 'DISTRESSED' } : company) });
  const forced: EconomySnapshot = { ...snapshot, economy, public: publicState }; const json = canonicalEconomyJson(forced); const hash = economySnapshotHash(forced);
  const trigger = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get('economy_snapshots_no_update') as { sql: string };
  assert(trigger.sql.startsWith('CREATE TRIGGER economy_snapshots_no_update'));
  db.transaction(() => {
    db.exec('DROP TRIGGER economy_snapshots_no_update');
    const changed = db.prepare('UPDATE economy_snapshots SET snapshot_json=?,snapshot_hash=? WHERE market_id=? AND tick_no=?').run(json, hash, marketId, snapshot.economy.tickNo); assert.equal(changed.changes, 1);
    db.prepare('UPDATE economy_markets SET current_hash=? WHERE market_id=?').run(hash, marketId);
    db.exec(trigger.sql);
  }).immediate();
  assert.throws(() => db.prepare('UPDATE economy_snapshots SET snapshot_hash=? WHERE market_id=?').run('0'.repeat(64), marketId), /append-only/);
}
function actions(db: Database.Database, tick: number): CorporateAction[] {
  return (db.prepare('SELECT action_json FROM corporate_actions WHERE market_id=? AND tick_no=? ORDER BY rowid').all(marketId, tick) as { action_json: string }[]).map((row) => JSON.parse(row.action_json) as CorporateAction);
}
function cashPayouts(db: Database.Database, kind: 'DIVIDEND' | 'LIQUIDATION'): { count: number; total: bigint } {
  const rows = db.prepare('SELECT account_delta_atoms FROM cash_journal WHERE market_id=? AND entry_type=?').all(marketId, kind) as { account_delta_atoms: string }[];
  return { count: rows.length, total: rows.reduce((sum, row) => sum + BigInt(row.account_delta_atoms), 0n) };
}

test('real SQLite liquidation cancels the old quote, preserves cost/loss and replaces only the issuer slot across offline restart', (t) => {
  const f = fixture(t,{symbol:'HGI',quantity:'2',distressTick:63}); const initialBuy = f.initialBuy; const source = INITIAL_COMPANIES.find((company) => company.symbol === 'HGI')!;
  f.toTick(63); const pending = f.quote('HGI', '1'); const before = f.replay(); const originalQuantity = before.positions.get(source.listingId)!;
  const after = f.tick();
  assert.equal(after.tickNo, 64); assert.equal(after.listings.length, 8); assert(!after.listings.some((listing) => listing.listingId === source.listingId));
  const next = after.listings.find((listing) => listing.symbol === 'HGI2')!; assert(next); assert.equal(next.price, '1000'); assert.equal(next.category, source.category); assert.equal(next.slotId, source.slotId);
  assert.notEqual(next.listingId, source.listingId); const privateState = f.snapshot().economy; assert(privateState.retiredCompanies.some((company) => company.issuerId === source.issuerId));
  assert.equal(privateState.companies.find((company) => company.listingId === next.listingId)!.generation, 2);
  const converted = f.replay(); assert.equal(converted.positions.get(source.listingId)?.quantity.numerator, 0n); assert.equal(converted.positions.get(next.listingId)?.quantity.numerator ?? 0n, 0n);
  const claim = f.rights().rights.find((right) => right.kind === 'LIQUIDATION')!; assert(claim); assert.equal(claim.quantity, initialBuy.quantity); assert.equal(parseMoney(claim.cost), originalQuantity.costAtoms);
  assert.equal(claim.status, 'OPEN'); assert.equal(claim.currentValue, '0');
  assert.deepEqual(f.broker.dispatch({ type: 'confirm', context: f.context(), token: pending.token }), { kind: 'ERROR', code: 'CORPORATE_ACTION_CANCELLED' });
  assert.deepEqual(f.broker.dispatch({ type: 'quote', context: f.context(), symbol: 'HGI', side: 'BUY', quantity: '1' }), { kind: 'ERROR', code: 'LISTING_NOT_TRADABLE' });
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM corporate_order_cancellations WHERE market_id=? AND account_id=? AND intent_id=?').get(marketId, f.accountId, pending.orderIntentId) as { n: number }).n, 1);
  const hashBefore = economySnapshotHash(f.snapshot()); const amountBefore = f.replay().cashAtoms; f.restartOffline(); assert.equal(f.market().tickNo, 64); assert.equal(economySnapshotHash(f.snapshot()), hashBefore); assert.equal(f.replay().cashAtoms, amountBefore);
  const settlingTick = claim.paymentTick; f.toTick(settlingTick); const settled = f.rights().rights.find((right) => right.rightId === claim.rightId)!;
  const action = actions(f.db, settlingTick).find((event) => event.kind === 'LIQUIDATION_SETTLED'); assert(action && action.kind === 'LIQUIDATION_SETTLED'); assert.equal(action.realizedRecoveryPerShare, '0'); assert.equal(action.commonPaidAtoms, '0');
  assert.equal(settled.status, 'SETTLED'); assert.equal(settled.paid, '0'); assert.equal(parseMoney(settled.realizedPnl), -originalQuantity.costAtoms);
  assert.equal(cashPayouts(f.db, 'LIQUIDATION').count, 0); assert.equal(f.snapshot().economy.retiredCompanies.find((company) => company.issuerId === source.issuerId)!.lifecycle, 'EXTINGUISHED');
  const cashBeforeRestart = f.replay().cashAtoms; const snapshotBeforeRestart = economySnapshotHash(f.snapshot()); f.restartOffline(); assert.equal(f.market().tickNo, settlingTick); assert.equal(f.replay().cashAtoms, cashBeforeRestart); assert.equal(economySnapshotHash(f.snapshot()), snapshotBeforeRestart);
  assert.deepEqual(f.broker.dispatch({ type: 'tick', now: f.clock.now() }), { kind: 'TICKED', markets: [] }); assert.equal(cashPayouts(f.db, 'LIQUIDATION').count, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM rights_journal WHERE market_id=? AND account_id=? AND right_id=? AND action_id=?').get(marketId, f.accountId, claim.rightId, action.id) as { n: number }).n, 1);
});

test('real SQLite liquidation before ex preserves the attached nominal dividend and pays its own recovery exactly once', (t) => {
  const f = fixture(t,{symbol:'DNL',quantity:'3',distressTick:64}); const source = INITIAL_COMPANIES.find((company) => company.symbol === 'DNL')!;
  f.toTick(64); const disclosed = f.snapshot().public.companies.find((company) => company.listingId === source.listingId)!.dividends.at(-1)!; assert(disclosed); assert.equal(disclosed.declaredTick, 64); assert.equal(disclosed.exTick, 67);
  f.tick(); const start = actions(f.db, 65).find((action) => action.kind === 'LIQUIDATION_STARTED'); assert(start && start.kind === 'LIQUIDATION_STARTED');
  const rights = f.rights().rights; const attached = rights.find((right) => right.rightId === disclosed.id)!; assert(attached); assert.equal(attached.quantity, '3'); assert.equal(attached.status, 'ATTACHED');
  const nominal = multiplyFractions(decimalFraction('3'), fraction(BigInt(disclosed.totalNominalAtoms), MONEY_SCALE * BigInt(disclosed.issuedShares)));
  assert.equal(parseMoney(attached.nominal), quantizeMoney(nominal, 'floor').money);
  assert.equal(f.replay().positions.get(source.listingId)?.quantity.numerator, 0n);
  f.toTick(67); assert(actions(f.db, 67).some((action) => action.kind === 'DIVIDEND_EX' && action.dividend.id === disclosed.id));
  const claimAtEx = f.rights().rights.find((right) => right.rightId === disclosed.id)!; assert.equal(claimAtEx.nominal, attached.nominal); assert.equal(claimAtEx.quantity, attached.quantity);
  f.toTick(69); assert.equal(cashPayouts(f.db, 'DIVIDEND').count, 0, 'ordinary pay date cannot bypass the liquidation priority');
  f.toTick(70); const recovered = f.snapshot().economy.retiredCompanies.find((company) => company.issuerId === source.issuerId)!.dividends.find((dividend) => dividend.id === disclosed.id)!;
  const expected = quantizeMoney(multiplyFractions(nominal, fraction(BigInt(recovered.paidAtoms), BigInt(recovered.totalNominalAtoms))), 'floor').money;
  const settled = f.rights().rights.find((right) => right.rightId === disclosed.id)!; assert.equal(settled.status, 'SETTLED'); assert.equal(settled.nominal, attached.nominal); assert.equal(parseMoney(settled.paid), expected);
  const payouts = cashPayouts(f.db, 'DIVIDEND'); assert.equal(payouts.total, expected); assert.equal(payouts.count, expected > 0n ? 1 : 0);
  const cashBeforeRestart = f.replay().cashAtoms; f.restartOffline(); assert.equal(f.replay().cashAtoms, cashBeforeRestart); assert.deepEqual(cashPayouts(f.db, 'DIVIDEND'), payouts);
  assert.deepEqual(f.broker.dispatch({ type: 'tick', now: f.clock.now() }), { kind: 'TICKED', markets: [] }); assert.deepEqual(cashPayouts(f.db, 'DIVIDEND'), payouts);
});
