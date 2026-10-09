import assert from 'node:assert/strict';
import test from 'node:test';
import { parseMoney } from '../src/domain/numeric.js';
import { INITIAL_COMPANIES, createInitialListings, validateInitialCompanies } from '../src/fixtures/index.js';

test('initial listings preserve the specified eight-company universe and classification', () => {
  assert.deepEqual(createInitialListings().map(({ slotId, category, symbol, price }) => ({ slotId, category, symbol, price })), [
    { slotId: 'O1', category: 'ORDINARY', symbol: 'HGI', price: '1000' },
    { slotId: 'O2', category: 'ORDINARY', symbol: 'DNL', price: '1000' },
    { slotId: 'O3', category: 'ORDINARY', symbol: 'TLR', price: '1000' },
    { slotId: 'G1', category: 'GROWTH', symbol: 'NXC', price: '1000' },
    { slotId: 'G2', category: 'GROWTH', symbol: 'VTR', price: '1000' },
    { slotId: 'T1', category: 'THEMATIC', symbol: 'AUR', price: '1000' },
    { slotId: 'T2', category: 'THEMATIC', symbol: 'LMB', price: '1000' },
    { slotId: 'D1', category: 'DIVIDEND', symbol: 'RVI', price: '1000' },
  ]);
  for (const listing of createInitialListings()) assert.notEqual(listing.issuerId, listing.listingId);
});

test('corporate money converts the whitepaper eok amounts to points exactly', () => {
  const expected = [
    ['HGI', '1400000000', '500000000', '900000000', '200000000', '300000000', '120000000', '1000000', '1000000000'],
    ['DNL', '1000000000', '300000000', '700000000', '150000000', '160000000', '100000000', '800000', '800000000'],
    ['TLR', '1800000000', '800000000', '1000000000', '180000000', '600000000', '100000000', '1200000', '1200000000'],
    ['NXC', '900000000', '200000000', '700000000', '350000000', '100000000', '0', '2000000', '2000000000'],
    ['VTR', '1400000000', '600000000', '800000000', '250000000', '400000000', '0', '1500000', '1500000000'],
    ['AUR', '600000000', '200000000', '400000000', '200000000', '100000000', '0', '1000000', '1000000000'],
    ['LMB', '500000000', '100000000', '400000000', '240000000', '50000000', '0', '1000000', '1000000000'],
    ['RVI', '2200000000', '1200000000', '1000000000', '240000000', '1000000000', '150000000', '1000000', '1000000000'],
  ];
  assert.deepEqual(INITIAL_COMPANIES.map((company) => [company.symbol, company.totalAssets, company.totalLiabilities, company.totalEquity, company.cash, company.interestBearingDebt, company.distributableProfit, company.issuedShares, company.initialMarketCapitalization]), expected);
  assert.doesNotThrow(() => validateInitialCompanies(INITIAL_COMPANIES));
});

test('opening account detail balances without adding cash or retained profits twice', () => {
  for (const company of INITIAL_COMPANIES) {
    const sum = (entries: readonly { amount: string }[]) => entries.reduce((total, entry) => total + parseMoney(entry.amount), 0n);
    assert.equal(sum(company.balanceSheet.assets), parseMoney(company.totalAssets));
    assert.equal(sum(company.balanceSheet.liabilities), parseMoney(company.totalLiabilities));
    assert.equal(sum(company.balanceSheet.equity), parseMoney(company.totalEquity));
    assert.equal(parseMoney(company.totalAssets), parseMoney(company.totalLiabilities) + parseMoney(company.totalEquity));
    assert.equal(company.balanceSheet.assets.find((item) => item.code === 'cash')?.amount, company.cash);
    assert.equal(company.balanceSheet.equity.find((item) => item.code === 'distributable_retained_earnings')?.amount, company.distributableProfit);
  }
});

test('annual operating assumptions match every whitepaper company row', () => {
  assert.deepEqual(INITIAL_COMPANIES.map((company) => [company.symbol, company.annualRevenue, company.operatingMargin, company.annualBorrowingRate, company.fixedDebtFraction, company.nominalRevenueGrowth, company.targetPayoutRatio]), [
    ['HGI', '1800000000', '0.12', '0.05', '0.6', '0.04', '0.25'],
    ['DNL', '1200000000', '0.1', '0.045', '0.7', '0.03', '0.35'],
    ['TLR', '2200000000', '0.12', '0.06', '0.5', '0.03', '0.15'],
    ['NXC', '800000000', '-0.05', '0.065', '0.4', '0.18', '0'],
    ['VTR', '1000000000', '0.03', '0.06', '0.5', '0.12', '0'],
    ['AUR', '120000000', '-0.8', '0.08', '0.3', null, '0'],
    ['LMB', '30000000', '-3', '0.09', '0.3', null, '0'],
    ['RVI', '800000000', '0.25', '0.075', '0.75', '0.02', '0.6'],
  ]);
});

