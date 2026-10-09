import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {runModelBatch,type BatchOptions} from '../validation/model/batch.js';
import type {ModelPreset} from '../validation/model/plans.js';

export function modelCommandOptions(args:readonly string[]):BatchOptions {
  const options:BatchOptions={preset:'pilot',outputDirectory:resolve('.runtime/validation'),maxTicksPerRun:1000,maxSeconds:60};const seen=new Set<string>();
  for(let i=0;i<args.length;i+=2) {
    const flag=args[i]!;const value=args[i+1];if(seen.has(flag)||value===undefined)throw new Error('MODEL_INVALID_ARGUMENTS');seen.add(flag);
    if(flag==='--preset') {if(!['pilot','reference','drift-pilot','drift'].includes(value))throw new Error('MODEL_INVALID_PRESET');options.preset=value as ModelPreset;}
    else if(flag==='--output-dir')options.outputDirectory=resolve(value);
    else if(flag==='--max-ticks-per-run'||flag==='--max-seconds') {
      if(!/^\d+$/.test(value))throw new Error('MODEL_INVALID_BUDGET');const number=Number(value);if(!Number.isSafeInteger(number))throw new Error('MODEL_INVALID_BUDGET');
      if(flag==='--max-ticks-per-run') {if(number<1||number>10000)throw new Error('MODEL_INVALID_BUDGET');options.maxTicksPerRun=number;}
      else {if(number<1||number>60)throw new Error('MODEL_INVALID_BUDGET');options.maxSeconds=number;}
    } else throw new Error('MODEL_UNKNOWN_ARGUMENT');
  }
  return options;
}
// Importable parsing supports regression tests without starting a diagnostic run.
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {
    const options=modelCommandOptions(process.argv.slice(2));const result=runModelBatch(options);
    console.log(JSON.stringify({validation:'MODEL',preset:result.preset,status:result.status,modelQuality:result.modelQuality,scope:result.scope,resources:result.resources,
      report:resolve(options.outputDirectory,`model-${result.preset}.json`)},null,2));
    if(result.status==='FAILED')process.exitCode=1;
  } catch(error) {console.error(JSON.stringify({validation:'MODEL',status:'ERROR',code:error instanceof Error?error.message:'MODEL_CHECK_FAILED'}));process.exitCode=1;}
}
