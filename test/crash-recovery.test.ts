import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test, {type TestContext} from 'node:test';
import type { ServiceContext, ServiceRequest } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { openReadonlyDatabase, verifyRecoveryDatabase } from '../src/diagnostics/verify-recovery.js';
import { ProcessLock, WriterAlreadyRunningError } from '../src/runtime/process-lock.js';

const guild='111111111111111111',user='222222222222222222';
function fixture(t:TestContext) {
  const parent=resolve(process.cwd()), root=mkdtempSync(join(parent,'.papermarket-crash-')), path=join(root,'market.sqlite');
  const identityKey=randomBytes(32),economySeed=Buffer.alloc(32,19),clock=new FakeClock('2026-10-09T00:00:00.000Z');
  let db=openDatabase(path), broker:BrokerRepository;
  new FoundationRepository(db,clock).createMarket({marketId:'crash-test-market',guildId:guild,listings:createInitialListings()});
  broker=new BrokerRepository(db,clock,{identityKey,economySeed});let id=333333333333333333n;
  const context=():ServiceContext=>({guildId:guild,discordUserId:user,interactionId:(++id).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  assert.equal(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind,'SETUP');
  assert.equal(broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true}).kind,'ACCOUNT');
  assert.equal(broker.dispatch({type:'alerts',context:context(),dmEnabled:true}).kind,'ALERTS');
  const children:ChildProcess[]=[];
  t.after(async()=>{
    for(const child of children) if(child.exitCode===null&&child.signalCode===null){ const exit=once(child,'exit');child.kill('SIGKILL');await exit; }
    if(db.open)db.close();
    if(dirname(resolve(root))!==parent||!basename(root).startsWith('.papermarket-crash-'))throw new Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true});
  });
  const fingerprint=()=>{const readonly=openReadonlyDatabase(path);try{return verifyRecoveryDatabase(readonly,{identityKey,economySeed});}finally{readonly.close();}};
  const quote=()=>{
    const response=broker.dispatch({type:'quote',context:context(),symbol:'HGI',side:'BUY',quantity:'1',orderType:'LIMIT',conditionPrice:'1100'});
    assert.equal(response.kind,'QUOTE');if(response.kind!=='QUOTE')throw new Error('Quote failed');return response.quote.token;
  };
  const reopen=()=>{if(db.open)db.close();db=openDatabase(path);broker=new BrokerRepository(db,clock,{identityKey,economySeed});};
  const start=async(phase:'BEFORE_COMMIT'|'AFTER_COMMIT',request:ServiceRequest)=>{
    if(db.open)db.close();
    const child=fork(fileURLToPath(new URL('./helpers/crash-worker.js',import.meta.url)),[],{stdio:['ignore','pipe','pipe','ipc']});children.push(child);
    // Consume only bounded synchronization messages. Helper never writes credentials.
    let stderr='';child.stderr?.on('data',chunk=>{stderr=(stderr+String(chunk)).slice(-1024);});child.stdout?.resume();
    await new Promise<void>((accept,reject)=>{
      const timer=setTimeout(()=>{reject(new Error('Crash helper startup timed out'));},15_000);
      const fail=()=>{clearTimeout(timer);reject(new Error('Crash helper failed to reach boundary'));};
      child.once('error',fail);child.once('exit',fail);
      child.once('message',message=>{clearTimeout(timer);child.off('error',fail);child.off('exit',fail);
        if(typeof message==='object'&&message!==null&&'ready'in message&&message.ready===phase)accept();else reject(new Error('Crash helper boundary mismatch'));
      });
      child.send({databasePath:path,identityKey:identityKey.toString('hex'),economySeed:economySeed.toString('hex'),now:clock.now(),phase,request});
    });
    assert.equal(stderr,'');return child;
  };
  const kill=async(child:ChildProcess)=>{const exit=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exit;};
  return {path,clock,context,quote,start,kill,reopen,fingerprint,get db(){return db;},get broker(){return broker;}};
}

