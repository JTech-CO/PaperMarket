import { Worker } from 'node:worker_threads';
export interface BackupObservation {readonly elapsedMs:number;readonly failed:boolean;readonly created:boolean;readonly mirrored:boolean;readonly rehearsed:boolean}
/** Verification and crypto run on a separate worker so hourly backup cannot block Gateway defer or the financial writer. */
export class BackupRuntime {
  readonly #worker:Worker;readonly #ready:Promise<void>;readonly #options:{onObservation?:(value:BackupObservation)=>void;onFailure?:()=>void};
  #timer:ReturnType<typeof setInterval>|undefined;#running=false;#stopped=false;#started=false;#resolveStop:(()=>void)|undefined;
  constructor(options:{databasePath:string;backupDirectory:string;mirrorDirectory?:string;backupKey:Buffer;identityKey:Buffer;economySeed:Buffer;onObservation?:(value:BackupObservation)=>void;onFailure?:()=>void}) {
    this.#options=options;
    this.#worker=new Worker(new URL('./backup-worker.js',import.meta.url),{workerData:{databasePath:options.databasePath,backupDirectory:options.backupDirectory,backupKey:options.backupKey.toString('hex'),identityKey:options.identityKey.toString('hex'),economySeed:options.economySeed.toString('hex'),...(options.mirrorDirectory?{mirrorDirectory:options.mirrorDirectory}:{})}});
    this.#ready=new Promise((resolve,reject)=>{
      const startup=setTimeout(()=>{reject(new Error('Backup worker startup timed out'));void this.#worker.terminate();},10_000);startup.unref();
      this.#worker.on('message',(message:{ready?:boolean;stopped?:boolean;done?:boolean;elapsedMs?:number;failed?:boolean;created?:boolean;mirrored?:boolean;rehearsed?:boolean})=>{
        if(message.ready){clearTimeout(startup);resolve();return;}if(message.stopped){this.#resolveStop?.();return;}
        if(message.done){this.#running=false;try{this.#options.onObservation?.({elapsedMs:message.elapsedMs??0,failed:message.failed===true,created:message.created===true,mirrored:message.mirrored===true,rehearsed:message.rehearsed===true});}catch{}if(message.failed)this.#fail();}
      });
      this.#worker.on('error',()=>{clearTimeout(startup);reject(new Error('Backup worker could not start'));this.#fail();});
      this.#worker.on('exit',()=>{clearTimeout(startup);reject(new Error('Backup worker exited'));this.#resolveStop?.();if(!this.#stopped){this.#stopped=true;if(this.#timer)clearInterval(this.#timer);this.#fail();}});
    });
    void this.#ready.catch(()=>undefined);
  }
  #fail():void {try{this.#options.onFailure?.();}catch{}}
  async start():Promise<void>{await this.#ready;if(this.#started||this.#stopped)return;this.#started=true;this.runDue();this.#timer=setInterval(()=>this.runDue(),60_000);this.#timer.unref();}
  runDue():void {if(this.#stopped||this.#running)return;this.#running=true;try{this.#worker.postMessage('RUN_DUE');}catch{this.#running=false;this.#fail();}}
  async stop():Promise<void>{
    if(this.#stopped)return;this.#stopped=true;if(this.#timer)clearInterval(this.#timer);
    try{await this.#ready;await new Promise<void>(resolve=>{const timeout=setTimeout(()=>{this.#fail();resolve();},30_000);this.#resolveStop=()=>{clearTimeout(timeout);resolve();};this.#worker.postMessage('STOP');});}
    finally{await this.#worker.terminate();}
  }
}
