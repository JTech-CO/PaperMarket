import {createHash} from 'node:crypto';
import {closeSync,existsSync,mkdirSync,openSync,readFileSync,renameSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {basename,join,resolve} from 'node:path';
import {performance} from 'node:perf_hooks';
import {z} from 'zod';
import {canonicalModelJson} from './encoding.js';
import {distribution} from './statistics.js';
import {MODEL_VALIDATION_VERSION,modelHardware,modelPlan,strategyDefinition,type ModelPlan,type ModelPreset} from './plans.js';
import {advanceModelTick,createSeedRun,summarizeSeed,validateSeedRun,type SeedRun} from './runner.js';
import {FinancialDecimal as D} from '../../domain/numeric.js';
import {STANDARD_RULESET} from '../../domain/ruleset.js';
import {ECONOMY_ENGINE_VERSION} from '../../economy/repository.js';
import {PRICE_ENGINE_VERSION} from '../../market/pricing.js';

const MAX_FILE_BYTES=64*1024*1024;
const hash=(value:unknown)=>createHash('sha256').update(canonicalModelJson(value)).digest('hex');
type SeedSummary=ReturnType<typeof summarizeSeed>;
interface Entry {seedId:string;checkpoint:string|null;checkpointHash:string|null;summary:SeedSummary|null}
interface Resources {executions:number;wallSeconds:number;cpuUserSeconds:number;cpuSystemSeconds:number;maximumRssBytes:number;lastChunk:{attemptedTicks:number;completedTicks:number;wallSeconds:number;maxTicks:number;maxSeconds:number}|null}
interface Index {version:typeof MODEL_VALIDATION_VERSION;recorderVersion:'opening-equity-observation-v1'|'POST_TICK_ONLY_LEGACY';planHash:string;nextSeed:number;entries:Entry[];resources:Resources}
export interface BatchOptions {preset:ModelPreset;outputDirectory:string;maxTicksPerRun:number;maxSeconds:number}
const provenanceSchema=z.strictObject({sourceArtifact:z.string().regex(/^model-(?:pilot|reference|drift-pilot|drift)\.before-opening-equity-observation-v1\.[0-9a-f]{64}\.json$/),
  sourceSha256:z.string().regex(/^[0-9a-f]{64}$/),sourceCompletedTicks:z.number().int().min(0),sourcePlanHash:z.string().regex(/^[0-9a-f]{64}$/),
  correction:z.literal('OPENING_EQUITY_DRAWDOWN_OBSERVATION')});
type RecorderProvenance=z.infer<typeof provenanceSchema>;
export const batchOptionsSchema=z.strictObject({preset:z.enum(['pilot','reference','drift-pilot','drift']),outputDirectory:z.string().min(1).max(4096),
  maxTicksPerRun:z.number().int().min(1).max(10000),maxSeconds:z.number().finite().min(1).max(60)});
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);const duration=z.number().finite().min(0);
const indexSchema=z.strictObject({version:z.literal(MODEL_VALIDATION_VERSION),recorderVersion:z.enum(['opening-equity-observation-v1','POST_TICK_ONLY_LEGACY']).default('POST_TICK_ONLY_LEGACY'),planHash:z.string().regex(/^[0-9a-f]{64}$/),nextSeed:count,
  entries:z.array(z.strictObject({seedId:z.string().regex(/^[ch]\d{3}$/),checkpoint:z.string().regex(/^[ch]\d{3}-[0-9a-f]{64}\.json$/).nullable(),checkpointHash:z.string().regex(/^[0-9a-f]{64}$/).nullable(),summary:z.unknown().nullable()})).max(200),
  resources:z.strictObject({executions:count,wallSeconds:duration,cpuUserSeconds:duration,cpuSystemSeconds:duration,maximumRssBytes:count,lastChunk:z.strictObject({attemptedTicks:count,completedTicks:count,wallSeconds:duration,maxTicks:count,maxSeconds:duration}).nullable()})});
