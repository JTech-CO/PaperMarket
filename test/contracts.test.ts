import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { inspect } from 'node:util';
import {
  createDurableCommandContext, eventEnvelopeSchema, orderRequestSchema,
  priceMarketInputSchema, PrivateEconomyState, publicStateSchema, quoteSnapshotSchema,
  referenceAdjustmentSchema, validateOrderIntent,
  type DurableCommandContext, type OrderIntent, type PriceMarketInput,
  type PublicState, type ValidatedOrderIntent,
} from '../src/domain/contracts.js';
import {
  discordSnowflakeSchema, issuerIdSchema, listingIdSchema, marketIdSchema,
  marketVersionSchema, sequenceNoSchema, slotIdSchema, tickNoSchema,
  utcTimestampSchema, type ListingId,
} from '../src/domain/identifiers.js';
import type { Money, Price } from '../src/domain/numeric.js';

const createdAt = '2026-10-03T12:00:00.000Z';
const publicFixture = {
  marketId: 'market-1', tickNo: 0, marketVersion: 0,
  engineVersion: '0.0.0', rulesetVersion: '0.0.0', publishedAt: createdAt,
  annualPolicyRate: '0.03',
  issuers: [{
    issuerId: 'issuer-HGI', listingId: 'listing-HGI', slotId: 'O1', category: 'ORDINARY',
    symbol: 'HGI', displayName: '한결산업', disclosures: [],
  }],
};

function command(overrides: Record<string, unknown> = {}): DurableCommandContext {
  return createDurableCommandContext({
    marketId: 'market-1', accountId: 'account-1',
    discordUserId: '10000000000000001', interactionId: '10000000000000002',
    sequenceNo: 1, receivedAt: createdAt, expectedMarketVersion: 0, ...overrides,
  });
}

function intent(overrides: Record<string, unknown> = {}) {
  return {
    orderIntentId: 'intent-1', marketId: 'market-1', accountId: 'account-1',
    discordUserId: '10000000000000001', expectedMarketVersion: 0,
    expiresAt: '2026-10-03T12:01:00.000Z',
    request: { listingId: 'listing-HGI', orderType: 'MARKET', side: 'BUY', quantity: '9.99' },
    ...overrides,
  };
}

