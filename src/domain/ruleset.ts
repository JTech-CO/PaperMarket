import { NUMERIC_POLICY, parseMoney, parsePrice, parseRate } from './numeric.js';

export const STANDARD_RULESET = Object.freeze({
  rulesetId: 'standard-v1', rulesetVersion: '1.0.0', engineVersion: '0.0.0',
  tickSeconds: 300, virtualDaysPerYear: 252, virtualDaysPerQuarter: 63,
  initialPrice: parsePrice('1000'), initialCash: parseMoney('10000'),
  slots: Object.freeze(['O1', 'O2', 'O3', 'G1', 'G2', 'T1', 'T2', 'D1'] as const),
  ordinaryReturnLimit: parseRate('0.3'), tradeFeeRate: parseRate('0.001'),
  corporateTaxRate: parseRate('0.2'), personalTaxRate: parseRate('0'),
  policyRateInitial: parseRate('0.03'), cashRateSpread: parseRate('-0.005'),
  orderQuantityStep: '0.000001', moneyAtom: '0.000000000001',
  quoteTtlSeconds: 30, defaultOrderTtlTicks: 21,
  dividendExOffset: 3, dividendPaymentOffset: 5,
  unscheduledEventMean: '0.35', eventCatalogSize: 240,
  decimalPrecision: NUMERIC_POLICY.precision,
  priceFloor: null, userMarketImpact: '0', liquidityQuantityLimit: null, autoSeasonReset: false,
});