function readBounded(path:string):unknown {
  if(statSync(path).size>MAX_FILE_BYTES)throw new Error('MODEL_CHECKPOINT_SIZE_LIMIT');return JSON.parse(readFileSync(path,'utf8'));
}
function atomicJson(path:string,value:unknown):void {
  const body=canonicalModelJson(value);if(Buffer.byteLength(body)>MAX_FILE_BYTES)throw new Error('MODEL_CHECKPOINT_SIZE_LIMIT');
  const temporary=`${path}.tmp`;writeFileSync(temporary,body,{flag:'wx'});
  try {renameSync(temporary,path);} finally {if(existsSync(temporary))rmSync(temporary);}
}
function initialIndex(plan:ModelPlan):Index {
  return {version:MODEL_VALIDATION_VERSION,recorderVersion:'opening-equity-observation-v1',planHash:plan.hash,nextSeed:0,entries:plan.seeds.map(s=>({seedId:s.id,checkpoint:null,checkpointHash:null,summary:null})),
    resources:{executions:0,wallSeconds:0,cpuUserSeconds:0,cpuSystemSeconds:0,maximumRssBytes:0,lastChunk:null}};
}
function loadIndex(path:string,plan:ModelPlan):Index {
  if(!existsSync(path))return initialIndex(plan);
  const wrapper=z.strictObject({hash:z.string().regex(/^[0-9a-f]{64}$/),index:z.unknown()}).parse(readBounded(path));
  if(hash(wrapper.index)!==wrapper.hash)throw new Error('MODEL_INDEX_HASH');const parsed=indexSchema.parse(wrapper.index);
  if(parsed.planHash!==plan.hash||parsed.nextSeed>=plan.seeds.length||parsed.entries.length!==plan.seeds.length||parsed.entries.some((e,i)=>e.seedId!==plan.seeds[i]!.id))throw new Error('MODEL_INDEX_IDENTITY');
  for(const entry of parsed.entries) {
    if((entry.checkpoint===null)!==(entry.checkpointHash===null)||(entry.checkpoint===null)!==(entry.summary===null))throw new Error('MODEL_INDEX_IDENTITY');
    if(entry.checkpoint!==null&&entry.checkpoint!==`${entry.seedId}-${entry.checkpointHash}.json`)throw new Error('MODEL_INDEX_IDENTITY');
    if(entry.summary!==null) {
      const summary=entry.summary as SeedSummary;const definition=plan.seeds.find(s=>s.id===entry.seedId)!;
      if(summary.seed?.id!==definition.id||summary.seed.marketId!==definition.marketId||summary.seed.partition!==definition.partition||summary.targetTicks!==plan.ticksPerSeed
        ||!Number.isSafeInteger(summary.completedTicks)||summary.completedTicks<0||summary.completedTicks>plan.ticksPerSeed||!['IN_PROGRESS','COMPLETE','FAILED'].includes(summary.status)
        ||(summary.status==='COMPLETE')!==(summary.completedTicks===plan.ticksPerSeed)||(summary.status==='FAILED')!==(summary.failure!==null))throw new Error('MODEL_INDEX_IDENTITY');
    }
  }
  return parsed as Index;
}
function loadRun(directory:string,entry:Entry,plan:ModelPlan,index:number,allowLegacy=false):SeedRun {
  const definition=plan.seeds[index]!;if(entry.checkpoint===null)return createSeedRun(plan,definition);
  const wrapper=z.strictObject({hash:z.string().regex(/^[0-9a-f]{64}$/),run:z.unknown()}).parse(readBounded(join(directory,entry.checkpoint)));
  if(wrapper.hash!==entry.checkpointHash||hash(wrapper.run)!==wrapper.hash)throw new Error('MODEL_CHECKPOINT_HASH');
  const run=validateSeedRun(wrapper.run,plan,definition);
  const current=summarizeSeed(run);
  if(canonicalModelJson(current)!==canonicalModelJson(entry.summary)) {
    if(!allowLegacy)throw new Error('MODEL_CHECKPOINT_SUMMARY');
    // Compatibility is restricted to the recorder's omitted tick-zero drawdown observation. Financial state stays hash-bound.
    const legacy={...current,strategies:current.strategies.map(s=>({...s,maxDrawdownPct:run.accounts.find(a=>a.id===s.id)!.maxDrawdownPct}))};
    if(canonicalModelJson(legacy)!==canonicalModelJson(entry.summary))throw new Error('MODEL_CHECKPOINT_SUMMARY');
  }
  entry.summary=current;return run;
}
function saveIndex(path:string,index:Index):void {atomicJson(path,{hash:hash(index),index});}
function preservePriorReport(output:string,plan:ModelPlan):RecorderProvenance|null {
  const path=join(output,`model-${plan.preset}.json`);if(!existsSync(path))return null;
  const previous=z.looseObject({planHash:z.string(),scope:z.looseObject({completedTicks:count}),versions:z.looseObject({drawdownRecorder:z.string().optional()}).optional(),
    recorderCorrectionProvenance:provenanceSchema.nullable().optional()}).parse(readBounded(path));
  if(previous.planHash!==plan.hash)throw new Error('MODEL_PRIOR_REPORT_PLAN');
  if(previous.versions?.drawdownRecorder==='opening-equity-observation-v1') {
    const provenance=previous.recorderCorrectionProvenance??null;
    if(provenance) {
      if(provenance.sourcePlanHash!==plan.hash||provenance.sourceArtifact!==`model-${plan.preset}.before-opening-equity-observation-v1.${provenance.sourceSha256}.json`
        ||createHash('sha256').update(readFileSync(join(output,provenance.sourceArtifact))).digest('hex')!==provenance.sourceSha256)throw new Error('MODEL_PRIOR_REPORT_PROVENANCE');
    }
    return provenance;
  }
  const bytes=readFileSync(path);const sourceSha256=createHash('sha256').update(bytes).digest('hex');
  const sourceArtifact=`model-${plan.preset}.before-opening-equity-observation-v1.${sourceSha256}.json`;const preserved=join(output,sourceArtifact);
  if(existsSync(preserved)) {if(createHash('sha256').update(readFileSync(preserved)).digest('hex')!==sourceSha256)throw new Error('MODEL_PRIOR_REPORT_PROVENANCE');}
  else writeFileSync(preserved,bytes,{flag:'wx'});
  return {sourceArtifact,sourceSha256,sourceCompletedTicks:previous.scope.completedTicks,sourcePlanHash:plan.hash,correction:'OPENING_EQUITY_DRAWDOWN_OBSERVATION'};
}
function report(index:Index,plan:ModelPlan) {
  const seeds=index.entries.map((e,i)=>e.summary??{seed:plan.seeds[i]!,status:'NOT_STARTED',targetTicks:plan.ticksPerSeed,completedTicks:0,failure:null});
  const complete=seeds.filter(s=>s.status==='COMPLETE').length;const failed=seeds.filter(s=>s.status==='FAILED').length;const started=seeds.filter(s=>s.status!=='NOT_STARTED').length;
  const comparisons=index.entries.filter(e=>e.summary!==null).map(e=>e.summary!);
  const strategyReturns=Object.fromEntries(strategyDefinition.ids.map(id=>[id,{
    calibration:distribution(comparisons.filter(s=>s.seed.partition==='CALIBRATION').map(s=>new D(s.strategies.find(a=>a.id===id)!.returnRatio).toNumber())),
    holdout:distribution(comparisons.filter(s=>s.seed.partition==='HOLDOUT').map(s=>new D(s.strategies.find(a=>a.id===id)!.returnRatio).toNumber())),
    includedStatuses:'All started seeds, including FAILED and partial; horizons differ until all requested ticks complete.',
  }]));
  return {milestone:6,validationVersion:MODEL_VALIDATION_VERSION,preset:plan.preset,planHash:plan.hash,
    versions:{economy:ECONOMY_ENGINE_VERSION,pricing:PRICE_ENGINE_VERSION,ruleset:STANDARD_RULESET.rulesetVersion,drawdownRecorder:'opening-equity-observation-v1'},
    status:failed?'FAILED':complete===plan.seeds.length?'COMPLETE':'IN_PROGRESS',modelQuality:'NOT_CALIBRATED',
    scope:{requestedSeeds:plan.seeds.length,ticksPerSeed:plan.ticksPerSeed,requestedTicks:plan.seeds.length*plan.ticksPerSeed,
      completedTicks:seeds.reduce((s,e)=>s+e.completedTicks,0),startedSeeds:started,completeSeeds:complete,failedSeeds:failed,notStartedSeeds:plan.seeds.length-started},
    preregistration:{reference:{seeds:200,calibration:160,holdout:40,ticksPerSeed:10000,requestedTicks:2000000,execution:plan.preset==='reference'?'SEE_SCOPE':'NOT_RUN_BY_THIS_PRESET'},
      drift:{seedIds:['c000','h000'],ticksPerSeed:100000,requestedTicks:200000,execution:plan.preset==='drift'?'SEE_SCOPE':'NOT_RUN_BY_THIS_PRESET'},
      noSelection:'Predefined seeds; failed results remain in coverage and comparisons. No parameter tuning or winner selection is performed.'},
    hardware:modelHardware(),measurementContext:'Local single-process measurement. Other unit checks or milestone work may have run concurrently; exclusive-host throughput is not asserted.',resources:index.resources,strategies:strategyDefinition,
    drawdownObservationPolicy:'Original 10000 grant, exact post-buy tick-zero equity, and every committed close. The recorder now includes opening fees; financial checkpoint state, prices and decisions are unchanged.',strategyReturns,seeds,
    limitations:['Pilot results do not establish calibration or statistical power.','All prices come from the full production economic/public/pricing engine; account settlement shares production exact benchmark helpers.',
      'Offline batch excludes SQLite/Discord latency; those are measured separately.','Shadow strategies transact at a committed close without user timing, latency or order reservations.',
      'Dividend coverage is declared amount divided by the publicly available four-quarter average recurring net profit; cash and reserve constraints still apply in the engine.',
      'Complete seeds and failed or partial seeds retain their actual horizons; aggregate strategy numbers cannot be treated as equal-horizon performance until coverage is complete.'],
    storage:{checkpointLimitBytes:MAX_FILE_BYTES,checkpointRule:'Immutable hash-named checkpoint and atomic manifest; incomplete writes are not committed. The lock prevents simultaneous writers. Hashes detect corruption, not an adversary able to rewrite all local files.',
      interruptedProcessRecovery:'After a process crash, inspect the recorded lock PID and confirm its writer has stopped before removing the single .model-validation.lock file and any .tmp files in this preset directory. Resume from the committed index; never rewrite completed checkpoints or change seeds.',
      timeBudget:'Cooperative tick budget; an in-flight full tick and integrity verification/atomic writes finish before returning. Actual wall time is recorded and may slightly exceed the requested seconds.'}};
}
export type ModelReport=ReturnType<typeof report>&{recorderCorrectionProvenance:RecorderProvenance|null;
  summaryRefresh?:{wallSeconds:number;cpuUserSeconds:number;cpuSystemSeconds:number;completedEngineTicks:number;financialCheckpointRewrites:number}};
