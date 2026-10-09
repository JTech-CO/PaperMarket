import { inspect } from 'node:util';
import { z } from 'zod';
import {
  accountIdSchema, causeIdSchema, discordSnowflakeSchema,
  engineVersionSchema, eventIdSchema, issuerCategorySchema, issuerIdSchema,
  listingIdSchema, marketIdSchema, marketVersionSchema, orderIntentIdSchema,
  rulesetVersionSchema, sequenceNoSchema, slotIdSchema, tickNoSchema,
  utcTimestampSchema,
  type AccountId, type AccountVersion, type CauseId, type EventId,
  type IssuerId, type ListingId, type MarketId, type SlotId, type TickNo, type UtcTimestamp,
} from './identifiers.js';
import {
  parseOrderQuantity, parsePrice, parseRate, type Fraction, type Money, type Price,
  type Quantity, type Rate,
} from './numeric.js';
import type { DeterministicRandom } from './random.js';

function decimalSchema<T extends string>(parser: (input: unknown) => T, name: string) {
  return z.string().max(256).transform((value, context): T => {
    try {
      return parser(value);
    } catch {
      context.addIssue({ code: 'custom', message: `Invalid ${name}` });
      return z.NEVER;
    }
  });
}

const priceSchema = decimalSchema(parsePrice, 'price');
const rateSchema = decimalSchema(parseRate, 'rate');
const orderQuantitySchema = decimalSchema(parseOrderQuantity, 'order quantity');

export const eventEnvelopeSchema = z.strictObject({
  eventId: eventIdSchema,
  causeId: causeIdSchema,
  marketId: marketIdSchema,
  tickNo: tickNoSchema,
  marketVersion: marketVersionSchema,
  sequenceNo: sequenceNoSchema,
  engineVersion: engineVersionSchema,
  rulesetVersion: rulesetVersionSchema,
  createdAt: utcTimestampSchema,
});
export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
export type DomainEvent<TPayload> = Readonly<EventEnvelope & {
  eventType: string;
  payload: TPayload;
}>;

/** Construct only after authentication, durable receipt and server sequencing. */
export const durableCommandContextSchema = z.strictObject({
  marketId: marketIdSchema,
  accountId: accountIdSchema,
  discordUserId: discordSnowflakeSchema,
  interactionId: discordSnowflakeSchema,
  sequenceNo: sequenceNoSchema,
  receivedAt: utcTimestampSchema,
  expectedMarketVersion: marketVersionSchema,
}).readonly().brand<'DurableCommandContext'>();
export type DurableCommandContext = z.infer<typeof durableCommandContextSchema>;

export function createDurableCommandContext(input: unknown): DurableCommandContext {
  return durableCommandContextSchema.parse(input);
}

// Untrusted order data cannot assign an account, identity, receipt time or sequence.
const requestFields = { listingId: listingIdSchema, quantity: orderQuantitySchema };
export const orderRequestSchema = z.discriminatedUnion('orderType', [
  z.strictObject({ ...requestFields, orderType: z.literal('MARKET'), side: z.enum(['BUY', 'SELL']) }),
  z.strictObject({
    ...requestFields, orderType: z.literal('LIMIT'), side: z.enum(['BUY', 'SELL']), limitPrice: priceSchema,
  }),
  z.strictObject({
    ...requestFields, orderType: z.literal('STOP'), side: z.literal('SELL'), stopPrice: priceSchema,
  }),
]);
export type OrderRequest = z.infer<typeof orderRequestSchema>;

export const orderIntentSchema = z.strictObject({
  orderIntentId: orderIntentIdSchema,
  marketId: marketIdSchema,
  accountId: accountIdSchema,
  discordUserId: discordSnowflakeSchema,
  expectedMarketVersion: marketVersionSchema,
  expiresAt: utcTimestampSchema,
  request: orderRequestSchema,
});
export type OrderIntent = z.infer<typeof orderIntentSchema>;
declare const validatedIntentBrand: unique symbol;
export type ValidatedOrderIntent = Readonly<OrderIntent> & { readonly [validatedIntentBrand]: true };

/** Bind an already durable command to its owner before the broker sees it. */
export function validateOrderIntent(input: unknown, command: DurableCommandContext): ValidatedOrderIntent {
  const context = durableCommandContextSchema.parse(command);
  const intent = orderIntentSchema.parse(input);
  if (intent.marketId !== context.marketId || intent.accountId !== context.accountId
    || intent.discordUserId !== context.discordUserId) {
    throw new Error('ORDER_OWNER_MISMATCH');
  }
  if (intent.expectedMarketVersion !== context.expectedMarketVersion) throw new Error('STALE_QUOTE');
  if (Date.parse(intent.expiresAt) <= Date.parse(context.receivedAt)) throw new Error('ORDER_EXPIRED');
  Object.freeze(intent.request);
  return Object.freeze(intent) as ValidatedOrderIntent;
}