test('eight equal maturity tranches preserve every company fixed and variable debt share', () => {
  const fractions = ['0.6', '0.7', '0.5', '0.4', '0.5', '0.3', '0.3', '0.75'];
  for (const [index, company] of INITIAL_COMPANIES.entries()) {
    assert.equal(company.fixedDebtFraction, fractions[index]);
    assert.deepEqual(company.debtTranches.map((item) => item.maturityTick), [63, 126, 189, 252, 315, 378, 441, 504]);
    const debt = parseMoney(company.interestBearingDebt);
    const expectedFraction = parseMoney(fractions[index]);
    for (const tranche of company.debtTranches) {
      const principal = parseMoney(tranche.principal);
      assert.equal(principal * 8n, debt);
      assert.equal(parseMoney(tranche.fixedPrincipal) * 1_000_000_000_000n, principal * expectedFraction);
      assert.equal(parseMoney(tranche.fixedPrincipal) + parseMoney(tranche.variablePrincipal), principal);
      assert.equal(parseMoney(tranche.initialVariableSpread) + parseMoney('0.03'), parseMoney(company.annualBorrowingRate));
    }
  }
});

test('four labelled synthetic quarters match whitepaper operating references and reconcile to initial equity', () => {
  const rvi = INITIAL_COMPANIES.find((company) => company.symbol === 'RVI')!;
  assert.deepEqual(rvi.syntheticHistory[0], {
    kind: 'SYNTHETIC_INITIALIZATION', quarter: 'Q-4', revenue: '200000000', operatingProfit: '50000000',
    interestExpense: '18750000', pretaxProfit: '31250000', corporateTax: '6250000', netProfit: '25000000',
  });
  const lmb = INITIAL_COMPANIES.find((company) => company.symbol === 'LMB')!;
  assert.equal(lmb.operatingMargin, '-3');
  assert.equal(lmb.syntheticHistory[0]?.netProfit, '-23625000');
  assert.equal(lmb.syntheticHistory[0]?.corporateTax, '0');
  for (const company of INITIAL_COMPANIES) {
    assert.deepEqual(company.syntheticHistory.map((quarter) => quarter.quarter), ['Q-4', 'Q-3', 'Q-2', 'Q-1']);
    const historicalNet = company.syntheticHistory.reduce((total, quarter) => total + parseMoney(quarter.netProfit), 0n);
    assert.equal(historicalNet, parseMoney(company.syntheticHistoryBridge.fourQuarterNetProfit));
    assert.equal(historicalNet + parseMoney(company.syntheticHistoryBridge.retainedEarningsAdjustment), parseMoney(company.distributableProfit));
    assert.equal(company.syntheticHistoryBridge.openingDistributableRetainedEarnings, company.distributableProfit);
    assert.equal(company.nominalRevenueGrowth === null, company.category === 'THEMATIC');
  }
});

test('initialization rejects imbalance, invalid account detail, duplicate identities and malformed input', () => {
  const imbalance = structuredClone(INITIAL_COMPANIES);
  Object.assign(imbalance[0]!, { totalAssets: '1400000001' });
  assert.throws(() => validateInitialCompanies(imbalance), /assets must equal/);

  const duplicate = structuredClone(INITIAL_COMPANIES);
  Object.assign(duplicate[1]!, { issuerId: duplicate[0]!.issuerId });
  assert.throws(() => validateInitialCompanies(duplicate), /valid and unique/);

  const detail = structuredClone(INITIAL_COMPANIES);
  Object.assign(detail[0]!.balanceSheet.assets[1]!, { amount: '0' });
  assert.throws(() => validateInitialCompanies(detail), /does not reconcile/);

  const classified = structuredClone(INITIAL_COMPANIES);
  Object.assign(classified[0]!, { category: 'GROWTH' });
  assert.throws(() => validateInitialCompanies(classified), /classifications/);

  const malformed = structuredClone(INITIAL_COMPANIES);
  Object.assign(malformed[0]!, { totalAssets: 1_400_000_000 });
  assert.throws(() => validateInitialCompanies(malformed), /invalid string/);

  const coherentButUnspecified = structuredClone(INITIAL_COMPANIES);
  Object.assign(coherentButUnspecified[0]!, { totalAssets: '1400000001', totalEquity: '900000001' });
  assert.throws(() => validateInitialCompanies(coherentButUnspecified), /whitepaper initial financial table/);
  assert.throws(() => validateInitialCompanies([]), /8 entries/);
});

test('initialization rejects debt schedule and synthetic-history inconsistencies', () => {
  const invalidDebt = structuredClone(INITIAL_COMPANIES);
  Object.assign(invalidDebt[0]!.debtTranches[0]!, { maturityTick: 64 });
  assert.throws(() => validateInitialCompanies(invalidDebt), /maturity ticks/);

  const invalidHistory = structuredClone(INITIAL_COMPANIES);
  Object.assign(invalidHistory[0]!.syntheticHistory[0]!, { netProfit: '1' });
  assert.throws(() => validateInitialCompanies(invalidHistory), /netProfit must reconcile/);

  const invalidBridge = structuredClone(INITIAL_COMPANIES);
  Object.assign(invalidBridge[0]!.syntheticHistoryBridge, { retainedEarningsAdjustment: '0' });
  assert.throws(() => validateInitialCompanies(invalidBridge), /without adding new income/);
});

test('exported fixture is immutable and new listing arrays cannot mutate it', () => {
  assert.equal(Object.isFrozen(INITIAL_COMPANIES), true);
  assert.equal(Object.isFrozen(INITIAL_COMPANIES[0]!.balanceSheet.assets), true);
  const listings = createInitialListings();
  Object.assign(listings[0]!, { price: '1' });
  assert.equal(INITIAL_COMPANIES[0]!.initialPrice, '1000');
  assert.equal(createInitialListings()[0]!.price, '1000');
});
