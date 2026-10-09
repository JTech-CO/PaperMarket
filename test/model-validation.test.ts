import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {basename,dirname,join,resolve} from 'node:path';
import test,{type TestContext} from 'node:test';
import {BrokerRepository} from '../src/broker/repository.js';
import {FakeClock} from '../src/domain/clock.js';
import {parseListingId} from '../src/domain/identifiers.js';
import {FinancialDecimal as D,MONEY_SCALE,addFractions,decimalFraction,fraction,parseMoney,parseOrderQuantity,parsePrice,parseFraction,serializeFraction} from '../src/domain/numeric.js';
import {STANDARD_RULESET} from '../src/domain/ruleset.js';
import {settleBuy,settleSell} from '../src/domain/settlement.js';
import {modelCommandOptions} from '../src/diagnostics/verify-model.js';
import {canonicalEconomyJson} from '../src/economy/repository.js';
import type {CorporateAction,CorporateDividend} from '../src/economy/types.js';
import {INITIAL_COMPANIES,createInitialListings} from '../src/fixtures/initial-companies.js';
import {advanceBenchmarkState,createBenchmarkState,type BenchmarkFrame} from '../src/reporting/benchmarks.js';
import {benchmarkEquity} from '../src/reporting/benchmarks.js';
import {openDatabase} from '../src/storage/database.js';
import {FoundationRepository} from '../src/storage/repository.js';
import {refreshModelReport,runModelBatch} from '../src/validation/model/batch.js';
import {canonicalModelJson} from '../src/validation/model/encoding.js';
import {DRIFT_SEEDS,PILOT_SEEDS,REFERENCE_SEEDS,modelMasterSeed,modelPlan,modelRandoms} from '../src/validation/model/plans.js';
import {advanceModelTick,createSeedRun,modelFrame,summarizeSeed,validateSeedRun} from '../src/validation/model/runner.js';
import {correlation,distribution,modelReturnRowSchema,summarizeStatistics} from '../src/validation/model/statistics.js';
import {STRATEGIES,buyTargets,executeStrategy,initialStrategies,strategyTarget} from '../src/validation/model/strategies.js';

