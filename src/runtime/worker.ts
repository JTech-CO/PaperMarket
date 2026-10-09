import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { BrokerRepository } from '../broker/repository.js';
import type { ServiceRequest } from '../application/contracts.js';
import { openDatabase } from '../storage/index.js';
import { readOperationalState } from '../ops/metrics.js';

const hexSecret = z.string().regex(/^[a-f0-9]{64,128}$/).refine((text) => text.length % 2 === 0);
const options = z.strictObject({ databasePath: z.string().max(4096), identityKeyHex: hexSecret,
  economySeedHex: hexSecret.optional(),validationClockOffsetMs:z.number().int().min(0).max(30*366*86_400_000).optional() }).parse(workerData);
const port = parentPort;
if (!port) throw new Error('Repository worker requires a parent');
const database = openDatabase(options.databasePath);
// Used only by local validation launchers. The live runtime supplies no offset.
const now=()=>new Date(Date.now()+(options.validationClockOffsetMs??0)).toISOString();
const broker = new BrokerRepository(database, { now }, {
  identityKey: Buffer.from(options.identityKeyHex, 'hex'),
  ...(options.economySeedHex ? { economySeed: Buffer.from(options.economySeedHex, 'hex') } : {}),
  onDiagnostic:(diagnostic)=>port.postMessage({diagnostic}),
});
const recovered = broker.dispatch({ type: 'recover', now: now() });
if (recovered.kind === 'ERROR') { database.close(); throw new Error('Repository recovery failed'); }
const healthInterval=setInterval(()=>{try{port.postMessage({operationalState:readOperationalState(options.databasePath,now())});}catch{port.postMessage({operationalState:null});}},60_000);healthInterval.unref();

port.on('message', (message: { id: number; request?: ServiceRequest; shutdown?: true }) => {
  if (message.shutdown) { clearInterval(healthInterval);database.close(); port.postMessage({ id: message.id, shutdown: true }); port.close(); return; }
  if (!Number.isSafeInteger(message.id) || !message.request) return;
  const startedAt=performance.now();
  try { const response=broker.dispatch(message.request);port.postMessage({ id: message.id, response,serviceMs:performance.now()-startedAt }); }
  catch { port.postMessage({ id: message.id, response: { kind: 'ERROR', code: 'INTERNAL_ERROR' } }); }
});
port.postMessage({ ready: true });
