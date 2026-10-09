import assert from 'node:assert/strict';
import test, {type TestContext} from 'node:test';
import type {ChartView,MarketView} from '../src/application/contracts.js';
import {FakeClock} from '../src/domain/clock.js';
import {dividendRightMark} from '../src/domain/corporate-rights.js';
import {FinancialDecimal as D,MONEY_SCALE,addFractions,decimalFraction,fraction,parseMoney,parsePrice,parseRate,quantizeMoney} from '../src/domain/numeric.js';
import {canonicalEconomyJson,economySnapshotHash} from '../src/economy/repository.js';
import {createPublicEconomy,publishEconomy,validatePublicEconomy} from '../src/economy/public.js';
import type {CorporateAction,CorporateDividend} from '../src/economy/types.js';
import {createInitialListings,INITIAL_COMPANIES} from '../src/fixtures/initial-companies.js';
import {createMarketState} from '../src/market/pricing.js';
import {ReportingBenchmarks} from '../src/reporting/benchmarks.js';
import {ReportingRepository} from '../src/reporting/repository.js';
import {openDatabase} from '../src/storage/database.js';
import {FoundationRepository} from '../src/storage/repository.js';

const marketId='chart_financial_market';const original=INITIAL_COMPANIES[0]!;
const replacement:Extract<CorporateAction,{kind:'REPLACEMENT'}>={id:'chart_replacement',kind:'REPLACEMENT',effectiveTick:2,issuerId:original.issuerId,
  listingId:original.listingId,symbol:original.symbol,baseSymbol:'HGI',generation:2,createdTick:2,newIssuerId:'chart_hgi_2',newListingId:'chart_hgi_listing_2',
  newSymbol:'HGI2',newName:'Chart replacement',issuedShares:original.issuedShares};
function dividend(dps='15'):CorporateDividend {
  const nominal=(parseMoney(dps)*BigInt(original.issuedShares)).toString();
  return {id:'chart_dividend',issuerId:original.issuerId,listingId:original.listingId,declaredTick:1,exTick:4,payTick:6,status:'DECLARED',issuedShares:original.issuedShares,
    totalNominalAtoms:nominal,dps,remainingPayableAtoms:nominal,recoveryRatio:'1',paidAtoms:'0'};
}
function divAction(kind:'DIVIDEND_DECLARED'|'DIVIDEND_EX'|'DIVIDEND_PAYMENT'|'DIVIDEND_IMPAIRED',tick:number,d=dividend()):CorporateAction {
  return {id:`chart_${kind}_${tick}`,kind,effectiveTick:tick,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,dividend:d};
}
function liquidation(tick=2,recovery='200',dividendRecoveryRatio='0.4'):CorporateAction {
  return {id:'chart_liquidation',kind:'LIQUIDATION_STARTED',effectiveTick:tick,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,
    liquidationId:'chart_liq',settlementTick:23,estimatedRecoveryPerShare:recovery,dividendRecoveryRatio};
}
function final(commonPaidAtoms:string,eligibleShares=original.issuedShares,dividendRecoveries:Extract<CorporateAction,{kind:'LIQUIDATION_SETTLED'}>['dividendRecoveries']=[]):CorporateAction {
  return {id:'chart_final',kind:'LIQUIDATION_SETTLED',effectiveTick:23,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,
    liquidationId:'chart_liq',realizedRecoveryPerShare:commonPaidAtoms==='0'?'0':'0.00000097',commonPaidAtoms,eligibleShares,dividendRecoveries};
}
function fixture(t:TestContext) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock('2026-10-09T00:00:00.000Z');
  new FoundationRepository(db,clock).createMarket({marketId,guildId:'111111111111111111',listings:createInitialListings()});
  const reporting=new ReportingRepository(db,new ReportingBenchmarks(db));let publicState=createPublicEconomy(INITIAL_COMPANIES,0,marketId);
  let currentTick=0;const priceByListing=new Map(createInitialListings().map(l=>[l.listingId,'1000']));
  function market():MarketView {
    return {marketId,state:'OPEN',tickNo:currentTick,marketVersion:currentTick,sequenceNo:currentTick,nextBoundaryAt:clock.now(),updatedAt:clock.now(),priceSource:'ECONOMY',
      channelId:'444444444444444444',boardMessageId:null,listings:[]};
  }
  function frame(tick:number,actions:CorporateAction[]=[],price='1000',policyRate='0.03') {
    clock.advanceBy(300000);currentTick=tick;
    publicState=publishEconomy(publicState,[],tick,actions).state;
    publicState=validatePublicEconomy({...publicState,observedMacro:{...publicState.observedMacro,policyRate}});
    for(const action of actions) {
      if(action.kind==='REPLACEMENT') {
        db.prepare("UPDATE listings SET status='LIQUIDATING',price='0' WHERE market_id=? AND listing_id=?").run(marketId,original.listingId);
        db.prepare('INSERT INTO issuers(market_id,issuer_id,category) VALUES(?,?,?)').run(marketId,action.newIssuerId,original.category);
        db.prepare("INSERT INTO listings(market_id,listing_id,issuer_id,slot_id,category,symbol,price,status,created_at) VALUES(?,?,?,?,?,?,?,'ACTIVE',?)")
          .run(marketId,action.newListingId,action.newIssuerId,original.slotId,original.category,action.newSymbol,'1000',clock.now());
        priceByListing.delete(original.listingId);priceByListing.set(action.newListingId,'1000');
      }
      if(action.kind==='LIQUIDATION_SETTLED')db.prepare("UPDATE listings SET status='EXTINGUISHED' WHERE market_id=? AND listing_id=?").run(marketId,original.listingId);
    }
    const active=publicState.companies.find(c=>c.baseSymbol==='HGI')!;priceByListing.set(active.listingId,price);
    const pricingBase=createMarketState(publicState);
    const pricing={...pricingBase,companies:pricingBase.companies.map(c=>({...c,price:parsePrice(priceByListing.get(c.listingId)!),
      continuationMark:parseRate(new D(priceByListing.get(c.listingId)!).minus(c.attachedRightsMark).toString())}))};
    const snapshot={engineVersion:'0.4.0',economy:{privateMarker:'must never appear in chart'},public:publicState,pricing};
    db.prepare('UPDATE markets SET tick_no=?,market_version=? WHERE market_id=?').run(tick,tick,marketId);
    db.prepare('INSERT INTO economy_snapshots(market_id,tick_no,engine_tick,market_version,engine_version,snapshot_json,snapshot_hash,boundary_at,committed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(marketId,tick,tick,tick,'0.4.0',canonicalEconomyJson(snapshot),economySnapshotHash(snapshot),clock.now(),clock.now());
    for(const action of actions)db.prepare('INSERT INTO corporate_actions(market_id,action_id,tick_no,action_json) VALUES(?,?,?,?)').run(marketId,action.id,tick,JSON.stringify(action));
    return snapshot;
  }
  const chart=(series:'PRICE'|'TOTAL_RETURN'='TOTAL_RETURN',symbol='HGI',limit=2000)=>reporting.chart(market(),symbol,undefined,series,'LINEAR',limit);
  const valueAt=(chart:ChartView,tick:number)=>chart.points.find(p=>p.tickNo===tick)!.value;
  return {db,reporting,clock,frame,chart,market,valueAt};
}

