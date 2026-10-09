import { z } from 'zod';
import { parseUtcTimestamp, utcTimestampSchema, type UtcTimestamp } from './identifiers.js';

export const TICK_INTERVAL_MILLISECONDS = 300_000;
export const TICKS_PER_VIRTUAL_MONTH = 21;
export const TICKS_PER_VIRTUAL_QUARTER = 63;
export const TICKS_PER_VIRTUAL_YEAR = 252;

export interface Clock {
  now(): UtcTimestamp;
}

export class SystemClock implements Clock {
  now(): UtcTimestamp {
    return parseUtcTimestamp(new Date().toISOString());
  }
}

/** A monotonic, explicitly advanced UTC wall clock for domain tests. */
export class FakeClock implements Clock {
  #milliseconds: number;

  constructor(initial: unknown) {
    this.#milliseconds = Date.parse(parseUtcTimestamp(initial));
  }

  now(): UtcTimestamp {
    return parseUtcTimestamp(new Date(this.#milliseconds).toISOString());
  }

  advanceBy(milliseconds: number): UtcTimestamp {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError('Clock increments must be nonnegative integer milliseconds');
    }
    return this.set(new Date(this.#milliseconds + milliseconds).toISOString());
  }

  set(timestamp: unknown): UtcTimestamp {
    const next = parseUtcTimestamp(timestamp);
    const milliseconds = Date.parse(next);
    if (milliseconds < this.#milliseconds) throw new RangeError('Clock cannot move backwards');
    this.#milliseconds = milliseconds;
    return next;
  }
}

export const activeTickCheckpointSchema = z.strictObject({
  elapsedMilliseconds: z.number().int().min(0).max(TICK_INTERVAL_MILLISECONDS),
  paused: z.boolean(),
  checkpointAt: utcTimestampSchema,
});
export type ActiveTickCheckpoint = z.infer<typeof activeTickCheckpointSchema>;

/**
 * Measures one active interval. At most one tick can become due, even after a
 * wall-clock jump. Restoration rebases at now; an unverified offline gap is
 * never counted as economy time. The coordinator persists these checkpoints.
 */
export class ActiveTickClock {
  readonly #clock: Clock;
  #lastObservedMilliseconds: number;
  #elapsedMilliseconds: number;
  #paused: boolean;

  constructor(clock: Clock, checkpoint?: ActiveTickCheckpoint) {
    this.#clock = clock;
    const now = Date.parse(parseUtcTimestamp(clock.now()));
    const restored = checkpoint === undefined ? undefined : activeTickCheckpointSchema.parse(checkpoint);
    if (restored !== undefined && Date.parse(restored.checkpointAt) > now) {
      throw new RangeError('Checkpoint cannot be later than the recovery clock');
    }
    this.#lastObservedMilliseconds = now;
    this.#elapsedMilliseconds = restored?.elapsedMilliseconds ?? 0;
    this.#paused = restored?.paused ?? false;
  }

  elapsedMilliseconds(): number {
    this.#sample();
    return this.#elapsedMilliseconds;
  }

  remainingMilliseconds(): number {
    return TICK_INTERVAL_MILLISECONDS - this.elapsedMilliseconds();
  }

  pause(): void {
    this.#sample();
    this.#paused = true;
  }

  resume(): void {
    this.#sample();
    this.#paused = false;
  }

  checkpoint(): Readonly<ActiveTickCheckpoint> {
    this.#sample();
    return Object.freeze({
      elapsedMilliseconds: this.#elapsedMilliseconds,
      paused: this.#paused,
      checkpointAt: parseUtcTimestamp(new Date(this.#lastObservedMilliseconds).toISOString()),
    });
  }

  #sample(): void {
    const now = Date.parse(parseUtcTimestamp(this.#clock.now()));
    if (now < this.#lastObservedMilliseconds) throw new RangeError('Clock moved backwards');
    if (!this.#paused) {
      this.#elapsedMilliseconds = Math.min(TICK_INTERVAL_MILLISECONDS,
        this.#elapsedMilliseconds + (now - this.#lastObservedMilliseconds));
    }
    this.#lastObservedMilliseconds = now;
  }
}
