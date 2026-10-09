import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test, {type TestContext} from 'node:test';
import Database from 'better-sqlite3';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { FinancialDecimal as D,parseMoney } from '../src/domain/numeric.js';
import { capitalReturnFactor, linkCapitalFlows } from '../src/domain/capital.js';
import type { ServiceContext, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { migrateDatabase } from '../src/storage/migrations.js';
import { csvCell, ReportingRepository } from '../src/reporting/repository.js';
import { ReportingBenchmarks } from '../src/reporting/benchmarks.js';
const guild='111111111111111111',user='222222222222222222',other='222222222222222223',channel='444444444444444444';
function fixture(t:TestContext,economic=true) {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');migrateDatabase(db);t.after(()=>db.close());
  const clock=new FakeClock('2026-10-05T01:00:00.000Z');const options={identityKey:randomBytes(32),...(economic?{economySeed:Buffer.from('reporting-test-seed-17'.repeat(2))}:{})};
  let broker=new BrokerRepository(db,clock,options);let id=333333333333333333n;
  const context=(uid=user):ServiceContext=>({guildId:guild,discordUserId:uid,interactionId:(++id).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId:channel});assert.equal(setup.kind,'SETUP');
  const open=broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true});assert.equal(open.kind,'ACCOUNT');if(open.kind!=='ACCOUNT')throw new Error();
  const execute=(request:Omit<Extract<ServiceRequest,{context:ServiceContext}>,'context'>,uid=user)=>broker.dispatch({...request,context:context(uid)} as ServiceRequest);
  const tick=()=>{clock.advanceBy(300000);const response=broker.dispatch({type:'tick',now:clock.now()});assert.equal(response.kind,'TICKED',JSON.stringify(response));if(response.kind==='TICKED')assert.equal(response.markets[0]?.state,'OPEN');return response;};
  const trade=(side:'BUY'|'SELL',quantity='1')=>{const q=execute({type:'quote',symbol:'HGI',side,quantity} as never);assert.equal(q.kind,'QUOTE',JSON.stringify(q));if(q.kind!=='QUOTE')throw new Error();const fill=execute({type:'confirm',token:q.quote.token} as never);assert.equal(fill.kind,'FILLED',JSON.stringify(fill));return fill;};
  return {db,clock,context,execute,tick,trade,accountId:open.account.accountId,get broker(){return broker;},reopen(){broker=new BrokerRepository(db,clock,options);}};
}
function kind<K extends ServiceResponse['kind']>(r:ServiceResponse,k:K):Extract<ServiceResponse,{kind:K}>{assert.equal(r.kind,k,JSON.stringify(r));return r as Extract<ServiceResponse,{kind:K}>;}

