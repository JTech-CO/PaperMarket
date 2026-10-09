import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { FakeClock } from '../src/domain/clock.js';
import { listingIdSchema } from '../src/domain/identifiers.js';
import { FinancialDecimal as D, parseMoney, parsePrice } from '../src/domain/numeric.js';
import { settleBuy, maxAffordableQuantity } from '../src/domain/settlement.js';
import { STANDARD_RULESET } from '../src/domain/ruleset.js';
import { canonicalEconomyJson, economySnapshotHash } from '../src/economy/repository.js';
import { createPublicEconomy } from '../src/economy/public.js';
import type { CorporateAction, CorporateDividend } from '../src/economy/types.js';
import { createInitialListings, INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { createMarketState } from '../src/market/pricing.js';
import { ReportingBenchmarks,benchmarkEquity,createBenchmarkState,type BenchmarkFrame } from '../src/reporting/benchmarks.js';
import { benchmarkSchemaSql } from '../src/reporting/benchmark-schema.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';

const marketId = 'benchmark_market';
const guild = '111111111111111111';
const user = '222222222222222222';
const original = INITIAL_COMPANIES[0]!;
function contribute(db:ReturnType<typeof openDatabase>,accountId:string,tick:number):void {
  const amount=parseMoney('1000').toString();const event=`benchmark_contribution_${tick}`;
  db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) SELECT ?,?,'benchmark_external_capital',market_id,account_id,'CONTRIBUTION',?,?,'EXTERNAL_CAPITAL',currency,?,?,?,engine_version,ruleset_version,created_at,NULL FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='INITIAL_GRANT'")
    .run(`${event}_journal`,event,amount,`-${amount}`,tick,tick,tick+2,marketId,accountId);
}
function fixture(t: TestContext, initialDailyRate = '0') {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  if (!db.prepare("SELECT name FROM sqlite_master WHERE name='benchmark_series'").get()) db.exec(benchmarkSchemaSql);
  const clock = new FakeClock('2026-10-05T00:00:00.000Z'); const foundation = new FoundationRepository(db, clock);
  foundation.createMarket({ marketId, guildId: guild, listings: createInitialListings() });
  const account = foundation.openAccount({ marketId, discordUserId: user, interactionId: '333333333333333333' });
  const reporting = new ReportingBenchmarks(db);
  let publicState = createPublicEconomy(INITIAL_COMPANIES, 0, marketId);
  let prices = Object.fromEntries(publicState.companies.map(item => [item.listingId, parsePrice('1000')]));
  let cumulative: CorporateAction[] = [];
  const dividends = new Map<string, CorporateDividend>();
  function frame(tick: number, dailyRate = '0', actions: CorporateAction[] = [], priceOverrides: Record<string, string> = {}) {
    for (const action of actions) {
      if ('dividend' in action) dividends.set(action.dividend.id, action.dividend);
      if (action.kind === 'REPLACEMENT') {
        db.prepare("UPDATE listings SET status='LIQUIDATING' WHERE market_id=? AND listing_id=?").run(marketId, action.listingId);
        db.prepare('INSERT INTO issuers(market_id,issuer_id,category) VALUES(?,?,?)').run(marketId, action.newIssuerId, original.category);
        db.prepare("INSERT INTO listings(market_id,listing_id,issuer_id,slot_id,category,symbol,price,status,created_at) VALUES(?,?,?,?,?,?,?,'ACTIVE',?)")
          .run(marketId, action.newListingId, action.newIssuerId, original.slotId, original.category, action.newSymbol, '1000', clock.now());
        publicState = { ...publicState, companies: publicState.companies.map(item => item.listingId === action.listingId
          ? { ...item, issuerId: action.newIssuerId as typeof item.issuerId, listingId: action.newListingId as typeof item.listingId, symbol: action.newSymbol as typeof item.symbol,
            generation: action.generation, createdTick: action.createdTick as typeof item.createdTick, dividends: [] } : item) };
        delete prices[action.listingId]; prices[action.newListingId] = parsePrice('1000');
      }
    }
    cumulative = [...cumulative, ...actions];
    publicState = { ...publicState, tickNo: tick as typeof publicState.tickNo, corporateActions: cumulative as typeof publicState.corporateActions,
      companies: publicState.companies.map(item => ({ ...item, dividends: [...dividends.values()].filter(dividend => dividend.listingId === item.listingId) as typeof item.dividends })) };
    for (const [listing, price] of Object.entries(priceOverrides)) prices[listing] = parsePrice(price);
    const pricing = { ...createMarketState(publicState, prices), tickNo: tick };
    const source = { engineVersion: '0.4.0', economy: { inaccessiblePrivateData: 'never consumed by benchmarks' }, public: publicState, pricing };
    db.prepare('UPDATE markets SET tick_no=?,market_version=? WHERE market_id=?').run(tick, tick, marketId);
    db.prepare('INSERT INTO economy_snapshots(market_id,tick_no,engine_tick,market_version,engine_version,snapshot_json,snapshot_hash,boundary_at,committed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(marketId, tick, tick, tick, '0.4.0', canonicalEconomyJson(source), economySnapshotHash(source), clock.now(), clock.now());
    db.prepare('INSERT INTO economy_rate_intervals(market_id,tick_no,daily_cash_rate,rate_json) VALUES(?,?,?,?)').run(marketId, tick, dailyRate, '{}');
    for (const action of actions) db.prepare('INSERT INTO corporate_actions(market_id,action_id,tick_no,action_json) VALUES(?,?,?,?)').run(marketId, action.id, tick, JSON.stringify(action));
    return source;
  }
  frame(0, initialDailyRate);
  const state = (kind: string, tick?: number) => JSON.parse((db.prepare('SELECT state_json FROM benchmark_snapshots WHERE market_id=? AND series_id=? AND (? IS NULL OR tick_no=?) ORDER BY tick_no DESC LIMIT 1')
    .get(marketId, `${kind}:${account.accountId}`, tick ?? null, tick ?? null) as { state_json: string }).state_json) as { cashAtoms: string; positions: { listingId: string; quantity: string; costAtoms: string }[]; rights: { id: string; costAtoms: string }[]; interestCarry: { numerator: string; denominator: string }; dividendCarry: { numerator: string; denominator: string } };
  return { db, reporting, account, frame, state };
}
function claim(declaredTick = 1, id = 'benchmark_dividend', dps = '15'): CorporateDividend {
  const total = parseMoney(dps) * BigInt(original.issuedShares);
  return { id, issuerId: original.issuerId, listingId: original.listingId, declaredTick, exTick: declaredTick + 3, payTick: declaredTick + 5,
    status: 'DECLARED', issuedShares: original.issuedShares, totalNominalAtoms: total.toString(), dps, remainingPayableAtoms: total.toString(), recoveryRatio: '1', paidAtoms: '0' };
}
function divAction(kind: 'DIVIDEND_DECLARED' | 'DIVIDEND_EX' | 'DIVIDEND_PAYMENT' | 'DIVIDEND_IMPAIRED', tick: number, dividend = claim()): CorporateAction {
  return { kind, id: `${dividend.id}_${kind}`, issuerId: original.issuerId, listingId: original.listingId, symbol: original.symbol, effectiveTick: tick, dividend };
}

test('same opening 10000 principal uses eight fee-inclusive fractional purchases and no investor positions', t => {
  const f = fixture(t); f.reporting.initializeMarket(marketId); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  const views = f.reporting.owned(marketId, f.account.accountId);
  assert.equal(views.cash.equity, '10000'); assert.equal(views.cash.totalReturnPct, '0'); assert.equal(views.cash.openingPolicy, 'EXACT_ACTIVE_OFFSET');
  const quantity = maxAffordableQuantity(parseMoney('1250'), parsePrice('1000'), STANDARD_RULESET.tradeFeeRate);
  const purchase = settleBuy(parsePrice('1000'), quantity, STANDARD_RULESET.tradeFeeRate);
  const state = f.state('HOLD8'); assert.equal(state.positions.length, 8); assert.equal(state.positions[0]!.quantity, quantity);
  assert.equal(state.cashAtoms, (parseMoney('10000') - purchase.money * 8n).toString());
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM position_journal').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM cash_journal WHERE entry_type='INITIAL_GRANT'").get() as { n: number }).n, 1);
  assert.equal(f.reporting.pm8(marketId).openingPolicy, 'MARKET_ADOPTION');
});
test('cash interest uses previous public rate and exact opening active time, never wall-clock outage time', t => {
  const f = fixture(t, '0.001');
  f.reporting.initializeAccount(marketId, f.account.accountId, 100000);
  f.frame(1, '0.002'); f.reporting.advanceBoundary(marketId);
  assert.equal(f.reporting.owned(marketId, f.account.accountId).cash.equity, '10006.666666666666');
  f.frame(2, '0.009'); f.reporting.advanceBoundary(marketId);
  assert.equal(f.reporting.owned(marketId, f.account.accountId).cash.equity, '10026.679999999999');
  const immutable = f.db.prepare('SELECT state_hash FROM benchmark_snapshots ORDER BY rowid').all();
  f.reporting.advanceBoundary(marketId); assert.deepEqual(f.db.prepare('SELECT state_hash FROM benchmark_snapshots ORDER BY rowid').all(), immutable);
});
test('legacy backfill uses opening price and all recorded public history, explicitly excludes unprovable first partial interval', t => {
  const f = fixture(t);
  f.frame(1, '0.001', [], { [original.listingId]: '1200' }); f.frame(2, '0.001'); f.frame(3, '0.001');
  f.reporting.initializeAccount(marketId, f.account.accountId);
  const views = f.reporting.owned(marketId, f.account.accountId); assert.equal(views.cash.startTick, 0); assert.equal(views.cash.tickNo, 3);
  assert.equal(views.cash.openingPolicy, 'LEGACY_BOUNDARY_ONLY'); assert.equal(views.cash.cashInterest, '20.01');
  assert.equal(f.state('HOLD8', 0).positions.find(item => item.listingId === original.listingId)?.quantity, '1.248751');
  f.reporting.initializeMarket(marketId); assert.equal(f.reporting.pm8(marketId).startTick, 3);
  assert.equal((f.db.prepare("SELECT count(*) AS n FROM benchmark_snapshots WHERE series_id='PM8'").get() as { n: number }).n, 1);
});
test('dividend ex-date transfers value into a claim and payout substitutes cash without reinvestment', t => {
  const f = fixture(t); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  const dividend = claim();
  f.frame(1, '0', [divAction('DIVIDEND_DECLARED', 1, dividend)]); f.reporting.advanceBoundary(marketId);
  f.frame(2); f.reporting.advanceBoundary(marketId); f.frame(3); f.reporting.advanceBoundary(marketId);
  const before = f.reporting.owned(marketId, f.account.accountId).hold8;
  f.frame(4, '0', [divAction('DIVIDEND_EX', 4, { ...dividend, status: 'EX_ENTITLED' })], { [original.listingId]: '985' }); f.reporting.advanceBoundary(marketId);
  const ex = f.reporting.owned(marketId, f.account.accountId).hold8;
  // The public policy rate discounts a claim for its remaining two virtual days.
  assert.ok(new D(ex.equity).lte(before.equity)); assert.equal(ex.dividends, '0'); assert.ok(new D(ex.receivables).gt(0));
  const held = f.state('HOLD8').positions;
  f.frame(5); f.reporting.advanceBoundary(marketId);
  f.frame(6, '0', [divAction('DIVIDEND_PAYMENT', 6, { ...dividend, status: 'PAID', remainingPayableAtoms: '0', paidAtoms: dividend.totalNominalAtoms })]); f.reporting.advanceBoundary(marketId);
  const paid = f.reporting.owned(marketId, f.account.accountId).hold8;
  assert.equal(paid.dividends, '18.731265'); assert.equal(paid.receivables, '0'); assert.deepEqual(f.state('HOLD8').positions, held);
  assert.equal(paid.equity, before.equity);
});
test('HOLD8 retains liquidation cost and zero loss, never receives a free replacement; PM8 pays for its later entry', t => {
  const f = fixture(t); f.reporting.initializeMarket(marketId); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  const held = f.state('HOLD8').positions.find(item => item.listingId === original.listingId)!;
  const started: CorporateAction = { id: 'benchmark_liq_started', kind: 'LIQUIDATION_STARTED', effectiveTick: 1, issuerId: original.issuerId,
    listingId: original.listingId, symbol: original.symbol, liquidationId: 'benchmark_liq', settlementTick: 30, estimatedRecoveryPerShare: '200', dividendRecoveryRatio: '0' };
  const replacement: Extract<CorporateAction, { kind: 'REPLACEMENT' }> = { id: 'benchmark_replacement', kind: 'REPLACEMENT', effectiveTick: 1, issuerId: original.issuerId, listingId: original.listingId,
    symbol: original.symbol, baseSymbol: 'HGI', generation: 2, createdTick: 1, newIssuerId: 'issuer_hgi_2', newListingId: 'listing_hgi_2', newSymbol: 'HGI2', newName: 'Replacement', issuedShares: original.issuedShares };
  f.frame(1, '0', [started, replacement]); f.reporting.advanceBoundary(marketId);
  assert.equal(f.state('HOLD8').positions.length, 7); assert.equal(f.state('HOLD8').rights[0]!.costAtoms, held.costAtoms);
  const receivables = f.reporting.owned(marketId, f.account.accountId).hold8.receivables; assert.ok(new D(receivables).gt(0));
  for (let tick = 2; tick <= 21; tick++) { f.frame(tick); f.reporting.advanceBoundary(marketId); }
  const pm = JSON.parse((f.db.prepare("SELECT state_json FROM benchmark_snapshots WHERE market_id=? AND series_id='PM8' AND tick_no=21").get(marketId) as { state_json: string }).state_json) as { positions: { listingId: string; costAtoms: string }[]; rights: unknown[] };
  assert.equal(pm.positions.length, 8); assert.ok(BigInt(pm.positions.find(item => item.listingId === replacement.newListingId)!.costAtoms) > 0n); assert.equal(pm.rights.length, 1);
  assert.equal(f.state('HOLD8').positions.some(item => item.listingId === replacement.newListingId), false);
  const pm8 = f.reporting.pm8(marketId); assert.ok(new D(pm8.equity).lt('10000')); assert.ok(new D(pm8.fees).gt('9.99')); assert.equal(pm8.receivables, receivables);
  for (let tick = 22; tick < 30; tick++) { f.frame(tick); f.reporting.advanceBoundary(marketId); }
  f.frame(30, '0', [{ id: 'benchmark_liq_final', kind: 'LIQUIDATION_SETTLED', effectiveTick: 30, issuerId: original.issuerId, listingId: original.listingId,
    symbol: original.symbol, liquidationId: 'benchmark_liq', realizedRecoveryPerShare: '0', commonPaidAtoms: '0', eligibleShares: original.issuedShares, dividendRecoveries: [] }]); f.reporting.advanceBoundary(marketId);
  const final = f.reporting.owned(marketId, f.account.accountId).hold8; assert.equal(final.receivables, '0'); assert.equal(final.liquidationReceipts, '0'); assert.ok(new D(final.totalReturnPct).lt('-12'));
  assert.equal(f.state('HOLD8').positions.length, 7);
});
test('snapshot immutability, owner scope and closed accounts block private benchmark reads', t => {
  const f = fixture(t); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  assert.throws(() => f.reporting.owned('another_market', f.account.accountId), /scope/);
  assert.throws(() => f.reporting.owned(marketId, 'another_account'), /scope/);
  assert.throws(() => f.db.prepare('UPDATE benchmark_snapshots SET source_hash=?').run('0'.repeat(64)), /append-only/);
  assert.throws(() => f.db.prepare('DELETE FROM benchmark_series').run(), /persistent/);
  f.db.prepare("UPDATE accounts SET status='CLOSED' WHERE market_id=? AND account_id=?").run(marketId, f.account.accountId);
  assert.throws(() => f.reporting.owned(marketId, f.account.accountId), /scope/);
});
test('hash tampering and missing recorded public ticks fail closed rather than inventing prices', t => {
  const f = fixture(t); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  f.db.exec('DROP TRIGGER benchmark_snapshots_no_update');
  f.db.prepare('UPDATE benchmark_snapshots SET state_hash=? WHERE market_id=? AND series_id=?').run('0'.repeat(64), marketId, `CASH:${f.account.accountId}`);
  assert.throws(() => f.reporting.owned(marketId, f.account.accountId), /chain/);
  f.db.prepare('UPDATE markets SET tick_no=1,market_version=1 WHERE market_id=?').run(marketId);
  assert.throws(() => new ReportingBenchmarks(f.db).initializeMarket(marketId), /source is missing/);
});
test('PM8 adoption begins at its recorded active offset and repeated startup does not reset principal or accrue offline time', t => {
  const f = fixture(t, '0.001'); f.reporting.initializeMarket(marketId, 200000);
  const initial = f.reporting.pm8(marketId);
  f.frame(1, '0.001'); f.reporting.advanceBoundary(marketId);
  const view = f.reporting.pm8(marketId);
  const paid = new D(initial.cash).mul('0.001').div(3).toDecimalPlaces(12, D.ROUND_FLOOR).toString();
  assert.ok(new D(view.cashInterest).eq(paid));
  const hashes = f.db.prepare('SELECT state_hash FROM benchmark_snapshots ORDER BY rowid').all();
  const restarted = new ReportingBenchmarks(f.db); restarted.initializeMarket(marketId, 0);
  assert.deepEqual(restarted.pm8(marketId), view); assert.deepEqual(f.db.prepare('SELECT state_hash FROM benchmark_snapshots ORDER BY rowid').all(), hashes);
});
test('three subatom dividend remainders pool exactly rather than paying an atom per claim or discarding value', t => {
  const f = fixture(t); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  const dividends = [0, 1, 2].map(index => claim(1, `tiny_benchmark_${index}`, '0.000000000001'));
  f.frame(1, '0', dividends.map(dividend => divAction('DIVIDEND_DECLARED', 1, dividend))); f.reporting.advanceBoundary(marketId);
  f.frame(2); f.reporting.advanceBoundary(marketId); f.frame(3); f.reporting.advanceBoundary(marketId);
  f.frame(4, '0', dividends.map(dividend => divAction('DIVIDEND_EX', 4, { ...dividend, status: 'EX_ENTITLED' }))); f.reporting.advanceBoundary(marketId);
  f.frame(5); f.reporting.advanceBoundary(marketId);
  f.frame(6, '0', dividends.map(dividend => divAction('DIVIDEND_PAYMENT', 6, { ...dividend, status: 'PAID', paidAtoms: dividend.totalNominalAtoms, remainingPayableAtoms: '0' }))); f.reporting.advanceBoundary(marketId);
  assert.equal(f.reporting.owned(marketId, f.account.accountId).hold8.dividends, '0.000000000003');
  assert.deepEqual(f.state('HOLD8').dividendCarry, { numerator: '746253', denominator: '1000000000000000000' });
});
test('a changed historical rate is detected even when an already validated price frame was cached', t => {
  const f = fixture(t); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  f.frame(1); f.reporting.advanceBoundary(marketId); f.reporting.owned(marketId, f.account.accountId);
  f.db.exec('DROP TRIGGER economy_rate_intervals_no_update');
  f.db.prepare('UPDATE economy_rate_intervals SET daily_cash_rate=? WHERE market_id=? AND tick_no=0').run('0.001', marketId);
  assert.throws(() => f.reporting.owned(marketId, f.account.accountId), /public source differs/);
});
test('late shadow persistence failure rolls back adoption and every prior sibling snapshot in the enclosing market transaction', t => {
  const f = fixture(t);
  f.db.exec("CREATE TRIGGER reject_hold8 BEFORE INSERT ON benchmark_snapshots WHEN NEW.series_id GLOB 'HOLD8:*' BEGIN SELECT RAISE(ABORT,'injected shadow failure'); END;");
  assert.throws(() => f.db.transaction(() => {
    f.reporting.initializeMarket(marketId); f.reporting.initializeAccount(marketId, f.account.accountId, 0);
  })(), /injected shadow failure/);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM benchmark_series').get() as { n: number }).n, 0);
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM benchmark_snapshots').get() as { n: number }).n, 0);
});

test('validation reuse detects a new historical action inserted by the same connection',t=>{
  const f=fixture(t);f.reporting.initializeAccount(marketId,f.account.accountId,0);f.reporting.owned(marketId,f.account.accountId);
  const action=divAction('DIVIDEND_DECLARED',0,claim(0));
  f.db.prepare('INSERT INTO corporate_actions(market_id,action_id,tick_no,action_json) VALUES(?,?,?,?)').run(marketId,action.id,0,JSON.stringify(action));
  assert.throws(()=>f.reporting.owned(marketId,f.account.accountId),/source differs/);
});
test('a rolled-back validated boundary cannot supply a cached valuation to different replacement rows',t=>{
  const f=fixture(t);f.reporting.initializeAccount(marketId,f.account.accountId,0);
  let rolledValue='';assert.throws(()=>f.db.transaction(()=>{
    f.frame(1,'0',[],{[original.listingId]:'1200'});f.reporting.advanceBoundary(marketId);rolledValue=f.reporting.owned(marketId,f.account.accountId).hold8.equity;throw new Error('rollback fixture');
  })(),/rollback fixture/);
  f.frame(1,'0',[],{[original.listingId]:'900'});f.reporting.advanceBoundary(marketId);
  const value=f.reporting.owned(marketId,f.account.accountId).hold8.equity;
  assert.notEqual(value,rolledValue);assert.deepEqual(f.reporting.owned(marketId,f.account.accountId),new ReportingBenchmarks(f.db).owned(marketId,f.account.accountId));
});

test('verified source reuse rejects altered raw JSON even with the previously verified claimed hash',t=>{
  const f=fixture(t);f.reporting.initializeAccount(marketId,f.account.accountId,0);f.reporting.owned(marketId,f.account.accountId);
  f.db.exec('DROP TRIGGER economy_snapshots_no_update');
  f.db.prepare('UPDATE economy_snapshots SET snapshot_json=? WHERE market_id=? AND tick_no=0').run('{}',marketId);
  assert.throws(()=>f.reporting.owned(marketId,f.account.accountId),/snapshot hash differs/);
});

test('exact shared holding valuation remains independent of cash and observes changed or missing prices',()=>{
  const state=createBenchmarkState();state.cashAtoms=parseMoney('10').toString();state.positions=[{listingId:listingIdSchema.parse(original.listingId),quantity:'2',costAtoms:'0'}];
  const prices=new Map([[original.listingId,'1000']]);
  const frame:BenchmarkFrame={tick:0,version:0,engineTick:0,hash:'synthetic',dailyRate:'0',annualRate:'0',prices,actions:[],dividends:[]};
  assert.deepEqual(benchmarkEquity(state,frame),{numerator:2010n,denominator:1n});
  state.cashAtoms=parseMoney('20').toString();assert.deepEqual(benchmarkEquity(state,frame),{numerator:2020n,denominator:1n});
  prices.set(original.listingId,'900');assert.deepEqual(benchmarkEquity(state,frame),{numerator:1820n,denominator:1n});
  prices.delete(original.listingId);assert.throws(()=>benchmarkEquity(state,frame),/lost its price/);
});

test('owned shadows receive actual end-boundary funding in cash while returns and PM8 exclude its amount',t=>{
  const f=fixture(t);f.reporting.initializeMarket(marketId);f.reporting.initializeAccount(marketId,f.account.accountId,0);
  const opening=f.reporting.owned(marketId,f.account.accountId);
  const positions=structuredClone(f.state('HOLD8').positions);
  for(let tick=1;tick<=21;tick++){f.frame(tick,tick===21?'0.001':'0');if(tick===21)contribute(f.db,f.account.accountId,tick);f.reporting.advanceBoundary(marketId);}
  const funded=f.reporting.owned(marketId,f.account.accountId);
  assert.equal(funded.cash.equity,'11000');assert.equal(funded.cash.contributions,'1000');assert.equal(funded.cash.netInvestmentPnl,'0');assert.equal(funded.cash.totalReturnPct,'0');assert.equal(funded.cash.index,'1000');
  assert.equal(new D(funded.hold8.equity).minus(opening.hold8.equity).toString(),'1000');assert.equal(funded.hold8.totalReturnPct,opening.hold8.totalReturnPct);assert.deepEqual(f.state('HOLD8').positions,positions);assert.match(funded.hold8.contributionPolicy??'',/현금/);
  assert.equal(f.reporting.pm8(marketId).contributions,'0');
  f.frame(22);f.reporting.advanceBoundary(marketId);
  assert.equal(f.reporting.owned(marketId,f.account.accountId).cash.equity,'11011');
  assert.equal(f.reporting.owned(marketId,f.account.accountId).cash.totalReturnPct,'0.1');
  const restart=new ReportingBenchmarks(f.db);restart.initializeAccount(marketId,f.account.accountId);
  assert.deepEqual(restart.owned(marketId,f.account.accountId),f.reporting.owned(marketId,f.account.accountId));
});

test('a funding row inserted behind an already verified shadow history is detected',t=>{
  const f=fixture(t);f.reporting.initializeAccount(marketId,f.account.accountId,0);
  f.frame(1);f.reporting.advanceBoundary(marketId);f.reporting.owned(marketId,f.account.accountId);
  contribute(f.db,f.account.accountId,1);
  assert.throws(()=>f.reporting.owned(marketId,f.account.accountId),/funding ledger differs/);
});
