import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { FinancialDecimal as D, moneyToAtoms, parseMoney } from '../src/domain/numeric.js';
import { dividendRightMark, transformCorporateRights } from '../src/domain/corporate-rights.js';
import { DeterministicRandom } from '../src/domain/random.js';
import { INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { createPublicEconomy, publicCorporateActionSchema, publishEconomy, validatePublicEconomy } from '../src/economy/public.js';
import type { CorporateAction, CorporateDividend } from '../src/economy/types.js';
import { advanceEconomy, createEconomyState, validateEconomyState } from '../src/economy/engine.js';
import { createMarketState, ordinaryPrice, priceMarket, pricingStateSchema } from '../src/market/pricing.js';
import { valueCompanies } from '../src/market/valuation.js';

const atoms = (points: string) => moneyToAtoms(parseMoney(points));
const initial = () => createPublicEconomy(INITIAL_COMPANIES, 0, 'actions_market');
function dividend(dps = '15', declaredTick = 1): CorporateDividend {
  const company = initial().companies[0]!;
  return { id: 'dividend_1', issuerId: company.issuerId, listingId: company.listingId, declaredTick,
    exTick: declaredTick + 3, payTick: declaredTick + 5, status: 'DECLARED', issuedShares: company.issuedShares,
    totalNominalAtoms: atoms(new D(dps).mul(company.issuedShares).toFixed()), dps,
    remainingPayableAtoms: atoms(new D(dps).mul(company.issuedShares).toFixed()), recoveryRatio: '1', paidAtoms: '0' };
}
function dividendAction(kind: 'DIVIDEND_DECLARED' | 'DIVIDEND_EX' | 'DIVIDEND_PAYMENT' | 'DIVIDEND_IMPAIRED', claim = dividend(), tick = claim.declaredTick): CorporateAction {
  return { id: `${kind}_${claim.id}`, kind, effectiveTick: tick, issuerId: claim.issuerId, listingId: claim.listingId, symbol: 'HGI', dividend: claim };
}

test('AT30 exact cum/ex separation conserves stock and detached rights, with no payment-day second ex', () => {
  const split = transformCorporateRights({ previousPrice: '1000', previousAttachedRightsMark: '15', nextRights: [
    { dividendId: 'div1', nominalPerShare: '15', markPerShare: '15', detach: true },
  ] });
  assert.equal(split.referencePrice, '985'); assert.equal(split.referenceAdjustment, '0');
  assert.equal(new D(split.referencePrice).plus(split.detachedRights[0]!.markPerShare).toString(), '1000');
  assert.equal(transformCorporateRights({ previousPrice: '985', previousAttachedRightsMark: '0', nextRights: [] }).referencePrice, '985');
});

test('AT33 low-price nominal 100 rights can be worth 30 and separate 50 into 20 plus 30', () => {
  const split = transformCorporateRights({ previousPrice: '50', previousAttachedRightsMark: '30', nextRights: [
    { dividendId: 'risky', nominalPerShare: '100', markPerShare: '30', detach: true },
  ] });
  assert.equal(split.referencePrice, '20'); assert.equal(split.detachedRights[0]!.nominalPerShare, '100');
  assert.equal(split.detachedRights[0]!.markPerShare, '30');
  assert.equal(new D(split.referencePrice).plus(split.detachedRights[0]!.markPerShare).toString(), '50');
});

test('AT33 declaration transfers existing value once and reconciles a quote below the entitlement', () => {
  const unchanged = transformCorporateRights({ previousPrice: '1000', previousAttachedRightsMark: '0', declaration: true,
    nextRights: [{ dividendId: 'new', nominalPerShare: '15', markPerShare: '15', detach: false }] });
  assert.equal(unchanged.continuationMark, '985'); assert.equal(unchanged.referencePrice, '1000');
  const repaired = transformCorporateRights({ previousPrice: '0.5', previousAttachedRightsMark: '0', declaration: true, modelContinuationMark: '20',
    nextRights: [{ dividendId: 'large', nominalPerShare: '100', markPerShare: '100', detach: false }] });
  assert.equal(repaired.referencePrice, '120'); assert.equal(repaired.referenceAdjustment, '119.5');
  assert.throws(() => transformCorporateRights({ previousPrice: '0.5', previousAttachedRightsMark: '0', declaration: true,
    nextRights: [{ dividendId: 'large', nominalPerShare: '100', markPerShare: '100', detach: false }] }));
});

test('zero continuation is rights-only and zero ex-reference never enters a logarithmic kernel', () => {
  const rightsOnly = transformCorporateRights({ previousPrice: '15', previousAttachedRightsMark: '0', declaration: true,
    nextRights: [{ dividendId: 'only', nominalPerShare: '15', markPerShare: '15', detach: false }] });
  assert.equal(rightsOnly.priceMode, 'RIGHTS_ONLY'); assert.equal(rightsOnly.continuationMark, '0');
  const extinct = transformCorporateRights({ previousPrice: '15', previousAttachedRightsMark: '15',
    nextRights: [{ dividendId: 'only', nominalPerShare: '15', markPerShare: '15', detach: true }] });
  assert.equal(extinct.priceMode, 'EXTINGUISHED'); assert.equal(extinct.referencePrice, '0');
  assert.throws(() => ordinaryPrice(extinct.referencePrice, { gap: '0', valueInnovation: '0', marketResidual: '0', sentiment: '0', residual: '0' }));
});

test('an exact-zero market continuation reconciles to positive public continuation as a separate corporate adjustment', () => {
  const split = transformCorporateRights({ previousPrice: '15', previousAttachedRightsMark: '15', modelContinuationMark: '20',
    nextRights: [{ dividendId: 'exact_boundary', nominalPerShare: '15', markPerShare: '15', detach: true }] });
  assert.equal(split.continuationMark, '20'); assert.equal(split.referencePrice, '20'); assert.equal(split.priceMode, 'ORDINARY');
  assert.equal(split.referenceAdjustment, '20');
  assert.equal(new D(split.referencePrice).plus(split.detachedRights[0]!.markPerShare).toString(), new D(15).plus(split.referenceAdjustment).toString());
  const zeroModel = transformCorporateRights({ previousPrice: '15', previousAttachedRightsMark: '15', modelContinuationMark: '0',
    nextRights: [{ dividendId: 'terminal_boundary', nominalPerShare: '15', markPerShare: '15', detach: true }] });
  assert.equal(zeroModel.referencePrice, '0'); assert.equal(zeroModel.priceMode, 'EXTINGUISHED');
});

test('same-tick public claim discount and recovery separate nominal from current mark', () => {
  assert.equal(dividendRightMark('100', '0.3', '0', 2), '30');
  const marked = dividendRightMark('15', '1', '0.025', 2);
  assert.ok(new D(marked).lt(15)); assert.ok(new D(marked).gt('14.99'));
  assert.equal(dividendRightMark('15', '1', '0.025', 0), '15');
  assert.throws(() => dividendRightMark('15', '1.01', '0', 2));
  assert.throws(() => transformCorporateRights({ previousPrice: '1', previousAttachedRightsMark: '2', nextRights: [] }));
});

test('declared cash remains in valuation and the new dividend payable is deducted exactly once', () => {
  const prior = initial(); const baseline = valueCompanies(prior)[0]!;
  const declaration = dividendAction('DIVIDEND_DECLARED');
  const announced = publishEconomy(prior, [], 1, [declaration]);
  const valuation = valueCompanies(announced.state)[0]!;
  assert.equal(valuation.cash, baseline.cash);
  assert.equal(valuation.declaredDividendLiability, '15000000');
  assert.ok(new D(baseline.continuationValuePerShare).minus(valuation.continuationValuePerShare).minus(15).abs().lt('1e-44'));
  assert.equal(announced.publications[0]!.kind, 'CORPORATE_ACTION');
  assert.deepEqual(publishEconomy(announced.state, [], 2, [declaration]).publications, []);
  const report = announced.state.companies[0]!.latestReport;
  const withReportedPayable = { ...report, dividendPayableAtoms: atoms('15000000'), liabilitiesAtoms: (BigInt(report.liabilitiesAtoms) + BigInt(atoms('15000000'))).toString(),
    equityAtoms: (BigInt(report.equityAtoms) - BigInt(atoms('15000000'))).toString() };
  const state = validatePublicEconomy({ ...announced.state, companies: announced.state.companies.map((company, index) => index ? company : { ...company,
    latestReport: withReportedPayable, reports: [...company.reports.slice(0, -1), withReportedPayable] }) });
  assert.equal(valueCompanies(state)[0]!.continuationValuePerShare, valuation.continuationValuePerShare);
});

test('cash payment removes the payable and cash equally, never a second equity debit', () => {
  const prior = initial(); const claim = dividend();
  const declared = publishEconomy(prior, [], 1, [dividendAction('DIVIDEND_DECLARED', claim)]).state;
  const ex = publishEconomy(declared, [], 4, [dividendAction('DIVIDEND_EX', { ...claim, status: 'EX_ENTITLED' }, 4)]).state;
  const paid = publishEconomy(ex, [], 6, [dividendAction('DIVIDEND_PAYMENT', { ...claim, status: 'PAID', remainingPayableAtoms: '0', paidAtoms: claim.totalNominalAtoms }, 6)]).state;
  assert.equal(paid.companies[0]!.corporateCashAdjustmentAtoms, `-${claim.totalNominalAtoms}`);
  assert.equal(valueCompanies(paid)[0]!.continuationValuePerShare, valueCompanies(declared)[0]!.continuationValuePerShare);
});

test('external financing values both new cash and new shares rather than mechanically scaling the old quote', () => {
  const prior = initial(); const company = prior.companies[0]!; const before = valueCompanies(prior)[0]!;
  const action: CorporateAction = { id: 'funding1', kind: 'FINANCING', effectiveTick: 1, issuerId: company.issuerId,
    listingId: company.listingId, symbol: company.symbol, raisedAtoms: atoms('25000000'), issuedSharesBefore: company.issuedShares, issuedSharesAfter: '1100000' };
  const published = publishEconomy(prior, [], 1, [action]).state; const after = valueCompanies(published)[0]!;
  const expected = new D(before.continuationValuePerShare).mul(company.issuedShares).plus('25000000').div('1100000');
  assert.ok(new D(after.continuationValuePerShare).minus(expected).abs().lt('1e-44'));
  assert.equal(after.cash, new D(before.cash).plus('25000000').toString());
  assert.equal(published.companies[0]!.issuedShares, '1100000');
});

test('published one-time operating gains are disclosed without recurring in the FCFF margin forecast', () => {
  const prior = initial(); const company = prior.companies[0]!; const oldReport = company.latestReport;
  const gain = BigInt(atoms('10000000'));
  const operatingProfitAtoms = (BigInt(oldReport.operatingProfitAtoms) + gain).toString();
  const pretaxProfitAtoms = (BigInt(operatingProfitAtoms) - BigInt(oldReport.interestExpenseAtoms)).toString();
  const corporateTaxAtoms = (BigInt(pretaxProfitAtoms) / 5n).toString();
  const report = { ...oldReport, kind: 'ACTUAL' as const, quarterNo: 1, closedTick: 63, publishTick: 64,
    oneOffProfitAtoms: gain.toString(), operatingProfitAtoms, pretaxProfitAtoms, corporateTaxAtoms,
    netProfitAtoms: (BigInt(pretaxProfitAtoms) - BigInt(corporateTaxAtoms)).toString() };
  const actual = publishEconomy(prior, [{ id: 'oneoff_report', kind: 'EARNINGS', effectiveTick: 63, publishTick: 64,
    issuerId: company.issuerId, symbol: company.baseSymbol, report }], 64);
  assert.equal(actual.state.companies[0]!.forecast.operatingMargin, company.forecast.operatingMargin);
  assert.ok(new D(actual.publications[0]!.actual.operatingMargin!).gt(actual.publications[0]!.actual.recurringOperatingMargin!));
});

test('AT34 public impairment keeps nominal DPS and changes the attached recovery mark', () => {
  const claim = dividend('100'); const prior = publishEconomy(initial(), [], 1, [dividendAction('DIVIDEND_DECLARED', claim)]).state;
  const damaged = publishEconomy(prior, [], 2, [dividendAction('DIVIDEND_IMPAIRED', { ...claim, status: 'IMPAIRED', recoveryRatio: '0.3' }, 2)]).state;
  assert.equal(damaged.companies[0]!.dividends[0]!.dps, '100');
  assert.equal(damaged.companies[0]!.dividends[0]!.totalNominalAtoms, claim.totalNominalAtoms);
  const pricing = createMarketState(prior);
  const marked = priceMarket(damaged, pricing, new DeterministicRandom(randomBytes(32)));
  assert.ok(new D(marked.state.companies[0]!.attachedRightsMark).lt(30));
});

test('corporate action input cannot contain private fields or an unpublished payload', () => {
  const prior = initial(); const action = dividendAction('DIVIDEND_DECLARED');
  assert.throws(() => publishEconomy(prior, [], 1, [{ ...action, trueState: { cash: '999' } } as unknown as CorporateAction]));
  assert.throws(() => priceMarket(publishEconomy(prior, [], 1).state, createMarketState(prior), new DeterministicRandom(randomBytes(32)), [action]));
  assert.throws(() => publishEconomy(prior, [], 1, [dividendAction('DIVIDEND_EX')]));
});

test('issued corporate capital is canonical positive integer text', () => {
  const action = dividendAction('DIVIDEND_DECLARED');
  for (const invalid of ['0', '0.5', '1e6', '01', '1000000000000000001']) {
    assert.throws(() => publicCorporateActionSchema.parse({ ...action, dividend: { ...dividend(), issuedShares: invalid } }));
    const state = initial();
    assert.throws(() => validatePublicEconomy({ ...state, companies: state.companies.map((company, index) => index ? company : { ...company, issuedShares: invalid }) }));
  }
});

test('AT12 ordinary returns apply after detachment and remain within 30 percent', () => {
  const prior = initial(); let publicState = prior; let pricing = createMarketState(prior);
  const random = new DeterministicRandom(randomBytes(32)); const claim = dividend();
  for (let tick = 1; tick <= 6; tick++) {
    const actions: CorporateAction[] = tick === 1 ? [dividendAction('DIVIDEND_DECLARED', claim)] : tick === 4
      ? [dividendAction('DIVIDEND_EX', { ...claim, status: 'EX_ENTITLED' }, tick)] : tick === 6
        ? [dividendAction('DIVIDEND_PAYMENT', { ...claim, status: 'PAID', remainingPayableAtoms: '0', paidAtoms: claim.totalNominalAtoms }, tick)] : [];
    publicState = publishEconomy(publicState, [], tick, actions).state;
    const result = priceMarket(publicState, pricing, random, actions); const contribution = result.contributions[0]!;
    assert.ok(new D(contribution.actualReturn).gte('-0.3') && new D(contribution.actualReturn).lte('0.3'));
    assert.ok(new D(result.prices[0]!.price).gte(result.state.companies[0]!.attachedRightsMark));
    if (tick === 4) {
      assert.equal(contribution.detachedRights!.length, 1);
      assert.equal(contribution.attachedRightsMark, '0');
      assert.equal(new D(contribution.referencePrice).plus(contribution.detachedRights![0]!.markPerShare).toString(), new D(pricing.companies[0]!.price).plus(contribution.referenceAdjustment!).toString());
    }
    if (tick === 6) assert.equal(contribution.detachedRights!.length, 0);
    pricing = result.state;
  }
});

test('AT53 low market price alone never changes the public corporate lifecycle', () => {
  const prior = initial(); const lowPrices = Object.fromEntries(prior.companies.map((company) => [company.listingId, '0.00001']));
  const result = priceMarket(publishEconomy(prior, [], 1).state, createMarketState(prior, lowPrices), new DeterministicRandom(randomBytes(32)));
  assert.ok(result.prices.every((company) => new D(company.price).gt(0)));
  assert.ok(prior.companies.every((company) => company.lifecycle === 'OPERATING'));
});

test('AT56 replacement uses new identities and a fresh 1000 quote, preserving the eight slot categories', () => {
  const prior = initial(); const old = prior.companies[0]!;
  const actions: CorporateAction[] = [
    { id: 'liq1', kind: 'LIQUIDATION_STARTED', effectiveTick: 1, issuerId: old.issuerId, listingId: old.listingId, symbol: old.symbol,
      liquidationId: 'liq_plan1', settlementTick: 4, estimatedRecoveryPerShare: '0', dividendRecoveryRatio: '0' },
    { id: 'replace1', kind: 'REPLACEMENT', effectiveTick: 1, issuerId: old.issuerId, listingId: old.listingId, symbol: old.symbol,
      baseSymbol: 'HGI', generation: 2, createdTick: 1, newIssuerId: 'new_hgi_issuer', newListingId: 'new_hgi_listing', newSymbol: 'HGI2', newName: '한결산업 2세대', issuedShares: '1000000' },
  ];
  const published = publishEconomy(prior, [], 1, actions).state;
  assert.equal(published.companies.length, 8); assert.equal(published.companies[0]!.symbol, 'HGI2');
  assert.equal(published.companies[0]!.category, old.category); assert.equal(published.companies[0]!.baseSymbol, 'HGI');
  const priorPrices = Object.fromEntries(prior.companies.map((company) => [company.listingId, '343']));
  const priced = priceMarket(published, createMarketState(prior, priorPrices), new DeterministicRandom(randomBytes(32)), actions);
  assert.equal(priced.prices[0]!.price, '1000'); assert.equal(priced.contributions[0]!.priceMode, 'REPLACEMENT');
  assert.equal(priced.state.companies[0]!.lastReturn, '0'); assert.equal(priced.state.companies[0]!.sentiment, '0');
  const advanced = priceMarket(publishEconomy(published, [], 2).state, priced.state, new DeterministicRandom(randomBytes(32)));
  assert.notEqual(advanced.prices[0]!.price, '1000');
  assert.throws(() => publishEconomy(prior, [], 1, [actions[1]!]));
});

test('real private liquidation actions compose with the public boundary and replacement pricing through final settlement', () => {
  const privateInitial = createEconomyState('actions_market'); const old = privateInitial.companies[0]!;
  const forced = { ...old, balances: { ...old.balances, cash: '0',
    paid_in_capital: (BigInt(old.balances.paid_in_capital) - BigInt(old.balances.cash)).toString() },
    lifecycle: 'DISTRESSED' as const, lifecycleSinceTick: 1, status: 'STRESSED' as const,
    workingCapital: old.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1, overdueSinceTick: 1 } : { ...item, dueTick: 100 }) };
  let privateState = validateEconomyState({ ...privateInitial, tickNo: 63,
    companies: privateInitial.companies.map((company, index) => index ? company : forced) });
  const publicInitial = publishEconomy(initial(), [], 63).state;
  let publicState = validatePublicEconomy({ ...publicInitial,
    companies: publicInitial.companies.map((company, index) => index ? company : { ...company, lifecycle: 'DISTRESSED' }) });
  let pricing = createMarketState(publicState);
  const random = { uniform: (context: { eventChannel: string }) => context.eventChannel === 'external-capital' ? '0.999' : '0.5' };
  for (let tick = 64; tick <= 69; tick++) {
    const step = advanceEconomy(privateState, tick, random); privateState = step.state;
    const published = publishEconomy(publicState, step.publications, tick, step.actions); publicState = published.state;
    const priced = priceMarket(publicState, pricing, random, step.actions); pricing = priced.state;
    assert.equal(publicState.companies.length, 8);
    if (tick === 64) { assert.equal(publicState.companies[0]!.symbol, 'HGI2'); assert.equal(priced.prices[0]!.price, '1000'); }
    if (tick === 69) assert.ok(published.publications.some((publication) => publication.actual.actionKind === 'LIQUIDATION_SETTLED'));
  }
  assert.equal(privateState.retiredCompanies[0]!.lifecycle, 'EXTINGUISHED');
  assert.notEqual(pricing.companies[0]!.issuerId, old.issuerId);
});

test('legacy snapshots normalize new public/pricing fields while preserving the exact quote', () => {
  const current = initial();
  const legacy = { ...current, corporateActions: undefined, companies: current.companies.map((company) => {
    const { baseSymbol: _base, generation: _generation, createdTick: _created, lifecycle: _lifecycle, dividends: _dividends,
      corporateCashAdjustmentAtoms: _cash, corporateDebtAdjustmentAtoms: _debt, ...old } = company;
    return old;
  }) };
  assert.equal(validatePublicEconomy(legacy).companies[0]!.generation, 1);
  const pricing = createMarketState(current, { [current.companies[0]!.listingId]: '0.000123456789' });
  const oldPricing = { ...pricing, companies: pricing.companies.map((company) => {
    const { attachedRightsMark: _attached, continuationMark: _continuation, priceMode: _mode, ...old } = company; return old;
  }) };
  assert.equal(pricingStateSchema.parse(oldPricing).companies[0]!.price, '0.000123456789');
});