test('one-share total value uses production claim discounting at EX and cash substitution at payment',t=>{
  const f=fixture(t);const d=dividend();f.frame(0);f.frame(1,[divAction('DIVIDEND_DECLARED',1,d)]);
  f.frame(2);f.frame(3);f.frame(4,[divAction('DIVIDEND_EX',4,{...d,status:'EX_ENTITLED'})],'985');
  const mark=dividendRightMark('15','1','0.025',2);
  assert.equal(parseMoney(f.valueAt(f.chart(),4)),quantizeMoney(addFractions(decimalFraction('985'),decimalFraction(mark)),'floor').money);
  assert.equal(f.valueAt(f.chart('PRICE'),4),'985');assert.deepEqual(f.chart().annotations,[{tickNo:4,label:'EX'}]);
  f.frame(5,[],'985');f.frame(6,[divAction('DIVIDEND_PAYMENT',6,{...d,status:'PAID',paidAtoms:d.totalNominalAtoms,remainingPayableAtoms:'0'})],'985');
  f.frame(7,[],'985','0.10');assert.equal(f.valueAt(f.chart(),6),'1000');assert.equal(f.valueAt(f.chart(),7),'1000');
  assert.ok(!JSON.stringify(f.chart()).includes('privateMarker'));assert.equal(f.chart().points[0]!.tickNo,0);
});

test('retirement retains declared pre-EX dividends and their changing discount marks after replacement',t=>{
  const f=fixture(t);const d=dividend();f.frame(0);f.frame(1,[divAction('DIVIDEND_DECLARED',1,d)]);
  f.frame(2,[liquidation(),replacement],'1000');
  const expected=quantizeMoney(addFractions(decimalFraction('200'),decimalFraction(dividendRightMark('15','0.4','0.025',4))),'floor').money;
  assert.equal(parseMoney(f.valueAt(f.chart(),2)),expected);
  f.frame(3,[],'1400','0.05');assert.equal(parseMoney(f.valueAt(f.chart(),3)),quantizeMoney(addFractions(decimalFraction('200'),decimalFraction(dividendRightMark('15','0.4','0.045',3))),'floor').money);
  f.frame(4,[divAction('DIVIDEND_EX',4,{...d,status:'IMPAIRED',recoveryRatio:'0.4'})],'1800','0.05');
  f.frame(6,[divAction('DIVIDEND_PAYMENT',6,{...d,status:'SETTLED',recoveryRatio:'0.4',paidAtoms:(parseMoney('6')*BigInt(d.issuedShares)).toString(),remainingPayableAtoms:'0'})],'1900');
  assert.equal(f.valueAt(f.chart(),6),'206');f.frame(23,[final('0')],'2000');f.frame(24,[],'2500');
  assert.equal(f.chart().points.at(-1)!.value,'6');assert.equal(f.chart().points.at(-1)!.tickNo,23);
  const raw=f.chart('PRICE');assert.deepEqual(raw.points.map(p=>[p.tickNo,p.value]),[[0,'1000'],[1,'1000'],[2,'0']]);
  assert.deepEqual(raw.annotations,[{tickNo:2,label:'청산'}]);assert.ok(f.chart().annotations.some(a=>a.label==='종료'));
  const next=f.chart('PRICE','HGI2');assert.equal(next.generation,2);assert.equal(next.points[0]!.tickNo,2);assert.equal(next.points.at(-1)!.value,'2500');
});