export const publicDisclosureSchema = z.strictObject({
  eventId: eventIdSchema,
  causeId: causeIdSchema,
  publishedTick: tickNoSchema,
  publishedAt: utcTimestampSchema,
  title: z.string().min(1).max(120),
  summary: z.string().max(4_000),
}).readonly();
export type PublicDisclosure = z.infer<typeof publicDisclosureSchema>;

export const publicIssuerSchema = z.strictObject({
  issuerId: issuerIdSchema,
  listingId: listingIdSchema,
  slotId: slotIdSchema,
  category: issuerCategorySchema,
  symbol: z.string().min(1).max(12).regex(/^[A-Z][A-Z0-9]{0,11}$/),
  displayName: z.string().min(1).max(100),
  disclosures: z.array(publicDisclosureSchema).max(256).readonly(),
}).readonly();

/** Only disclosed facts cross this boundary; hidden forecasts have no field. */
export const publicStateSchema = z.strictObject({
  marketId: marketIdSchema,
  tickNo: tickNoSchema,
  marketVersion: marketVersionSchema,
  engineVersion: engineVersionSchema,
  rulesetVersion: rulesetVersionSchema,
  publishedAt: utcTimestampSchema,
  annualPolicyRate: rateSchema,
  issuers: z.array(publicIssuerSchema).max(8).readonly(),
}).superRefine((state, context) => {
  const slots = new Set<string>();
  const listings = new Set<string>();
  const issuers = new Set<string>();
  for (const issuer of state.issuers) {
    const expectedCategory = issuer.slotId.startsWith('O') ? 'ORDINARY'
      : issuer.slotId.startsWith('G') ? 'GROWTH'
        : issuer.slotId.startsWith('T') ? 'THEMATIC' : 'DIVIDEND';
    if (issuer.category !== expectedCategory) {
      context.addIssue({ code: 'custom', message: 'Issuer category must match its slot' });
    }
    if (slots.has(issuer.slotId) || listings.has(issuer.listingId) || issuers.has(issuer.issuerId)) {
      context.addIssue({ code: 'custom', message: 'Public issuer keys must be unique' });
    }
    slots.add(issuer.slotId);
    listings.add(issuer.listingId);
    issuers.add(issuer.issuerId);
    for (const disclosure of issuer.disclosures) {
      if (disclosure.publishedTick > state.tickNo || disclosure.publishedAt > state.publishedAt) {
        context.addIssue({ code: 'custom', message: 'Future information cannot be public' });
      }
    }
  }
}).readonly();
export type PublicState = Readonly<z.infer<typeof publicStateSchema>> & {
  readonly trueState?: never;
  readonly seed?: never;
};

/** An internal state can be read by an engine, but cannot serialize its data. */
export class PrivateEconomyState<TState> {
  readonly #state: TState;

  constructor(state: TState) {
    this.#state = state;
  }

  forEngine(): TState { return this.#state; }
  toJSON(): Readonly<{ visibility: 'PRIVATE' }> { return Object.freeze({ visibility: 'PRIVATE' }); }
  [inspect.custom](): string { return 'PrivateEconomyState { visibility: PRIVATE }'; }
}

const quoteFields = {
  marketId: marketIdSchema,
  listingId: listingIdSchema,
  tickNo: tickNoSchema,
  marketVersion: marketVersionSchema,
  createdAt: utcTimestampSchema,
};
const haltReasonSchema = z.enum(['RIGHTS_ONLY', 'EXTINGUISHED', 'LIQUIDATION']);
export const quoteSnapshotSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...quoteFields, kind: z.literal('ACTIVE'), price: priceSchema, tradable: z.boolean() }),
  z.strictObject({
    ...quoteFields, kind: z.literal('HALTED'), price: z.null(), tradable: z.literal(false), reason: haltReasonSchema,
  }),
]).readonly();
export type QuoteSnapshot = Readonly<z.infer<typeof quoteSnapshotSchema>>;

const referenceFields = {
  listingId: listingIdSchema,
  causeId: causeIdSchema,
};
export const referenceAdjustmentSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...referenceFields, kind: z.literal('ACTIVE'), adjustedReferencePrice: priceSchema }),
  z.strictObject({
    ...referenceFields, kind: z.literal('HALTED'), adjustedReferencePrice: z.null(), reason: haltReasonSchema,
  }),
]).readonly();
export type ReferenceAdjustment = Readonly<z.infer<typeof referenceAdjustmentSchema>>;

