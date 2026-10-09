import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename,dirname,join,resolve } from 'node:path';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { MarketView,QuoteView,ServiceContext } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { accumulateCashInterest,settleTickCashInterest } from '../src/domain/cash-interest.js';
import { decimalFraction,fraction,moneyFromAtoms,moneyToString,parseFraction,parseMoney } from '../src/domain/numeric.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { EconomyRepository,canonicalEconomyJson,economySnapshotHash } from '../src/economy/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { migrationChecksum,migrations } from '../src/storage/migrations.js';
import { FoundationRepository } from '../src/storage/repository.js';

const initial='2026-10-04T00:00:00.000Z';
const guildId='111111111111111111';const userId='222222222222222222';const channelId='444444444444444444';
function fixture(t:TestContext,seed=randomBytes(32),marketId='economy-test-market',path=':memory:') {
  const clock=new FakeClock(initial);const identityKey=randomBytes(32);let db=openDatabase(path);
  const foundation=new FoundationRepository(db,clock);
  foundation.createMarket({marketId,guildId,listings:createInitialListings()});
  let broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});let interaction=333333333333333333n;
  const context=(user=userId):ServiceContext=>({guildId,discordUserId:user,interactionId:(++interaction).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId});
  assert.equal(setup.kind,'SETUP',JSON.stringify(setup));
  function open(user=userId) {
    const response=broker.dispatch({type:'open',context:context(user),age14Plus:true,agreeTerms:true});
    assert.equal(response.kind,'ACCOUNT',JSON.stringify(response));if(response.kind!=='ACCOUNT') throw new Error('open failed');return response.account;
  }
  function market():MarketView {
    const response=broker.dispatch({type:'market',context:context()});assert.equal(response.kind,'MARKET',JSON.stringify(response));
    if(response.kind!=='MARKET') throw new Error('market failed');return response.market;
  }
  function quote(side:'BUY'|'SELL',quantity='1'):QuoteView {
    const response=broker.dispatch({type:'quote',context:context(),symbol:'HGI',side,quantity});
    assert.equal(response.kind,'QUOTE',JSON.stringify(response));if(response.kind!=='QUOTE') throw new Error('quote failed');return response.quote;
  }
  function fill(quote:QuoteView) {
    const response=broker.dispatch({type:'confirm',context:context(),token:quote.token});
    assert.equal(response.kind,'FILLED',JSON.stringify(response));if(response.kind!=='FILLED') throw new Error('fill failed');return response.fill;
  }
  function tick(milliseconds=300000):MarketView {
    clock.advanceBy(milliseconds);const response=broker.dispatch({type:'tick',now:clock.now()});
    assert.equal(response.kind,'TICKED',JSON.stringify(response));if(response.kind!=='TICKED'||response.markets.length!==1) throw new Error('tick failed');return response.markets[0]!;
  }
  function reopen() {db.close();db=openDatabase(path);broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});}
  t.after(()=>{if(db.open)db.close();});
  return {get db(){return db;},get broker(){return broker;},clock,identityKey,seed,marketId,context,open,market,quote,fill,tick,reopen};
}
function temporaryDirectory():string {
  const root=resolve(tmpdir());const directory=mkdtempSync(join(root,'papermarket-economy-'));
  return directory;
}
function cleanupDirectory(directory:string):void {
  if(dirname(resolve(directory))!==resolve(tmpdir())||!basename(directory).startsWith('papermarket-economy-'))throw new Error('Unexpected cleanup path');
  rmSync(directory,{recursive:true,force:true});
}
function count(db:Database.Database,sql:string):number{return (db.prepare(sql).get() as {n:number}).n;}
function hash(db:Database.Database):string{return (db.prepare('SELECT current_hash FROM economy_markets').get() as {current_hash:string}).current_hash;}

