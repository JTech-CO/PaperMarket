import {createHash} from 'node:crypto';
import {z} from 'zod';
import {TICK_INTERVAL_MILLISECONDS} from '../../domain/clock.js';
import {FinancialDecimal as D,moneyToString,parseRate,quantizeMoney,serializeFraction} from '../../domain/numeric.js';
import {annualEffectiveRateForDays} from '../../domain/rates.js';
import {advanceEconomy,createEconomyState,validateEconomyState} from '../../economy/engine.js';
import {canonicalEconomyJson} from '../../economy/repository.js';
import {createPublicEconomy,publishEconomy,publicCorporateActionSchema,publicDividendSchema,validatePublicEconomy,type PublicEconomy} from '../../economy/public.js';
import type {CorporateAction,CorporateDividend,EconomyState} from '../../economy/types.js';
import {INITIAL_COMPANIES} from '../../fixtures/initial-companies.js';
import {createMarketState,priceMarket,pricingStateSchema,type PricingState} from '../../market/pricing.js';
import {valueCompanies} from '../../market/valuation.js';
import {advanceBenchmarkState,benchmarkEquity,validateBenchmarkState,type BenchmarkFrame} from '../../reporting/benchmarks.js';
import {MODEL_VALIDATION_VERSION,modelRandoms,type ModelPlan,type SeedDefinition} from './plans.js';
import {STRATEGIES,executeStrategy,initialStrategies,openingStrategyDrawdownPct,type StrategyAccount} from './strategies.js';
import {modelReturnRowSchema,summarizeStatistics,type ModelStatistics} from './statistics.js';
import {canonicalModelJson} from './encoding.js';