export const priceMarketInputSchema = z.strictObject({
  publicState: publicStateSchema,
  previousPrices: z.array(quoteSnapshotSchema).max(8),
  referenceAdjustments: z.array(referenceAdjustmentSchema).max(8),
}).superRefine((input, context) => {
  const previousListings = new Set<string>();
  for (const quote of input.previousPrices) {
    if (quote.marketId !== input.publicState.marketId
      || quote.marketVersion > input.publicState.marketVersion
      || quote.tickNo > input.publicState.tickNo
      || quote.createdAt > input.publicState.publishedAt) {
      context.addIssue({ code: 'custom', message: 'Previous quotes must belong to this committed market' });
    }
    if (previousListings.has(quote.listingId)) {
      context.addIssue({ code: 'custom', message: 'A listing must have at most one previous quote' });
    }
    previousListings.add(quote.listingId);
  }
  const currentListings = new Set(input.publicState.issuers.map((issuer) => issuer.listingId));
  const adjustedListings = new Set<string>();
  for (const adjustment of input.referenceAdjustments) {
    if (!currentListings.has(adjustment.listingId) || adjustedListings.has(adjustment.listingId)) {
      context.addIssue({ code: 'custom', message: 'Reference adjustments require one current listing each' });
    }
    adjustedListings.add(adjustment.listingId);
  }
});
export type PriceMarketInput = Readonly<z.infer<typeof priceMarketInputSchema>> & {
  readonly publicState: PublicState;
  readonly trueState?: never;
  readonly seed?: never;
};

export interface JournalDraft {
  readonly causeId: CauseId;
  readonly accountCode: string;
  readonly amount: Money;
}

export interface PublicationCandidate {
  readonly effectiveTick: EventEnvelope['tickNo'];
  readonly issuerId: z.infer<typeof issuerIdSchema>;
  readonly disclosure: PublicDisclosure;
}

export interface AdvanceEconomyInput<TState> {
  readonly previousState: PrivateEconomyState<TState>;
  readonly context: EventEnvelope;
  readonly random: DeterministicRandom;
}
export interface AdvanceEconomyResult<TState> {
  readonly state: PrivateEconomyState<TState>;
  readonly journals: readonly JournalDraft[];
  readonly publicCandidates: readonly PublicationCandidate[];
}
export type AdvanceEconomy<TState> = (input: AdvanceEconomyInput<TState>) => AdvanceEconomyResult<TState>;

export interface PublishInformationInput {
  readonly previousPublicState: PublicState;
  readonly context: EventEnvelope;
  readonly candidates: readonly PublicationCandidate[];
}
export type PublishInformation = (input: PublishInformationInput) => PublicState;

export interface PriceContribution {
  readonly listingId: ListingId;
  readonly component: 'PUBLIC_VALUATION' | 'RISK_PREMIUM' | 'SENTIMENT' | 'CORPORATE_ACTION';
  readonly returnContribution: Rate;
}
export interface PriceMarketResult {
  readonly prices: readonly QuoteSnapshot[];
  readonly contributions: readonly PriceContribution[];
}
export type PriceMarket = (input: PriceMarketInput) => PriceMarketResult;

export interface AccountPosition {
  readonly listingId: ListingId;
  readonly quantity: Quantity;
  readonly reservedQuantity: Quantity;
  readonly costBasis: Money;
}
export interface EntitlementState {
  readonly kind: 'DIVIDEND';
  readonly entitlementId: EventId;
  readonly causeId: CauseId;
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly originListingId: ListingId;
  readonly quantity: Quantity;
  readonly nominalAmount: Money;
  readonly markedAmount: Money;
  readonly receivedAmount: Money;
  readonly fractionalRemainder: Fraction;
  readonly recordTick: TickNo;
  readonly paymentTick: TickNo;
  readonly status: 'PENDING' | 'PARTIALLY_PAID' | 'PAID' | 'IMPAIRED' | 'CANCELLED';
}
export interface LiquidationClaimState {
  readonly kind: 'LIQUIDATION';
  readonly claimId: EventId;
  readonly causeId: CauseId;
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly originListingId: ListingId;
  readonly quantity: Quantity;
  readonly transferredCostBasis: Money;
  readonly nominalAmount: Money;
  readonly markedAmount: Money;
  readonly receivedAmount: Money;
  readonly fractionalRemainder: Fraction;
  readonly openedTick: TickNo;
  readonly status: 'PENDING' | 'PARTIALLY_PAID' | 'SETTLED';
}
export type AccountReceivable = EntitlementState | LiquidationClaimState;

