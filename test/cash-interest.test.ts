import assert from 'node:assert/strict';
import test from 'node:test';
import { accumulateCashInterest, cashTimeInterest, settleTickCashInterest } from '../src/domain/cash-interest.js';
import { NumericBoundaryError, addFractions, decimalFraction, fraction, moneyFromAtoms, moneyToString, parseMoney, parseRate } from '../src/domain/numeric.js';
import { annualEffectiveRateForDays } from '../src/domain/rates.js';

test('AT-48 interest follows the old and new cash ownership intervals without intratick compounding', () => {
  let accrued = cashTimeInterest(parseMoney('10000'), '0.001', 150_000);
  accrued = accumulateCashInterest(accrued, parseMoney('1000'), '0.001', 150_000);
  const settled = settleTickCashInterest(accrued);
  assert.equal(moneyToString(settled.money), '5.5');
  assert.deepEqual(settled.carry, fraction(0n));
  assert.equal(moneyToString(settleTickCashInterest(cashTimeInterest(parseMoney('10000'), '0.001', 1000)).money), '0.033333333333');
  assert.equal(moneyToString(settleTickCashInterest(cashTimeInterest(parseMoney('10000'), '0.001', 300_000)).money), '10');
});

test('splitting an interval for queries or checkpoints preserves the exact interest', () => {
  const rate = annualEffectiveRateForDays(parseRate('0.025'), 1);
  const whole = cashTimeInterest(parseMoney('10000'), rate, 300_000);
  let split = fraction(0n);
  for (const elapsed of [1, 17, 999, 100_000, 198_983]) split = accumulateCashInterest(split, parseMoney('10000'), rate, elapsed);
  assert.deepEqual(split, whole);
  assert.deepEqual(settleTickCashInterest(split), settleTickCashInterest(whole));
});

test('tick-start rates apply piecewise and paid interest becomes principal only in the next tick', () => {
  const starting = parseMoney('1000');
  const first = settleTickCashInterest(cashTimeInterest(starting, '0.001', 300_000));
  const second = settleTickCashInterest(cashTimeInterest((starting + first.money).toString(), '0.002', 300_000), first.carry);
  assert.equal(moneyToString(first.money), '1');
  assert.equal(moneyToString(second.money), '2.002');
  assert.deepEqual(cashTimeInterest(starting, '0', 300_000), fraction(0n));
});

test('AT-49 tiny accruals conserve subatom carry across tick settlements', () => {
  let carry = fraction(0n);
  let paid = 0n;
  const exact = decimalFraction('0.0000000000004');
  for (let tick = 0; tick < 5; tick++) { const result = settleTickCashInterest(exact, carry); paid += result.money; carry = result.carry; }
  assert.equal(moneyToString(moneyFromAtoms(paid.toString())), '0.000000000002');
  assert.deepEqual(carry, fraction(0n));
  const twoParts = addFractions(cashTimeInterest('1', '0.4', 100_000), cashTimeInterest('1', '0.4', 200_000));
  assert.deepEqual(twoParts, exact);
});

test('untrusted cash, rate, duration and fractional carry fail before calculation', () => {
  for (const duration of [-1, 300_001, 0.5, Number.MAX_SAFE_INTEGER, Number.NaN]) {
    assert.throws(() => cashTimeInterest('1000', '0.01', duration), NumericBoundaryError);
  }
  for (const rate of ['-0.1', '2', 'NaN', '1e-1001']) assert.throws(() => cashTimeInterest('1000', rate, 1));
  assert.throws(() => cashTimeInterest('-1', '0.01', 1), NumericBoundaryError);
  assert.throws(() => settleTickCashInterest(fraction(1n), fraction(1n)), NumericBoundaryError);
});
