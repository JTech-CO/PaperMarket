import { z } from 'zod';
import { BrokerRepository } from '../../src/broker/repository.js';
import type { ServiceRequest } from '../../src/application/contracts.js';
import { FakeClock } from '../../src/domain/clock.js';
import { openDatabase } from '../../src/storage/database.js';
import { ProcessLock } from '../../src/runtime/process-lock.js';

const commandSchema = z.strictObject({
  databasePath: z.string().min(1).max(4096), identityKey: z.string().regex(/^[a-f0-9]{64}$/u), economySeed: z.string().regex(/^[a-f0-9]{64}$/u),
  now: z.string().datetime(), phase: z.enum(['BEFORE_COMMIT','AFTER_COMMIT']), request: z.unknown(),
});
// Synthetic secrets arrive through local parent IPC, never argv, stdout or exceptions.
process.once('message', raw => {
  try {
    const command = commandSchema.parse(raw), lock = new ProcessLock(command.databasePath); lock.acquire();
    const db = openDatabase(command.databasePath), clock = new FakeClock(command.now);
    const broker = new BrokerRepository(db,clock,{ identityKey:Buffer.from(command.identityKey,'hex'), economySeed:Buffer.from(command.economySeed,'hex') });
    if (command.phase === 'BEFORE_COMMIT') db.exec('BEGIN IMMEDIATE');
    const response = broker.dispatch(command.request as ServiceRequest);
    if (response.kind !== 'FILLED' && response.kind !== 'TICKED') throw new Error('Unexpected synthetic result');
    // BEFORE: nested broker commits remain under the uncommitted outer transaction.
    // AFTER: the actual production broker transaction has committed, but no result
    // has been delivered to an interaction. Only this test synchronization marker leaves.
    process.send?.({ ready: command.phase, kind: response.kind });
    setInterval(()=>{},1000);
  } catch { process.send?.({ error:'CRASH_HELPER_FAILED' }); process.exitCode=1; process.disconnect?.(); }
});
