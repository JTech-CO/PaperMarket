import { z } from 'zod';
import { listingIdSchema } from './identifiers.js';
import {
  addFractions, decimalFraction, fractionToCanonicalDecimal, moneyFromAtoms, multiplyFractions,
  parseFraction, parseOrderQuantity, parsePrice, parseQuantity, parseRate, serializeFraction,
} from './numeric.js';
import { maxAffordableQuantity, settleAccrual, settleBuy } from './settlement.js';

export interface ReferencePosition { readonly listingId: string; readonly quantity: string; readonly costAtoms: string }
export interface ReferenceLiquidationRight extends ReferencePosition { readonly estimatedRecoveryPerShare: string }
export interface ReferenceStrategyState {
  readonly cashAtoms: string; readonly realizedProfitAtoms: string;
  readonly positions: readonly ReferencePosition[]; readonly liquidationRights: readonly ReferenceLiquidationRight[];
  readonly settlementCarry?: { readonly numerator: string; readonly denominator: string };
}
const atom = z.string().max(51).refine((value) => { try { moneyFromAtoms(value); return true; } catch { return false; } });
const nonnegativeAtoms = atom.refine((value) => BigInt(value) >= 0n);
const quantity = z.string().max(96).refine((value) => { try { parseQuantity(value); return true; } catch { return false; } });
const mark = z.string().max(96).refine((value) => { try { return !parseRate(value).startsWith('-'); } catch { return false; } });
const position = z.strictObject({ listingId: listingIdSchema, quantity, costAtoms: nonnegativeAtoms });
const stateSchema = z.strictObject({ cashAtoms: nonnegativeAtoms, realizedProfitAtoms: atom,
  positions: z.array(position).max(64), liquidationRights: z.array(position.extend({ estimatedRecoveryPerShare: mark })).max(256),
  settlementCarry: z.strictObject({ numerator: z.string().max(4096), denominator: z.string().max(4096) })
    .refine((value) => { try { const carry = parseFraction(value); return carry.numerator >= 0n && carry.numerator * 1_000_000_000_000n < carry.denominator; } catch { return false; } })
    .default({ numerator: '0', denominator: '1' }),
}).refine((state) => new Set(state.positions.map((value) => value.listingId)).size === state.positions.length
  && new Set(state.liquidationRights.map((value) => value.listingId)).size === state.liquidationRights.length);

/** Removal preserves cost and claims. Merely seeing a replacement grants nothing. */
export function retireReferenceListing(input: ReferenceStrategyState, listingId: string, estimatedRecoveryPerShare: string): ReferenceStrategyState {
  const state = stateSchema.parse(input); listingIdSchema.parse(listingId); mark.parse(estimatedRecoveryPerShare);
  const held = state.positions.find((position) => position.listingId === listingId);
  if (!held) return state;
  if (state.liquidationRights.some((right) => right.listingId === listingId)) throw new Error('REFERENCE_DUPLICATE_LIQUIDATION_RIGHT');
  return Object.freeze({ ...state, positions: state.positions.filter((position) => position.listingId !== listingId),
    liquidationRights: [...state.liquidationRights, { ...held, estimatedRecoveryPerShare: parseRate(estimatedRecoveryPerShare) }] });
}

/** A final zero recovery records the original loss; it does not reset principal. */
export function settleReferenceLiquidation(input: ReferenceStrategyState, listingId: string, realizedRecoveryPerShare: string): ReferenceStrategyState {
  const state = stateSchema.parse(input); listingIdSchema.parse(listingId); mark.parse(realizedRecoveryPerShare);
  const right = state.liquidationRights.find((right) => right.listingId === listingId);
  if (!right) throw new Error('REFERENCE_UNKNOWN_LIQUIDATION_RIGHT');
  const settlement = settleAccrual(multiplyFractions(decimalFraction(right.quantity), decimalFraction(realizedRecoveryPerShare)), parseFraction(state.settlementCarry));
  const cash = settlement.money;
  return Object.freeze({ ...state, cashAtoms: moneyFromAtoms((BigInt(state.cashAtoms) + cash).toString()).toString(),
    realizedProfitAtoms: moneyFromAtoms((BigInt(state.realizedProfitAtoms) + cash - BigInt(right.costAtoms)).toString()).toString(),
    liquidationRights: state.liquidationRights.filter((right) => right.listingId !== listingId), settlementCarry: serializeFraction(settlement.carry) });
}

/** The later PM8 rebalance can reuse normal fee-inclusive cash-funded settlement. */
export function buyReferenceReplacement(input: ReferenceStrategyState, order: Readonly<{
  listingId: string; price: string; budgetAtoms: string; feeRate: string;
}>): ReferenceStrategyState {
  const state = stateSchema.parse(input); listingIdSchema.parse(order.listingId);
  const budget = moneyFromAtoms(order.budgetAtoms);
  if (budget <= 0n || budget > BigInt(state.cashAtoms) || state.liquidationRights.some((right) => right.listingId === order.listingId)) throw new Error('REFERENCE_BUDGET_OR_LISTING_INVALID');
  const price = parsePrice(order.price); const fee = parseRate(order.feeRate);
  const quantity = maxAffordableQuantity(budget, price, fee); const settlement = settleBuy(price, parseOrderQuantity(quantity), fee);
  const previous = state.positions.find((position) => position.listingId === order.listingId);
  const newPosition = { listingId: order.listingId, quantity: previous
    ? fractionToCanonicalDecimal(addFractions(decimalFraction(previous.quantity), decimalFraction(quantity))) : quantity,
    costAtoms: moneyFromAtoms(((previous ? BigInt(previous.costAtoms) : 0n) + settlement.money).toString()).toString() };
  return Object.freeze({ ...state, cashAtoms: moneyFromAtoms((BigInt(state.cashAtoms) - settlement.money).toString()).toString(),
    positions: [...state.positions.filter((position) => position.listingId !== order.listingId), newPosition] });
}