/** Build genuine pre-M5 financial/public history before the broker adopts reporting sources. */
function legacySnapshotFixture(t:TestContext,version:'0.2.0'|'0.3.0',omittedFields:ReadonlySet<string>,heldQuantity?:'0.123456') {
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock(initial);const seed=randomBytes(32);const marketId='legacy-snapshot-market';
  const foundation=new FoundationRepository(db,clock);foundation.createMarket({marketId,guildId,listings:createInitialListings()});
  db.prepare("INSERT INTO market_settings(market_id,market_channel_id,board_message_id,quote_provider,configured_at,checkpoint_at,remaining_ms) VALUES(?,?,NULL,'STATIC_TRIAL',?,?,300000)")
    .run(marketId,channelId,initial,initial);
  const account=foundation.openAccount({marketId,discordUserId:userId,interactionId:'333333333333333330'});
  if(heldQuantity) {
    const cost=parseMoney('123.579456');const listingId=createInitialListings().find(listing=>listing.symbol==='HGI')!.listingId;
    db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('legacy-snapshot-cash','legacy-snapshot-event','legacy-snapshot-cause',?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',0,0,2,'0.0.0','1.0.0',?,NULL)")
      .run(marketId,account.accountId,(-cost).toString(),cost.toString(),initial);
    db.prepare("INSERT INTO position_journal(journal_id,event_id,cause_id,market_id,account_id,listing_id,quantity_delta,system_quantity_delta,cost_delta_atoms,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('legacy-snapshot-position','legacy-snapshot-event','legacy-snapshot-cause',?,?,?,?,?,?,0,0,2,'0.0.0','1.0.0',?,NULL)")
      .run(marketId,account.accountId,listingId,heldQuantity,`-${heldQuantity}`,cost.toString(),initial);
    db.prepare('UPDATE markets SET sequence_no=2 WHERE market_id=?').run(marketId);
    db.prepare('UPDATE accounts SET account_version=account_version+1 WHERE market_id=? AND account_id=?').run(marketId,account.accountId);
  }
  const repo=new EconomyRepository(db,seed);const market=db.prepare('SELECT * FROM markets WHERE market_id=?').get(marketId) as Parameters<EconomyRepository['initialize']>[0];
  repo.initialize(market,initial);
  const source=JSON.parse(JSON.stringify(repo.load(marketId))) as Record<string,unknown>;source.engineVersion=version;
  function strip(value:unknown):void {if(Array.isArray(value)){value.forEach(strip);return;}if(value&&typeof value==='object')for(const [key,child] of Object.entries(value)){if(omittedFields.has(key))delete(value as Record<string,unknown>)[key];else strip(child);}}
  strip(source);const json=canonicalEconomyJson(source);const snapshotHash=economySnapshotHash(source);
  const trigger=db.prepare("SELECT sql FROM sqlite_schema WHERE name='economy_snapshots_no_update'").get() as {sql:string};
  db.transaction(()=>{
    db.exec('DROP TRIGGER economy_snapshots_no_update');
    db.prepare('UPDATE economy_snapshots SET engine_version=?,snapshot_json=?,snapshot_hash=? WHERE market_id=? AND tick_no=0').run(version,json,snapshotHash,marketId);
    db.prepare('UPDATE economy_markets SET current_hash=? WHERE market_id=?').run(snapshotHash,marketId);db.exec(trigger.sql);
  }).immediate();
  assert.equal(count(db,'SELECT count(*) AS n FROM benchmark_snapshots'),0);
  assert.throws(()=>db.prepare('UPDATE economy_snapshots SET snapshot_hash=? WHERE market_id=?').run('0'.repeat(64),marketId),/append-only/);
  // M5 adoption now binds the already existing legacy source; no benchmark hash is rewritten.
  const broker=new BrokerRepository(db,clock,{identityKey:randomBytes(32),economySeed:seed});
  const tick=()=>{clock.advanceBy(300000);const result=broker.dispatch({type:'tick',now:clock.now()});assert.equal(result.kind,'TICKED',JSON.stringify(result));if(result.kind==='TICKED')assert.equal(result.markets[0]?.state,'OPEN');};
  return {db,clock,seed,marketId,account:{cash:moneyToString(moneyFromAtoms(account.cashAtoms))},json,snapshotHash,tick};
}

test('stage 2 snapshot is verified before in-memory defaults and upgraded without rewriting history or holdings',t=>{
  const stage3Fields=new Set(['retiredCompanies','generation','createdTick','lifecycle','lifecycleSinceTick','dividendBan','financingAttempts','reservedDividendAtoms','dividends','liquidation','dividend_payable','dividendPayableAtoms','oneOffProfitAtoms','counterpartyIssuerId','corporateActions','baseSymbol','corporateCashAdjustmentAtoms','corporateDebtAdjustmentAtoms','corporateLiabilityAdjustmentAtoms','continuationMark','attachedRightsMark','priceMode','events','eventEquityIssues','contract_liability','unitPriceBasis','eventDisclosures','foreignExchangeProfitAtoms','fxAtOrigination','foreignExposure','assetAccount']);
  const f=legacySnapshotFixture(t,'0.2.0',stage3Fields,'0.123456');const {json,snapshotHash:oldHash,account}=f;
  const before=new FoundationRepository(f.db,f.clock).replayAccount({marketId:f.marketId,discordUserId:userId});
  const restored=new EconomyRepository(f.db,f.seed).load(f.marketId);assert.equal(restored.engineVersion,'0.2.0');assert.equal(restored.economy.companies[0]?.generation,1);
  assert.equal(hash(f.db),oldHash);assert.equal(account.cash,'10000');f.tick();
  const after=new FoundationRepository(f.db,f.clock).replayAccount({marketId:f.marketId,discordUserId:userId});assert.deepEqual(after.positions,before.positions);assert(after.cashAtoms>=before.cashAtoms);
  const preserved=f.db.prepare('SELECT snapshot_json,snapshot_hash,engine_version FROM economy_snapshots WHERE market_id=? AND tick_no=0').get(f.marketId) as {snapshot_json:string;snapshot_hash:string;engine_version:string};
  assert.deepEqual(preserved,{snapshot_json:json,snapshot_hash:oldHash,engine_version:'0.2.0'});assert.equal(new EconomyRepository(f.db,f.seed).load(f.marketId).engineVersion,'0.4.0');
});

test('economic initialization preserves listings and exposes only sealed public facts',t=>{
  const f=fixture(t);const market=f.market();
  assert.equal(market.priceSource,'ECONOMY');assert.equal(market.economy?.engineVersion,'0.4.0');assert.equal(market.economy?.economyTick,0);
  assert.equal(market.listings.length,8);assert.equal(market.listings.every(listing=>listing.price==='1000'),true);
  assert.equal(market.economy?.companies.every(company=>company.reportKind==='SYNTHETIC_INITIALIZATION'),true);
  const rendered=JSON.stringify(market);
  for(const forbidden of ['seed_check','sealedQuarters','workingCapital','balances','currentQuarter','interestCarry','snapshot_json']) assert.equal(rendered.includes(forbidden),false);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM economy_snapshots'),1);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM economy_rate_intervals'),1);
});
test('stage 3 snapshots gain event defaults only after original hash verification and keep historical JSON immutable',t=>{
  const added=new Set(['events','eventEquityIssues','contract_liability','unitPriceBasis','eventDisclosures','foreignExchangeProfitAtoms','fxAtOrigination','foreignExposure','assetAccount','corporateLiabilityAdjustmentAtoms']);
  const f=legacySnapshotFixture(t,'0.3.0',added);const {json,snapshotHash}=f;
  const restored=new EconomyRepository(f.db,f.seed).load(f.marketId);assert.equal(restored.engineVersion,'0.3.0');assert.ok(restored.economy.events.projects.length>0);assert.equal(restored.economy.companies[0]?.balances.contract_liability,'0');assert.equal(hash(f.db),snapshotHash);f.tick();
  assert.equal(new EconomyRepository(f.db,f.seed).load(f.marketId).engineVersion,'0.4.0');assert.deepEqual(f.db.prepare('SELECT snapshot_json,snapshot_hash,engine_version FROM economy_snapshots WHERE market_id=? AND tick_no=0').get(f.marketId),{snapshot_json:json,snapshot_hash:snapshotHash,engine_version:'0.3.0'});
});

