import {
  NumericBoundaryError, MONEY_SCALE, addFractions, decimalFraction, fraction, moneyFromAtoms,
  multiplyFractions, parseRate, type Fraction, type Money, type Rate,
} from './numeric.js';
import { settleAccrual } from './settlement.js';

const TICK_MILLISECONDS = 300_000;

function validateAccrual(value: Fraction): Fraction {
  if (typeof value.numerator !== 'bigint' || typeof value.denominator !== 'bigint' ||
      value.denominator <= 0n || value.numerator < 0n ||
      value.numerator.toString().length > 4096 || value.denominator.toString().length > 4096) {
    throw new NumericBoundaryError('Invalid cash-interest fraction');
  }
  return fraction(value.numerator, value.denominator);
}

/** Exact points, using the rate fixed at the start of a virtual day. Reserved cash is included. */
export function cashTimeInterest(
  cashAtoms: Money | string, dailyRate: Rate | string, activeElapsedMilliseconds: number,
): Fraction {
  const cash = moneyFromAtoms(typeof cashAtoms === 'bigint' ? cashAtoms.toString() : cashAtoms);
  const rate = decimalFraction(parseRate(dailyRate));
  if (cash < 0n || rate.numerator < 0n || rate.numerator > rate.denominator ||
      !Number.isSafeInteger(activeElapsedMilliseconds) || activeElapsedMilliseconds < 0 ||
      activeElapsedMilliseconds > TICK_MILLISECONDS) {
    throw new NumericBoundaryError('Invalid cash-interest interval');
  }
  return multiplyFractions(multiplyFractions(fraction(cash, MONEY_SCALE), rate),
    fraction(BigInt(activeElapsedMilliseconds), BigInt(TICK_MILLISECONDS)));
}

/** Accumulate without paying interest or adding it to the principal during this tick. */
export function accumulateCashInterest(
  accrued: Fraction, cashAtoms: Money | string, dailyRate: Rate | string, activeElapsedMilliseconds: number,
): Fraction {
  return addFractions(validateAccrual(accrued), cashTimeInterest(cashAtoms, dailyRate, activeElapsedMilliseconds));
}

/** Pay whole money atoms once at the boundary; preserve the exact subatom remainder. */
export function settleTickCashInterest(accrued: Fraction, carry: Fraction = fraction(0n)): {
  readonly money: Money; readonly carry: Fraction;
} {
  const validatedCarry = validateAccrual(carry);
  if (validatedCarry.numerator * MONEY_SCALE >= validatedCarry.denominator) {
    throw new NumericBoundaryError('Cash-interest carry must be less than one money atom');
  }
  return settleAccrual(validateAccrual(accrued), validatedCarry);
}
