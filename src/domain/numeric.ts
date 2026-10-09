import { Decimal } from 'decimal.js';
import { z } from 'zod';

declare const moneyBrand: unique symbol;
declare const priceBrand: unique symbol;
declare const quantityBrand: unique symbol;
declare const rateBrand: unique symbol;
export type Money = bigint & { readonly [moneyBrand]: true };
export type Price = string & { readonly [priceBrand]: true };
export type Quantity = string & { readonly [quantityBrand]: true };
/** A dimensionless ratio, e.g. "0.03" means 3%; compounding validates its own domain. */
export type Rate = string & { readonly [rateBrand]: true };
export interface Fraction { readonly numerator: bigint; readonly denominator: bigint }

export const MONEY_SCALE = 1_000_000_000_000n;
export const QUANTITY_SCALE = 1_000_000n;
export const NUMERIC_POLICY = Object.freeze({
  precision: 50, inputLength: 96, maxAtomDigits: 50, inputExponent: 1000,
  minE: -2000, maxE: 2000, rounding: Decimal.ROUND_HALF_EVEN,
});

// A dedicated constructor isolates the engine from any other module's global settings.
export const FinancialDecimal = Decimal.clone({
  precision: NUMERIC_POLICY.precision, rounding: NUMERIC_POLICY.rounding,
  minE: NUMERIC_POLICY.minE, maxE: NUMERIC_POLICY.maxE,
  toExpNeg: -7, toExpPos: 21, modulo: Decimal.EUCLID, crypto: false,
});
const decimalInput = z.string().min(1).max(NUMERIC_POLICY.inputLength)
  .regex(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:e[+-]?\d{1,4})?$/);
const moneyInput = z.string().min(1).max(64).regex(/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/);
const atomInput = z.string().min(1).max(51).regex(/^(?:0|-?[1-9]\d*)$/);

export class NumericBoundaryError extends Error {
  constructor(message = 'Value exceeds the supported numeric representation') {
    super(message); this.name = 'NumericBoundaryError';
  }
}

function decimalValue(input: unknown): Decimal {
  const text = decimalInput.parse(input);
  // Inspect the lexical exponent before constructing Decimal: its minE can
  // otherwise silently turn a nonzero out-of-range input into zero.
  const [significand = '0', exponent = '0'] = text.replace(/^-/, '').split('e');
  const [whole = '0', decimals = ''] = significand.split('.');
  const firstNonzero = (whole + decimals).search(/[1-9]/);
  const scientificExponent = Number(exponent) + whole.length - 1 - firstNonzero;
  if (firstNonzero >= 0 && Math.abs(scientificExponent) > NUMERIC_POLICY.inputExponent) {
    throw new NumericBoundaryError();
  }
  const value = new FinancialDecimal(text);
  if (!value.isFinite() || value.sd() > NUMERIC_POLICY.precision
      || (!value.isZero() && Math.abs(value.e) > NUMERIC_POLICY.inputExponent)) {
    throw new NumericBoundaryError();
  }
  return value;
}

/** Check calculation overflow rather than replacing it with zero or a price floor. */
export function checkedDecimal(value: Decimal): Decimal {
  if (!value.isFinite() || (!value.isZero() && Math.abs(value.e) > NUMERIC_POLICY.inputExponent)) {
    throw new NumericBoundaryError();
  }
  return value;
}

export function moneyFromAtoms(input: unknown): Money {
  const text = atomInput.parse(input);
  if (text.replace('-', '').length > NUMERIC_POLICY.maxAtomDigits) throw new NumericBoundaryError();
  return BigInt(text) as Money;
}

export function parseMoney(input: unknown): Money {
  const text = moneyInput.parse(input);
  const negative = text.startsWith('-');
  const [whole = '0', decimal = ''] = (negative ? text.slice(1) : text).split('.');
  const atoms = BigInt(whole) * MONEY_SCALE + BigInt(decimal.padEnd(12, '0'));
  return moneyFromAtoms((negative ? -atoms : atoms).toString());
}

