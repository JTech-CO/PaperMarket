import { FinancialDecimal, NumericBoundaryError, checkedDecimal, parseRate } from './numeric.js';
import type { Rate } from './numeric.js';

export const VIRTUAL_DAYS_PER_YEAR = 252;
export const VIRTUAL_DAYS_PER_QUARTER = 63;
export const TICK_SECONDS = 300;

/** Inputs and output are ratios; all compounding uses the virtual calendar. */
export function annualEffectiveRateForDays(annualRate: Rate, days: number): Rate {
  if (!Number.isSafeInteger(days) || days < 0 || days > 1_000_000) throw new NumericBoundaryError('Invalid virtual day count');
  const annual = new FinancialDecimal(parseRate(annualRate));
  if (annual.lte('-1')) throw new NumericBoundaryError('Effective annual rate must exceed -100%');
  const exponent = new FinancialDecimal(days.toString()).div(VIRTUAL_DAYS_PER_YEAR.toString());
  const compounded = annual.plus('1').pow(exponent);
  if (compounded.isZero()) throw new NumericBoundaryError('Compounding underflow');
  const result = checkedDecimal(compounded.minus('1'));
  if ((days > 0 && !annual.isZero() && result.isZero()) || result.lte('-1')) {
    throw new NumericBoundaryError('Compounding exceeds the supported precision');
  }
  return parseRate(result.toString());
}
export function dailyEffectiveRateToAnnual(dailyRate: Rate): Rate {
  const daily = new FinancialDecimal(parseRate(dailyRate));
  if (daily.lte('-1')) throw new NumericBoundaryError('Effective daily rate must exceed -100%');
  const compounded = daily.plus('1').pow(VIRTUAL_DAYS_PER_YEAR.toString());
  if (compounded.isZero()) throw new NumericBoundaryError('Compounding underflow');
  const result = checkedDecimal(compounded.minus('1'));
  if ((!daily.isZero() && result.isZero()) || result.lte('-1')) {
    throw new NumericBoundaryError('Compounding exceeds the supported precision');
  }
  return parseRate(result.toString());
}
