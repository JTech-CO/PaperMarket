import { z } from 'zod';

// Names and symbols are display values; permanent keys have distinct brands.
const opaqueId = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]{1,64}$/);
export const marketIdSchema = opaqueId.brand<'MarketId'>();
export const issuerIdSchema = opaqueId.brand<'IssuerId'>();
export const listingIdSchema = opaqueId.brand<'ListingId'>();
export const accountIdSchema = opaqueId.brand<'AccountId'>();
export const orderIntentIdSchema = opaqueId.brand<'OrderIntentId'>();
export const eventIdSchema = opaqueId.brand<'EventId'>();
export const causeIdSchema = opaqueId.brand<'CauseId'>();

const uint64Max = (1n << 64n) - 1n;
export const discordSnowflakeSchema = z.string().regex(/^[1-9][0-9]{16,19}$/)
  .refine((value) => /^[1-9][0-9]{16,19}$/.test(value) && BigInt(value) <= uint64Max,
    'Snowflake exceeds uint64')
  .brand<'DiscordSnowflake'>();

const safeNonnegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const tickNoSchema = safeNonnegativeInteger.brand<'TickNo'>();
export const marketVersionSchema = safeNonnegativeInteger.brand<'MarketVersion'>();
export const accountVersionSchema = safeNonnegativeInteger.brand<'AccountVersion'>();
export const sequenceNoSchema = safeNonnegativeInteger.brand<'SequenceNo'>();

const version = z.string().min(1).max(64).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const engineVersionSchema = version.brand<'EngineVersion'>();
export const rulesetVersionSchema = version.brand<'RulesetVersion'>();
export const slotIdSchema = z.enum(['O1', 'O2', 'O3', 'G1', 'G2', 'T1', 'T2', 'D1']);
export const issuerCategorySchema = z.enum(['ORDINARY', 'GROWTH', 'THEMATIC', 'DIVIDEND']);
export const marketStatusSchema = z.enum([
  'INITIALIZING', 'OPEN', 'UPDATING', 'PAUSED', 'RECOVERING', 'ARCHIVED',
]);

// Require one canonical UTC representation, including milliseconds.
export const utcTimestampSchema = z.string().max(24)
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const milliseconds = Date.parse(value);
    return Number.isFinite(milliseconds) && new Date(milliseconds).toISOString() === value;
  }, 'Invalid UTC timestamp')
  .brand<'UtcTimestamp'>();

export type MarketId = z.infer<typeof marketIdSchema>;
export type IssuerId = z.infer<typeof issuerIdSchema>;
export type ListingId = z.infer<typeof listingIdSchema>;
export type AccountId = z.infer<typeof accountIdSchema>;
export type OrderIntentId = z.infer<typeof orderIntentIdSchema>;
export type EventId = z.infer<typeof eventIdSchema>;
export type CauseId = z.infer<typeof causeIdSchema>;
export type DiscordSnowflake = z.infer<typeof discordSnowflakeSchema>;
export type TickNo = z.infer<typeof tickNoSchema>;
export type MarketVersion = z.infer<typeof marketVersionSchema>;
export type AccountVersion = z.infer<typeof accountVersionSchema>;
export type SequenceNo = z.infer<typeof sequenceNoSchema>;
export type EngineVersion = z.infer<typeof engineVersionSchema>;
export type RulesetVersion = z.infer<typeof rulesetVersionSchema>;
export type UtcTimestamp = z.infer<typeof utcTimestampSchema>;
export type SlotId = z.infer<typeof slotIdSchema>;
export type IssuerCategory = z.infer<typeof issuerCategorySchema>;
export type MarketStatus = z.infer<typeof marketStatusSchema>;

export const parseMarketId = (input: unknown): MarketId => marketIdSchema.parse(input);
export const parseIssuerId = (input: unknown): IssuerId => issuerIdSchema.parse(input);
export const parseListingId = (input: unknown): ListingId => listingIdSchema.parse(input);
export const parseAccountId = (input: unknown): AccountId => accountIdSchema.parse(input);
export const parseOrderIntentId = (input: unknown): OrderIntentId => orderIntentIdSchema.parse(input);
export const parseEventId = (input: unknown): EventId => eventIdSchema.parse(input);
export const parseCauseId = (input: unknown): CauseId => causeIdSchema.parse(input);
export const parseDiscordSnowflake = (input: unknown): DiscordSnowflake => discordSnowflakeSchema.parse(input);
export const parseTickNo = (input: unknown): TickNo => tickNoSchema.parse(input);
export const parseMarketVersion = (input: unknown): MarketVersion => marketVersionSchema.parse(input);
export const parseAccountVersion = (input: unknown): AccountVersion => accountVersionSchema.parse(input);
export const parseSequenceNo = (input: unknown): SequenceNo => sequenceNoSchema.parse(input);
export const parseEngineVersion = (input: unknown): EngineVersion => engineVersionSchema.parse(input);
export const parseRulesetVersion = (input: unknown): RulesetVersion => rulesetVersionSchema.parse(input);
export const parseUtcTimestamp = (input: unknown): UtcTimestamp => utcTimestampSchema.parse(input);