export interface SeedFailure {attemptedTick:number;phase:string;code:string}
export interface SeedRun {
  validationVersion:typeof MODEL_VALIDATION_VERSION;planHash:string;seed:SeedDefinition;targetTicks:number;status:'IN_PROGRESS'|'COMPLETE'|'FAILED';
  economy:EconomyState;public:PublicEconomy;pricing:PricingState;accounts:StrategyAccount[];knownDividends:CorporateDividend[];
  statistics:ModelStatistics;history:Record<string,number[]>;lastActions:CorporateAction[];chainHash:string;failure:SeedFailure|null;
  financialChecks:{balancedJournalEntries:number;corporateBalanceTicks:number;exactAccountTransitions:number};
}
const digest=(value:unknown)=>createHash('sha256').update(canonicalModelJson(value)).digest('hex');
export function modelFrame(state:Pick<SeedRun,'public'|'pricing'|'knownDividends'|'lastActions'>):BenchmarkFrame {
  const annualRate=D.max(0,new D(state.public.observedMacro.policyRate).minus('0.005')).toString();
  return {tick:state.public.tickNo,version:state.public.tickNo,engineTick:state.public.tickNo,
    hash:digest({public:state.public,pricing:state.pricing}),annualRate,dailyRate:annualEffectiveRateForDays(parseRate(annualRate),1),
    prices:new Map(state.pricing.companies.map(c=>[c.listingId,c.price])),actions:state.lastActions,dividends:state.knownDividends};
}
export function createSeedRun(plan:ModelPlan,definition:SeedDefinition):SeedRun {
  if(!plan.seeds.some(s=>s.id===definition.id&&s.marketId===definition.marketId&&s.partition===definition.partition))throw new Error('MODEL_SEED_NOT_PREREGISTERED');
  const economy=createEconomyState(definition.marketId);const publicState=createPublicEconomy(INITIAL_COMPANIES,0,definition.marketId);const pricing=createMarketState(publicState);
  const base={public:publicState,pricing,knownDividends:[] as CorporateDividend[],lastActions:[] as CorporateAction[]};
  const accounts=initialStrategies(modelFrame(base));
  const statistics:ModelStatistics={returns:[],limitHits:0,ordinaryPrices:0,liquidations:0,replacements:0,dividendCoverage:[],pendingDeclarations:[],
    initialValueGaps:Object.fromEntries(valueCompanies(publicState).map(v=>[v.symbol,new D(v.continuationValuePerShare).div(1000).minus(1).toString()]))};
  const state:SeedRun={validationVersion:MODEL_VALIDATION_VERSION,planHash:plan.hash,seed:definition,targetTicks:plan.ticksPerSeed,status:'IN_PROGRESS',
    economy,...base,accounts,statistics,history:{},chainHash:'',failure:null,financialChecks:{balancedJournalEntries:0,corporateBalanceTicks:0,exactAccountTransitions:0}};
  state.chainHash=digest({planHash:plan.hash,seed:definition,economy,frame:modelFrame(state).hash,accounts});return state;
}
export function advanceModelTick(prior:SeedRun):SeedRun {
  if(prior.status!=='IN_PROGRESS')throw new Error('MODEL_TERMINAL_SEED');
  const tick=prior.economy.tickNo+1;const randoms=modelRandoms(prior.seed);let phase='ECONOMY';
  try {
    const advanced=advanceEconomy(prior.economy,tick,randoms.economy,prior.public);
    for(const entry of advanced.corporateEntries) {
      const dr=entry.lines.filter(l=>l.side==='DR').reduce((s,l)=>s+BigInt(l.amountAtoms),0n);
      const cr=entry.lines.filter(l=>l.side==='CR').reduce((s,l)=>s+BigInt(l.amountAtoms),0n);
      if(dr!==cr)throw new Error('MODEL_UNBALANCED_CORPORATE_JOURNAL');
    }
    phase='PUBLICATION';const published=publishEconomy(prior.public,advanced.publications,tick,advanced.actions);
    phase='PRICING';const priced=priceMarket(published.state,prior.pricing,randoms.economy,advanced.actions);
    // Match the production repository's transaction failure; never substitute a price or retry a new seed.
    if(priced.prices.some(p=>new D(p.price).isZero()))throw new Error('ZERO_CORPORATE_REFERENCE');
    const known=new Map(prior.knownDividends.map(d=>[d.id,d]));
    for(const action of advanced.actions) {
      if('dividend' in action)known.set(action.dividend.id,action.dividend);
      if(action.kind==='LIQUIDATION_STARTED')for(const [id,dividend] of known)if(dividend.listingId===action.listingId)known.set(id,{...dividend,recoveryRatio:action.dividendRecoveryRatio});
      if(action.kind==='LIQUIDATION_SETTLED')for(const recovered of action.dividendRecoveries) {
        const dividend=known.get(recovered.dividendId);if(dividend)known.set(dividend.id,{...dividend,status:'SETTLED',remainingPayableAtoms:'0',paidAtoms:recovered.paidAtoms,recoveryRatio:recovered.recoveryRatio});
      }
    }
    for(const company of published.state.companies)for(const d of company.dividends)known.set(d.id,d);
    // Settled obligations with no account claim are no longer needed by the next exact transition.
    const claimed=new Set(prior.accounts.flatMap(a=>a.state.rights.map(r=>r.id)));
    const knownDividends=[...known.values()].filter(d=>d.remainingPayableAtoms!=='0'||claimed.has(d.id)||d.payTick>=tick);
    const frame=modelFrame({public:published.state,pricing:priced.state,knownDividends,lastActions:[...advanced.actions]});
    const previous=modelFrame(prior);const history:Record<string,number[]>={};
    const values:Record<string,number>={};const limitListings:string[]=[];let ordinaryPrices=0,limitHits=0;
    for(const contribution of priced.contributions) {
      const company=published.state.companies.find(c=>c.listingId===contribution.listingId)!;
      if(contribution.priceMode==='REPLACEMENT'||!prior.pricing.companies.some(c=>c.listingId===company.listingId))continue;
      const value=new D(contribution.actualReturn).toNumber();if(!Number.isFinite(value))throw new Error('MODEL_NONFINITE_RETURN');
      values[company.baseSymbol]=value;history[company.listingId]=[...(prior.history[company.listingId]??[]),value].slice(-21);
      if((contribution.priceMode??'ORDINARY')==='ORDINARY') {
        ordinaryPrices++;if(contribution.wasClipped) {limitHits++;if(value>0)limitListings.push(company.listingId);}
      }
    }
    phase='ACCOUNT_SETTLEMENT';const accounts=prior.accounts.map(account=>{
      const settled={...account,state:advanceBenchmarkState(account.state,previous,frame,TICK_INTERVAL_MILLISECONDS)};
      const traded=executeStrategy(settled,{public:published.state,frame,history,earnings:published.publications.filter(p=>p.kind==='EARNINGS'),limitListings},randoms.strategy);
      const exact=benchmarkEquity(traded.state,frame);const points=new D(exact.numerator.toString()).div(exact.denominator.toString());
      if(points.lt(0))throw new Error('MODEL_NEGATIVE_EQUITY');const peak=D.max(traded.peak,points);const drawdown=peak.isZero()?new D(0):peak.minus(points).div(peak).mul(100);
      return {...traded,peak:peak.toString(),maxDrawdownPct:D.max(traded.maxDrawdownPct,drawdown).toString()};
    });
    phase='STATISTICS';const declarations=[...prior.statistics.pendingDeclarations,...advanced.actions.flatMap(a=>a.kind==='DIVIDEND_DECLARED'?[{id:a.dividend.id,issuerId:a.issuerId,tick:a.effectiveTick,atoms:a.dividend.totalNominalAtoms}]:[])];
    const coverage:string[]=[];const pending:ModelStatistics['pendingDeclarations']=[];
    for(const declaration of declarations) {
      const company=published.state.companies.find(c=>c.issuerId===declaration.issuerId);
      const report=company?.reports.find(r=>r.kind==='ACTUAL'&&r.publishTick===declaration.tick&&r.publishTick<=tick);
      if(!report) {pending.push(declaration);continue;}
      const reports=company!.reports.filter(r=>r.publishTick<=declaration.tick).slice(-4);
      const normalized=reports.reduce((sum,r)=>{const pretax=BigInt(r.pretaxProfitAtoms)-BigInt(r.oneOffProfitAtoms);return sum+pretax-(pretax>0n?pretax/5n:0n);},0n)/BigInt(reports.length);
      if(normalized<=0n)throw new Error('MODEL_DIVIDEND_WITHOUT_RECURRING_COVERAGE');
      coverage.push(new D(declaration.atoms).div(normalized.toString()).toString());
    }
    const statistics:ModelStatistics={...prior.statistics,limitHits:prior.statistics.limitHits+limitHits,ordinaryPrices:prior.statistics.ordinaryPrices+ordinaryPrices,
      liquidations:prior.statistics.liquidations+advanced.actions.filter(a=>a.kind==='LIQUIDATION_STARTED').length,
      replacements:prior.statistics.replacements+advanced.actions.filter(a=>a.kind==='REPLACEMENT').length,pendingDeclarations:pending,
      // Arrays append only after every financial/statistical check and chain hash succeeds.
      returns:prior.statistics.returns,dividendCoverage:prior.statistics.dividendCoverage};
    const chainHash=digest({previous:prior.chainHash,engine:digest(advanced.state),frame:frame.hash,accounts,
      statisticsDelta:{tick,values,ordinaryPrices,limitHits,coverage,actions:advanced.actions.map(a=>[a.id,a.kind])}});
    const next:SeedRun={...prior,economy:advanced.state,public:published.state,pricing:priced.state,knownDividends,lastActions:[...advanced.actions],accounts,history,statistics,chainHash,
      status:tick===prior.targetTicks?'COMPLETE':'IN_PROGRESS',financialChecks:{balancedJournalEntries:prior.financialChecks.balancedJournalEntries+advanced.corporateEntries.length,
        corporateBalanceTicks:prior.financialChecks.corporateBalanceTicks+1,exactAccountTransitions:prior.financialChecks.exactAccountTransitions+accounts.length}};
    statistics.returns.push({tick,values});statistics.dividendCoverage.push(...coverage);return next;
  } catch(error) {
    const message=error instanceof Error?error.message:'UNKNOWN_MODEL_ERROR';
    return {...prior,status:'FAILED',failure:{attemptedTick:tick,phase,code:message.slice(0,500)}};
  }
}
const count=z.number().int().min(0).max(1000000000);const nonnegative=z.string().max(96).refine(v=>{try{return new D(v).isFinite()&&new D(v).gte(0);}catch{return false;}});
const statisticsSchema=z.strictObject({returns:z.array(modelReturnRowSchema).max(100000),
  limitHits:count,ordinaryPrices:count,liquidations:count,replacements:count,dividendCoverage:z.array(nonnegative).max(100000),
  pendingDeclarations:z.array(z.strictObject({id:z.string().max(256),issuerId:z.string().max(256),tick:count,atoms:z.string().regex(/^\d+$/).max(51)})).max(4096),
  initialValueGaps:z.record(z.enum(['HGI','DNL','TLR','NXC','VTR','AUR','LMB','RVI']),z.string().max(96))});