test('permanent identifiers, Snowflakes and integer units reject unsafe boundaries', () => {
  assert.equal(issuerIdSchema.parse('issuer-1'), 'issuer-1');
  assert.equal(listingIdSchema.parse('listing_1'), 'listing_1');
  for (const input of ['', 'a'.repeat(65), ' id', 'issuer/1', '회사', 1]) {
    assert.equal(marketIdSchema.safeParse(input).success, false);
  }
  assert.equal(discordSnowflakeSchema.parse('18446744073709551615'), '18446744073709551615');
  for (const input of ['18446744073709551616', '00000000000000001', '1000000000000000', 'x', 1]) {
    assert.equal(discordSnowflakeSchema.safeParse(input).success, false);
  }
  for (const schema of [tickNoSchema, marketVersionSchema, sequenceNoSchema]) {
    assert.equal(schema.parse(0), 0);
    assert.equal(schema.parse(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER);
    for (const input of [-1, 0.1, Number.MAX_SAFE_INTEGER + 1, '1', NaN, Infinity]) {
      assert.equal(schema.safeParse(input).success, false);
    }
  }
  assert.equal(slotIdSchema.options.length, 8);
  assert.equal(slotIdSchema.safeParse('O4').success, false);
});

test('UTC timestamps have one exact representation and reject impossible dates', () => {
  assert.equal(utcTimestampSchema.parse(createdAt), createdAt);
  for (const input of [
    '2026-10-03T21:00:00.000+09:00', '2026-10-03T12:00:00Z',
    '2026-02-30T12:00:00.000Z', '2026-13-01T12:00:00.000Z', 'tomorrow', 1,
  ]) {
    assert.equal(utcTimestampSchema.safeParse(input).success, false);
  }
});

test('domain event envelope requires origin, sequence, clock and both versions', () => {
  const valid = {
    eventId: 'event-1', causeId: 'cause-1', marketId: 'market-1', tickNo: 0,
    marketVersion: 0, sequenceNo: 1, engineVersion: '0.0.0', rulesetVersion: '0.0.0', createdAt,
  };
  assert.equal(eventEnvelopeSchema.parse(valid).eventId, 'event-1');
  const { causeId: _causeId, ...noCause } = valid;
  assert.equal(eventEnvelopeSchema.safeParse(noCause).success, false);
  assert.equal(eventEnvelopeSchema.safeParse({ ...valid, seed: randomBytes(32) }).success, false);
});

test('untrusted order requests cannot set financial amounts, owners or receipt authority', () => {
  const valid = { listingId: 'listing-HGI', orderType: 'MARKET', side: 'BUY', quantity: '0.000001' };
  assert.equal(orderRequestSchema.parse(valid).quantity, '0.000001');
  for (const field of ['accountId', 'discordUserId', 'sequenceNo', 'receivedAt', 'fee', 'cash']) {
    assert.equal(orderRequestSchema.safeParse({ ...valid, [field]: 'forged' }).success, false);
  }
  for (const quantity of ['0', '-1', '0.0000001', '1e3', '9'.repeat(100), 1]) {
    assert.equal(orderRequestSchema.safeParse({ ...valid, quantity }).success, false);
  }
  assert.equal(orderRequestSchema.safeParse({ ...valid, orderType: 'STOP', side: 'BUY', stopPrice: '900' }).success, false);
  assert.equal(orderRequestSchema.parse({ ...valid, orderType: 'STOP', side: 'SELL', stopPrice: '900' }).orderType, 'STOP');
});

test('validated order intent requires matching server owner, market, version and live expiration', () => {
  const accepted = validateOrderIntent(intent(), command());
  assert.equal(accepted.accountId, 'account-1');
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.request), true);
  assert.throws(() => validateOrderIntent(intent({ accountId: 'account-2' }), command()), /ORDER_OWNER_MISMATCH/);
  assert.throws(() => validateOrderIntent(intent({ discordUserId: '10000000000000003' }), command()), /ORDER_OWNER_MISMATCH/);
  assert.throws(() => validateOrderIntent(intent({ marketId: 'market-2' }), command()), /ORDER_OWNER_MISMATCH/);
  assert.throws(() => validateOrderIntent(intent({ expectedMarketVersion: 1 }), command()), /STALE_QUOTE/);
  assert.throws(() => validateOrderIntent(intent({ expiresAt: createdAt }), command()), /ORDER_EXPIRED/);
  assert.throws(() => validateOrderIntent(intent(), command({ receivedAt: '2026-10-03T12:01:00.000Z' })), /ORDER_EXPIRED/);
});

test('public pricing projection excludes hidden state at all validated levels', () => {
  const accepted = publicStateSchema.parse(publicFixture);
  assert.equal(Object.isFrozen(accepted), true);
  assert.equal(Object.isFrozen(accepted.issuers), true);
  assert.equal(Object.isFrozen(accepted.issuers[0]), true);
  assert.equal(publicStateSchema.safeParse({ ...publicFixture, trueState: { futureOutcome: 'unreleased' } }).success, false);
  assert.equal(publicStateSchema.safeParse({
    ...publicFixture, issuers: [{ ...publicFixture.issuers[0], trueState: 'unreleased' }],
  }).success, false);
  const input = { publicState: accepted, previousPrices: [], referenceAdjustments: [] };
  assert.equal(priceMarketInputSchema.safeParse(input).success, true);
  assert.equal(priceMarketInputSchema.safeParse({ ...input, seed: randomBytes(32) }).success, false);
  const quote = {
    kind: 'ACTIVE', marketId: 'market-1', listingId: 'listing-HGI', tickNo: 0,
    marketVersion: 0, price: '1000', tradable: true, createdAt,
  };
  for (const overrides of [
    { marketId: 'another-market' }, { tickNo: 1 }, { marketVersion: 1 },
    { createdAt: '2026-10-03T12:00:00.001Z' },
  ]) assert.equal(priceMarketInputSchema.safeParse({ ...input, previousPrices: [{ ...quote, ...overrides }] }).success, false);
  assert.equal(priceMarketInputSchema.safeParse({ ...input, previousPrices: [quote, quote] }).success, false);
  const adjustment = { kind: 'ACTIVE', listingId: 'listing-HGI', causeId: 'cause-1', adjustedReferencePrice: '985' };
  assert.equal(priceMarketInputSchema.safeParse({ ...input, referenceAdjustments: [adjustment] }).success, true);
  assert.equal(priceMarketInputSchema.safeParse({ ...input, referenceAdjustments: [adjustment, adjustment] }).success, false);
  assert.equal(priceMarketInputSchema.safeParse({
    ...input, referenceAdjustments: [{ ...adjustment, listingId: 'unknown-listing' }],
  }).success, false);
  assert.equal(publicStateSchema.safeParse({
    ...publicFixture, issuers: [{
      ...publicFixture.issuers[0], disclosures: [{
        eventId: 'event-1', causeId: 'cause-1', publishedTick: 1,
        publishedAt: createdAt, title: 'Future report', summary: '',
      }],
    }],
  }).success, false);
  assert.equal(publicStateSchema.safeParse({
    ...publicFixture, issuers: [{ ...publicFixture.issuers[0], category: 'GROWTH' }],
  }).success, false);
  assert.equal(publicStateSchema.safeParse({
    ...publicFixture, issuers: [{ ...publicFixture.issuers[0], symbol: '1HGI' }],
  }).success, false);
});

