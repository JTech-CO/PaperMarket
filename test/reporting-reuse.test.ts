import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { BrokerRepository } from '../src/broker/repository.js';
import type { MarketView, ServiceContext, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { FakeClock } from '../src/domain/clock.js';
import { migrateDatabase } from '../src/storage/migrations.js';
import { LedgerIntegrityError } from '../src/storage/replay.js';
import { ReportingRepository } from '../src/reporting/repository.js';
import { ReportingBenchmarks } from '../src/reporting/benchmarks.js';
import { publicEconomySchema } from '../src/economy/public.js';
import { EconomyRepository } from '../src/economy/repository.js';

function kind<K extends ServiceResponse['kind']>(response:ServiceResponse,expected:K):Extract<ServiceResponse,{kind:K}> {
  assert.equal(response.kind,expected,JSON.stringify(response));return response as Extract<ServiceResponse,{kind:K}>;
}
function fixture(t:TestContext,ticks=3) {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateDatabase(db);t.after(()=>db.close());
  const clock=new FakeClock('2026-10-05T01:00:00.000Z');
  const broker=new BrokerRepository(db,clock,{identityKey:randomBytes(32),economySeed:Buffer.from('public-reuse-regression-seed-16'.repeat(2))});
  let next=333333333333333333n;
  const guild='111111111111111111',users=['222222222222222221','222222222222222222','222222222222222223'];
  const context=(user=users[0]!):ServiceContext=>({guildId:guild,discordUserId:user,interactionId:(++next).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=kind(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}),'SETUP');
  const owners=users.map(user=>{
    const account=kind(broker.dispatch({type:'open',context:context(user),age14Plus:true,agreeTerms:true}),'ACCOUNT').account;
    return {marketId:setup.market.marketId,accountId:account.accountId,discordUserId:user};
  });
  for(let index=0;index<ticks;index++){clock.advanceBy(300000);kind(broker.dispatch({type:'tick',now:clock.now()}),'TICKED');}
  const market=():MarketView=>{const response=broker.dispatch({type:'market',context:context()});assert.equal(response.kind,'MARKET');if(response.kind!=='MARKET')throw new Error();return response.market;};
  return {db,broker,clock,owners,context,market,reporting:new ReportingRepository(db,new ReportingBenchmarks(db))};
}

test('public snapshot validation is reused for exact immutable bytes while response objects stay independent',t=>{
  const f=fixture(t,1),market=f.market(),parse=t.mock.method(publicEconomySchema,'parse');
  const stock=f.reporting.company(market,'HGI');const original=stock.financial!.cash;
  Object.assign(stock.financial!,{cash:'0'});
  assert.equal(f.reporting.company(market,'HGI').financial!.cash,original);
  f.reporting.news(market);assert.equal(parse.mock.callCount(),1);
  f.reporting.chart(market,'HGI',undefined,'PRICE','LINEAR',10);
  const afterHistory=parse.mock.callCount();assert.equal(afterHistory,2);
  f.reporting.chart(market,'HGI',undefined,'PRICE','LINEAR',10);assert.equal(parse.mock.callCount(),afterHistory);
});

test('changed public raw JSON with the formerly valid claimed digest never reuses a cached projection',t=>{
  const f=fixture(t,1),market=f.market();f.reporting.company(market,'HGI');
  const row=f.db.prepare('SELECT snapshot_json FROM economy_snapshots WHERE market_id=? AND tick_no=1').get(market.marketId) as {snapshot_json:string};
  const raw=JSON.parse(row.snapshot_json) as {public:{companies:Array<{name:string}>}};raw.public.companies[0]!.name+=' altered';
  f.db.exec('DROP TRIGGER economy_snapshots_no_update');
  f.db.prepare('UPDATE economy_snapshots SET snapshot_json=? WHERE market_id=? AND tick_no=1').run(JSON.stringify(raw),market.marketId);
  assert.throws(()=>f.reporting.company(market,'HGI'),LedgerIntegrityError);
});

test('completed owner sample chains skip public frame decoding and remain owner checked',t=>{
  const f=fixture(t),before=f.db.prepare('SELECT * FROM performance_samples ORDER BY account_id,tick_no').all();
  const parse=t.mock.method(publicEconomySchema,'parse');
  for(const owner of f.owners)f.reporting.backfill(owner,3);
  assert.equal(parse.mock.callCount(),0);assert.deepEqual(f.db.prepare('SELECT * FROM performance_samples ORDER BY account_id,tick_no').all(),before);
  assert.throws(()=>f.reporting.backfill({...f.owners[0]!,discordUserId:f.owners[1]!.discordUserId},3),LedgerIntegrityError);
});

test('completed sample fast path still rejects a changed historical sample with its old chain digest',t=>{
  const f=fixture(t),owner=f.owners[0]!;
  f.db.exec('DROP TRIGGER performance_samples_no_update');
  f.db.prepare("UPDATE performance_samples SET equity_atoms='0' WHERE market_id=? AND account_id=? AND tick_no=0").run(owner.marketId,owner.accountId);
  assert.throws(()=>f.reporting.backfill(owner,3),LedgerIntegrityError);
});

test('real missing tail intervals are reconstructed exactly and shared public frames decode once',t=>{
  const f=fixture(t),owners=f.owners.slice(0,2);
  const original=new Map((f.db.prepare('SELECT account_id,equity_atoms FROM performance_samples WHERE tick_no=2').all() as Array<{account_id:string;equity_atoms:string}>).map(row=>[row.account_id,row.equity_atoms]));
  f.db.exec('DROP TRIGGER performance_samples_no_delete');
  f.db.prepare('DELETE FROM performance_samples WHERE tick_no=2 AND account_id IN (?,?)').run(owners[0]!.accountId,owners[1]!.accountId);
  const parse=t.mock.method(publicEconomySchema,'parse');
  f.reporting.backfill(owners[0]!,3);const parsedOnce=parse.mock.callCount();assert.equal(parsedOnce,4);
  f.reporting.backfill(owners[1]!,3);assert.equal(parse.mock.callCount(),parsedOnce);
  for(const owner of owners) {
    const rebuilt=f.db.prepare('SELECT equity_atoms,source FROM performance_samples WHERE market_id=? AND account_id=? AND tick_no=2').get(owner.marketId,owner.accountId) as {equity_atoms:string;source:string};
    assert.equal(rebuilt.equity_atoms,original.get(owner.accountId));assert.equal(rebuilt.source,'HISTORICAL_TICK_END');
    const response=f.broker.dispatch({type:'performance',context:f.context(owner.discordUserId)} as ServiceRequest);
    assert.equal(kind(response,'PERFORMANCE').performance.missingHistory,false);
  }
});

test('broker public market projection loads and validates one shared economic snapshot per command',t=>{
  const f=fixture(t,1),load=t.mock.method(EconomyRepository.prototype,'load');
  f.market();assert.equal(load.mock.callCount(),1);
  const first=kind(f.broker.dispatch({type:'company',symbol:'HGI',context:f.context()}),'STOCK');
  assert.equal(load.mock.callCount(),2);assert.equal(first.stock.listing.symbol,'HGI');
});
