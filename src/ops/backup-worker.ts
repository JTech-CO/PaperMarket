import { parentPort,workerData } from 'node:worker_threads';
import { z } from 'zod';
import { BackupManager } from './backup.js';
const hex=z.string().regex(/^[a-f0-9]{64,128}$/).refine(value=>value.length%2===0);
const config=z.strictObject({databasePath:z.string().min(1).max(4096),backupDirectory:z.string().min(1).max(4096),mirrorDirectory:z.string().min(1).max(4096).optional(),backupKey: z.string().regex(/^[a-f0-9]{64}$/),identityKey:hex,economySeed:hex}).parse(workerData);
const port=parentPort;if(!port)throw new Error('Backup worker requires a parent');
const manager=new BackupManager({databasePath:config.databasePath,backupDirectory:config.backupDirectory,backupKey:Buffer.from(config.backupKey,'hex'),identityKey:Buffer.from(config.identityKey,'hex'),economySeed:Buffer.from(config.economySeed,'hex'),...(config.mirrorDirectory?{mirrorDirectory:config.mirrorDirectory}:{})});
let stopping=false;
port.on('message',(message:unknown)=>{
  if(message==='STOP'){
    stopping=true;void manager.stop().then(()=>{port.postMessage({stopped:true});port.close();});return;
  }
  if(message!=='RUN_DUE'||stopping)return;
  const started=performance.now();
  void manager.runDue().then(result=>port.postMessage({done:true,elapsedMs:performance.now()-started,failed:false,created:result.backup!==undefined,mirrored:result.mirrored!==undefined,rehearsed:result.rehearsed!==undefined}))
    .catch(()=>port.postMessage({done:true,elapsedMs:performance.now()-started,failed:true}));
});
port.postMessage({ready:true});