test('zero equity and rights-only states have an explicit halt without a positive price floor', () => {
  const adjustment = { kind: 'HALTED', listingId: 'listing-HGI', causeId: 'cause-1', adjustedReferencePrice: null, reason: 'RIGHTS_ONLY' };
  assert.equal(referenceAdjustmentSchema.parse(adjustment).adjustedReferencePrice, null);
  assert.equal(referenceAdjustmentSchema.safeParse({ ...adjustment, adjustedReferencePrice: '0' }).success, false);
  const haltedQuote = {
    kind: 'HALTED', marketId: 'market-1', listingId: 'listing-HGI', tickNo: 0,
    marketVersion: 0, price: null, tradable: false, reason: 'EXTINGUISHED', createdAt,
  };
  assert.equal(quoteSnapshotSchema.parse(haltedQuote).price, null);
  assert.equal(quoteSnapshotSchema.safeParse({ ...haltedQuote, tradable: true }).success, false);
  assert.equal(referenceAdjustmentSchema.safeParse({
    kind: 'ACTIVE', listingId: 'listing-HGI', causeId: 'cause-1', adjustedReferencePrice: '0',
  }).success, false);
});

test('internal economy state does not serialize or inspect future information', () => {
  const state = new PrivateEconomyState({ trueState: { futureOutcome: 'unreleased' }, seed: randomBytes(32) });
  assert.equal(state.forEngine().trueState.futureOutcome, 'unreleased');
  assert.equal(JSON.stringify(state), '{"visibility":"PRIVATE"}');
  assert.equal(inspect(state), 'PrivateEconomyState { visibility: PRIVATE }');
});

// The compiler runs these boundary checks, while no unimplemented engine runs.
function staticBoundaries(state: PublicState, hidden: PrivateEconomyState<object>, rawIntent: OrderIntent) {
  // @ts-expect-error business issuers cannot be used as tradable listing identifiers
  const listing: ListingId = state.issuers[0]!.issuerId;
  // @ts-expect-error financial strings require the numeric parser
  const price: Price = '1000';
  // @ts-expect-error Number values cannot enter the money ledger
  const money: Money = 1000;
  // @ts-expect-error raw intent has not passed ownership, version and expiry checks
  const validated: ValidatedOrderIntent = rawIntent;
  const contaminated = { ...state, trueState: hidden };
  // @ts-expect-error hidden future state cannot be passed by structural widening
  const publicState: PublicState = contaminated;
  // @ts-expect-error an economy state is not a public pricing state
  const pricing: PriceMarketInput = { publicState: hidden, previousPrices: [], referenceAdjustments: [] };
  void listing; void price; void money; void validated; void publicState; void pricing;
}
void staticBoundaries;
