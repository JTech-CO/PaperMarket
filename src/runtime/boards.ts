import type { MarketView } from '../application/contracts.js';

/** Public delivery is independent of commits; retain only the latest queued snapshot per market. */
export class MarketBoardPublisher {
  readonly #pending = new Map<string, MarketView>();
  readonly #deliver: (market: MarketView) => Promise<void>;
  readonly #onFailure: () => void;
  #running = false;
  #stopped = false;

  constructor(deliver: (market: MarketView) => Promise<void>, onFailure: () => void) {
    this.#deliver = deliver; this.#onFailure = onFailure;
  }
  enqueue(markets: readonly MarketView[]): void {
    if (this.#stopped) return;
    for (const market of markets) {
      if (!this.#pending.has(market.marketId) && this.#pending.size >= 32) continue;
      const prior = this.#pending.get(market.marketId);
      if (!prior || prior.marketVersion <= market.marketVersion) this.#pending.set(market.marketId, market);
    }
    if (!this.#running) void this.#drain();
  }
  stop(): void { this.#stopped = true; this.#pending.clear(); }
  async #drain(): Promise<void> {
    this.#running = true;
    try {
      while (!this.#stopped && this.#pending.size > 0) {
        const next = this.#pending.entries().next().value;
        if (!next) break;
        const [id, market] = next;
        this.#pending.delete(id);
        try { await this.#deliver(market); } catch { this.#onFailure(); }
      }
    } finally { this.#running = false; }
  }
}
