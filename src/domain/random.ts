import { createHmac } from 'node:crypto';
import { inspect } from 'node:util';
import { z } from 'zod';
import { engineVersionSchema, issuerIdSchema, tickNoSchema } from './identifiers.js';

export const RANDOM_ALGORITHM = 'papermarket-hmac-sha256-v1' as const;
export const randomContextSchema = z.strictObject({
  engineVersion: engineVersionSchema,
  tick: tickNoSchema,
  issuerId: issuerIdSchema,
  eventChannel: z.string().min(1).max(64).regex(/^[A-Za-z0-9._-]{1,64}$/),
  drawIndex: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
});
export type RandomContext = z.infer<typeof randomContextSchema>;

/** The versioned array representation prevents concatenation ambiguities. */
export function encodeRandomContext(input: unknown): string {
  const context = randomContextSchema.parse(input);
  return JSON.stringify([
    RANDOM_ALGORITHM, context.engineVersion, context.tick,
    context.issuerId, context.eventChannel, context.drawIndex,
  ]);
}

// n / 2^256 = n * 5^256 / 10^256: the fraction is exact, without Number.
const exactDecimalMultiplier = 5n ** 256n;

/** Public conversion vectors can be frozen without recording a market seed. */
export function digestToUniformDecimal(digest: Buffer): string {
  if (!Buffer.isBuffer(digest) || digest.length !== 32) throw new RangeError('A 256 bit digest is required');
  const numerator = BigInt(`0x${digest.toString('hex')}`);
  if (numerator === 0n) return '0';
  const digits = (numerator * exactDecimalMultiplier).toString().padStart(256, '0');
  return `0.${digits.replace(/0+$/, '')}`;
}

/** No mutable draw position: consumers can query in any order or replay. */
export class DeterministicRandom {
  readonly #secret: Buffer;

  constructor(secret: Buffer) {
    if (!Buffer.isBuffer(secret) || secret.length < 32 || secret.length > 64) {
      throw new RangeError('An externally supplied 32 to 64 byte market secret is required');
    }
    this.#secret = Buffer.from(secret);
  }

  digestHex(context: RandomContext): string {
    return createHmac('sha256', this.#secret).update(encodeRandomContext(context), 'utf8').digest('hex');
  }

  uniform(context: RandomContext): string {
    return digestToUniformDecimal(Buffer.from(this.digestHex(context), 'hex'));
  }

  toJSON(): Readonly<{ algorithm: typeof RANDOM_ALGORITHM }> {
    return Object.freeze({ algorithm: RANDOM_ALGORITHM });
  }

  [inspect.custom](): string {
    return `DeterministicRandom { algorithm: '${RANDOM_ALGORITHM}' }`;
  }
}