test('owner performance reconciles buy fees, sale cost and time-weighted cash interest',t=>{
  const f=fixture(t);f.trade('BUY','2');f.clock.advanceBy(150000);f.trade('SELL','1');f.tick();
  const p=kind(f.execute({type:'performance'}),'PERFORMANCE').performance;
  const sums=[p.realizedPnl,p.unrealizedPnl,p.dividends,p.cashInterest,p.liquidation,p.otherRightsPnl,p.rounding].reduce((s,v)=>s+parseMoney(v),0n);
  assert.equal(sums,parseMoney(p.equity)-parseMoney('10000'));assert.equal(p.reconciled,true);assert.equal(p.missingHistory,false);assert.ok(new D(p.fees).gt(0));assert.ok(new D(p.cashInterest).gt(0));
});
test('MDD series is immutable tick-end sampling and reads do not append samples',t=>{
  const f=fixture(t);f.trade('BUY');f.tick();const before=f.db.prepare('SELECT * FROM performance_samples').all();
  const first=kind(f.execute({type:'performance'}),'PERFORMANCE').performance;f.execute({type:'performance'});f.execute({type:'chart',symbol:'HGI'} as never);
  assert.deepEqual(f.db.prepare('SELECT * FROM performance_samples').all(),before);assert.ok(new D(first.maxDrawdownPct).gte(0));assert.match(first.drawdownDefinition,/틱 말/);
  assert.throws(()=>f.db.prepare("UPDATE performance_samples SET equity_atoms='0'").run(),/append-only/);
  f.reopen();assert.deepEqual(f.db.prepare('SELECT * FROM performance_samples').all(),before);
});
test('public company/calendar/news and actual charts work without an account',t=>{
  const f=fixture(t);f.tick();const stock=kind(f.execute({type:'company',symbol:'hgi'} as never,other),'STOCK').stock;
  assert.equal(stock.listing.symbol,'HGI');assert.equal(stock.financial?.reportKind,'SYNTHETIC_INITIALIZATION');
  const chart=kind(f.execute({type:'chart',symbol:'HGI',series:'PRICE',scale:'LOG'} as never,other),'CHART').chart;
  assert.deepEqual(chart.points.map(p=>p.tickNo),[0,1]);assert.ok(chart.points.every(p=>Object.keys(p).join(',')==='tickNo,at,value'));
  assert.ok(kind(f.execute({type:'calendar'},other),'CALENDAR').calendar.items.every(i=>i.eventTick>=0));
  kind(f.execute({type:'news'},other),'NEWS');assert.equal(f.execute({type:'performance'},other).kind,'ERROR');
});
test('no view or owner export exposes seed, nonce, identity linkage or sealed future state',t=>{
  const f=fixture(t);f.trade('BUY');f.tick();
  for(const request of [{type:'performance'},{type:'company',symbol:'HGI'},{type:'chart',symbol:'HGI'},{type:'calendar'},{type:'news'},{type:'export',format:'JSON'}]) {
    const response=f.execute(request as never);assert.notEqual(response.kind,'ERROR',JSON.stringify(response));const text=JSON.stringify(response);
    for(const secret of ['reporting-test-seed-17','snapshot_json','actor_hash','identity_key','eventRuntime','privateLedger','token','seed_check'])assert.ok(!text.includes(secret),secret);
  }
});
test('CSV formula escaping covers control-leading formulas and all quoted text',()=>{
  for(const text of ['=SUM(1,2)','  +1','\t@evil','\r-2','\n=1'])assert.ok(csvCell(text).startsWith('"\''));
  assert.equal(csvCell('quoted"value'), '"quoted""value"');
});
test('export is private, paged and includes real fills/dividends/interest instead of arbitrary database dumps',t=>{
  const f=fixture(t);f.trade('BUY');f.tick();
  const csv=kind(f.execute({type:'export',format:'CSV'} as never),'EXPORT').export;assert.equal(csv.files.length,8);assert.ok(csv.files.every(file=>file.content.startsWith('\ufeff')));
  const json=kind(f.execute({type:'export',format:'JSON'} as never),'EXPORT').export;const parsed=JSON.parse(json.files[0]!.content);assert.equal(parsed.account.accountId,f.accountId);assert.ok(parsed.history.some((e:{kind:string})=>e.kind==='FILL'));assert.ok(parsed.history.some((e:{kind:string})=>e.kind==='INTEREST'));
  assert.deepEqual(f.execute({type:'export',format:'JSON'} as never,other),{kind:'ERROR',code:'ACCOUNT_NOT_FOUND'});
});
test('company generation is validated before accepting a trading modal quote',t=>{
  const f=fixture(t);assert.deepEqual(f.execute({type:'quote',symbol:'HGI',generation:2,side:'BUY',quantity:'1'} as never),{kind:'ERROR',code:'LISTING_NOT_TRADABLE'});
  assert.deepEqual(f.execute({type:'company',symbol:'HGI',generation:2} as never),{kind:'ERROR',code:'LISTING_NOT_TRADABLE'});
});
test('private alerts default to inbox, explicit consent enables DM and closing purges projections',t=>{
  const f=fixture(t);const initial=kind(f.execute({type:'alerts'}),'ALERTS').alerts;assert.equal(initial.dmEnabled,false);
  f.execute({type:'alerts',symbol:'HGI',watch:true} as never);f.execute({type:'alerts',dmEnabled:true} as never);f.execute({type:'alerts',symbol:'HGI',direction:'ABOVE',threshold:'1100'} as never);
  assert.equal((f.db.prepare('SELECT count(*) n FROM notification_preferences').get() as {n:number}).n,1);
  const closed=kind(f.execute({type:'close',confirmed:true} as never),'CLOSED');assert.equal(closed.accountId,f.accountId);
  const counts=f.db.prepare('SELECT (SELECT count(*) FROM notification_preferences) prefs,(SELECT count(*) FROM watched_listings) watches,(SELECT count(*) FROM price_alerts) alerts,(SELECT count(*) FROM notification_inbox) inbox,(SELECT count(*) FROM notification_outbox) outbox,(SELECT count(*) FROM notification_seen) seen').get() as Record<string,number>;
  assert.ok(Object.values(counts).every(n=>n===0));
  assert.deepEqual(f.execute({type:'performance'}),{kind:'ERROR',code:'ACCOUNT_CLOSED'});
});
test('immediately triggered conditional fills atomically enter private inbox and outbox without repeat economic effects',t=>{
  const f=fixture(t);f.execute({type:'alerts',dmEnabled:true} as never);
  const q=kind(f.execute({type:'quote',symbol:'HGI',side:'BUY',quantity:'1',orderType:'LIMIT',conditionPrice:'1100'} as never),'QUOTE');
  const request={type:'confirm',context:f.context(),token:q.quote.token} as const;kind(f.broker.dispatch(request),'FILLED');
  const effects=f.db.prepare('SELECT * FROM cash_journal').all();const inbox=kind(f.execute({type:'alerts',markRead:false} as never),'ALERTS').alerts.inbox.items;
  assert.equal(inbox.filter(n=>n.kind==='SCHEDULED_FILLED').length,1);
  kind(f.broker.dispatch(request),'FILLED');assert.deepEqual(f.db.prepare('SELECT * FROM cash_journal').all(),effects);
  const batch=kind(f.broker.dispatch({type:'notification-poll',now:f.clock.now()}),'NOTIFICATION_BATCH');assert.equal(batch.deliveries.length,1);
  const delivery=batch.deliveries[0]!;kind(f.broker.dispatch({type:'notification-ack',now:f.clock.now(),jobId:delivery.jobId,leaseToken:delivery.leaseToken,delivered:false}),'NOTIFICATION_ACK');assert.deepEqual(f.db.prepare('SELECT * FROM cash_journal').all(),effects);
});
test('bounded input rejects oversize export/chart and forged notification targets',t=>{
  const f=fixture(t);for(const request of [{type:'chart',symbol:'HGI',limit:2001},{type:'export',format:'JSON',limit:1001},{type:'alerts',discordUserId:other},{type:'notification-poll',now:f.clock.now(),discordUserId:other},{type:'alerts',dmEnabled:true,symbol:'HGI',watch:true}])assert.equal(f.broker.dispatch({...request,...('now'in request?{}:{context:f.context()})} as ServiceRequest).kind,'ERROR');
});
test('trial markets retain static actual observations and CASH without invented economic history',t=>{
  const f=fixture(t,false);f.trade('BUY');f.tick();const p=kind(f.execute({type:'performance'}),'PERFORMANCE').performance;assert.equal(p.cashInterest,'0');assert.equal(p.baselines.cash.equity,'10000');assert.equal(p.reconciled,true);
  const chart=kind(f.execute({type:'chart',symbol:'HGI'} as never),'CHART').chart;assert.deepEqual(chart.points.map(p=>p.tickNo),[0,1]);assert.ok(chart.points.every(p=>p.value==='1000'));
});