export function moneyToAtoms(value: Money): string { return moneyFromAtoms(value.toString()).toString(); }
export function moneyToString(value: Money): string {
  moneyFromAtoms(value.toString());
  const magnitude = value < 0n ? -value : value;
  const fraction = (magnitude % MONEY_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${value < 0n ? '-' : ''}${magnitude / MONEY_SCALE}${fraction ? `.${fraction}` : ''}`;
}

export function parsePrice(input: unknown): Price {
  const value = decimalValue(input);
  if (!value.gt('0')) throw new NumericBoundaryError('An active listing price must be positive');
  return value.toString() as Price;
}
export function parseQuantity(input: unknown): Quantity {
  const value = decimalValue(input);
  if (value.lt('0')) throw new NumericBoundaryError('Quantity cannot be negative');
  return value.toString() as Quantity;
}
export function parseOrderQuantity(input: unknown): Quantity {
  const text = z.string().max(64).regex(/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/).parse(input);
  const quantity = parseQuantity(text);
  if (quantity === '0') throw new NumericBoundaryError('Order quantity must be positive');
  return quantity;
}
export function parseRate(input: unknown): Rate { return decimalValue(input).toString() as Rate; }

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a; let y = b < 0n ? -b : b;
  while (y !== 0n) { const remainder = x % y; x = y; y = remainder; }
  return x;
}

export function fraction(numerator: bigint, denominator = 1n): Fraction {
  if (denominator <= 0n) throw new NumericBoundaryError('Fraction denominator must be positive');
  // Protect replay/settlement from unbounded values while allowing tiny price exponents.
  if (numerator.toString().length > 4096 || denominator.toString().length > 4096) {
    throw new NumericBoundaryError();
  }
  const divisor = gcd(numerator, denominator);
  return Object.freeze({ numerator: numerator / divisor, denominator: denominator / divisor });
}

/** Exact base-ten conversion. Number is used only for a bounded exponent, never a financial value. */
export function decimalFraction(input: string): Fraction {
  const text = decimalValue(input).toString();
  const [significand = '0', exponent = '0'] = text.split('e');
  const negative = significand.startsWith('-');
  const [whole = '0', digits = ''] = (negative ? significand.slice(1) : significand).split('.');
  const power = Number(exponent) - digits.length;
  let numerator = BigInt(whole + digits);
  if (negative) numerator = -numerator;
  return power >= 0 ? fraction(numerator * (10n ** BigInt(power)))
    : fraction(numerator, 10n ** BigInt(-power));
}
export function addFractions(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.denominator + b.numerator * a.denominator, a.denominator * b.denominator);
}
export function multiplyFractions(a: Fraction, b: Fraction): Fraction {
  return fraction(a.numerator * b.numerator, a.denominator * b.denominator);
}
export function negateFraction(value: Fraction): Fraction { return fraction(-value.numerator, value.denominator); }

/** Used for exact quantity replay; nonterminating cash remainders stay as fractions. */
export function fractionToCanonicalDecimal(value: Fraction): string {
  const normalized = fraction(value.numerator, value.denominator);
  let denominator = normalized.denominator; let twos = 0; let fives = 0;
  while (denominator % 2n === 0n) { denominator /= 2n; twos++; }
  while (denominator % 5n === 0n) { denominator /= 5n; fives++; }
  if (denominator !== 1n) throw new NumericBoundaryError('Fraction has no finite decimal representation');
  const places = Math.max(twos, fives);
  const scaled = normalized.numerator * 2n ** BigInt(places - twos) * 5n ** BigInt(places - fives);
  const absolute = (scaled < 0n ? -scaled : scaled).toString().padStart(places + 1, '0');
  const raw = places === 0 ? absolute : `${absolute.slice(0, -places)}.${absolute.slice(-places)}`;
  // Replay may accumulate more than 50 significant digits; preserve it or explicitly reject it.
  const valueDecimal = new FinancialDecimal(`${scaled < 0n ? '-' : ''}${raw}`);
  if (valueDecimal.sd() > NUMERIC_POLICY.precision) throw new NumericBoundaryError();
  return checkedDecimal(valueDecimal).toString();
}

export interface MoneySettlement {
  readonly money: Money;
  /** Settled cash minus exact cash, expressed in points. */
  readonly roundingAdjustment: Fraction;
}
export function quantizeMoney(exact: Fraction, direction: 'ceil' | 'floor'): MoneySettlement {
  const scaledNumerator = exact.numerator * MONEY_SCALE;
  let atoms = scaledNumerator / exact.denominator;
  const remainder = scaledNumerator % exact.denominator;
  if (direction === 'ceil' && remainder > 0n) atoms++;
  if (direction === 'floor' && remainder < 0n) atoms--;
  const money = moneyFromAtoms(atoms.toString());
  return { money, roundingAdjustment: addFractions(fraction(atoms, MONEY_SCALE), negateFraction(exact)) };
}

export function serializeFraction(value: Fraction): { numerator: string; denominator: string } {
  const normalized = fraction(value.numerator, value.denominator);
  return { numerator: normalized.numerator.toString(), denominator: normalized.denominator.toString() };
}
export function parseFraction(input: unknown): Fraction {
  const integer = z.string().min(1).max(4096).regex(/^(?:0|-?[1-9]\d*)$/);
  const stored = z.strictObject({
    numerator: integer,
    denominator: z.string().min(1).max(4096).regex(/^[1-9]\d*$/),
  }).parse(input);
  return fraction(BigInt(stored.numerator), BigInt(stored.denominator));
}
