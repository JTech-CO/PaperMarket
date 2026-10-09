import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { z } from 'zod';

const lockSchema = z.strictObject({
  pid: z.number().int().positive().max(2_147_483_647),
  nonce: z.string().uuid(),
});
function parseOwner(text: string): z.infer<typeof lockSchema> | undefined {
  if (text.length > 256) return undefined;
  try { const parsed = lockSchema.safeParse(JSON.parse(text)); return parsed.success ? parsed.data : undefined; }
  catch { return undefined; }
}

export class WriterAlreadyRunningError extends Error {
  constructor() { super('A database writer already owns this file'); this.name = 'WriterAlreadyRunningError'; }
}

/** Local-file ownership, in addition to SQLite transactions. Never kill another owner. */
export class ProcessLock {
  readonly #path: string;
  readonly #nonce = randomUUID();
  #held = false;

  constructor(databasePath: string) { this.#path = `${databasePath}.writer-lock`; }

  acquire(): void {
    if (this.#held) throw new WriterAlreadyRunningError();
    // Serialise stale-file recovery too: two recovering processes must never
    // unlink each other's newly acquired writer file. A crashed acquisition
    // guard requires operator inspection, rather than unsafe automatic stealing.
    const guardPath = `${this.#path}.acquire`;
    let guard: number;
    try { guard = openSync(guardPath, 'wx', 0o600); }
    catch { throw new WriterAlreadyRunningError(); }
    try {
      writeFileSync(guard, JSON.stringify({ pid: process.pid, nonce: this.#nonce }), 'utf8');
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const descriptor = openSync(this.#path, 'wx', 0o600);
        try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, nonce: this.#nonce }), 'utf8'); }
        finally { closeSync(descriptor); }
        this.#held = true;
        return;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error;
      }
      const ownerText = readFileSync(this.#path, 'utf8');
      const owner = parseOwner(ownerText);
      if (!owner) throw new WriterAlreadyRunningError();
      try { process.kill(owner.pid, 0); throw new WriterAlreadyRunningError(); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ESRCH') throw new WriterAlreadyRunningError();
      }
      // Recheck identity before removing this exact stale file. No directory traversal/deletion.
      if (readFileSync(this.#path, 'utf8') !== ownerText) throw new WriterAlreadyRunningError();
      unlinkSync(this.#path);
    }
    throw new WriterAlreadyRunningError();
    } finally { closeSync(guard); unlinkSync(guardPath); }
  }

  release(): void {
    if (!this.#held) return;
    if (existsSync(this.#path)) {
      const text = readFileSync(this.#path, 'utf8');
      const owner = parseOwner(text);
      if (owner?.pid === process.pid && owner.nonce === this.#nonce) unlinkSync(this.#path);
    }
    this.#held = false;
  }
}