export function runModelBatch(input:BatchOptions):ModelReport {
  const options=batchOptionsSchema.parse(input);const plan=modelPlan(options.preset);const output=resolve(options.outputDirectory);
  mkdirSync(output,{recursive:true});const directory=join(output,'.model-checkpoints',options.preset);mkdirSync(directory,{recursive:true});
  const lockPath=join(output,'.model-validation.lock');const lock=openSync(lockPath,'wx');
  const start=performance.now();const cpuStart=process.cpuUsage();let attempts=0,completed=0;
  try {
    writeFileSync(lock,canonicalModelJson({pid:process.pid,preset:options.preset,planHash:plan.hash}));
    const indexPath=join(directory,'index.json');const index=loadIndex(indexPath,plan);const originalResources=structuredClone(index.resources);
    // Terminal results also affect coverage and comparisons. Verify their source rather than trusting cached summaries.
    for(let i=0;i<index.entries.length;i++)if(index.entries[i]!.checkpoint!==null)loadRun(directory,index.entries[i]!,plan,i,index.recorderVersion==='POST_TICK_ONLY_LEGACY');
    index.recorderVersion='opening-equity-observation-v1';
    const updateResources=()=>{
      const cpu=process.cpuUsage(cpuStart);const wall=(performance.now()-start)/1000;
      index.resources={executions:originalResources.executions+1,wallSeconds:originalResources.wallSeconds+wall,cpuUserSeconds:originalResources.cpuUserSeconds+cpu.user/1e6,
        cpuSystemSeconds:originalResources.cpuSystemSeconds+cpu.system/1e6,maximumRssBytes:Math.max(originalResources.maximumRssBytes,process.resourceUsage().maxRSS*1024),
        lastChunk:{attemptedTicks:attempts,completedTicks:completed,wallSeconds:wall,maxTicks:options.maxTicksPerRun,maxSeconds:options.maxSeconds}};
    };
    while(attempts<options.maxTicksPerRun&&(performance.now()-start)/1000<options.maxSeconds) {
      let selected=-1;
      for(let offset=0;offset<index.entries.length;offset++) {const i=(index.nextSeed+offset)%index.entries.length;const s=index.entries[i]!.summary?.status;if(s!=='COMPLETE'&&s!=='FAILED'){selected=i;break;}}
      if(selected===-1)break;const entry=index.entries[selected]!;let run=loadRun(directory,entry,plan,selected);const oldCheckpoint=entry.checkpoint;
      const quantum=Math.min(64,options.maxTicksPerRun-attempts);
      for(let n=0;n<quantum&&run.status==='IN_PROGRESS'&&(performance.now()-start)/1000<options.maxSeconds;n++) {
        const before=run.economy.tickNo;run=advanceModelTick(run);attempts++;completed+=run.economy.tickNo-before;
      }
      const checkpointHash=hash(run);const checkpoint=`${run.seed.id}-${checkpointHash}.json`;const checkpointPath=join(directory,checkpoint);
      if(!existsSync(checkpointPath))atomicJson(checkpointPath,{hash:checkpointHash,run});
      entry.checkpoint=checkpoint;entry.checkpointHash=checkpointHash;entry.summary=summarizeSeed(run);index.nextSeed=(selected+1)%index.entries.length;
      updateResources();saveIndex(indexPath,index);
      if(oldCheckpoint!==null&&oldCheckpoint!==checkpoint) {
        // The strict manifest schema supplies a basename inside this preset directory; no recursive cleanup.
        const oldPath=join(directory,oldCheckpoint);if(basename(oldPath)!==oldCheckpoint)throw new Error('MODEL_UNSAFE_CHECKPOINT_PATH');if(existsSync(oldPath))rmSync(oldPath);
      }
    }
    updateResources();saveIndex(indexPath,index);const result={...report(index,plan),recorderCorrectionProvenance:preservePriorReport(output,plan)};
    atomicJson(join(output,`model-${options.preset}.json`),result);return result;
  } finally {closeSync(lock);rmSync(lockPath);}
}
/** Rebuild corrected public summaries from validated retained state, with zero engine ticks or financial rewrites. */
export function refreshModelReport(preset:ModelPreset,outputDirectory:string):ModelReport {
  const plan=modelPlan(preset);const output=resolve(outputDirectory);const directory=join(output,'.model-checkpoints',preset);const indexPath=join(directory,'index.json');
  if(!existsSync(indexPath))throw new Error('MODEL_NO_RETAINED_RUN');const lockPath=join(output,'.model-validation.lock');const lock=openSync(lockPath,'wx');
  try {
    writeFileSync(lock,canonicalModelJson({pid:process.pid,preset,planHash:plan.hash,purpose:'SUMMARY_REFRESH_ONLY'}));
    const start=performance.now();const cpuStart=process.cpuUsage();const index=loadIndex(indexPath,plan);
    for(let i=0;i<index.entries.length;i++)if(index.entries[i]!.checkpoint!==null)loadRun(directory,index.entries[i]!,plan,i,index.recorderVersion==='POST_TICK_ONLY_LEGACY');
    index.recorderVersion='opening-equity-observation-v1';
    const recorderCorrectionProvenance=preservePriorReport(output,plan);saveIndex(indexPath,index);const cpu=process.cpuUsage(cpuStart);
    const result={...report(index,plan),recorderCorrectionProvenance,summaryRefresh:{wallSeconds:(performance.now()-start)/1000,cpuUserSeconds:cpu.user/1e6,cpuSystemSeconds:cpu.system/1e6,
      completedEngineTicks:0,financialCheckpointRewrites:0}};
    atomicJson(join(output,`model-${preset}.json`),result);return result;
  } finally {closeSync(lock);rmSync(lockPath);}
}