test('history cursor traverses more than one page of same-sequence payouts without losing or repeating events',t=>{
  const f=fixture(t,false);
  const insert=f.db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) SELECT ?,?,'rounding_fixture',market_id,account_id,'ROUNDING','0','0','ROUNDING',currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,NULL FROM cash_journal WHERE market_id=(SELECT market_id FROM accounts WHERE account_id=?) AND account_id=? AND entry_type='INITIAL_GRANT'");
  for(let i=0;i<8;i++)insert.run(`history_fixture_journal_${i}`,`history_fixture_event_${i}`,f.accountId,f.accountId);
  const market=f.db.prepare('SELECT market_id FROM accounts WHERE account_id=?').get(f.accountId) as {market_id:string};
  const reporting=new ReportingRepository(f.db,new ReportingBenchmarks(f.db));
  const owner={marketId:market.market_id,accountId:f.accountId,discordUserId:user};
  const ids:string[]=[];let sequence:number|undefined;let event:string|undefined;
  for(let page=0;page<3;page++){
    const result=reporting.history(owner,4,sequence,event);ids.push(...result.entries.map(entry=>entry.eventId));
    sequence=result.nextBeforeSequence??undefined;event=result.nextBeforeEventId??undefined;
    if(sequence===undefined)break;
  }
  assert.equal(ids.length,9);assert.equal(new Set(ids).size,9);
  assert.throws(()=>reporting.history(owner,4,0,'another_owner_event'),/INVALID_CURSOR/);
});