const seedSchema=z.strictObject({id:z.string().regex(/^[ch]\d{3}$/),partition:z.enum(['CALIBRATION','HOLDOUT']),marketId:z.string().max(256)});
const runSchema=z.strictObject({validationVersion:z.literal(MODEL_VALIDATION_VERSION),planHash:z.string().regex(/^[0-9a-f]{64}$/),seed:seedSchema,targetTicks:count,
  status:z.enum(['IN_PROGRESS','COMPLETE','FAILED']),economy:z.unknown(),public:z.unknown(),pricing:z.unknown(),accounts:z.array(z.strictObject({id:z.string().max(64),state:z.unknown(),peak:nonnegative,maxDrawdownPct:nonnegative,trades:count,targetListing:z.string().max(256).nullable()})).length(17),
  knownDividends:z.array(publicDividendSchema).max(4096),statistics:statisticsSchema,history:z.record(z.string().max(256),z.array(z.number().finite().min(-1).max(1)).max(21)),lastActions:z.array(publicCorporateActionSchema).max(256),
  chainHash:z.string().regex(/^[0-9a-f]{64}$/),failure:z.strictObject({attemptedTick:count,phase:z.string().max(64),code:z.string().max(500)}).nullable(),
  financialChecks:z.strictObject({balancedJournalEntries:count,corporateBalanceTicks:count,exactAccountTransitions:count})});
