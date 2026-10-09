import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,mkdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename,dirname,join,resolve } from 'node:path';
import test from 'node:test';
import { OperationalMetrics,readOperationalState } from '../src/ops/metrics.js';
import { WorkerBackend,type BackendObservation } from '../src/runtime/backend.js';
import { BackupRuntime,type BackupObservation } from '../src/ops/backup-runtime.js';
import { ReportingBenchmarks } from '../src/reporting/benchmarks.js';
import { ReportingRepository } from '../src/reporting/repository.js';
import { openDatabase } from '../src/storage/database.js';
function directory():string {
  const root=resolve('.runtime/test-fixtures/ops');mkdirSync(root,{recursive:true});return mkdtempSync(join(root,'papermarket-ops-'));
}
async function clean(path:string):Promise<void>{
  const root=resolve('.runtime/test-fixtures/ops');if(dirname(resolve(path))!==root||!basename(path).startsWith('papermarket-ops-'))throw new Error('Unsafe cleanup');await rm(path,{recursive:true,force:true,maxRetries:3,retryDelay:100});
}
test('operational telemetry accepts bounded numeric allowlisted metrics and contains no arbitrary labels',()=>{
  const metrics=new OperationalMetrics();
  metrics.observe('queryMs',10);metrics.observe('queryMs',30);metrics.observe('queryMs',Number.NaN);
  metrics.observe('token-secret' as never,1);metrics.increment('token-secret' as never);metrics.increment('errors');
  const result=metrics.snapshot();assert.equal(result.durations.queryMs?.count,2);assert.equal(result.durations.queryMs?.p95,30);
  assert.deepEqual(result.counters,{errors:1});assert.ok(!JSON.stringify(result).includes('token-secret'));
});
test('readonly reporting audit verifies retained samples and benchmarks after account closure',async t=>{
  const root=directory(),path=join(root,'market.sqlite'),identityKey=randomBytes(32),economySeed=randomBytes(32);
  const observations:BackendObservation[]=[];
  const backend=new WorkerBackend({databasePath:path,identityKey,economySeed,onObservation:value=>{observations.push(value);throw new Error('Telemetry failure');}});
  let logical:WorkerBackend|undefined;t.after(async()=>{await logical?.close();await backend.close();await clean(root);});await backend.start();let id=100000000000000100n;
  const context=()=>({guildId:'100000000000000001',discordUserId:'100000000000000002',interactionId:(++id).toString(),guildPermissions:'32',receivedAt:new Date().toISOString()});
  assert.equal((await backend.execute({type:'setup',context:context(),channelId:'100000000000000003'})).kind,'SETUP');
  assert.equal((await backend.execute({type:'open',context:context(),age14Plus:true,agreeTerms:true})).kind,'ACCOUNT');
  const tick=await backend.execute({type:'tick',now:new Date(Date.now()+300_001).toISOString()});assert.equal(tick.kind,'TICKED');
  await backend.close();
  logical=new WorkerBackend({databasePath:path,identityKey,economySeed,validationClockOffsetMs:300_100});await logical.start();
  assert.equal((await logical.execute({type:'close',context:context(),confirmed:true})).kind,'CLOSED');await logical.close();
  const db=openDatabase(path);try{const benchmarks=new ReportingBenchmarks(db);assert.equal(benchmarks.auditAll().series,3);assert.equal(new ReportingRepository(db,benchmarks).auditAll().samples,1);}finally{db.close();}
  const state=readOperationalState(path);assert.equal(state.status,'OK');assert.equal(state.markets,1);
  assert.ok(observations.every(value=>!JSON.stringify(value).includes('100000000000000002')));
  assert.ok(observations.some(value=>value.operation==='TICK'&&value.serviceMs!==undefined));
});
test('dedicated backup worker verifies an online backup and stops independently of the financial writer',async t=>{
  const root=directory(),path=join(root,'market.sqlite'),identityKey=randomBytes(32),economySeed=randomBytes(32),backupKey=randomBytes(32);
  const backend=new WorkerBackend({databasePath:path,identityKey,economySeed});let runtime:BackupRuntime|undefined;t.after(async()=>{await runtime?.stop();await backend.close();await clean(root);});await backend.start();
  const context={guildId:'100000000000000001',discordUserId:'100000000000000002',interactionId:'100000000000000100',guildPermissions:'32',receivedAt:new Date().toISOString()};
  assert.equal((await backend.execute({type:'setup',context,channelId:'100000000000000003'})).kind,'SETUP');
  let done!:(value:BackupObservation)=>void;const observed=new Promise<BackupObservation>(resolve=>{done=resolve;});
  runtime=new BackupRuntime({databasePath:path,backupDirectory:join(root,'backups'),identityKey,economySeed,backupKey,onObservation:value=>{if(value.created||value.failed)done(value);}});
  await runtime.start();
  const result=await observed;assert.equal(result.failed,false);assert.equal(result.created,true);assert.ok(result.elapsedMs>=0);
  assert.equal((await backend.execute({type:'market',context:{...context,interactionId:'100000000000000101',receivedAt:new Date().toISOString()}})).kind,'MARKET');
  await runtime.stop();await backend.close();
});
