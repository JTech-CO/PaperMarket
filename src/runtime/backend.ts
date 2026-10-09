import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Backend, ServiceRequest, ServiceResponse } from '../application/contracts.js';
import { RequestGate } from './backpressure.js';
import { ProcessLock } from './process-lock.js';
import type { OperationalState } from '../ops/metrics.js';
import { validateFilesystemPath } from './paths.js';

export interface BackendObservation {
  readonly operation:'QUERY'|'FINANCIAL'|'TICK'|'BACKGROUND';readonly elapsedMs:number;
  readonly serviceMs?:number;readonly queueAndTransportMs?:number;readonly pending:number;
  readonly outcome:'OK'|'ERROR'|'BUSY';readonly gateRejected:boolean;readonly integrityFailure:boolean;
}
function operation(request:ServiceRequest):BackendObservation['operation'] {
  if(request.type==='tick')return 'TICK';
  if(!('context' in request))return 'BACKGROUND';
  return ['setup','open','confirm','cancel','cancel-order','close','save-board'].includes(request.type)?'FINANCIAL':'QUERY';
}

export class WorkerBackend implements Backend {
  readonly #worker: Worker;
  readonly #lock: ProcessLock;
  readonly #gate = new RequestGate();
  readonly #pending = new Map<number, { resolve: (response: ServiceResponse) => void; leave: () => void;startedAt:number;operation:BackendObservation['operation'] }>();
  readonly #onObservation:((observation:BackendObservation)=>void)|undefined;
  readonly #ready: Promise<void>;
  #id = 0;
  #closed = false;
  #shutdownResolve: (() => void) | undefined;

  constructor(options: { databasePath: string; identityKey: Buffer; economySeed?: Buffer; onUnexpectedExit?: () => void;onObservation?:(observation:BackendObservation)=>void;onDiagnostic?:(code:'ZERO_CORPORATE_REFERENCE'|'ECONOMIC_TICK_FAILED')=>void;validationClockOffsetMs?:number;onOperationalState?:(state:OperationalState|null)=>void }) {
    this.#onObservation=options.onObservation;
    if(options.validationClockOffsetMs!==undefined&&(!Number.isSafeInteger(options.validationClockOffsetMs)||options.validationClockOffsetMs<0||options.validationClockOffsetMs>30*366*86_400_000))throw new RangeError('Invalid validation clock offset');
    validateFilesystemPath(options.databasePath,'FILE');
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.#lock = new ProcessLock(options.databasePath);
    this.#lock.acquire();
    try {
      this.#worker = new Worker(new URL('./worker.js', import.meta.url), {
        workerData: { databasePath: options.databasePath, identityKeyHex: options.identityKey.toString('hex'),
          ...(options.economySeed ? { economySeedHex: options.economySeed.toString('hex') } : {}),...(options.validationClockOffsetMs===undefined?{}:{validationClockOffsetMs:options.validationClockOffsetMs}) },
      });
    } catch (error) { this.#lock.release(); throw error; }
    this.#ready = new Promise<void>((resolve, reject) => {
      const startupTimeout = setTimeout(() => {
        reject(new Error('Repository worker startup timed out'));
        void this.#worker.terminate();
      }, 60_000);
      startupTimeout.unref();
      this.#worker.once('error', () => reject(new Error('Repository worker could not start')));
      this.#worker.on('message', (message: { ready?: true; id?: number; response?: ServiceResponse; shutdown?: true;serviceMs?:number;diagnostic?:'ZERO_CORPORATE_REFERENCE'|'ECONOMIC_TICK_FAILED';operationalState?:OperationalState|null }) => {
        if('operationalState' in message){try{options.onOperationalState?.(message.operationalState??null);}catch{}return;}
        if(message.diagnostic==='ZERO_CORPORATE_REFERENCE'||message.diagnostic==='ECONOMIC_TICK_FAILED'){try{options.onDiagnostic?.(message.diagnostic);}catch{}return;}
        if (message.ready) { clearTimeout(startupTimeout); resolve(); return; }
        if (message.shutdown) { this.#shutdownResolve?.(); return; }
        if (message.id === undefined || !message.response) return;
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id); pending.leave();
        const elapsedMs=performance.now()-pending.startedAt;
        const serviceMs=typeof message.serviceMs==='number'&&Number.isFinite(message.serviceMs)&&message.serviceMs>=0?Math.min(elapsedMs,message.serviceMs):undefined;
        this.#observe({operation:pending.operation,elapsedMs,pending:this.#pending.size,outcome:message.response.kind==='ERROR'?(message.response.code==='BUSY'?'BUSY':'ERROR'):'OK',gateRejected:false,integrityFailure:message.response.kind==='ERROR'&&message.response.code==='INTEGRITY_ERROR',...(serviceMs===undefined?{}:{serviceMs,queueAndTransportMs:Math.max(0,elapsedMs-serviceMs)})});
        pending.resolve(message.response);
      });
      this.#worker.once('exit', () => {
        clearTimeout(startupTimeout);
        const unexpected = !this.#closed;
        this.#closed = true;
        this.#lock.release();
        reject(new Error('Repository worker exited'));
        for (const pending of this.#pending.values()) { pending.leave(); pending.resolve({ kind: 'ERROR', code: 'INTERNAL_ERROR' }); }
        this.#pending.clear(); this.#shutdownResolve?.();
        if (unexpected) options.onUnexpectedExit?.();
      });
    });
    // Startup failure is surfaced by start/execute, never as an unhandled rejection.
    void this.#ready.catch(() => undefined);
  }

  async start(): Promise<void> { await this.#ready; }
  #observe(observation:BackendObservation):void {try{this.#onObservation?.(observation);}catch{/* Telemetry never changes a financial result. */}}

  async execute(request: ServiceRequest): Promise<ServiceResponse> {
    const startedAt=performance.now();
    try { await this.#ready; } catch { return { kind: 'ERROR', code: 'INTERNAL_ERROR' }; }
    if (this.#closed) return { kind: 'ERROR', code: 'INTERNAL_ERROR' };
    const leave = this.#gate.enter(request);
    if (!leave) {this.#observe({operation:operation(request),elapsedMs:performance.now()-startedAt,pending:this.#pending.size,outcome:'BUSY',gateRejected:true,integrityFailure:false});return { kind: 'ERROR', code: 'BUSY' };}
    const id = ++this.#id;
    return new Promise<ServiceResponse>((resolve) => {
      this.#pending.set(id, { resolve, leave,startedAt,operation:operation(request) });
      try { this.#worker.postMessage({ id, request }); }
      catch { this.#pending.delete(id); leave(); resolve({ kind: 'ERROR', code: 'INTERNAL_ERROR' }); }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    try {
      await this.#ready;
      await new Promise<void>((resolve) => {
        const shutdownTimeout = setTimeout(resolve, 5_000);
        this.#shutdownResolve = () => { clearTimeout(shutdownTimeout); resolve(); };
        this.#worker.postMessage({ id: ++this.#id, shutdown: true });
      });
    } catch { /* Failed startup/exit is already represented in the caller's outcome. */ }
    finally { await this.#worker.terminate(); this.#lock.release(); }
  }
}
