import { z } from 'zod';
import {
  accountIdSchema, causeIdSchema, eventIdSchema, listingIdSchema,
  marketIdSchema, marketVersionSchema, orderIntentIdSchema, sequenceNoSchema,
  tickNoSchema, utcTimestampSchema,
} from '../domain/identifiers.js';
import { addFractions, decimalFraction, fractionToCanonicalDecimal, moneyFromAtoms, type Fraction } from '../domain/numeric.js';
import { FOUNDATION_ENGINE_VERSION, FOUNDATION_RULESET_VERSION, INITIAL_ACCOUNT_GRANT_ATOMS } from './constants.js';

export { INITIAL_ACCOUNT_GRANT_ATOMS } from './constants.js';

export class LedgerIntegrityError extends Error {
  constructor(message = 'Account journal integrity check failed.') {
    super(message);
    this.name = 'LedgerIntegrityError';
  }
}

const metadataSchema = z.object({
  journal_id: eventIdSchema,
  event_id: eventIdSchema,
  cause_id: causeIdSchema,
  market_id: marketIdSchema,
  account_id: accountIdSchema,
  tick_no: tickNoSchema,
  market_version: marketVersionSchema,
  sequence_no: sequenceNoSchema.refine((value) => value > 0),
  engine_version: z.literal(FOUNDATION_ENGINE_VERSION),
  ruleset_version: z.literal(FOUNDATION_RULESET_VERSION),
  created_at: utcTimestampSchema,
  related_order_id: orderIntentIdSchema.nullable(),
});

export const cashJournalRowSchema = metadataSchema.extend({
  entry_type: z.enum(['INITIAL_GRANT', 'TRADE', 'DIVIDEND', 'INTEREST', 'LIQUIDATION', 'REVERSAL', 'ROUNDING']),
  account_delta_atoms: z.string().min(1).max(51),
  system_delta_atoms: z.string().min(1).max(51),
  system_account: z.enum(['INITIAL_CAPITAL', 'BROKER', 'DIVIDEND', 'INTEREST', 'LIQUIDATION', 'ROUNDING']),
  currency: z.literal('PAPERMARKET_POINT'),
});

export const positionJournalRowSchema = metadataSchema.extend({
  listing_id: listingIdSchema,
  quantity_delta: z.string().min(1).max(128),
  system_quantity_delta: z.string().min(1).max(128),
  cost_delta_atoms: z.string().min(1).max(51),
});

export type CashJournalRow = z.input<typeof cashJournalRowSchema>;
export type PositionJournalRow = z.input<typeof positionJournalRowSchema>;

export interface ReplayedPosition {
  readonly quantity: Fraction;
  readonly costAtoms: bigint;
}

export interface ReplayedAccount {
  readonly accountId: string;
  readonly cashAtoms: bigint;
  readonly positions: ReadonlyMap<string, ReplayedPosition>;
}

function atoms(value: string): bigint {
  // The money parser validates canonical integer text and the 50-digit bound.
  return BigInt(moneyFromAtoms(value));
}