export interface AccountState {
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly discordUserId: DurableCommandContext['discordUserId'];
  readonly accountVersion: AccountVersion;
  readonly cashTotal: Money;
  readonly cashReserved: Money;
  readonly positions: readonly AccountPosition[];
  readonly receivables: readonly AccountReceivable[];
}
export interface ExecuteOrderInput {
  readonly intent: ValidatedOrderIntent;
  readonly quote: QuoteSnapshot;
  readonly account: AccountState;
  readonly command: DurableCommandContext;
}
export interface ExecuteOrderResult {
  readonly account: AccountState;
  readonly journal: readonly JournalDraft[];
  readonly fill: {
    readonly orderIntentId: OrderIntent['orderIntentId'];
    readonly listingId: ListingId;
    readonly price: Price;
    readonly quantity: Quantity;
    readonly fee: Money;
    readonly marketVersion: EventEnvelope['marketVersion'];
  };
}
export type ExecuteOrder = (input: ExecuteOrderInput) => ExecuteOrderResult;

interface CorporateActionOrigin {
  readonly causeId: CauseId;
  readonly issuerId: IssuerId;
  readonly listingId: ListingId;
  readonly effectiveTick: EventEnvelope['tickNo'];
}
export type CorporateAction = CorporateActionOrigin & (
  | {
    readonly actionType: 'CASH_DIVIDEND';
    readonly phase: 'DECLARE' | 'EX_RIGHTS' | 'PAY';
    readonly dividendPerShare: Price;
    readonly recordTick: TickNo;
    readonly paymentTick: TickNo;
  }
  | {
    readonly actionType: 'EXTERNAL_ISSUANCE';
    readonly newEconomicShares: Quantity;
    readonly issuePrice: Price;
  }
  | {
    readonly actionType: 'DEBT_RESTRUCTURING';
    readonly newDebtPrincipal: Money;
    readonly annualInterestRate: Rate;
  }
  | {
    readonly actionType: 'LIQUIDATION';
    readonly phase: 'OPEN' | 'PAY' | 'CLOSE';
    readonly shareholderRecovery: Money;
  }
  | {
    readonly actionType: 'REPLACEMENT';
    readonly newIssuerId: IssuerId;
    readonly newListingId: ListingId;
    readonly slotId: SlotId;
    readonly initialPrice: Price;
  }
);

export interface IssuerCapitalizationState {
  readonly issuedShares: Quantity;
  readonly cash: Money;
  readonly reservedCash: Money;
  readonly dividendLiability: Money;
  readonly debtPrincipal: Money;
}

export interface SecurityMovementJournalDraft {
  readonly causeId: CauseId;
  readonly marketId: MarketId;
  readonly accountId: AccountId;
  readonly listingId: ListingId;
  readonly direction: 'INCREASE' | 'DECREASE';
  readonly quantity: Quantity;
  readonly transferredCostBasis: Money;
  readonly counterparty: 'SYSTEM_SECURITIES';
}

export interface IssuerCapitalizationChange {
  readonly causeId: CauseId;
  readonly issuerId: IssuerId;
  readonly listingId: ListingId;
  readonly before: IssuerCapitalizationState;
  readonly after: IssuerCapitalizationState;
}

export interface ListingLifecycleChange {
  readonly issuerId: IssuerId;
  readonly listingId: ListingId;
  readonly slotId: SlotId;
  readonly state: 'ACTIVE' | 'HALTED' | 'EXTINGUISHED';
  readonly replacedListingId?: ListingId;
}

export interface ApplyCorporateActionInput {
  readonly action: CorporateAction;
  readonly context: EventEnvelope;
  readonly issuerCapitalization: IssuerCapitalizationState;
  readonly accounts: readonly AccountState[];
}
export interface ApplyCorporateActionResult {
  readonly accounts: readonly AccountState[];
  readonly issuerChanges: readonly IssuerCapitalizationChange[];
  readonly listingChanges: readonly ListingLifecycleChange[];
  readonly referenceAdjustments: readonly ReferenceAdjustment[];
  readonly journal: readonly JournalDraft[];
  readonly securityJournal: readonly SecurityMovementJournalDraft[];
  readonly cancelledIntentIds: readonly OrderIntent['orderIntentId'][];
  readonly disclosures: readonly PublicDisclosure[];
}
export type ApplyCorporateAction = (input: ApplyCorporateActionInput) => ApplyCorporateActionResult;

export interface CommittedMarketReadModel {
  readonly publicState: PublicState;
  readonly prices: readonly QuoteSnapshot[];
  readonly committedAt: UtcTimestamp;
  readonly trueState?: never;
  readonly seed?: never;
}
export interface RenderedView {
  readonly title: string;
  readonly description: string;
  readonly fields: readonly { readonly name: string; readonly value: string }[];
  readonly footer: string;
}
export type RenderView = (input: CommittedMarketReadModel) => RenderedView;