test('final liquidation uses exact cash atoms and recovers retired dividend nominal basis without a free successor',t=>{
  const f=fixture(t);const d=dividend();f.frame(0);f.frame(1,[divAction('DIVIDEND_DECLARED',1,d)]);
  f.frame(2,[liquidation(),replacement]);f.frame(4,[divAction('DIVIDEND_EX',4,{...d,status:'IMPAIRED',recoveryRatio:'0.4'})]);
  const common=parseMoney('0.97').toString();const dividendPaid=(parseMoney('6')*BigInt(d.issuedShares)).toString();
  f.frame(23,[final(common,'1000003',[{dividendId:d.id,recoveryRatio:'0.4',paidAtoms:dividendPaid}])],'6000');
  const exact=addFractions(fraction(BigInt(common),MONEY_SCALE*1000003n),fraction(BigInt(dividendPaid),MONEY_SCALE*BigInt(d.issuedShares)));
  assert.equal(parseMoney(f.chart().points.at(-1)!.value),quantizeMoney(exact,'floor').money);
  assert.equal(f.chart().points.at(-1)!.value,'6.000000969997');
  assert.notEqual(f.chart().points.at(-1)!.value,'6.00000097');
  assert.deepEqual(f.chart('PRICE').points.at(-1),{tickNo:2,at:f.chart('PRICE').points.at(-1)!.at,value:'0'});
});

test('zero recovery ends total value at zero and never connects to replacement observations',t=>{
  const f=fixture(t);f.frame(0);f.frame(2,[liquidation(2,'0','0'),replacement]);f.frame(23,[final('0')]);f.frame(24,[],'9000');
  assert.equal(f.chart().points.at(-1)!.value,'0');assert.equal(f.chart().points.at(-1)!.tickNo,23);
  assert.equal(f.chart('PRICE').points.at(-1)!.tickNo,2);assert.equal(f.chart('PRICE','HGI2').points.at(-1)!.value,'9000');
});

test('STATIC_TRIAL emits original creation and committed observations only, including before an economy epoch',t=>{
  const f=fixture(t);assert.deepEqual(f.chart().points.map(p=>[p.tickNo,p.value]),[[0,'1000']]);
  for(const tick of [1,2])f.db.prepare('INSERT INTO trial_ticks(market_id,tick_no,market_version,sequence_no,boundary_at,committed_at) VALUES(?,?,?,?,?,?)')
    .run(marketId,tick,tick,tick,f.clock.now(),f.clock.now());
  const trialMarket={...f.market(),tickNo:2,marketVersion:2,priceSource:'TRIAL' as const};
  assert.deepEqual(f.reporting.chart(trialMarket,'HGI',undefined,'PRICE','LINEAR',2000).points.map(p=>[p.tickNo,p.value]),[[0,'1000'],[1,'1000'],[2,'1000']]);
  f.frame(3,[],'1050');assert.deepEqual(f.chart().points.map(p=>[p.tickNo,p.value]),[[0,'1000'],[1,'1000'],[2,'1000'],[3,'1050']]);
  assert.deepEqual(f.chart('PRICE','HGI',2).points.map(p=>p.tickNo),[2,3]);
});

test('original snapshot hash and action agreement are validated before public chart output',t=>{
  const f=fixture(t);f.frame(0);f.frame(1,[divAction('DIVIDEND_DECLARED',1)]);
  const before=f.db.prepare('SELECT snapshot_json,snapshot_hash FROM economy_snapshots ORDER BY tick_no').all();f.chart();
  assert.deepEqual(f.db.prepare('SELECT snapshot_json,snapshot_hash FROM economy_snapshots ORDER BY tick_no').all(),before);
  f.db.exec('DROP TRIGGER economy_snapshots_no_update');f.db.prepare('UPDATE economy_snapshots SET snapshot_hash=? WHERE market_id=? AND tick_no=?').run('0'.repeat(64),marketId,0);
  assert.throws(()=>f.chart(),/snapshot hash/);
});

test('tampered corporate action fails against its committed public snapshot',t=>{
  const f=fixture(t);f.frame(0);f.frame(1,[divAction('DIVIDEND_DECLARED',1)]);
  f.db.exec('DROP TRIGGER corporate_actions_no_update');
  const changed=divAction('DIVIDEND_DECLARED',1,dividend('20'));
  f.db.prepare('UPDATE corporate_actions SET action_json=? WHERE market_id=? AND action_id=?').run(JSON.stringify(changed),marketId,changed.id);
  assert.throws(()=>f.chart(),/action differs/);
});
