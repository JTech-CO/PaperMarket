import {createHash,createHmac} from 'node:crypto';
import {cpus,totalmem} from 'node:os';
import {DeterministicRandom} from '../../domain/random.js';
import {STANDARD_RULESET} from '../../domain/ruleset.js';
import {ECONOMY_ENGINE_VERSION,canonicalEconomyJson} from '../../economy/repository.js';
import {PRICE_ENGINE_VERSION} from '../../market/pricing.js';
import {STRATEGIES} from './strategies.js';

export const MODEL_VALIDATION_VERSION='model-validation-v1' as const;
export type ModelPreset='pilot'|'reference'|'drift-pilot'|'drift';
export interface SeedDefinition {readonly id:string;readonly partition:'CALIBRATION'|'HOLDOUT';readonly marketId:string}
export interface ModelPlan {readonly preset:ModelPreset;readonly ticksPerSeed:number;readonly seeds:readonly SeedDefinition[];readonly hash:string}
const seed=(partition:SeedDefinition['partition'],index:number):SeedDefinition=>{
  const id=`${partition==='CALIBRATION'?'c':'h'}${index.toString().padStart(3,'0')}`;
  return Object.freeze({id,partition,marketId:`model_${id}`});
};
/** This registry is fixed before inspecting outcomes. Pilot and full plans share the same paths. */
export const REFERENCE_SEEDS=Object.freeze([
  ...Array.from({length:160},(_,i)=>seed('CALIBRATION',i)),
  ...Array.from({length:40},(_,i)=>seed('HOLDOUT',i)),
]);
export const PILOT_SEEDS=Object.freeze([REFERENCE_SEEDS[0]!,REFERENCE_SEEDS[1]!,REFERENCE_SEEDS[160]!,REFERENCE_SEEDS[161]!]);
export const DRIFT_SEEDS=Object.freeze([REFERENCE_SEEDS[0]!,REFERENCE_SEEDS[160]!]);
export const strategyDefinition=Object.freeze({
  count:17,ids:STRATEGIES,initialCashAtoms:STANDARD_RULESET.initialCash.toString(),feeRate:STANDARD_RULESET.tradeFeeRate,
  lotDecimals:6,rebalanceTicks:21,baseline:'HOLD8 and concentrations buy once at tick zero; retired holdings become claims without receiving replacement shares.',
  signals:'EX_CAPTURE buys at the close before a public EX boundary and sells after entitlement; CHEAP uses lowest public price; MOMENTUM/CONTRARIAN use 21 consecutive adjusted returns of the same listing; EARNINGS_SURPRISE uses published revenue surprise; LIMIT_FOLLOW buys the first listing with an upper-limit hit; RANDOM uses a separate counter RNG.',
  settlement:'Current committed public close; production buy/sell fees, floor/ceil, previous public cash rate, exact carries and corporate claims. Receivables cannot fund buys.',
});
export function modelPlan(preset:ModelPreset):ModelPlan {
  if(!['pilot','reference','drift-pilot','drift'].includes(preset))throw new Error('MODEL_INVALID_PRESET');
  const ticksPerSeed=preset==='pilot'?252:preset==='reference'?10000:preset==='drift-pilot'?1000:100000;
  const seeds=preset==='pilot'?PILOT_SEEDS:preset==='reference'?REFERENCE_SEEDS:preset==='drift-pilot'?[DRIFT_SEEDS[0]!]:DRIFT_SEEDS;
  const hash=createHash('sha256').update(canonicalEconomyJson({version:MODEL_VALIDATION_VERSION,preset,ticksPerSeed,seeds,
    economyVersion:ECONOMY_ENGINE_VERSION,pricingVersion:PRICE_ENGINE_VERSION,strategyDefinition,publicSeedLabel:'PaperMarket model validation public seeds v1'})).digest('hex');
  return Object.freeze({preset,ticksPerSeed,seeds:Object.freeze([...seeds]),hash});
}
/** Synthetic, published validation seeds never read the production economy secret. */
export function modelRandoms(definition:SeedDefinition):{economy:DeterministicRandom;strategy:DeterministicRandom} {
  const master=modelMasterSeed(definition);
  const economy=createHmac('sha256',master).update(JSON.stringify(['PaperMarket economic draws v1',definition.marketId])).digest();
  const strategy=createHmac('sha256',master).update(JSON.stringify(['PaperMarket model strategy draws v1',definition.marketId])).digest();
  return {economy:new DeterministicRandom(economy),strategy:new DeterministicRandom(strategy)};
}
export function modelMasterSeed(definition:SeedDefinition):Buffer {return createHash('sha256').update(`PaperMarket model validation public seeds v1:${definition.id}`).digest();}
export function modelHardware() {
  const cpu=cpus();return {node:process.version,platform:process.platform,architecture:process.arch,cpuModel:cpu[0]?.model??'UNKNOWN',logicalCpus:cpu.length,totalMemoryBytes:totalmem(),
    sqlite:'NOT_USED_BY_BATCH; real SQLite parity covered by tests',execution:'Single process, single CPU thread; synchronous full economic/public/pricing engine.'};
}
