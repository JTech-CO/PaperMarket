import {FinancialDecimal as D,MONEY_SCALE,decimalFraction,addFractions,multiplyFractions,fraction,moneyFromAtoms,parsePrice,parseOrderQuantity,quantizeMoney} from '../../domain/numeric.js';
import {STANDARD_RULESET} from '../../domain/ruleset.js';
import {maxAffordableQuantity,settleBuy} from '../../domain/settlement.js';
import {DeterministicRandom} from '../../domain/random.js';
import {parseEngineVersion,parseIssuerId,parseTickNo} from '../../domain/identifiers.js';
import {INITIAL_COMPANIES} from '../../fixtures/initial-companies.js';
import {benchmarkEquity,buyBenchmarkEqual,createBenchmarkState,sellBenchmarkAll,validateBenchmarkState,type BenchmarkFrame,type BenchmarkState} from '../../reporting/benchmarks.js';
import type {PublicEconomy} from '../../economy/public.js';
import type {PublicDisclosureRecord} from '../../economy/public.js';

export const STRATEGIES=Object.freeze(['CASH','HOLD8',...INITIAL_COMPANIES.map(c=>`CONCENTRATE_${c.symbol}`),'EX_CAPTURE','CHEAP','MOMENTUM','CONTRARIAN','RANDOM','EARNINGS_SURPRISE','LIMIT_FOLLOW'] as const);
export interface StrategyAccount {id:string;state:BenchmarkState;peak:string;maxDrawdownPct:string;trades:number;targetListing:string|null}
export interface StrategyFacts {public:PublicEconomy;frame:BenchmarkFrame;history:Readonly<Record<string,readonly number[]>>;earnings:readonly PublicDisclosureRecord[];limitListings:readonly string[]}
export function buyTargets(state:BenchmarkState,frame:BenchmarkFrame,listings:readonly string[]):BenchmarkState {
  if(!listings.length)return state;
  if(listings.length>8||new Set(listings).size!==listings.length)throw new Error('MODEL_INVALID_TARGETS');
  const result=structuredClone(state);const budget=BigInt(result.cashAtoms)/BigInt(listings.length);
  for(const listingId of [...listings].sort()) {
    const priceText=frame.prices.get(listingId);if(!priceText)throw new Error('MODEL_MISSING_TARGET_PRICE');const price=parsePrice(priceText);
    const unit=multiplyFractions(decimalFraction(price),addFractions(fraction(1n),decimalFraction(STANDARD_RULESET.tradeFeeRate)));
    if(budget*unit.denominator*1_000_000n<MONEY_SCALE*unit.numerator)continue;
    const quantity=maxAffordableQuantity(moneyFromAtoms(budget.toString()),price,STANDARD_RULESET.tradeFeeRate);const purchase=settleBuy(price,parseOrderQuantity(quantity),STANDARD_RULESET.tradeFeeRate);
    result.cashAtoms=moneyFromAtoms((BigInt(result.cashAtoms)-purchase.money).toString()).toString();
    result.feesAtoms=moneyFromAtoms((BigInt(result.feesAtoms)+quantizeMoney(purchase.fee,'floor').money).toString()).toString();
    result.positions.push({listingId:listingId as BenchmarkState['positions'][number]['listingId'],quantity,costAtoms:purchase.money.toString()});
  }
  return validateBenchmarkState(result);
}
export function initialStrategies(frame:BenchmarkFrame):StrategyAccount[] {
  return STRATEGIES.map(id=>{
    let state=createBenchmarkState();
    if(id==='HOLD8')state=buyBenchmarkEqual(state,frame.prices);
    else if(id.startsWith('CONCENTRATE_'))state=buyTargets(state,frame,[INITIAL_COMPANIES.find(c=>`CONCENTRATE_${c.symbol}`===id)!.listingId]);
    return {id,state,peak:'10000',maxDrawdownPct:'0',trades:state.positions.length,targetListing:null};
  });
}
/** The actual model opening is a 10000 grant followed by tick-zero buys at the prescribed 1000 price. */
export function openingStrategyDrawdownPct(id:string):string {
  if(!STRATEGIES.includes(id))throw new Error('MODEL_UNKNOWN_STRATEGY');
  const prices=new Map(INITIAL_COMPANIES.map(c=>[c.listingId,STANDARD_RULESET.initialPrice]));let state=createBenchmarkState();
  const frame:BenchmarkFrame={tick:0,version:0,engineTick:0,hash:'',prices,dailyRate:'0',annualRate:'0',actions:[],dividends:[]};
  if(id==='HOLD8')state=buyBenchmarkEqual(state,prices);
  else if(id.startsWith('CONCENTRATE_'))state=buyTargets(state,frame,[INITIAL_COMPANIES.find(c=>`CONCENTRATE_${c.symbol}`===id)!.listingId]);
  const value=benchmarkEquity(state,frame);const equity=new D(value.numerator.toString()).div(value.denominator.toString());
  return D.max(0,new D(10000).minus(equity)).div(10000).mul(100).toString();
}
/** Decisions read only committed public frames. Counter RNG uses a separate key and channel. */
export function strategyTarget(id:string,facts:StrategyFacts,random:DeterministicRandom):string|null|undefined {
  const {public:publicState,frame}=facts;const companies=[...publicState.companies].sort((a,b)=>a.listingId.localeCompare(b.listingId));
  if(id==='CASH'||id==='HOLD8'||id.startsWith('CONCENTRATE_'))return undefined;
  if(id==='EX_CAPTURE') {
    const candidate=companies.find(c=>c.dividends.some(d=>d.exTick===frame.engineTick+1&&d.remainingPayableAtoms!=='0'));
    return candidate?.listingId??null;
  }
  if(id==='EARNINGS_SURPRISE') {
    if(!facts.earnings.length&&frame.tick%21!==0)return undefined;
    const scores=facts.earnings.filter(e=>e.kind==='EARNINGS').map(e=>({company:companies.find(c=>c.issuerId===e.issuerId),score:new D(e.actual.revenueAtoms??'0').minus(e.expected.revenueAtoms??'0').div(D.max(1,new D(e.expected.revenueAtoms??'0')))}))
      .filter(e=>e.company&&e.score.gt(0)).sort((a,b)=>b.score.cmp(a.score)||a.company!.listingId.localeCompare(b.company!.listingId));
    return scores[0]?.company?.listingId??null;
  }
  if(id==='LIMIT_FOLLOW')return companies.find(c=>facts.limitListings.includes(c.listingId))?.listingId??null;
  if(frame.tick%21!==0)return undefined;
  if(id==='CHEAP')return companies.sort((a,b)=>new D(frame.prices.get(a.listingId)!).cmp(frame.prices.get(b.listingId)!)||a.listingId.localeCompare(b.listingId))[0]!.listingId;
  if(id==='RANDOM') {
    const u=new D(random.uniform({engineVersion:parseEngineVersion('0.4.0'),tick:parseTickNo(frame.tick),issuerId:parseIssuerId('model_strategy'),eventChannel:'public-random-choice',drawIndex:0}));
    return companies[u.mul(companies.length).floor().toNumber()]!.listingId;
  }
  const scores=companies.map(c=>({id:c.listingId,returns:facts.history[c.listingId]?.slice(-21)??[]})).filter(c=>c.returns.length===21)
    .map(c=>({id:c.id,score:c.returns.reduce((v,r)=>v.mul(new D(r.toString()).plus(1)),new D(1)).minus(1)}))
    .sort((a,b)=>(id==='CONTRARIAN'?a.score.cmp(b.score):b.score.cmp(a.score))||a.id.localeCompare(b.id));
  return scores[0]?.id??null;
}
export function executeStrategy(account:StrategyAccount,facts:StrategyFacts,random:DeterministicRandom):StrategyAccount {
  const target=strategyTarget(account.id,facts,random);if(target===undefined)return account;
  // Unchanged targets stay invested without charging a gratuitous round trip.
  if(account.state.positions.length===1&&account.state.positions[0]!.listingId===target)return {...account,targetListing:target};
  let state=account.state;let trades=account.trades+state.positions.length;state=sellBenchmarkAll(state,facts.frame);
  if(target!==null) {state=buyTargets(state,facts.frame,[target]);trades+=state.positions.length;}
  return {...account,state,trades,targetListing:target};
}
