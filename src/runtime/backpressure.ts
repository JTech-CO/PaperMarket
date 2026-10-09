import type { ServiceRequest } from '../application/contracts.js';

/** Short-lived service protection, independent of quantities or daily trading rules. */
export class RequestGate {
  readonly #active = new Map<string, number>();
  readonly #bursts = new Map<string, { tokens: number; sampledAt: number }>();
  #total = 0;
  readonly #now: () => number;

  constructor(now: () => number = Date.now) { this.#now = now; }

  enter(request: ServiceRequest): (() => void) | null {
    const key = 'context' in request ? `${request.context.guildId}:${request.context.discordUserId}` : 'scheduler';
    const now = this.#now();
    for (const [oldKey, sample] of this.#bursts) {
      if (now - sample.sampledAt >= 60_000 && !this.#active.has(oldKey)) this.#bursts.delete(oldKey);
    }
    if (this.#total >= 256 || (this.#active.get(key) ?? 0) >= 8) return null;
    if ('context' in request) {
      if (!this.#bursts.has(key) && this.#bursts.size >= 10_000) return null;
      const prior = this.#bursts.get(key) ?? { tokens: 10, sampledAt: now };
      const tokens = Math.min(10, prior.tokens + Math.max(0, now - prior.sampledAt) * 0.005);
      this.#bursts.set(key, { tokens: tokens >= 1 ? tokens - 1 : tokens, sampledAt: now });
      if (tokens < 1) return null;
    }
    this.#total++;
    this.#active.set(key, (this.#active.get(key) ?? 0) + 1);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#total--;
      const left = (this.#active.get(key) ?? 1) - 1;
      if (left === 0) this.#active.delete(key); else this.#active.set(key, left);
    };
  }
}