test('one economic boundary commits prices, accounts, exact interest and immutable corporate entries together',t=>{
  const f=fixture(t);const account=f.open();const before=f.market();const after=f.tick();
  assert.equal(after.tickNo,1);assert.equal(after.marketVersion,before.marketVersion+1);
  assert.equal(after.economy?.economyTick,1);assert.equal(after.listings.some(listing=>listing.price!=='1000'),true);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM economy_snapshots'),2);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM economy_prices'),8);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM corporate_journal')>0,true);
  const rate=(f.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no=0').get() as {daily_cash_rate:string}).daily_cash_rate;
  const expected=settleTickCashInterest(accumulateCashInterest(fraction(0n),parseMoney('10000'),rate,300000));
  const restored=new FoundationRepository(f.db).getAccount({marketId:f.marketId,discordUserId:userId})!;
  assert.equal(restored.cashAtoms,(parseMoney('10000')+expected.money).toString());assert.equal(restored.accountVersion,account.accountVersion+1);
  assert.equal(count(f.db,"SELECT count(*) AS n FROM cash_journal WHERE entry_type='INTEREST'"),1);
  assert.throws(()=>f.db.prepare('UPDATE economy_snapshots SET snapshot_hash = ?').run('0'.repeat(64)),/append-only/);
  assert.throws(()=>f.db.prepare('DELETE FROM corporate_journal').run(),/append-only/);
  const duplicate=f.broker.dispatch({type:'tick',now:f.clock.now()});assert.deepEqual(duplicate,{kind:'TICKED',markets:[]});
  assert.equal(count(f.db,'SELECT count(*) AS n FROM interest_payouts'),1);
});