export function validateSeedRun(input:unknown,plan:ModelPlan,definition:SeedDefinition):SeedRun {
  const parsed=runSchema.parse(input);const economy=validateEconomyState(parsed.economy);const publicState=validatePublicEconomy(parsed.public);const pricing=pricingStateSchema.parse(parsed.pricing);
  if(parsed.planHash!==plan.hash||parsed.targetTicks!==plan.ticksPerSeed||canonicalEconomyJson(parsed.seed)!==canonicalEconomyJson(definition)
    ||economy.marketId!==definition.marketId||publicState.marketId!==definition.marketId||economy.tickNo!==publicState.tickNo||pricing.tickNo!==economy.tickNo||economy.tickNo>plan.ticksPerSeed
    ||parsed.statistics.returns.length!==economy.tickNo||parsed.statistics.returns.some((r,i)=>r.tick!==i+1)||parsed.accounts.some((a,i)=>a.id!==STRATEGIES[i])
    ||parsed.financialChecks.corporateBalanceTicks!==economy.tickNo||parsed.financialChecks.exactAccountTransitions!==economy.tickNo*17
    ||(parsed.status==='COMPLETE')!==(economy.tickNo===plan.ticksPerSeed)||((parsed.status==='FAILED')!==(parsed.failure!==null))
    ||(parsed.failure&&parsed.failure.attemptedTick!==economy.tickNo+1)||parsed.statistics.limitHits>parsed.statistics.ordinaryPrices)throw new Error('MODEL_CHECKPOINT_IDENTITY');
  for(const company of publicState.companies)if(!economy.companies.some(c=>c.issuerId===company.issuerId&&c.listingId===company.listingId)
    ||!pricing.companies.some(c=>c.issuerId===company.issuerId&&c.listingId===company.listingId))throw new Error('MODEL_CHECKPOINT_IDENTITY');
  const run:SeedRun={...parsed,economy,public:publicState,pricing,accounts:parsed.accounts.map(a=>({...a,state:validateBenchmarkState(a.state)})),knownDividends:parsed.knownDividends as CorporateDividend[],lastActions:parsed.lastActions as CorporateAction[]};
  const frame=modelFrame(run);for(const account of run.accounts)benchmarkEquity(account.state,frame);return run;
}
export function summarizeSeed(run:SeedRun) {
  const frame=modelFrame(run);const strategies=run.accounts.map(a=>{
    const exact=benchmarkEquity(a.state,frame);const value=new D(exact.numerator.toString()).div(exact.denominator.toString());
    return {id:a.id,equity:moneyToString(quantizeMoney(exact,'floor').money),exactEquity:serializeFraction(exact),returnRatio:value.div(10000).minus(1).toString(),
      feesAtoms:a.state.feesAtoms,interestAtoms:a.state.interestAtoms,dividendAtoms:a.state.dividendAtoms,liquidationAtoms:a.state.liquidationAtoms,
      cashAtoms:a.state.cashAtoms,positions:a.state.positions.length,rights:a.state.rights.length,trades:a.trades,maxDrawdownPct:D.max(a.maxDrawdownPct,openingStrategyDrawdownPct(a.id)).toString()};
  });
  return {seed:run.seed,status:run.status,targetTicks:run.targetTicks,completedTicks:run.economy.tickNo,failure:run.failure,chainHash:run.chainHash,
    financialChecks:run.financialChecks,statistics:summarizeStatistics(run.statistics),strategies,
    cashVersusHold8ReturnGap:new D(strategies.find(s=>s.id==='HOLD8')!.returnRatio).minus(strategies.find(s=>s.id==='CASH')!.returnRatio).toString()};
}
