import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import { FinancialDecimal as D } from '../src/domain/numeric.js';
import { parseEngineVersion, parseIssuerId, parseTickNo } from '../src/domain/identifiers.js';
import { DeterministicRandom } from '../src/domain/random.js';
import { INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { createPublicEconomy, publishEconomy, validatePublicEconomy } from '../src/economy/public.js';
import type { EconomyPublication, EconomyRandom, EconomyState, FinancialReport, PublicEconomyState } from '../src/economy/types.js';
import { createMarketState, ordinaryPrice, priceMarket, PRICE_PARAMETERS, pricingStateSchema } from '../src/market/pricing.js';
import { valueCompanies } from '../src/market/valuation.js';
import { advanceEconomy, createEconomyState } from '../src/economy/engine.js';

function assertPrivateTypeBoundary(privateState: EconomyState): void {
  // @ts-expect-error Private economic state is not a PublicEconomy input.
  valueCompanies(privateState);
}
void assertPrivateTypeBoundary;

const initial = () => createPublicEconomy(INITIAL_COMPANIES, 0, 'test_market');
const next = (state = initial(), tickNo = state.tickNo + 1) => publishEconomy(state, [], tickNo).state;
function reportFor(state = initial(), symbol = 'HGI', changes: Partial<FinancialReport> = {}): FinancialReport {
  const company = state.companies.find((value) => value.symbol === symbol)!;
  return { ...company.latestReport, kind: 'ACTUAL', quarterNo: 1, closedTick: 63, publishTick: 64, ...changes };
}
function earnings(state = initial(), symbol = 'HGI', changes: Partial<FinancialReport> = {}): EconomyPublication {
  const company = state.companies.find((value) => value.symbol === symbol)!;
  const report = reportFor(state, symbol, changes);
  return { id: `earnings-${symbol}-${report.quarterNo}`, kind: 'EARNINGS', effectiveTick: report.closedTick, publishTick: report.publishTick, issuerId: company.issuerId, symbol: company.baseSymbol, report };
}
function mutateCompany(state: PublicEconomyState, symbol: string, action: (company: PublicEconomyState['companies'][number]) => PublicEconomyState['companies'][number]) {
  return validatePublicEconomy({ ...state, companies: state.companies.map((company) => company.symbol === symbol ? action(company) : company) });
}

test('public initialization retains eight fixed slots and four disclosed synthetic reports', () => {
  const state = initial();
  assert.equal(state.companies.length, 8);
  assert.equal(state.observedMacro.policyRate, '0.03');
  assert.equal(state.observedMacro.creditStress, '0.2');
  assert.deepEqual(state.companies.map((company) => company.nextEarningsTick), [64, 64, 65, 66, 66, 67, 67, 65]);
  assert.ok(state.companies.every((company) => company.reports.length === 4 && company.reports.every((report) => report.kind === 'SYNTHETIC_INITIALIZATION')));
});

test('public boundary rejects private state, extra hidden fields and nested hidden forecasts', () => {
  const state = initial();
  assert.throws(() => validatePublicEconomy({ schemaVersion: 1, marketId: 'test_market', tickNo: 0, macro: state.observedMacro, companies: [], contracts: [] }));
  assert.throws(() => validatePublicEconomy({ ...state, trueState: { nextRevenue: '999' } }));
  assert.throws(() => validatePublicEconomy({ ...state, companies: state.companies.map((company) => ({ ...company, hiddenSuccess: true })) }));
  assert.throws(() => validatePublicEconomy({ ...state, observedMacro: { ...state.observedMacro, futurePolicyRate: '0.15' } }));
});

test('sealed report remains invisible until its exact publication offset and publishes once', () => {
  const state = initial(); const candidate = earnings(state);
  const before = publishEconomy(state, [candidate], 63);
  assert.equal(before.state.companies[0]!.latestReport.kind, 'SYNTHETIC_INITIALIZATION');
  assert.equal(before.publications.length, 0);
  const visible = publishEconomy(before.state, [candidate], 64);
  assert.equal(visible.state.companies[0]!.latestReport.kind, 'ACTUAL');
  assert.equal(visible.publications.length, 1);
  assert.deepEqual(publishEconomy(visible.state, [candidate], 65).publications, []);
  assert.throws(() => publishEconomy(before.state, [{ ...candidate, publishTick: 62 }], 64));
});

test('announcements record actual, expected and previous, with differing prior expectations changing revisions', () => {
  const state = initial();
  const optimistic = mutateCompany(state, 'HGI', (company) => ({ ...company, forecast: { ...company.forecast, expectedQuarterRevenueAtoms: new D(company.latestReport.revenueAtoms).mul('1.35').toFixed(0) } }));
  const cautious = mutateCompany(state, 'HGI', (company) => ({ ...company, forecast: { ...company.forecast, expectedQuarterRevenueAtoms: new D(company.latestReport.revenueAtoms).mul('1.05').toFixed(0) } }));
  const actual = new D(state.companies[0]!.latestReport.revenueAtoms).mul('1.2').toFixed(0);
  const strong = publishEconomy(cautious, [earnings(state, 'HGI', { revenueAtoms: actual })], 64);
  const weak = publishEconomy(optimistic, [earnings(state, 'HGI', { revenueAtoms: actual })], 64);
  assert.equal(strong.publications[0]!.actual.revenueAtoms, weak.publications[0]!.actual.revenueAtoms);
  assert.notEqual(strong.publications[0]!.expected.revenueAtoms, weak.publications[0]!.expected.revenueAtoms);
  assert.ok(new D(strong.state.companies[0]!.forecast.annualRevenueGrowth).gt(weak.state.companies[0]!.forecast.annualRevenueGrowth));
  assert.notEqual(valueCompanies(strong.state)[0]!.continuationValuePerShare, valueCompanies(weak.state)[0]!.continuationValuePerShare);
});

test('macro observations stay lagged until monthly publication and fixed debt is never repriced', () => {
  const state = initial();
  const unpublished = next(state, 20);
  assert.deepEqual(unpublished.observedMacro, state.observedMacro);
  assert.deepEqual(unpublished.policyExpectation, state.policyExpectation);
  const candidate: EconomyPublication = { id: 'policy-21', kind: 'MACRO', effectiveTick: 21, publishTick: 21,
    macro: { ...state.observedMacro, policyRate: '0.0325', industrialDemand: '97' },
    expectation: { ...state.policyExpectation, meetingTick: 42, expectedRate: '0.0325' }, previousPolicyRate: '0.03' };
  const published = publishEconomy(unpublished, [candidate], 21);
  assert.equal(published.publications[0]!.actual.policyRate, '0.0325');
  assert.equal(published.publications[0]!.expected.policyRate, '0.03');
  for (const [index, term] of published.state.companies[0]!.debtTerms.entries()) {
    const previous = state.companies[0]!.debtTerms[index]!;
    if (term.rateType === 'FIXED') assert.equal(term.annualEffectiveRate, previous.annualEffectiveRate);
    else assert.equal(term.annualEffectiveRate, new D('0.0325').plus(term.spread).toString());
  }
  assert.throws(() => publishEconomy(state, [{ ...candidate, macro: { ...candidate.macro, policyRate: '0.1501' } }], 21));
});

test('FCFF has twenty nominal quarters, consistent annual discounting and alternative residual branches', () => {
  for (const value of valueCompanies(initial())) {
    assert.equal(value.scenarios.length, 3);
    assert.equal(value.scenarios.reduce((sum, branch) => sum.plus(branch.probability), new D(0)).toString(), '1');
    for (const branch of value.scenarios) {
      assert.equal(branch.quarters.length, 20);
      assert.equal(branch.quarters[3]!.discountFactor, new D(1).plus(branch.annualNominalWacc).toString());
      assert.equal(branch.quarters[19]!.discountFactor, new D(1).plus(branch.annualNominalWacc).pow(5).toString());
      assert.ok(branch.quarters.every((quarter) => new D(quarter.operatingProfit).minus(quarter.unleveredTax).plus(quarter.depreciation).minus(quarter.capex).minus(quarter.changeWorkingCapital).eq(quarter.fcff)));
      assert.equal(branch.residualKind, branch.kind === 'FAILURE' || branch.kind === 'FUNDING_FAILURE' ? 'ASSET_RECOVERY' : 'OPERATING_VALUE');
    }
  }
});

test('valuation deducts reported debt once and never deducts interest inside FCFF', () => {
  const state = initial(); const baseline = valueCompanies(state)[0]!;
  const changedInterest = mutateCompany(state, 'HGI', (company) => {
    const interestExpenseAtoms = new D(company.latestReport.interestExpenseAtoms).mul(9).toFixed(0);
    const pretaxProfitAtoms = (BigInt(company.latestReport.operatingProfitAtoms) - BigInt(interestExpenseAtoms)).toString();
    const corporateTaxAtoms = (BigInt(pretaxProfitAtoms) / 5n).toString();
    const report = { ...company.latestReport, interestExpenseAtoms, pretaxProfitAtoms, corporateTaxAtoms, netProfitAtoms: (BigInt(pretaxProfitAtoms) - BigInt(corporateTaxAtoms)).toString() };
    return { ...company, latestReport: report, reports: [...company.reports.slice(0, -1), report] };
  });
  assert.equal(valueCompanies(changedInterest)[0]!.enterpriseValue, baseline.enterpriseValue);
  const addedCash = mutateCompany(state, 'HGI', (company) => {
    const report = { ...company.latestReport, cashAtoms: (BigInt(company.latestReport.cashAtoms) + 1_000_000n * 1_000_000_000_000n).toString(), assetsAtoms: (BigInt(company.latestReport.assetsAtoms) + 1_000_000n * 1_000_000_000_000n).toString(), equityAtoms: (BigInt(company.latestReport.equityAtoms) + 1_000_000n * 1_000_000_000_000n).toString() };
    return { ...company, latestReport: report, reports: [...company.reports.slice(0, -1), report] };
  });
  assert.ok(new D(valueCompanies(addedCash)[0]!.continuationValuePerShare).minus(baseline.continuationValuePerShare).minus(1).abs().lt('1e-45'));
  const addedDebt = mutateCompany(state, 'HGI', (company) => {
    const report = { ...company.latestReport, debtAtoms: (BigInt(company.latestReport.debtAtoms) + 1_000_000n * 1_000_000_000_000n).toString(), liabilitiesAtoms: (BigInt(company.latestReport.liabilitiesAtoms) + 1_000_000n * 1_000_000_000_000n).toString(), equityAtoms: (BigInt(company.latestReport.equityAtoms) - 1_000_000n * 1_000_000_000_000n).toString() };
    return { ...company, latestReport: report, reports: [...company.reports.slice(0, -1), report] };
  });
  assert.ok(new D(baseline.continuationValuePerShare).minus(valueCompanies(addedDebt)[0]!.continuationValuePerShare).minus(1).abs().lt('1e-45'));
});

test('growth saturation and explicit financing failure avoid infinite guaranteed growth', () => {
  const values = valueCompanies(initial());
  const growth = values.find((value) => value.symbol === 'NXC')!;
  const success = growth.scenarios.find((branch) => branch.kind === 'SUCCESS')!;
  const first = new D(success.quarters[1]!.revenue).div(success.quarters[0]!.revenue);
  const last = new D(success.quarters[19]!.revenue).div(success.quarters[18]!.revenue);
  assert.ok(last.lt(first));
  assert.equal(growth.scenarios.find((branch) => branch.kind === 'FUNDING_FAILURE')!.quarters[19]!.revenue, '0');
  const thematic = values.find((value) => value.symbol === 'LMB')!;
  assert.ok(thematic.scenarios.some((branch) => branch.kind === 'FAILURE'));
  assert.ok(new D(thematic.continuationValuePerShare).gte(0));
});

test('eight initial price parameters exactly match the whitepaper', () => {
  assert.deepEqual(Object.values(PRICE_PARAMETERS).map(({ sigma, beta, kappa }) => [sigma, beta, kappa]), [
    ['0.009', '1', '0.020'], ['0.006', '0.6', '0.020'], ['0.013', '1.1', '0.018'], ['0.016', '1.3', '0.014'],
    ['0.018', '1.2', '0.014'], ['0.027', '1.4', '0.010'], ['0.030', '0.8', '0.010'], ['0.006', '0.6', '0.020'],
  ]);
});

test('ordinary price clips exponential returns at 30 percent without any economic floor', () => {
  const shock = { gap: '-1', valueInnovation: '0', marketResidual: '0', sentiment: '0', residual: '0' };
  assert.equal(ordinaryPrice('1000', shock).price, '700');
  assert.equal(ordinaryPrice('700', shock).price, '490');
  assert.equal(ordinaryPrice('490', shock).price, '343');
  assert.equal(ordinaryPrice('1e-900', shock).price, '7e-901');
  assert.equal(ordinaryPrice('1000', { ...shock, gap: '1' }).price, '1300');
  assert.throws(() => ordinaryPrice('0', shock));
});

test('zero public continuation value still yields a positive active market price', () => {
  const state = initial();
  const insolvent = mutateCompany(state, 'HGI', (company) => {
    const report = { ...company.latestReport, debtAtoms: '1000000000000000000000000', liabilitiesAtoms: '1000000000000000000000000', equityAtoms: (BigInt(company.latestReport.assetsAtoms) - 1_000_000_000_000_000_000_000_000n).toString() };
    return { ...company, latestReport: report, reports: [...company.reports.slice(0, -1), report] };
  });
  assert.equal(valueCompanies(insolvent)[0]!.continuationValuePerShare, '0');
  const pricing = createMarketState(insolvent);
  const result = priceMarket(next(insolvent), pricing, new DeterministicRandom(randomBytes(32)));
  assert.ok(new D(result.prices[0]!.price).gt(0));
});

test('return contributions reconcile the actual move including clipping and rounding', () => {
  const priced = ordinaryPrice('0.001', { gap: '0.8', valueInnovation: '0.1', marketResidual: '-0.01', sentiment: '0.02', residual: '-0.02' });
  const contribution = priced.contribution;
  assert.equal(contribution.wasClipped, true);
  const sum = new D(contribution.publicRevaluation).plus(contribution.commonRisk).plus(contribution.sentiment).plus(contribution.residual).plus(contribution.clippingAdjustment).plus(contribution.roundingAdjustment);
  assert.ok(sum.minus(contribution.actualReturn).abs().lt('1e-45'));
  assert.equal(contribution.actualReturn, '0.3');
});

test('participant weights persist smoothly and full pricing state is validated', () => {
  const state = initial(); const pricing = createMarketState(state);
  const result = priceMarket(next(state), pricing, new DeterministicRandom(randomBytes(32)));
  for (const key of Object.keys(pricing.groupWeights) as (keyof typeof pricing.groupWeights)[]) assert.ok(new D(result.state.groupWeights[key]).minus(pricing.groupWeights[key]).abs().lt('0.03'));
  assert.equal(Object.values(result.state.groupWeights).reduce((sum, value) => sum.plus(value), new D(0)).toString(), '1');
  assert.throws(() => pricingStateSchema.parse({ ...pricing, groupWeights: { ...pricing.groupWeights, trend: '0.3' } }));
});

test('quote views and unrelated random calls cannot alter the deterministic economic path', () => {
  const random = new DeterministicRandom(randomBytes(32));
  const state = initial(); const pricing = createMarketState(state); const updated = next(state);
  const expected = priceMarket(updated, pricing, random);
  for (let index = 0; index < 3; index++) { valueCompanies(state); valueCompanies(updated); createMarketState(state); }
  random.uniform({ engineVersion: parseEngineVersion('diagnostic-unrelated'), tick: parseTickNo(999), issuerId: parseIssuerId('unrelated-company'), eventChannel: 'unrelated-call', drawIndex: 100 });
  assert.deepEqual(priceMarket(updated, pricing, random), expected);
  const reversed = validatePublicEconomy({ ...updated, companies: [...updated.companies].reverse() });
  const sort = (prices: typeof expected.prices) => [...prices].sort((left, right) => left.listingId.localeCompare(right.listingId));
  assert.deepEqual(sort(priceMarket(reversed, pricing, random).prices), sort(expected.prices));
  assert.throws(() => priceMarket(validatePublicEconomy({ ...updated, tickNo: 2 }), pricing, random));
});

test('changing hidden customer state changes private results while pre-publication prices remain identical', () => {
  const random = new DeterministicRandom(Buffer.alloc(32, 17));
  const quietRandom: EconomyRandom = { uniform: context => context.eventChannel === 'event-count' ? '0.5' : random.uniform(context) };
  const publicState = initial(); const prior = createMarketState(publicState);
  const initialized = createEconomyState('test_market');
  const privateState = { ...initialized, events: { ...initialized.events, projects: [] } };
  const changedPrivate = { ...privateState, companies: privateState.companies.map((company) => company.symbol === 'HGI' ? { ...company, customerBase: '1.8' } : company) };
  const baseResult = advanceEconomy(privateState, 1, quietRandom);
  const changedResult = advanceEconomy(changedPrivate, 1, quietRandom);
  assert.notDeepEqual(baseResult.state.macro, privateState.macro);
  assert.notDeepEqual(baseResult.state.companies[0]!.currentQuarter, changedResult.state.companies[0]!.currentQuarter);
  assert.deepEqual(baseResult.publications, []);
  assert.deepEqual(changedResult.publications, []);
  assert.deepEqual(priceMarket(publishEconomy(publicState, baseResult.publications, 1).state, prior, random),
    priceMarket(publishEconomy(publicState, changedResult.publications, 1).state, prior, random));
});

test('global export news stays sealed until publication and reprices only exposed issuers against public expectations', () => {
  const baseline = initial();
  const publication: EconomyPublication = { id: 'global_export_news', kind: 'EVENT', effectiveTick: 1, publishTick: 2,
    disclosure: { id: 'global_export_news', causeId: 'global_export_cause', templateId: 'MAC-20', templateVersion: 1,
      profile: 'MACRO', title: '가상 수출 수요 발표', publicCopy: '실제 증가 20%, 사전 예상 증가 35%',
      issuerIds: [], symbols: [], effectiveTick: 1, publishTick: 2,
      actual: { exportDemand: '0.2' }, expected: { exportDemand: '0.35' }, previous: { exportDemand: '0' },
      certainty: 'CONFIRMED', sourceType: 'STATISTICS', target: 'exportDemand', magnitude: '0.2', duration: 63,
      halfLifeTicks: null, decay: 'NONE', sectorExposure: '1', reversalRule: 'EXPIRE' } };
  const sealed = publishEconomy(baseline, [publication], 1).state;
  assert.deepEqual(valueCompanies(sealed), valueCompanies(next(baseline, 1)));
  const disclosed = publishEconomy(sealed, [publication], 2).state;
  const ordinary = valueCompanies(next(sealed, 2)), observed = valueCompanies(disclosed);
  for (const symbol of ['HGI', 'TLR', 'VTR']) {
    assert.ok(new D(observed.find(company => company.symbol === symbol)!.continuationValuePerShare)
      .lt(ordinary.find(company => company.symbol === symbol)!.continuationValuePerShare));
  }
  for (const symbol of ['DNL', 'NXC', 'AUR', 'LMB', 'RVI']) {
    assert.equal(observed.find(company => company.symbol === symbol)!.continuationValuePerShare,
      ordinary.find(company => company.symbol === symbol)!.continuationValuePerShare);
  }
});

test('a duplicate policy headline has no independent direct price shock', () => {
  const state = initial(); const random = new DeterministicRandom(randomBytes(32));
  const prior = createMarketState(state);
  const a: EconomyPublication = { id: 'policy-news-a', kind: 'MACRO', effectiveTick: 1, publishTick: 1,
    macro: { ...state.observedMacro, policyRate: '0.0325' }, expectation: { ...state.policyExpectation, expectedRate: '0.0325' }, previousPolicyRate: '0.03' };
  const b: EconomyPublication = { ...a, id: 'policy-news-b' };
  assert.deepEqual(priceMarket(publishEconomy(state, [a], 1).state, prior, random).prices,
    priceMarket(publishEconomy(state, [a, b], 1).state, prior, random).prices);
});

test('an identical policy decision reprices differently when the public prior policy distribution differed', () => {
  const baseline = initial(); const random = new DeterministicRandom(randomBytes(32));
  const anticipated = validatePublicEconomy({ ...baseline, policyExpectation: { ...baseline.policyExpectation, expectedRate: '0.0325' } });
  const surprising = validatePublicEconomy({ ...baseline, policyExpectation: { ...baseline.policyExpectation, expectedRate: '0.0275' } });
  const candidate: EconomyPublication = { id: 'same-policy-decision', kind: 'MACRO', effectiveTick: 1, publishTick: 1,
    macro: { ...baseline.observedMacro, policyRate: '0.0325' }, expectation: { ...baseline.policyExpectation, expectedRate: '0.0325' }, previousPolicyRate: '0.03' };
  const a = priceMarket(publishEconomy(anticipated, [candidate], 1).state, createMarketState(anticipated), random);
  const b = priceMarket(publishEconomy(surprising, [candidate], 1).state, createMarketState(surprising), random);
  assert.notEqual(a.contributions[0]!.valueInnovationLog, b.contributions[0]!.valueInnovationLog);
  assert.notEqual(a.prices[0]!.price, b.prices[0]!.price);
});