test('linked returns remove external funding at its exact boundary and preserve losses across contributions',()=>{
  const linked=linkCapitalFlows('10000',[
    {eventId:'first',tickNo:21,sequenceNo:22,beforeEquity:'8000',amount:'1000'},
    {eventId:'second',tickNo:42,sequenceNo:43,beforeEquity:'9900',amount:'1000'},
  ]);
  assert.equal(capitalReturnFactor('10000','8000',linked,20),'0.8');
  assert.equal(capitalReturnFactor('10000','9000',linked,21),'0.8');
  assert.equal(capitalReturnFactor('10000','9900',linked,41),'0.88');
  assert.equal(capitalReturnFactor('10000','10900',linked,42),'0.88');
  assert.equal(capitalReturnFactor('10000','11990',linked,43),'0.968');
  assert.equal(capitalReturnFactor('10000','10100',[],5),'1.01');
  const exhausted=linkCapitalFlows('10000',[{eventId:'new_funding',tickNo:21,sequenceNo:22,beforeEquity:'0',amount:'1000'}]);
  assert.equal(capitalReturnFactor('10000','1100',exhausted,22),'0');
  assert.throws(()=>linkCapitalFlows('10000',[{eventId:'negative',tickNo:21,sequenceNo:22,beforeEquity:'10000',amount:'-1'}]),/checkpoint/);
});

test('real contributions stay external to profit, sampled drawdown, history and owner exports',t=>{
  const f=fixture(t,false);f.trade('BUY');
  for(let tick=0;tick<21;tick++)f.tick();
  const first=kind(f.execute({type:'performance'}),'PERFORMANCE').performance;
  assert.equal(first.equity,'10999');assert.equal(first.initialCapital,'10000');assert.equal(first.contributions,'1000');assert.equal(first.netInvestmentPnl,'-1');
  assert.equal(first.totalReturnPct,'-0.01');assert.equal(first.previousTickChangePct,'0');assert.equal(first.maxDrawdownPct,'0.01');assert.equal(first.nextContributionTick,42);assert.equal(first.reconciled,true);
  const sums=[first.realizedPnl,first.unrealizedPnl,first.dividends,first.cashInterest,first.liquidation,first.otherRightsPnl,first.rounding].reduce((sum,amount)=>sum+parseMoney(amount),0n);
  assert.equal(sums,parseMoney(first.netInvestmentPnl!));
  f.tick();const sampled=kind(f.execute({type:'performance'}),'PERFORMANCE').performance;
  assert.equal(sampled.maxDrawdownPct,first.maxDrawdownPct);assert.equal(sampled.totalReturnPct,first.totalReturnPct);
  f.reopen();assert.deepEqual(kind(f.execute({type:'performance'}),'PERFORMANCE').performance,sampled);
  const history=kind(f.execute({type:'history'}),'HISTORY').entries??[];
  assert.equal(history.filter(entry=>entry.kind==='CONTRIBUTION').length,1);assert.equal(history.find(entry=>entry.kind==='CONTRIBUTION')?.amount,'1000');
  const exported=kind(f.execute({type:'export',format:'JSON'} as never),'EXPORT').export;
  const payload=JSON.parse(exported.files[0]!.content) as {performance:{contributions:string;netInvestmentPnl:string};funding:{enabled:boolean;startTick:number;intervalTicks:number;amount:string;nextContributionTick:number};history:Array<{kind:string}>};
  assert.equal(payload.performance.contributions,'1000');assert.equal(payload.performance.netInvestmentPnl,'-1');assert.ok(payload.history.some(entry=>entry.kind==='CONTRIBUTION'));
  assert.deepEqual(payload.funding,{enabled:true,startTick:0,intervalTicks:21,amount:'1000',nextContributionTick:42});
  const csv=kind(f.execute({type:'export',format:'CSV'} as never),'EXPORT').export;
  assert.match(csv.files.find(file=>file.name==='account.csv')!.content,/"initial_capital","contributions","net_investment_pnl"/);
  assert.match(csv.files.find(file=>file.name==='account.csv')!.content,/"funding_enabled","funding_start_tick","funding_interval_ticks","funding_amount"/);
  assert.equal(f.execute({type:'performance'},other).kind,'ERROR');
  const owner=f.db.prepare('SELECT market_id FROM accounts WHERE account_id=?').get(f.accountId) as {market_id:string};
  const reporting=new ReportingRepository(f.db,new ReportingBenchmarks(f.db));
  assert.throws(()=>reporting.capitalPerformance({...owner,marketId:owner.market_id,accountId:f.accountId,discordUserId:other},'10999',22),/owner unavailable/);
  f.db.exec('DROP TRIGGER contribution_valuation_no_update');
  f.db.prepare('UPDATE contribution_valuations SET tick_no=22 WHERE account_id=?').run(f.accountId);
  assert.throws(()=>reporting.capitalPerformance({marketId:owner.market_id,accountId:f.accountId,discordUserId:user},'10999',22),/does not match its journal/);
});