function temporary(t:TestContext):string {
  const root=resolve('artifacts/milestone6');mkdirSync(root,{recursive:true});const directory=mkdtempSync(join(root,'.model-test-'));
  t.after(()=>{if(dirname(resolve(directory))!==root||!basename(directory).startsWith('.model-test-'))throw new Error('Unsafe test cleanup');rmSync(directory,{recursive:true,force:true});});return directory;
}
test('model presets preregister every calibration/holdout path and full drift scope',()=>{
  assert.equal(REFERENCE_SEEDS.length,200);assert.equal(REFERENCE_SEEDS.filter(s=>s.partition==='CALIBRATION').length,160);assert.equal(REFERENCE_SEEDS.filter(s=>s.partition==='HOLDOUT').length,40);
  assert.deepEqual(PILOT_SEEDS.map(s=>s.id),['c000','c001','h000','h001']);assert.deepEqual(DRIFT_SEEDS.map(s=>s.id),['c000','h000']);
  assert.equal(modelPlan('reference').ticksPerSeed,10000);assert.equal(modelPlan('drift').ticksPerSeed,100000);assert.equal(modelPlan('pilot').hash,modelPlan('pilot').hash);
  assert.equal(STRATEGIES.length,17);assert.equal(new Set(STRATEGIES).size,17);
  assert.throws(()=>modelCommandOptions(['--max-ticks-per-run','10001']));assert.throws(()=>modelCommandOptions(['--max-seconds','61']));
  assert.throws(()=>modelCommandOptions(['--preset','pilot','--preset','reference']));assert.throws(()=>modelCommandOptions(['--seed','best']));
});
test('full production engine and exact CASH/HOLD8 transitions match an actual SQLite branch',t=>{
  const plan=modelPlan('pilot');const definition=PILOT_SEEDS[0]!;let run=createSeedRun(plan,definition);
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock('2026-10-09T00:00:00.000Z');const guildId='111111111111111111';
  new FoundationRepository(db,clock).createMarket({marketId:definition.marketId,guildId,listings:createInitialListings()});
  const broker=new BrokerRepository(db,clock,{identityKey:Buffer.alloc(32,5),economySeed:modelMasterSeed(definition)});let id=333333333333333333n;
  const context=(discordUserId='222222222222222222')=>({guildId,discordUserId,interactionId:(++id).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  assert.equal(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind,'SETUP');
  const opened=broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true});assert.equal(opened.kind,'ACCOUNT');if(opened.kind!=='ACCOUNT')throw new Error('Account unavailable');
  // The preregistered model uses fixed initial capital. A second funded owner verifies that personal inflows do not change its market path.
  assert.equal(broker.dispatch({type:'funding',context:context(),enabled:false}).kind,'FUNDING');
  const fundedUser='222222222222222223';assert.equal(broker.dispatch({type:'open',context:context(fundedUser),age14Plus:true,agreeTerms:true}).kind,'ACCOUNT');
  const compare=()=>{
    const raw=db.prepare('SELECT snapshot_json FROM economy_snapshots WHERE market_id=? AND tick_no=?').get(definition.marketId,run.economy.tickNo) as {snapshot_json:string};
    const snapshot=JSON.parse(raw.snapshot_json) as {economy:unknown;public:unknown;pricing:unknown};
    assert.equal(canonicalEconomyJson(snapshot.economy),canonicalEconomyJson(run.economy));assert.equal(canonicalEconomyJson(snapshot.public),canonicalEconomyJson(run.public));
    assert.equal(canonicalEconomyJson(snapshot.pricing),canonicalEconomyJson(run.pricing));
    for(const kind of ['CASH','HOLD8']) {
      const stored=db.prepare('SELECT state_json FROM benchmark_snapshots WHERE market_id=? AND series_id=? AND tick_no=?').get(definition.marketId,`${kind}:${opened.account.accountId}`,run.economy.tickNo) as {state_json:string};
      assert.equal(stored.state_json,canonicalEconomyJson(run.accounts.find(a=>a.id===kind)!.state));
    }
  };
  compare();for(let tick=1;tick<=22;tick++) {clock.advanceBy(300000);const result=broker.dispatch({type:'tick',now:clock.now()});assert.equal(result.kind,'TICKED',JSON.stringify(result));run=advanceModelTick(run);assert.equal(run.status,'IN_PROGRESS');compare();}
  const funded=broker.dispatch({type:'portfolio',context:context(fundedUser)});assert.equal(funded.kind,'PORTFOLIO');if(funded.kind==='PORTFOLIO')assert.equal(funded.portfolio.contributions,'1000');
});
test('EX capture charges both real fees and sells only stock while preserving its exact entitlement',()=>{
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);const original=INITIAL_COMPANIES[0]!;
  const d:CorporateDividend={id:'model_test_dividend',issuerId:original.issuerId,listingId:original.listingId,declaredTick:0,exTick:3,payTick:5,status:'DECLARED',issuedShares:original.issuedShares,
    totalNominalAtoms:(parseMoney('15')*BigInt(original.issuedShares)).toString(),dps:'15',remainingPayableAtoms:(parseMoney('15')*BigInt(original.issuedShares)).toString(),recoveryRatio:'1',paidAtoms:'0'};
  const publicState={...run.public,tickNo:2,companies:run.public.companies.map(c=>c.listingId===original.listingId?{...c,dividends:[d]}:c)};
  const frame:BenchmarkFrame={...modelFrame(run),tick:2,engineTick:2,annualRate:'0',dailyRate:'0',dividends:[d]};
  let account=executeStrategy(run.accounts.find(a=>a.id==='EX_CAPTURE')!,{public:publicState,frame,history:{},earnings:[],limitListings:[]},modelRandoms(run.seed).strategy);
  assert.equal(account.state.positions.length,1);const quantity=account.state.positions[0]!.quantity;
  const action=(kind:'DIVIDEND_EX'|'DIVIDEND_PAYMENT',tick:number,dividend:CorporateDividend):CorporateAction=>({id:`model_${kind}`,kind,effectiveTick:tick,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,dividend});
  const prices=new Map(frame.prices);prices.set(original.listingId,'985');const ex={...frame,tick:3,engineTick:3,prices,actions:[action('DIVIDEND_EX',3,{...d,status:'EX_ENTITLED'})]};
  account={...account,state:advanceBenchmarkState(account.state,frame,ex,300000)};
  account=executeStrategy(account,{public:{...publicState,tickNo:3},frame:ex,history:{},earnings:[],limitListings:[]},modelRandoms(run.seed).strategy);
  assert.equal(account.state.positions.length,0);assert.equal(account.state.rights.length,1);assert.equal(account.trades,2);
  const pay={...ex,tick:5,engineTick:5,actions:[action('DIVIDEND_PAYMENT',5,{...d,status:'PAID',paidAtoms:d.totalNominalAtoms,remainingPayableAtoms:'0'})]};
  account={...account,state:advanceBenchmarkState(account.state,ex,pay,300000)};
  const buy=settleBuy(parsePrice('1000'),parseOrderQuantity(quantity),STANDARD_RULESET.tradeFeeRate);const sell=settleSell(parsePrice('985'),parseOrderQuantity(quantity),STANDARD_RULESET.tradeFeeRate);
  const dividend=parseMoney(new D(quantity).mul(15).toFixed(12));
  assert.equal(account.state.cashAtoms,(STANDARD_RULESET.initialCash-buy.money+sell.money+dividend).toString());assert.equal(account.state.rights.length,0);
  assert.ok(BigInt(account.state.feesAtoms)>0n);assert.ok(BigInt(account.state.cashAtoms)<STANDARD_RULESET.initialCash);
});
test('retired pre-EX ownership retains claims, exact liquidation fractions and no free replacement',()=>{
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);const original=INITIAL_COMPANIES[0]!;
  const dividend:CorporateDividend={id:'model_retired_div',issuerId:original.issuerId,listingId:original.listingId,declaredTick:0,exTick:3,payTick:5,status:'DECLARED',issuedShares:'3',totalNominalAtoms:'1',
    dps:new D(1).div(MONEY_SCALE.toString()).div(3).toString(),remainingPayableAtoms:'1',recoveryRatio:'1',paidAtoms:'0'};
  const state={...createBenchmarkState(),cashAtoms:'0',positions:[{listingId:parseListingId(original.listingId),quantity:parseOrderQuantity('0.000001'),costAtoms:'1000000000'}]};
  const before={...modelFrame(run),dailyRate:'0',annualRate:'0',dividends:[dividend]};
  const start:CorporateAction={id:'model_liq_start',kind:'LIQUIDATION_STARTED',effectiveTick:1,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,
    liquidationId:'model_liq',settlementTick:6,estimatedRecoveryPerShare:'200',dividendRecoveryRatio:'1'};
  const prices=new Map(before.prices);prices.delete(original.listingId);prices.set('hgi_listing_g2','1000');
  const retired={...before,tick:1,engineTick:1,prices,actions:[start]};const claims=advanceBenchmarkState(state,before,retired,300000);
  assert.equal(claims.positions.length,0);assert.equal(claims.rights.length,2);assert.equal(claims.rights.find(r=>r.kind==='DIVIDEND')!.attached,false);
  assert.equal(buyTargets(claims,retired,['hgi_listing_g2']).positions.length,0);assert.equal(buyTargets(claims,retired,['hgi_listing_g2']).cashAtoms,'0');
  const final:CorporateAction={id:'model_liq_final',kind:'LIQUIDATION_SETTLED',effectiveTick:6,issuerId:original.issuerId,listingId:original.listingId,symbol:original.symbol,
    liquidationId:'model_liq',realizedRecoveryPerShare:'0',commonPaidAtoms:'1',eligibleShares:'3',dividendRecoveries:[{dividendId:dividend.id,paidAtoms:'1',recoveryRatio:'1'}]};
  const settled=advanceBenchmarkState(claims,retired,{...retired,tick:6,engineTick:6,actions:[final]},300000);
  assert.equal(settled.positions.length,0);assert.equal(settled.cashAtoms,'0');assert.equal(settled.rights.length,0);
  const expected=fraction(1n,3n*MONEY_SCALE*1000000n);assert.deepEqual(parseFraction(settled.liquidationCarry),expected);assert.deepEqual(parseFraction(settled.dividendCarry),expected);
});
test('strategy signals use actual published fields and RNG channels are independent of economic draws',()=>{
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);const frame={...modelFrame(run),tick:21,engineTick:21};const company=run.public.companies[3]!;
  const facts={public:run.public,frame,history:{},earnings:[{id:'model_test_earnings',kind:'EARNINGS' as const,issuerId:company.issuerId,effectiveTick:20,publishedTick:21,
    actual:{revenueAtoms:'120'},expected:{revenueAtoms:'100'},previous:{revenueAtoms:'90'}}],limitListings:[]};const randoms=modelRandoms(run.seed);
  assert.equal(strategyTarget('EARNINGS_SURPRISE',facts,randoms.strategy),company.listingId);
  const first=advanceModelTick(createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!));
  for(let i=0;i<100;i++)strategyTarget('RANDOM',facts,randoms.strategy);
  const second=advanceModelTick(createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!));assert.equal(first.chainHash,second.chainHash);
  const history=Object.fromEntries(run.public.companies.map((c,i)=>[c.listingId,Array.from({length:i===0?20:21},()=>i/1000)]));
  assert.notEqual(strategyTarget('MOMENTUM',{...facts,history},randoms.strategy),run.public.companies[0]!.listingId);
});
test('failed economic path retains the last committed tick without substituting a price',()=>{
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);const broken={...run,pricing:{...run.pricing,tickNo:2 as typeof run.pricing.tickNo}};
  const frozen=canonicalModelJson(broken);const failed=advanceModelTick(broken);
  assert.equal(failed.status,'FAILED');assert.equal(failed.economy.tickNo,0);assert.equal(failed.failure?.attemptedTick,1);assert.equal(failed.failure?.phase,'PRICING');
  assert.equal(failed.failure?.code,'PRICE_TICK_SEQUENCE');assert.equal(canonicalModelJson(broken),frozen);assert.deepEqual(failed.accounts,run.accounts);
});
test('bounded checkpoint resumes the identical path and keeps all unstarted seed coverage',t=>{
  const directory=temporary(t);const options={preset:'pilot' as const,outputDirectory:directory,maxTicksPerRun:3,maxSeconds:60};
  let report=runModelBatch(options);assert.equal(report.scope.completedTicks,3);assert.equal(report.seeds.length,4);assert.equal(report.scope.notStartedSeeds,3);
  for(let i=0;i<4;i++)report=runModelBatch(options);
  assert.equal(report.scope.completedTicks,15);assert.equal(report.scope.completeSeeds,0);assert.equal(report.resources.executions,5);
  const entry=report.seeds.find(s=>s.seed.id==='c000')!;assert.equal(entry.completedTicks,6);
  let direct=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);for(let i=0;i<6;i++)direct=advanceModelTick(direct);
  assert.equal('chainHash' in entry?entry.chainHash:null,direct.chainHash);assert.equal(report.preregistration.reference.requestedTicks,2000000);
  assert.equal(report.preregistration.reference.execution,'NOT_RUN_BY_THIS_PRESET');assert.equal(report.status,'IN_PROGRESS');
});
test('checkpoint tampering, plan mismatch and non-finite statistics fail before reuse',t=>{
  const directory=temporary(t);runModelBatch({preset:'pilot',outputDirectory:directory,maxTicksPerRun:1,maxSeconds:60});
  const path=join(directory,'.model-checkpoints','pilot','index.json');const index=JSON.parse(readFileSync(path,'utf8')) as {index:{nextSeed:number}};
  index.index.nextSeed=3;writeFileSync(path,JSON.stringify(index));assert.throws(()=>runModelBatch({preset:'pilot',outputDirectory:directory,maxTicksPerRun:1,maxSeconds:60}),/MODEL_INDEX_HASH/);
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);assert.throws(()=>validateSeedRun({...run,planHash:'0'.repeat(64)},modelPlan('pilot'),PILOT_SEEDS[0]!));
  assert.throws(()=>canonicalModelJson({ratio:Infinity}));assert.deepEqual(serializeFraction(addFractions(decimalFraction('0.1'),decimalFraction('0.2'))),{numerator:'3',denominator:'10'});
  assert.equal(initialStrategies(modelFrame(run)).length,17);assert.equal(summarizeSeed(run).statistics.ordinaryPrices,0);
});
test('terminal failures remain in every seed result and their checkpoints are still verified',t=>{
  const directory=temporary(t);const plan=modelPlan('pilot');const checkpoints=join(directory,'.model-checkpoints','pilot');mkdirSync(checkpoints,{recursive:true});
  const digest=(value:unknown)=>createHash('sha256').update(canonicalModelJson(value)).digest('hex');
  // A failed transition persists its otherwise valid last committed state. These fixtures exercise that storage contract.
  const entries=plan.seeds.map(seed=>{
    const run={...createSeedRun(plan,seed),status:'FAILED' as const,failure:{attemptedTick:1,phase:'ECONOMY',code:'SYNTHETIC_TEST_FAILURE'}};
    const checkpointHash=digest(run);const checkpoint=`${seed.id}-${checkpointHash}.json`;
    writeFileSync(join(checkpoints,checkpoint),canonicalModelJson({hash:checkpointHash,run}));return {seedId:seed.id,checkpoint,checkpointHash,summary:summarizeSeed(run)};
  });
  const index={version:'model-validation-v1',planHash:plan.hash,nextSeed:0,entries,
    resources:{executions:0,wallSeconds:0,cpuUserSeconds:0,cpuSystemSeconds:0,maximumRssBytes:0,lastChunk:null}};
  writeFileSync(join(checkpoints,'index.json'),canonicalModelJson({hash:digest(index),index}));
  const result=runModelBatch({preset:'pilot',outputDirectory:directory,maxTicksPerRun:1,maxSeconds:60});
  assert.equal(result.status,'FAILED');assert.equal(result.scope.failedSeeds,4);assert.equal(result.scope.completedTicks,0);assert.equal(result.seeds.length,4);
  assert.equal(result.strategyReturns.CASH!.calibration.count,2);assert.equal(result.strategyReturns.CASH!.holdout.count,2);
  assert.ok(result.seeds.every(s=>s.failure?.code==='SYNTHETIC_TEST_FAILURE'));
  const path=join(checkpoints,entries[3]!.checkpoint);const stored=JSON.parse(readFileSync(path,'utf8')) as {run:{accounts:{state:{cashAtoms:string}}[]}};
  stored.run.accounts[0]!.state.cashAtoms='1';writeFileSync(path,JSON.stringify(stored));
  assert.throws(()=>runModelBatch({preset:'pilot',outputDirectory:directory,maxTicksPerRun:1,maxSeconds:60}),/MODEL_CHECKPOINT_HASH/);
});
test('model tail and correlation statistics retain exact zero/unavailable meanings',()=>{
  assert.equal(correlation([[1,1],[2,2]]),null);assert.equal(correlation([[1,1],[1,2],[1,3]]),null);assert.equal(correlation([[1,-1],[2,-2],[3,-3]]),-1);
  const values=distribution([-0.3,-0.1,0,0.1,0.3]);assert.equal(values.count,5);assert.equal(values.q01,-0.3);assert.equal(values.expectedShortfall05,-0.3);
  assert.equal(distribution([]).mean,null);
});
test('reported drawdown includes exact tick-zero opening fees without rewriting financial checkpoint state',()=>{
  const run=createSeedRun(modelPlan('pilot'),PILOT_SEEDS[0]!);const before=canonicalModelJson(run);const summary=summarizeSeed(run);
  const hold=run.accounts.find(a=>a.id==='HOLD8')!;const value=benchmarkEquity(hold.state,modelFrame(run));
  const expected=new D(10000).minus(new D(value.numerator.toString()).div(value.denominator.toString())).div(10000).mul(100).toString();
  assert.equal(summary.strategies.find(s=>s.id==='HOLD8')!.maxDrawdownPct,expected);assert.ok(new D(expected).gt(0));
  assert.equal(summary.strategies.find(s=>s.id==='CASH')!.maxDrawdownPct,'0');assert.equal(canonicalModelJson(run),before);
});
test('actual c000 RVI replacement discontinuity remains absent through schema, tails and lag statistics',()=>{
  // Real full-engine c000 drift-pilot ticks, projected to RVI/DNL. RVI generation 2 starts at tick 336.
  // Retained tick-393 checkpoint SHA256: 99ff105179a64c2b4a89da585aa83a2e525aa42b56c926c1a8dcf5cd2ed3a95e.
  const rows=[
    {tick:334,values:{RVI:-0.003988351148877788,DNL:0.0013425956257180083}},
    {tick:335,values:{RVI:0.011177849746596486,DNL:-0.004408434336552582}},
    {tick:336,values:{DNL:0.004571992712760464}},
    {tick:337,values:{RVI:-0.010176816709763573,DNL:-0.004180912066894172}},
    {tick:338,values:{RVI:0.001337785342852029,DNL:-0.005440455522828199}},
  ].map(row=>modelReturnRowSchema.parse(row));
  assert.equal(Object.hasOwn(rows[2]!.values,'RVI'),false);
  const result=summarizeStatistics({returns:rows,limitHits:0,ordinaryPrices:9,liquidations:1,replacements:1,dividendCoverage:[],pendingDeclarations:[],initialValueGaps:{RVI:'0',DNL:'0'}});
  assert.equal(result.perCompany.RVI!.distribution.count,4);assert.equal(result.perCompany.DNL!.distribution.count,5);
  assert.equal(result.perCompany.RVI!.lag1Autocorrelation,null);assert.equal(result.perCompany.RVI!.absoluteReturnClustering,null);
  assert.throws(()=>modelReturnRowSchema.parse({tick:336,values:{UNKNOWN:0}}));
});
test('explicit legacy recorder rebuild preserves the prior report and financial checkpoint, but rejects other summary changes',t=>{
  const directory=temporary(t);runModelBatch({preset:'pilot',outputDirectory:directory,maxTicksPerRun:1,maxSeconds:60});
  const indexPath=join(directory,'.model-checkpoints','pilot','index.json');
  const wrapper=JSON.parse(readFileSync(indexPath,'utf8')) as {hash:string;index:{recorderVersion?:string;entries:{checkpoint:string;summary:{strategies:{id:string;maxDrawdownPct:string;feesAtoms:string}[]} | null}[]}};
  const entry=wrapper.index.entries[0]!;const checkpointPath=join(directory,'.model-checkpoints','pilot',entry.checkpoint);const financialBefore=readFileSync(checkpointPath,'utf8');
  const saved=JSON.parse(financialBefore) as {run:{accounts:{id:string;maxDrawdownPct:string}[]}};
  for(const strategy of entry.summary!.strategies)strategy.maxDrawdownPct=saved.run.accounts.find(a=>a.id===strategy.id)!.maxDrawdownPct;
  delete wrapper.index.recorderVersion;wrapper.hash=createHash('sha256').update(canonicalModelJson(wrapper.index)).digest('hex');writeFileSync(indexPath,canonicalModelJson(wrapper));
  const reportPath=join(directory,'model-pilot.json');const legacy=JSON.parse(readFileSync(reportPath,'utf8')) as {versions:{drawdownRecorder?:string};seeds:unknown[]};
  delete legacy.versions.drawdownRecorder;legacy.seeds[0]=entry.summary;const legacyBytes=canonicalModelJson(legacy);writeFileSync(reportPath,legacyBytes);
  const rebuilt=refreshModelReport('pilot',directory);assert.equal(rebuilt.scope.completedTicks,1);assert.equal(rebuilt.summaryRefresh?.completedEngineTicks,0);
  assert.equal(readFileSync(checkpointPath,'utf8'),financialBefore);assert.equal(readFileSync(join(directory,rebuilt.recorderCorrectionProvenance!.sourceArtifact),'utf8'),legacyBytes);
  const current=JSON.parse(readFileSync(indexPath,'utf8')) as typeof wrapper;assert.equal(current.index.recorderVersion,'opening-equity-observation-v1');
  current.index.entries[0]!.summary!.strategies[0]!.feesAtoms='1';current.hash=createHash('sha256').update(canonicalModelJson(current.index)).digest('hex');writeFileSync(indexPath,canonicalModelJson(current));
  assert.throws(()=>refreshModelReport('pilot',directory),/MODEL_CHECKPOINT_SUMMARY/);
});