test('actual child kill before COMMIT rolls back the whole fill and notification; stale writer recovery then commits once',async t=>{
  const f=fixture(t),token=f.quote(),request={type:'confirm',context:f.context(),token} as const,before=f.fingerprint();
  const child=await f.start('BEFORE_COMMIT',request);
  assert.throws(()=>new ProcessLock(f.path).acquire(),WriterAlreadyRunningError);
  assert.deepEqual(f.fingerprint(),before);await f.kill(child);
  const recoveredLock=new ProcessLock(f.path);recoveredLock.acquire();
  try{
    f.reopen();assert.deepEqual(f.fingerprint(),before);
    const response=f.broker.dispatch(request);assert.equal(response.kind,'FILLED');
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM fills').get() as {n:number}).n,1);
    assert.equal((f.db.prepare("SELECT count(*) AS n FROM notification_inbox WHERE kind='SCHEDULED_FILLED'").get() as {n:number}).n,1);
    const after=f.fingerprint();f.broker.dispatch({...request,context:f.context()});const repeated=f.fingerprint();
    // A new interaction adds its response-cache receipt; every other persisted table is identical.
    for(const table of Object.keys(after.tableHashes))if(table!=='trade_commands')assert.equal(repeated.tableHashes[table],after.tableHashes[table],table);
  }finally{recoveredLock.release();}
});

test('actual child kill after COMMIT but before response recovers the existing fill without financial or notification duplication',async t=>{
  const f=fixture(t),token=f.quote(),request={type:'confirm',context:f.context(),token} as const;
  const child=await f.start('AFTER_COMMIT',request),committed=f.fingerprint();
  assert.equal(committed.rowCounts['fills'],1);assert.equal(committed.rowCounts['notification_outbox'],1);
  assert.throws(()=>new ProcessLock(f.path).acquire(),WriterAlreadyRunningError);await f.kill(child);
  const lock=new ProcessLock(f.path);lock.acquire();
  try{
    f.reopen();assert.equal(f.broker.dispatch({type:'recover',now:f.clock.now()}).kind,'RECOVERED');
    const beforeRows=f.db.prepare('SELECT * FROM cash_journal ORDER BY rowid').all();
    assert.equal(f.broker.dispatch({...request,context:f.context()}).kind,'FILLED');
    assert.deepEqual(f.db.prepare('SELECT * FROM cash_journal ORDER BY rowid').all(),beforeRows);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM fills').get() as {n:number}).n,1);
    assert.equal((f.db.prepare('SELECT count(*) AS n FROM notification_outbox').get() as {n:number}).n,1);
    assert.equal(f.fingerprint().tableHashes['cash_journal'],committed.tableHashes['cash_journal']);
  }finally{lock.release();}
});

test('actual child kill before an economic tick COMMIT leaves prices, rates, interest, benchmarks and performance unchanged',async t=>{
  const f=fixture(t),before=f.fingerprint();f.clock.advanceBy(300_000);
  const child=await f.start('BEFORE_COMMIT',{type:'tick',now:f.clock.now()});assert.deepEqual(f.fingerprint(),before);await f.kill(child);
  const lock=new ProcessLock(f.path);lock.acquire();try{
    f.reopen();assert.deepEqual(f.fingerprint(),before);
    assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'TICKED');
    const after=f.fingerprint();assert.equal(after.economicSnapshots,before.economicSnapshots+1);assert.equal(after.performanceSamples,before.performanceSamples+1);
    assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'TICKED');assert.deepEqual(f.fingerprint(),after);
  }finally{lock.release();}
});

test('actual child kill after an economic tick COMMIT does not advance the same boundary twice on recovery',async t=>{
  const f=fixture(t);f.clock.advanceBy(300_000);const child=await f.start('AFTER_COMMIT',{type:'tick',now:f.clock.now()}),committed=f.fingerprint();await f.kill(child);
  const lock=new ProcessLock(f.path);lock.acquire();try{
    f.reopen();assert.equal(f.broker.dispatch({type:'recover',now:f.clock.now()}).kind,'RECOVERED');
    assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'TICKED');
    const restored=f.fingerprint();
    for(const table of ['cash_journal','position_journal','economy_snapshots','economy_prices','economy_rate_intervals','rights_journal','benchmark_snapshots','performance_samples'])assert.equal(restored.tableHashes[table],committed.tableHashes[table],table);
  }finally{lock.release();}
});
