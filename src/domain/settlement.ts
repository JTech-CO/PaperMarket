import {
  FinancialDecimal, MONEY_SCALE, QUANTITY_SCALE, NumericBoundaryError, addFractions, decimalFraction, fraction,
  fractionToCanonicalDecimal, multiplyFractions, parseOrderQuantity, parsePrice, parseRate, quantizeMoney,
} from './numeric.js';
import type { Fraction, Money, MoneySettlement, Price, Quantity, Rate } from './numeric.js';

export interface TradeArithmetic extends MoneySettlement {
  readonly gross: Fraction;
  readonly fee: Fraction;
}
function tradeAmounts(price: Price, quantity: Quantity, feeRate: Rate): { gross: Fraction; fee: Fraction } {
  // Revalidate at the calculation boundary; brands are not a runtime security boundary.
  const gross = multiplyFractions(decimalFraction(parsePrice(price)), decimalFraction(parseOrderQuantity(quantity)));
  const rate = decimalFraction(parseRate(feeRate));
  if (rate.numerator < 0n || rate.numerator >= rate.denominator) {
    throw new NumericBoundaryError('Trade fee must be at least zero and less than one');
  }
  if (gross.numerator * MONEY_SCALE < gross.denominator) {
    throw new NumericBoundaryError('Trade value is below a settlement atom');
  }
  return { gross, fee: multiplyFractions(gross, rate) };
}
/** Pure settlement arithmetic; this does not execute or authorize an order. */
export function settleBuy(price: Price, quantity: Quantity, feeRate: Rate): TradeArithmetic {
  const amounts = tradeAmounts(price, quantity, feeRate);
  return { ...amounts, ...quantizeMoney(addFractions(amounts.gross, amounts.fee), 'ceil') };
}
export function settleSell(price: Price, quantity: Quantity, feeRate: Rate): TradeArithmetic {
  const amounts = tradeAmounts(price, quantity, feeRate);
  return { ...amounts, ...quantizeMoney(addFractions(amounts.gross, fraction(-amounts.fee.numerator, amounts.fee.denominator)), 'floor') };
}
export function maxAffordableQuantity(budget: Money, price: Price, feeRate: Rate): Quantity {
  if (budget <= 0n) throw new NumericBoundaryError('Budget must be positive');
  const rate = decimalFraction(parseRate(feeRate));
  if (rate.numerator < 0n || rate.numerator >= rate.denominator) throw new NumericBoundaryError('Invalid fee');
  const unitCost = multiplyFractions(decimalFraction(parsePrice(price)), addFractions(fraction(1n), rate));
  const steps = (budget * unitCost.denominator * QUANTITY_SCALE) / (MONEY_SCALE * unitCost.numerator);
  if (steps === 0n) throw new NumericBoundaryError('Budget cannot cover the minimum order step');
  const quantity = parseOrderQuantity(new FinancialDecimal(fractionToCanonicalDecimal(fraction(steps, QUANTITY_SCALE))).toFixed());
  if (settleBuy(price, quantity, feeRate).money > budget) throw new NumericBoundaryError('Budget invariant failed');
  return quantity;
}

/** Carry atom fractions exactly; no repeated rounding up or silent disposal of interest. */
export function settleAccrual(exact: Fraction, carry: Fraction = fraction(0n)): {
  readonly money: Money; readonly carry: Fraction;
} {
  const total = addFractions(exact, carry);
  if (total.numerator < 0n) throw new NumericBoundaryError('Accrual must be nonnegative');
  const settled = quantizeMoney(total, 'floor');
  return { money: settled.money, carry: fraction(-settled.roundingAdjustment.numerator, settled.roundingAdjustment.denominator) };
}