/** Pure exact replay; no SQLite arithmetic or floating point settlement. */
export function replayJournal(input: {
  readonly accountId: string;
  readonly marketId: string;
  readonly cashRows: readonly unknown[];
  readonly positionRows: readonly unknown[];
  readonly accountCreatedAt?: string;
  readonly maximumMetadata?: { readonly tickNo: number; readonly marketVersion: number; readonly sequenceNo: number };
}): ReplayedAccount {
  try {
    const accountId = accountIdSchema.parse(input.accountId);
    const marketId = marketIdSchema.parse(input.marketId);
    const accountCreatedAt = input.accountCreatedAt === undefined ? undefined : utcTimestampSchema.parse(input.accountCreatedAt);
    const maximum = input.maximumMetadata === undefined ? undefined : z.strictObject({
      tickNo: tickNoSchema, marketVersion: marketVersionSchema, sequenceNo: sequenceNoSchema,
    }).parse(input.maximumMetadata);
    function metadataIsWithinBounds(row: z.output<typeof metadataSchema>): boolean {
      return (accountCreatedAt === undefined || row.created_at >= accountCreatedAt) &&
        (maximum === undefined || (row.tick_no <= maximum.tickNo && row.market_version <= maximum.marketVersion && row.sequence_no <= maximum.sequenceNo));
    }
    let cashAtoms = 0n;
    let grants = 0;
    let previousCashSequence = -1;
    let previousPositionSequence = -1;
    let previousCashTimestamp = '';
    let previousPositionTimestamp = '';
    const cashEvents = new Set<string>();
    const positionEvents = new Set<string>();
    const positions = new Map<string, ReplayedPosition>();

    for (const raw of input.cashRows) {
      const row = cashJournalRowSchema.parse(raw);
      if (row.account_id !== accountId || row.market_id !== marketId ||
          row.sequence_no < previousCashSequence || row.created_at < previousCashTimestamp ||
          !metadataIsWithinBounds(row) || cashEvents.has(row.event_id)) {
        throw new LedgerIntegrityError();
      }
      previousCashSequence = row.sequence_no;
      previousCashTimestamp = row.created_at;
      cashEvents.add(row.event_id);
      const delta = atoms(row.account_delta_atoms);
      if (delta + atoms(row.system_delta_atoms) !== 0n) throw new LedgerIntegrityError();
      if (row.entry_type === 'INITIAL_GRANT') {
        grants += 1;
        if (cashEvents.size !== 1 || delta !== INITIAL_ACCOUNT_GRANT_ATOMS || row.system_account !== 'INITIAL_CAPITAL') throw new LedgerIntegrityError();
      } else if (grants !== 1) {
        throw new LedgerIntegrityError('Initial grant must precede financial movements.');
      }
      cashAtoms += delta;
      if (cashAtoms < 0n) throw new LedgerIntegrityError('Account cash cannot be negative.');
      moneyFromAtoms(cashAtoms.toString());
    }
    if (grants !== 1) throw new LedgerIntegrityError('Account requires exactly one initial grant.');

    for (const raw of input.positionRows) {
      const row = positionJournalRowSchema.parse(raw);
      const eventKey = JSON.stringify([row.event_id, row.listing_id]);
      if (row.account_id !== accountId || row.market_id !== marketId ||
          row.sequence_no < previousPositionSequence || row.created_at < previousPositionTimestamp ||
          !metadataIsWithinBounds(row) || positionEvents.has(eventKey)) {
        throw new LedgerIntegrityError();
      }
      previousPositionSequence = row.sequence_no;
      previousPositionTimestamp = row.created_at;
      positionEvents.add(eventKey);
      const delta = decimalFraction(row.quantity_delta);
      const systemDelta = decimalFraction(row.system_quantity_delta);
      if (row.quantity_delta !== fractionToCanonicalDecimal(delta) || row.system_quantity_delta !== fractionToCanonicalDecimal(systemDelta) ||
          addFractions(delta, systemDelta).numerator !== 0n) throw new LedgerIntegrityError();
      const previous = positions.get(row.listing_id) ?? { quantity: { numerator: 0n, denominator: 1n }, costAtoms: 0n };
      const quantity = addFractions(previous.quantity, delta);
      const costAtoms = previous.costAtoms + atoms(row.cost_delta_atoms);
      if (quantity.numerator < 0n || costAtoms < 0n || (quantity.numerator === 0n && costAtoms !== 0n)) {
        throw new LedgerIntegrityError('Account quantity and remaining cost must be consistent.');
      }
      moneyFromAtoms(costAtoms.toString());
      positions.set(row.listing_id, Object.freeze({ quantity: Object.freeze(quantity), costAtoms }));
    }
    return Object.freeze({ accountId, cashAtoms, positions });
  } catch (error) {
    if (error instanceof LedgerIntegrityError) throw error;
    throw new LedgerIntegrityError();
  }
}
