import assert from 'node:assert/strict';
import test from 'node:test';
import {
  FinancialDecimal, addFractions, decimalFraction, fraction, fractionToCanonicalDecimal,
  moneyFromAtoms, moneyToAtoms, moneyToString, parseFraction, parseMoney, parseOrderQuantity, parsePrice,
  parseQuantity, parseRate, quantizeMoney, serializeFraction,
} from '../src/domain/numeric.js';
import { annualEffectiveRateForDays, dailyEffectiveRateToAnnual } from '../src/domain/rates.js';
import { maxAffordableQuantity, settleAccrual, settleBuy, settleSell } from '../src/domain/settlement.js';

test('Money uses exact 10^-12 atoms and canonical lossless storage', () => {
  assert.equal(parseMoney('10000'), 10_000_000_000_000_000n);
  assert.equal(moneyToString(parseMoney('-12.000000000001')), '-12.000000000001');
  assert.equal(moneyToAtoms(parseMoney('0.000000000001')), '1');
  assert.equal(moneyToString(parseMoney('0')), '0');
  for (const value of ['01', '-0', '1e3', '1.0', '1'.repeat(51)]) assert.throws(() => moneyFromAtoms(value));
  for (const value of [1, NaN, Infinity, '1e3', '0.0000000000001', ' 1', '1'.repeat(64)]) assert.throws(() => parseMoney(value));
});
test('Price has no economic floor and rejects invalid or excessive representations', () => {
  assert.equal(parsePrice('1e-1000'), '1e-1000');
  assert.equal(parsePrice('0.000000000000001'), '1e-15');
  for (const value of [1000, 'NaN', 'Infinity', '0', '-1', '1e-1001', '1e1001', '1'.repeat(51)]) assert.throws(() => parsePrice(value));
});
test('User quantity step is distinct from internal entitlement precision', () => {
  assert.equal(parseOrderQuantity('9.990009'), '9.990009');
  assert.equal(parseQuantity('0.0000000001'), '1e-10');
  for (const value of ['0', '-1', '1e2', '0.0000001', 1]) assert.throws(() => parseOrderQuantity(value));
});
test('Nonzero out-of-range inputs cannot silently underflow to zero', () => {
  for (const value of ['1e-2001', '-1e-2001', '1e-9999', '1e9999']) {
    assert.throws(() => parseRate(value));
    assert.throws(() => parseQuantity(value));
  }
});
test('Decimal engine configuration is fixed and isolated', () => {
  assert.equal(FinancialDecimal.precision, 50);
  assert.equal(FinancialDecimal.rounding, FinancialDecimal.ROUND_HALF_EVEN);
  assert.equal(FinancialDecimal.minE, -2000);
  assert.equal(FinancialDecimal.maxE, 2000);
});
test('Fractions convert exactly and preserve values below the money atom', () => {
  assert.deepEqual(decimalFraction('1.25e-3'), fraction(1n, 800n));
  assert.equal(fractionToCanonicalDecimal(fraction(-1n, 800n)), '-0.00125');
  assert.deepEqual(serializeFraction(addFractions(fraction(1n, 3n), fraction(1n, 6n))), { numerator: '1', denominator: '2' });
  assert.throws(() => fractionToCanonicalDecimal(fraction(1n, 3n)));
  assert.throws(() => fraction(1n, 0n));
  assert.deepEqual(parseFraction(serializeFraction(fraction(1n, 3n))), fraction(1n, 3n));
  for (const stored of [
    { numerator: '1', denominator: '0' }, { numerator: '01', denominator: '1' },
    { numerator: '-0', denominator: '1' }, { numerator: 1, denominator: '3' },
    { numerator: '1', denominator: '3', seed: 'extra-field' },
  ]) assert.throws(() => parseFraction(stored));
});
test('Signed cash rounding uses mathematical ceil/floor', () => {
  assert.equal(quantizeMoney(fraction(-1n, 3n * 1_000_000_000_000n), 'ceil').money, 0n);
  assert.equal(quantizeMoney(fraction(-1n, 3n * 1_000_000_000_000n), 'floor').money, -1n);
});
test('Appendix C.1 identical-price roundtrip accounts for both fees', () => {
  const price = parsePrice('1000'); const quantity = parseOrderQuantity('9.99'); const fee = parseRate('0.001');
  const buy = settleBuy(price, quantity, fee); const sell = settleSell(price, quantity, fee);
  assert.equal(moneyToString(buy.money), '9999.99');
  assert.equal(moneyToString(sell.money), '9980.01');
  assert.equal(moneyToString(moneyFromAtoms((parseMoney('10000') - buy.money + sell.money).toString())), '9980.02');
});
test('Appendix C.7 budget quantity is maximal without exceeding available cash', () => {
  const budget = parseMoney('10000'); const price = parsePrice('1000'); const fee = parseRate('0.001');
  const quantity = maxAffordableQuantity(budget, price, fee);
  assert.equal(quantity, '9.990009');
  assert.equal(moneyToString(settleBuy(price, quantity, fee).money), '9999.999009');
  assert.ok(settleBuy(price, parseOrderQuantity('9.990010'), fee).money > budget);
});
test('Budget maximality holds across low and high prices including atom boundaries', () => {
  const fee = parseRate('0.001');
  for (const rawPrice of ['0.000001', '0.123456789123', '999.999999999999', '10000']) {
    const price = parsePrice(rawPrice);
    for (let whole = 1n; whole <= 20n; whole++) {
      const budget = parseMoney(whole.toString());
      const quantity = maxAffordableQuantity(budget, price, fee);
      const next = parseOrderQuantity(new FinancialDecimal(quantity).plus('0.000001').toFixed());
      assert.ok(settleBuy(price, quantity, fee).money <= budget);
      assert.ok(settleBuy(price, next, fee).money > budget);
    }
  }
});
test('Extremely small price is preserved but below-atom trades are rejected', () => {
  const price = parsePrice('1e-100'); const fee = parseRate('0.001');
  assert.throws(() => settleBuy(price, parseOrderQuantity('1'), fee));
  assert.equal(moneyToString(settleBuy(parsePrice('1e-15'), parseOrderQuantity('1000000'), fee).money), '0.000000001001');
});
test('Roundtrip has no positive cash gain across prices, quantities and fees', () => {
  for (let i = 1n; i <= 150n; i++) {
    const price = parsePrice(`${i}.1234567890123456789`);
    const quantity = parseOrderQuantity(`${i % 13n + 1n}.000001`);
    const fee = parseRate(i % 2n === 0n ? '0' : '0.001');
    const buy = settleBuy(price, quantity, fee); const sell = settleSell(price, quantity, fee);
    assert.ok(sell.money <= buy.money);
    assert.ok(buy.roundingAdjustment.numerator >= 0n);
    assert.ok(sell.roundingAdjustment.numerator <= 0n);
  }
});
test('Fractional accrual carry never loses or duplicates subatom payments', () => {
  const oneThirdAtom = fraction(1n, 3n * 1_000_000_000_000n);
  let carry = fraction(0n); let atoms = 0n;
  for (let i = 0; i < 300; i++) {
    const settled = settleAccrual(oneThirdAtom, carry); atoms += settled.money; carry = settled.carry;
  }
  assert.equal(atoms, 100n); assert.deepEqual(carry, fraction(0n));
});
test('AT-18 virtual effective annual/daily/quarter rates are consistent', () => {
  const annual = parseRate('0.025');
  const daily = annualEffectiveRateForDays(annual, 1);
  const recovered = dailyEffectiveRateToAnnual(daily);
  assert.ok(new FinancialDecimal(recovered).minus(annual).abs().lt('1e-45'));
  const quarter = annualEffectiveRateForDays(annual, 63);
  assert.ok(new FinancialDecimal(quarter).plus('1').pow('4').minus('1').minus(annual).abs().lt('1e-45'));
  assert.ok(new FinancialDecimal(daily).times('10000').minus('0.979914').abs().lt('0.000001'));
  assert.equal(annualEffectiveRateForDays(parseRate('0'), 1), '0');
  assert.throws(() => annualEffectiveRateForDays(parseRate('-1'), 1));
});
test('Effective-rate conversions explicitly fail precision cancellation and underflow', () => {
  for (const input of ['1e-100', '-1e-100']) {
    assert.throws(() => annualEffectiveRateForDays(parseRate(input), 1));
    assert.throws(() => dailyEffectiveRateToAnnual(parseRate(input)));
  }
  assert.throws(() => dailyEffectiveRateToAnnual(parseRate('-0.99999999999999999999999999999999999999999999999999')));
  assert.equal(annualEffectiveRateForDays(parseRate('1e-100'), 0), '0');
});