test('interest integrates the balances before and after a midtick fill and grants no prior ownership time',t=>{
  const f=fixture(t);f.clock.advanceBy(60000);f.open();f.clock.advanceBy(90000);f.fill(f.quote('BUY','5'));
  const rate=(f.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no=0').get() as {daily_cash_rate:string}).daily_cash_rate;
  let exact=accumulateCashInterest(fraction(0n),parseMoney('10000'),rate,90000);
  exact=accumulateCashInterest(exact,parseMoney('4995'),rate,150000);
  const expected=settleTickCashInterest(exact);f.tick(150000);
  const payout=f.db.prepare('SELECT * FROM interest_payouts').get() as {paid_atoms:string;accrued_numerator:string;accrued_denominator:string;carry_numerator:string;carry_denominator:string};
  assert.equal(payout.paid_atoms,expected.money.toString());
  assert.deepEqual(parseFraction({numerator:payout.accrued_numerator,denominator:payout.accrued_denominator}),exact);
  assert.deepEqual(parseFraction({numerator:payout.carry_numerator,denominator:payout.carry_denominator}),expected.carry);
});

test('displayed accrued interest enters equity once and is paid once without invalidating an intratick quote',t=>{
  const f=fixture(t);f.open();f.clock.advanceBy(120000);const quoted=f.quote('BUY');f.clock.advanceBy(1000);
  const before=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(before.kind,'PORTFOLIO');
  if(before.kind==='PORTFOLIO'){assert.equal(before.portfolio.account.cash,'10000');assert.equal(parseMoney(before.portfolio.accruedCashInterest!)>0n,true);assert.equal(parseMoney(before.portfolio.equity)>parseMoney('10000'),true);}
  f.fill(quoted);f.tick(179000);
  const after=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(after.kind,'PORTFOLIO');
  if(after.kind==='PORTFOLIO'){assert.equal(after.portfolio.accruedCashInterest,'0');assert.equal(parseMoney(after.portfolio.cashInterestTotal!)>0n,true);}
});

test('query, enrollment, quotes and fills do not change a seeded economic path or its hash',t=>{
  const seed=randomBytes(32);const quiet=fixture(t,seed);const busy=fixture(t,seed);
  busy.open();busy.open('222222222222222223');
  for(let tick=0;tick<4;tick++) {
    busy.fill(busy.quote('BUY','0.1'));busy.fill(busy.quote('SELL','0.1'));
    for(let query=0;query<3;query++){busy.market();busy.broker.dispatch({type:'portfolio',context:busy.context()});}
    quiet.tick();busy.tick();assert.equal(hash(quiet.db),hash(busy.db));
  }
});

test('restart keeps the exact snapshot and carry while excluding downtime from active interest time',t=>{
  const directory=temporaryDirectory();const f=fixture(t,randomBytes(32),'economy-test-market',join(directory,'market.sqlite'));
  t.after(()=>cleanupDirectory(directory));
  f.open();f.clock.advanceBy(100000);f.market();const before=hash(f.db);f.db.close();f.clock.advanceBy(3600000);f.reopen();
  assert.equal(hash(f.db),before);assert.deepEqual(f.broker.dispatch({type:'recover',now:f.clock.now()}),{kind:'RECOVERED'});
  f.tick(200000);
  const rate=(f.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no=0').get() as {daily_cash_rate:string}).daily_cash_rate;
  const expected=settleTickCashInterest(accumulateCashInterest(fraction(0n),parseMoney('10000'),rate,300000));
  const payout=f.db.prepare('SELECT paid_atoms,carry_numerator,carry_denominator FROM interest_payouts').get() as {paid_atoms:string;carry_numerator:string;carry_denominator:string};
  assert.equal(payout.paid_atoms,expected.money.toString());assert.deepEqual(parseFraction({numerator:payout.carry_numerator,denominator:payout.carry_denominator}),expected.carry);
});

test('wrong or missing persistent seed fails closed before any economic replay',t=>{
  const f=fixture(t);const before=hash(f.db);
  assert.throws(()=>new BrokerRepository(f.db,f.clock,{identityKey:f.identityKey,economySeed:randomBytes(32)}),/seed has changed/);
  assert.throws(()=>new BrokerRepository(f.db,f.clock,{identityKey:f.identityKey}),/requires.*market seed/);
  assert.equal(hash(f.db),before);
});

test('an economic write failure rolls back every price, interest and journal effect and pauses the market',t=>{
  const f=fixture(t);f.open();const before=f.market();const previousHash=hash(f.db);
  f.db.exec("CREATE TRIGGER test_economy_failure BEFORE INSERT ON corporate_journal BEGIN SELECT RAISE(ABORT,'test atomic failure'); END");
  f.clock.advanceBy(300000);const result=f.broker.dispatch({type:'tick',now:f.clock.now()});assert.deepEqual(result,{kind:'ERROR',code:'INTEGRITY_ERROR'});
  const current=f.market();assert.equal(current.state,'PAUSED');assert.equal(current.tickNo,0);assert.equal(current.marketVersion,0);
  assert.deepEqual(current.listings,before.listings);assert.equal(hash(f.db),previousHash);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM economy_snapshots'),1);assert.equal(count(f.db,'SELECT count(*) AS n FROM corporate_journal'),0);
  assert.equal(count(f.db,'SELECT count(*) AS n FROM interest_payouts'),0);assert.equal(count(f.db,"SELECT count(*) AS n FROM cash_journal WHERE entry_type='INTEREST'"),0);
});

test('corrupt snapshot content, listing drift and interest checkpoint corruption are detected',t=>{
  const f=fixture(t);f.open();f.db.prepare("UPDATE account_interest SET accrued_numerator='10000'").run();
  assert.deepEqual(f.broker.dispatch({type:'portfolio',context:f.context()}),{kind:'ERROR',code:'INTEGRITY_ERROR'});
  const another=fixture(t);another.db.prepare("UPDATE listings SET price='999' WHERE symbol='HGI'").run();
  assert.deepEqual(another.broker.dispatch({type:'market',context:another.context()}),{kind:'ERROR',code:'INTEGRITY_ERROR'});
  const last=fixture(t);last.db.exec('DROP TRIGGER economy_snapshots_no_update');
  last.db.prepare("UPDATE economy_snapshots SET snapshot_json=json_set(snapshot_json,'$.economy.macro.policyRate','0.04')").run();
  assert.throws(()=>new EconomyRepository(last.db,last.seed),/hash differs/);
});

test('monthly macro and delayed quarterly earnings are public only after their committed release',t=>{
  const advance=EconomyRepository.prototype.advance;
  t.mock.method(EconomyRepository.prototype,'advance',function(this:EconomyRepository,...args:Parameters<typeof advance>){
    try{return advance.apply(this,args);}catch(error){
      t.diagnostic(`Synthetic economic failure at tick ${args[1]}: ${error instanceof Error?error.message:'unknown error'}`);
      throw error;
    }
  });
  const f=fixture(t);for(let index=0;index<63;index++)f.tick();
  const before=f.market();assert.equal(before.economy?.macro.observedTick,63);assert.equal(before.economy?.companies.find(c=>c.symbol==='HGI')?.reportKind,'SYNTHETIC_INITIALIZATION');
  const after=f.tick();const hgi=after.economy?.companies.find(c=>c.symbol==='HGI');assert.equal(hgi?.reportKind,'ACTUAL');assert.equal(hgi?.closedTick,63);assert.equal(hgi?.publishedTick,64);
  assert.equal(after.economy?.companies.find(c=>c.symbol==='AUR')?.reportKind,'SYNTHETIC_INITIALIZATION');
  assert.equal(count(f.db,"SELECT count(*) AS n FROM economy_publications WHERE json_extract(publication_json,'$.kind')='EARNINGS'"),2);
});

test('version 2 migration preserves cash, fractional shares, trial tick and subatom price before rebasing an economic epoch',t=>{
  const directory=temporaryDirectory();const path=join(directory,'legacy.sqlite');const clock=new FakeClock(initial);const legacy=new Database(path);
  legacy.pragma('foreign_keys=ON');legacy.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK(length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;`);
  for(const migration of migrations.slice(0,2)){legacy.exec(migration.sql);legacy.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(migration.version,migration.name,migrationChecksum(migration),initial);}
  const foundation=new FoundationRepository(legacy,clock);foundation.createMarket({marketId:'legacy-market',guildId,listings:createInitialListings()});
  const account=foundation.openAccount({marketId:'legacy-market',discordUserId:userId,interactionId:'333333333333333330'});
  const fractionalQuantity='0.123456789123';const cost=parseMoney('123.580245912123');const listingId=createInitialListings().find(listing=>listing.symbol==='HGI')!.listingId;
  legacy.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('legacy-cash','legacy-event','legacy-cause',?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',0,0,2,'0.0.0','1.0.0',?,NULL)")
    .run('legacy-market',account.accountId,(-cost).toString(),cost.toString(),initial);
  legacy.prepare("INSERT INTO position_journal(journal_id,event_id,cause_id,market_id,account_id,listing_id,quantity_delta,system_quantity_delta,cost_delta_atoms,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES('legacy-position','legacy-event','legacy-cause',?,?,?,?,?,?,0,0,2,'0.0.0','1.0.0',?,NULL)")
    .run('legacy-market',account.accountId,listingId,fractionalQuantity,`-${fractionalQuantity}`,cost.toString(),initial);
  legacy.prepare("INSERT INTO market_settings VALUES(?, ?,NULL,'STATIC_TRIAL',?,?,300000)").run('legacy-market',channelId,initial,initial);
  legacy.prepare('UPDATE markets SET tick_no=7,market_version=7,sequence_no=2 WHERE market_id=?').run('legacy-market');
  legacy.prepare("UPDATE listings SET price='0.0000000000000001' WHERE symbol='HGI'").run();legacy.close();
  const upgraded=openDatabase(path);t.after(()=>upgraded.close());t.after(()=>cleanupDirectory(directory));const broker=new BrokerRepository(upgraded,clock,{identityKey:randomBytes(32),economySeed:randomBytes(32)});
  assert.deepEqual(broker.dispatch({type:'recover',now:clock.now()}),{kind:'RECOVERED'});
  const view=broker.dispatch({type:'market',context:{guildId,discordUserId:userId,interactionId:'333333333333333331',receivedAt:clock.now(),guildPermissions:'32'}});
  assert.equal(view.kind,'MARKET');if(view.kind==='MARKET'){assert.equal(view.market.tickNo,7);assert.equal(view.market.economy?.economyTick,0);assert.equal(view.market.listings.find(listing=>listing.symbol==='HGI')?.price,'1e-16');}
  const replay=new FoundationRepository(upgraded).replayAccount({marketId:'legacy-market',discordUserId:userId});
  assert.equal(replay.cashAtoms,(BigInt(account.cashAtoms)-cost));assert.deepEqual(replay.positions.get(listingId)?.quantity,decimalFraction(fractionalQuantity));assert.equal(replay.positions.get(listingId)?.costAtoms,cost);
  assert.equal(count(upgraded,"SELECT count(*) AS n FROM cash_journal WHERE entry_type='INITIAL_GRANT'"),1);
  assert.equal((upgraded.prepare('SELECT epoch_tick FROM economy_markets').get() as {epoch_tick:number}).epoch_tick,7);
});

test('canonical snapshot encoding is key-order independent and excludes unsupported values',()=>{
  assert.equal(canonicalEconomyJson({b:'2',a:{d:4,c:'3'}}),canonicalEconomyJson({a:{c:'3',d:4},b:'2'}));
  assert.equal(economySnapshotHash({b:2,a:1}),economySnapshotHash({a:1,b:2}));assert.throws(()=>canonicalEconomyJson({money:0.1}),/snapshot shape/);
});

test('closing an account stops principal accrual but preserves the earned receivable and ledger',t=>{
  const f=fixture(t);const account=f.open();f.clock.advanceBy(150000);
  assert.deepEqual(f.broker.dispatch({type:'close',context:f.context(),confirmed:true}),{kind:'CLOSED',accountId:account.accountId});
  f.tick(150000);const rate=(f.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no=0').get() as {daily_cash_rate:string}).daily_cash_rate;
  const expected=settleTickCashInterest(accumulateCashInterest(fraction(0n),parseMoney('10000'),rate,150000));
  assert.equal((f.db.prepare('SELECT paid_atoms FROM interest_payouts').get() as {paid_atoms:string}).paid_atoms,expected.money.toString());
  const raw=f.db.prepare('SELECT discord_user_id FROM accounts').get() as {discord_user_id:string};assert.notEqual(raw.discord_user_id,userId);
  const rows=f.db.prepare('SELECT carry_numerator,carry_denominator FROM account_interest').get() as {carry_numerator:string;carry_denominator:string};
  assert.deepEqual(parseFraction({numerator:rows.carry_numerator,denominator:rows.carry_denominator}),expected.carry);
  f.tick();const payouts=f.db.prepare('SELECT paid_atoms FROM interest_payouts ORDER BY tick_no').all() as Array<{paid_atoms:string}>;assert.equal(payouts[1]?.paid_atoms,'0');
});

test('paused reads freeze active cash interest and resume recovery excludes the entire pause',t=>{
  const f=fixture(t);f.open();f.clock.advanceBy(100000);
  const before=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(before.kind,'PORTFOLIO');
  if(before.kind!=='PORTFOLIO') throw new Error('portfolio failed');
  f.db.prepare("UPDATE markets SET state='PAUSED' WHERE market_id=?").run(f.marketId);
  const checkpoint=f.db.prepare('SELECT checkpoint_at,remaining_ms FROM market_settings').get();
  f.clock.advanceBy(3600000);
  for(let query=0;query<3;query++) {
    const paused=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(paused.kind,'PORTFOLIO');
    if(paused.kind==='PORTFOLIO') assert.equal(paused.portfolio.accruedCashInterest,before.portfolio.accruedCashInterest);
    f.market();assert.deepEqual(f.db.prepare('SELECT checkpoint_at,remaining_ms FROM market_settings').get(),checkpoint);
  }
  assert.deepEqual(f.broker.dispatch({type:'recover',now:f.clock.now()}),{kind:'RECOVERED'});
  assert.deepEqual(f.db.prepare('SELECT checkpoint_at,remaining_ms FROM market_settings').get(),checkpoint);
  // Operator recovery, after the pause's underlying cause has been resolved.
  f.db.prepare("UPDATE markets SET state='OPEN' WHERE market_id=?").run(f.marketId);
  assert.deepEqual(f.broker.dispatch({type:'recover',now:f.clock.now()}),{kind:'RECOVERED'});
  const recovered=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(recovered.kind,'PORTFOLIO');
  if(recovered.kind==='PORTFOLIO') assert.equal(recovered.portfolio.accruedCashInterest,before.portfolio.accruedCashInterest);
  f.tick(200000);
  const rate=(f.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE tick_no=0').get() as {daily_cash_rate:string}).daily_cash_rate;
  const expected=settleTickCashInterest(accumulateCashInterest(fraction(0n),parseMoney('10000'),rate,300000));
  assert.equal((f.db.prepare('SELECT paid_atoms FROM interest_payouts').get() as {paid_atoms:string}).paid_atoms,expected.money.toString());
});

test('an integrity pause captures its instant after the failed command checkpoint rolls back',t=>{
  const f=fixture(t);f.open();f.clock.advanceBy(100000);
  f.db.prepare("UPDATE account_interest SET accrued_numerator='10000'").run();
  assert.deepEqual(f.broker.dispatch({type:'portfolio',context:f.context()}),{kind:'ERROR',code:'INTEGRITY_ERROR'});
  const market=f.market();assert.equal(market.state,'PAUSED');
  const checkpoint=f.db.prepare('SELECT checkpoint_at,remaining_ms FROM market_settings').get() as {checkpoint_at:string;remaining_ms:number};
  assert.equal(checkpoint.remaining_ms,200000);assert.equal(checkpoint.checkpoint_at,f.clock.now());
  f.clock.advanceBy(3600000);f.market();assert.deepEqual(f.db.prepare('SELECT checkpoint_at,remaining_ms FROM market_settings').get(),checkpoint);
});
