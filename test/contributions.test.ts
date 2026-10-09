import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import { BrokerRepository } from '../src/broker/repository.js';
import type { ServiceContext, ServiceResponse } from '../src/application/contracts.js';
import { FakeClock } from '../src/domain/clock.js';
import { openDatabase } from '../src/storage/database.js';
import { parseMoney } from '../src/domain/numeric.js';
import { migrateDatabase, migrationChecksum, migrations } from '../src/storage/migrations.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { ContributionRepository } from '../src/broker/contributions.js';

const guild='111111111111111111',user='222222222222222222',second='222222222222222223';
function fixture(t:TestContext,economic=false) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock('2026-10-03T11:00:00.000Z');
  const identityKey=randomBytes(32),economySeed=randomBytes(32);let broker=new BrokerRepository(db,clock,{identityKey,...(economic?{economySeed}:{})});let sequence=333333333333333333n;
  const context=(who=user):ServiceContext=>({guildId:guild,discordUserId:who,interactionId:(++sequence).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'});assert.equal(setup.kind,'SETUP');if(setup.kind!=='SETUP')throw new Error();const marketId=setup.market.marketId;
  const open=(who=user)=>{const r=broker.dispatch({type:'open',context:context(who),age14Plus:true,agreeTerms:true});assert.equal(r.kind,'ACCOUNT');if(r.kind!=='ACCOUNT')throw new Error();return r.account;};
  const tick=(count:number)=>{for(let i=0;i<count;i++){clock.advanceBy(300000);const r=broker.dispatch({type:'tick',now:clock.now()});assert.equal(r.kind,'TICKED',JSON.stringify(r));}};
  const portfolio=(who=user)=>{const r=broker.dispatch({type:'portfolio',context:context(who)});assert.equal(r.kind,'PORTFOLIO',JSON.stringify(r));if(r.kind!=='PORTFOLIO')throw new Error();return r.portfolio;};
  const performance=()=>{const r=broker.dispatch({type:'performance',context:context()});assert.equal(r.kind,'PERFORMANCE',JSON.stringify(r));if(r.kind!=='PERFORMANCE')throw new Error();return r.performance;};
  return {db,clock,context,open,tick,portfolio,performance,marketId,get broker(){return broker;},restart(){broker=new BrokerRepository(db,clock,{identityKey,...(economic?{economySeed}:{})});}};
}
function error(value:ServiceResponse,code:string){assert.deepEqual(value,{kind:'ERROR',code});}

test('recurring capital is automatic, balanced, account-age based and neutral in returns',t=>{
  const f=fixture(t);f.open();f.tick(10);f.open(second);f.tick(10);
  assert.equal(f.portfolio().contributions,'0');f.tick(1);
  const p=f.portfolio();assert.equal(p.account.cash,'11000');assert.equal(p.contributions,'1000');assert.equal(p.initialCapital,'10000');assert.equal(p.netInvestmentPnl,'0');assert.equal(p.totalReturnPct,'0');assert.equal(p.nextContributionTick,42);
  assert.equal(f.portfolio(second).contributions,'0');
  const report=f.performance();assert.equal(report.reconciled,true);assert.equal(report.totalReturnPct,'0');assert.equal(report.maxDrawdownPct,'0');assert.equal(report.previousTickChangePct,'0');
  assert.equal(report.baselines.cash.contributions,'1000');assert.equal(report.baselines.cash.totalReturnPct,'0');assert.equal(report.baselines.hold8.contributions,'1000');assert.equal(report.pm8.contributions,'0');
  const rows=f.db.prepare("SELECT account_delta_atoms,system_delta_atoms,system_account FROM cash_journal WHERE entry_type='CONTRIBUTION'").all() as {account_delta_atoms:string;system_delta_atoms:string;system_account:string}[];
  assert.equal(rows.length,1);assert.equal(BigInt(rows[0]!.account_delta_atoms)+BigInt(rows[0]!.system_delta_atoms),0n);assert.equal(rows[0]!.system_account,'EXTERNAL_CAPITAL');
  f.broker.dispatch({type:'tick',now:f.clock.now()});f.restart();assert.equal(f.portfolio().contributions,'1000');f.tick(10);assert.equal(f.portfolio(second).contributions,'1000');
  const history=f.broker.dispatch({type:'history',context:f.context()});assert.equal(history.kind,'HISTORY');if(history.kind==='HISTORY')assert.ok(history.entries?.some(e=>e.kind==='CONTRIBUTION'));
});

test('funding disable/re-enable has no backlog and retries cannot reset cadence',t=>{
  const f=fixture(t);f.open();f.tick(10);const ctx=f.context();const request={type:'funding' as const,context:ctx,enabled:false};assert.equal(f.broker.dispatch(request).kind,'FUNDING');
  f.tick(25);assert.equal(f.portfolio().contributions,'0');f.broker.dispatch({type:'funding',context:f.context(),enabled:true});f.tick(5);
  f.broker.dispatch(request);assert.equal(f.portfolio().nextContributionTick,56);f.tick(16);assert.equal(f.portfolio().contributions,'1000');
  error(f.broker.dispatch({type:'funding',context:f.context(second),enabled:false}),'ACCOUNT_NOT_FOUND');
  error(f.broker.dispatch({...request,context:{...ctx,discordUserId:second}}),'IDEMPOTENCY_CONFLICT');
});

test('percentage buys derive fee-aware quantity from unreserved cash and preserve generation checks',t=>{
  const f=fixture(t);f.open();
  const conditional=f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',quantity:'5',orderType:'LIMIT',conditionPrice:'900'});assert.equal(conditional.kind,'QUOTE');if(conditional.kind!=='QUOTE')throw new Error();assert.equal(f.broker.dispatch({type:'confirm',context:f.context(),token:conditional.quote.token}).kind,'ORDER_OPENED');
  const r=f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',budgetPercent:100});assert.equal(r.kind,'QUOTE');if(r.kind!=='QUOTE')throw new Error();assert.ok(Number(r.quote.total)<=5495.5);assert.equal(r.quote.quantity,'5.490009');
  error(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',budgetPercent:50,budget:'1000'}),'INVALID_INPUT');
  error(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'SELL',budgetPercent:100}),'INVALID_INPUT');
  error(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',budgetPercent:100,generation:2}),'LISTING_NOT_TRADABLE');
});

test('economic funding updates interest principal and leaves corporate state independent',t=>{
  const f=fixture(t,true);const a=f.open();f.tick(21);const p=f.portfolio();assert.equal(p.contributions,'1000');assert.ok(Number(p.netInvestmentPnl)>0);assert.ok(Number(p.totalReturnPct)<1);
  const principal=f.db.prepare('SELECT cash_atoms FROM account_interest WHERE account_id=?').get(a.accountId) as {cash_atoms:string};assert.equal(principal.cash_atoms,parseMoney(p.account.cash).toString());
  assert.equal(f.performance().reconciled,true);f.restart();f.tick(1);assert.equal(f.portfolio().contributions,'1000');
});

test('migration7 preserves v6 journals and adopts existing accounts at the current tick',t=>{
  const db=new Database(':memory:');t.after(()=>db.close());db.pragma('foreign_keys=ON');
  db.exec('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY CHECK(version>0),name TEXT NOT NULL,checksum TEXT NOT NULL CHECK(length(checksum)=64),applied_at TEXT NOT NULL) STRICT');
  for(const migration of migrations.slice(0,6)){db.exec(migration.sql);db.prepare('INSERT INTO schema_migrations VALUES(?,?,?,?)').run(migration.version,migration.name,migrationChecksum(migration),'2026-10-03T11:00:00.000Z');}
  const marketId=randomUUID(),accountId=randomUUID(),eventId=randomUUID();
  new FoundationRepository(db,new FakeClock('2026-10-03T11:00:00.000Z')).createMarket({marketId,guildId:guild,listings:createInitialListings()});
  db.prepare("UPDATE markets SET tick_no=87,market_version=87,sequence_no=1 WHERE market_id=?").run(marketId);
  db.prepare("INSERT INTO accounts(account_id,market_id,discord_user_id,status,account_version,created_at) VALUES(?,?,?,'ACTIVE',1,?)").run(accountId,marketId,user,'2026-10-03T11:00:00.000Z');
  db.prepare("INSERT INTO cash_journal(rowid,journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES(9,?,?,?,?,?,'INITIAL_GRANT','10000000000000000','-10000000000000000','INITIAL_CAPITAL','PAPERMARKET_POINT',0,0,1,'0.0.0','1.0.0',?,NULL)")
    .run(randomUUID(),eventId,eventId,marketId,accountId,'2026-10-03T11:00:00.000Z');
  const before=db.prepare('SELECT rowid,* FROM cash_journal ORDER BY rowid').all();
  migrateDatabase(db);assert.equal(db.pragma('user_version',{simple:true}),7);assert.deepEqual(db.prepare('SELECT rowid,* FROM cash_journal ORDER BY rowid').all(),before);
  const plan=new ContributionRepository(db).view({marketId,accountId,discordUserId:user},87);assert.equal(plan.startTick,87);assert.equal(plan.nextContributionTick,108);assert.equal(plan.contributions,'0');
  assert.equal(new FoundationRepository(db).replayAccount({marketId,discordUserId:user}).cashAtoms,10000000000000000n);
  assert.throws(()=>db.exec("UPDATE cash_journal SET account_delta_atoms='1'"),/append-only/);
});

test('a partial funding write rolls back the whole boundary and a closed account never receives funding',t=>{
  const f=fixture(t);f.open();f.open(second);f.tick(20);assert.equal(f.broker.dispatch({type:'close',context:f.context(second),confirmed:true}).kind,'CLOSED');
  f.db.exec("CREATE TRIGGER synthetic_contribution_failure BEFORE INSERT ON contribution_valuations BEGIN SELECT RAISE(ABORT,'synthetic funding interruption'); END");
  f.clock.advanceBy(300000);assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'ERROR');
  assert.equal((f.db.prepare('SELECT tick_no FROM markets WHERE market_id=?').get(f.marketId) as {tick_no:number}).tick_no,20);
  assert.equal((f.db.prepare("SELECT count(*) n FROM cash_journal WHERE entry_type='CONTRIBUTION'").get() as {n:number}).n,0);
  f.db.exec('DROP TRIGGER synthetic_contribution_failure');assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'TICKED');
  assert.equal((f.db.prepare("SELECT count(*) n FROM cash_journal WHERE entry_type='CONTRIBUTION'").get() as {n:number}).n,1);
  assert.equal(f.portfolio().contributions,'1000');
});
