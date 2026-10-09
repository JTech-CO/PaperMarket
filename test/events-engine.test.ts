import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialDecimal as D } from '../src/domain/numeric.js';
import { DeterministicRandom } from '../src/domain/random.js';
import { INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { createEconomyState, advanceEconomy, validateEconomyState } from '../src/economy/engine.js';
import { advanceCorporations, checkCorporateBalance } from '../src/economy/corporate.js';
import { createPublicEconomy, publishEconomy, validatePublicEconomy } from '../src/economy/public.js';
import { valueCompanies } from '../src/market/valuation.js';
import { EVENT_CATALOG, getEventTemplate } from '../src/events/catalog.js';
import { conditionalHazardWeight, conditionalOutcomeProbabilities, eventEligible, eventEffectAt, executeEvent, advanceEvents, initialEventState, newEventCandidateCount, domainEventPublications } from '../src/events/engine.js';
import { publicBeliefSentiment, publicEventCompany } from '../src/events/public.js';
import { eventTemplateSchema, validateEventCatalog } from '../src/events/validator.js';
import type { EventDisclosure, EventTemplate } from '../src/events/types.js';
import type { EconomyRandom, EconomyState } from '../src/economy/types.js';

const midpoint: EconomyRandom = { uniform: () => '0.5' };
const t = (profile: EventTemplate['profile'], values: Partial<EventTemplate> = {}): EventTemplate => ({
  ...getEventTemplate('HGI-01'), id: `TEST-${profile}`, title: '확정 경제 사건', profile, mode: 'NEW', operation: 'START', subjects: ['HGI'], scope: 'COMPANY',
  target: 'demand', unit: 'RATIO', magnitude: { min: '0.02', max: '0.02' }, duration: { min: 3, max: 3 }, halfLifeTicks: null, decay: 'NONE', reversalRule: 'EXPIRE',
  eligibility: ['OPERATING'], exclusionGroup: `test_${profile}`, projectKey: null, successors: [], outcomes: [{ id: 'confirmed', probability: '1', magnitudeMultiplier: '1' }],
  financeAction: null, investmentAccounting: null, contractRole: 'SUPPLIER', investmentOwner: 'CUSTOMER', sectorExposure: '1', publicCopy: '{subject}: 실제 {actual}, 예상 {expected}, 이전 {previous}', publishLagTicks: 0, cooldownTicks: 1, hazardWeight: '1', ...values,
});
const seed = (template: EventTemplate): EconomyState => { const state = createEconomyState('event_test'); return { ...state, events: initialEventState(state.companies, 0, [template]) }; };
const stateAfter = (state: EconomyState, step: ReturnType<typeof executeEvent>, tick: number): EconomyState => ({ ...state, tickNo: tick, companies: step.companies, events: step.events, macro: step.macro, contracts: step.contracts });
const balanced = (step: ReturnType<typeof executeEvent>) => { for (const company of step.companies) checkCorporateBalance(company); for (const entry of step.entries) assert.equal(entry.lines.filter(line => line.side === 'DR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n), entry.lines.filter(line => line.side === 'CR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n)); };

test('catalog supports all 240 source rows and twelve executable profiles with strict input boundaries', () => {
  assert.equal(validateEventCatalog(EVENT_CATALOG).length, 240);
  assert.equal(new Set(EVENT_CATALOG.map(template => template.profile)).size, 12);
  assert.throws(() => eventTemplateSchema.parse({ ...t('DEMAND'), directPrice: '1200' }));
  assert.throws(() => eventTemplateSchema.parse({ ...t('DEMAND'), outcomes: [{ id: 'bad', probability: '0.9', magnitudeMultiplier: '1' }] }));
  assert.throws(() => validateEventCatalog(EVENT_CATALOG.slice(1)));
  assert.ok(EVENT_CATALOG.filter(template => template.mode !== 'NEW').every(template => template.hazardWeight === '0'));
});
test('0.35 Poisson candidates permit zero news and condition weighting uses no account activity', () => {
  let sum = 0; for (let i = 0; i < 10000; i++) sum += newEventCandidateCount({ uniform: () => new D(i).plus('0.5').div(10000).toString() }, i);
  assert.ok(Math.abs(sum / 10000 - 0.35) < 0.001);
  assert.equal(newEventCandidateCount(midpoint, 1), 0);
  const state = createEconomyState('event_test'); const risky = { ...state, macro: { ...state.macro, creditStress: '0.9' } };
  assert.ok(new D(conditionalHazardWeight(t('FINANCE', { financeAction: 'SPREAD' }), risky)).gt(conditionalHazardWeight(t('FINANCE', { financeAction: 'SPREAD' }), state)));
  const outcomes = { ...t('FINANCE', { financeAction: 'SPREAD' }), outcomes: [{ id: 'accepted', probability: '0.5', magnitudeMultiplier: '1' }, { id: 'failed', probability: '0.5', magnitudeMultiplier: '0' }] };
  assert.ok(new D(conditionalOutcomeProbabilities(outcomes, risky)[1]!).gt(conditionalOutcomeProbabilities(outcomes, state)[1]!));
});
test('HMAC exact 256-bit uniforms and long project keys reproduce without mutable draw order', () => {
  const random = new DeterministicRandom(Buffer.alloc(32, 17)); const state = createEconomyState('event_test');
  assert.deepEqual(advanceEconomy(state, 1, random), advanceEconomy(state, 1, random));
  assert.doesNotThrow(() => newEventCandidateCount(random, 1));
});
test('contract recognition follows delivery and capacity, carries one matched cause and no immediate sales cash', () => {
  const template = t('CONTRACT', { subjects: ['HGI', 'VTR'], scope: 'RELATION', eligibility: ['OPERATING', 'ACTIVE_NEGOTIATION', 'SPARE_CAPACITY'], projectKey: 'test:contract', duration: { min: 63, max: 63 } });
  const state = seed(template); const start = executeEvent(state, template, 1, midpoint);
  assert.equal(start.entries.length, 0); assert.equal(start.companies[0]!.balances.cash, state.companies[0]!.balances.cash);
  const delivered = advanceEvents(stateAfter(state, start, 1), start.macro, 2, midpoint, [template]); balanced(delivered);
  const revenue = delivered.entries.find(entry => entry.kind === 'EVENT_CONTRACT_RECOGNITION')!; const purchase = delivered.entries.find(entry => entry.kind === 'EVENT_CONTRACT_PURCHASE')!;
  assert.equal(revenue.causeId, purchase.causeId); assert.equal(revenue.lines[0]!.amountAtoms, purchase.lines[0]!.amountAtoms);
  assert.equal(delivered.companies[0]!.balances.cash, state.companies[0]!.balances.cash);
  assert.ok(delivered.companies[0]!.workingCapital.some(item => item.causeId === revenue.causeId && item.kind === 'AR' && item.dueTick === 29));
  assert.throws(() => executeEvent(stateAfter(state, start, 1), template, 2, midpoint, revenue.causeId));
});
test('procurement contract creates inventory and AP, without pretending customer sales', () => {
  const template = t('CONTRACT', { subjects: ['VTR'], contractRole: 'CUSTOMER', eligibility: ['OPERATING', 'ACTIVE_NEGOTIATION'], projectKey: 'test:procurement', duration: { min: 63, max: 63 } });
  const state = seed(template), start = executeEvent(state, template, 1, midpoint); const result = advanceEvents(stateAfter(state, start, 1), start.macro, 2, midpoint, [template]); balanced(result);
  assert.ok(result.entries.some(entry => entry.kind === 'EVENT_PROCUREMENT_DELIVERY')); assert.ok(!result.entries.some(entry => entry.kind === 'EVENT_CONTRACT_RECOGNITION'));
});
test('DEMAND/COST/PRICING/OPERATE alter their named operation and expire without basis compounding', () => {
  const base = createEconomyState('event_test'); const normal = advanceCorporations(base.marketId, base.companies, base.contracts, base.macro, 1, midpoint);
  for (const [profile, target] of [['DEMAND', 'demand'], ['COST', 'energy'], ['PRICING', 'unitPrice'], ['OPERATE', 'productivity']] as const) {
    const template = t(profile, { target }); const event = executeEvent(base, template, 1, midpoint);
    const actual = advanceCorporations(base.marketId, event.companies, event.contracts, event.macro, 1, midpoint, event.modifiers);
    if (profile === 'COST') { assert.ok(BigInt(actual.companies[0]!.currentQuarter.energyAtoms) > BigInt(normal.companies[0]!.currentQuarter.energyAtoms)); assert.equal(actual.companies[0]!.currentQuarter.revenueAtoms, normal.companies[0]!.currentQuarter.revenueAtoms); }
    else assert.ok(BigInt(actual.companies[0]!.currentQuarter.revenueAtoms) > BigInt(normal.companies[0]!.currentQuarter.revenueAtoms));
    assert.equal(eventEffectAt(event.events.occurrences[0]!, template, 4), '0');
    assert.equal(actual.companies[0]!.unitPriceBasis, normal.companies[0]!.unitPriceBasis);
  }
});
test('inventory turnover consumes book inventory through cost recognition and lowers new payable funding', () => {
  const base = createEconomyState('event_test'); const template = t('OPERATE', { target: 'inventoryTurnover', unit: 'PERCENTAGE_POINTS' }); const event = executeEvent(base, template, 1, midpoint);
  const actual = advanceCorporations(base.marketId, event.companies, event.contracts, event.macro, 1, midpoint, event.modifiers);
  assert.ok(actual.entries.some(entry => entry.kind === 'EVENT_INVENTORY_CONSUMPTION'));
  assert.ok(BigInt(actual.companies[0]!.balances.inventory) < BigInt(base.companies[0]!.balances.inventory)); actual.companies.forEach(checkCorporateBalance);
});
test('CAPEX records 30% advance as supplier liability and improves capacity only when commissioned', () => {
  const template = t('CAPEX', { subjects: ['VTR', 'HGI'], scope: 'RELATION', target: 'cash', unit: 'CASH_FRACTION', investmentAccounting: 'CAPITALIZE' }); const state = seed(template);
  const start = executeEvent(state, template, 1, midpoint); balanced(start); const supplier = start.companies.find(company => company.symbol === 'VTR')!; const customer = start.companies[0]!;
  assert.ok(BigInt(supplier.balances.contract_liability) > 0n); assert.equal(supplier.currentQuarter.revenueAtoms, '0'); assert.equal(customer.productivity, state.companies[0]!.productivity);
  const finish = advanceEvents(stateAfter(state, start, 1), start.macro, 4, midpoint, [template]); balanced(finish);
  assert.equal(finish.companies.find(company => company.symbol === 'VTR')!.balances.contract_liability, '0'); assert.equal(finish.companies[0]!.productivity, '1.03');
  assert.ok(finish.publications.some(publication => publication.kind === 'EVENT' && publication.disclosure.actual.projectStatus === 'COMPLETED'));
});
test('supplier-owned facility keeps supplier assets and defers reservation service revenue after completion', () => {
  const template = t('CAPEX', { subjects: ['RVI', 'NXC'], scope: 'RELATION', target: 'cash', unit: 'CASH_FRACTION', investmentAccounting: 'CAPITALIZE', investmentOwner: 'SUPPLIER' }); const state = seed(template), start = executeEvent(state, template, 1, midpoint);
  const finish = advanceEvents(stateAfter(state, start, 1), start.macro, 4, midpoint, [template]); balanced(finish);
  assert.equal(finish.companies.find(company => company.symbol === 'RVI')!.productivity, '1.03'); assert.equal(finish.companies.find(company => company.symbol === 'NXC')!.productivity, '1');
  assert.ok(BigInt(finish.companies.find(company => company.symbol === 'RVI')!.balances.contract_liability) > 0n);
  const service = advanceEvents(stateAfter(state, finish, 4), finish.macro, 5, midpoint, [template]); balanced(service); assert.ok(service.entries.some(entry => entry.kind === 'EVENT_RESERVED_CAPACITY_REVENUE'));
});
test('R&D is a current cash expense, not an asset awaiting capitalized completion', () => {
  const template = t('CAPEX', { target: 'cash', unit: 'CASH_FRACTION', investmentAccounting: 'RESEARCH_EXPENSE' }); const state = seed(template), result = executeEvent(state, template, 1, midpoint); balanced(result);
  assert.equal(result.companies[0]!.balances.construction_in_progress, '0'); assert.equal(result.companies[0]!.investments.length, 0); assert.ok(BigInt(result.companies[0]!.currentQuarter.researchAtoms) > 0n);
});
test('INCIDENT impairs only existing book assets and has no duplicate cash charge', () => {
  const template = t('INCIDENT', { subjects: ['NXC'], target: 'intangibleAssets', unit: 'ASSET_FRACTION' }); const state = seed(template), result = executeEvent(state, template, 1, midpoint); balanced(result);
  const before = state.companies.find(company => company.symbol === 'NXC')!, after = result.companies.find(company => company.symbol === 'NXC')!;
  assert.equal(after.balances.cash, before.balances.cash); assert.ok(BigInt(after.balances.intangible_assets) < BigInt(before.balances.intangible_assets));
});
test('refinancing changes one matured contract, preserves other fixed rates and records gross issue/repayment/fee', () => {
  const template = t('FINANCE', { target: 'creditSpread', unit: 'PERCENTAGE_POINTS', financeAction: 'SPREAD', eligibility: ['OPERATING', 'MATURE_DEBT'] }); const original = seed(template); const company = original.companies[0]!;
  const state = { ...original, companies: original.companies.map(value => value.issuerId === company.issuerId ? { ...value, debtContracts: value.debtContracts.map((debt, index) => index === 0 ? { ...debt, maturityTick: 1 } : debt) } : value) };
  const result = executeEvent(state, template, 1, midpoint); balanced(result); const next = result.companies[0]!;
  assert.notEqual(next.debtContracts[0]!.annualEffectiveRate, company.debtContracts[0]!.annualEffectiveRate); assert.deepEqual(next.debtContracts.slice(1), company.debtContracts.slice(1));
  assert.equal(next.balances.debt, company.balances.debt); assert.equal(next.currentQuarter.debtIssuedAtoms, next.currentQuarter.debtRepaidAtoms); assert.ok(result.entries.some(entry => entry.kind === 'EVENT_REFINANCE_FEE'));
});
test('external equity, real due-date extension, disposal, repayment and conditional grants reconcile', () => {
  for (const action of ['EQUITY_ISSUE', 'COLLECTION_DELAY', 'PAYMENT_EXTENSION', 'ASSET_DISPOSAL', 'DEBT_REPAYMENT', 'CONDITIONAL_SUPPORT'] as const) {
    const template = t('FINANCE', { target: 'cash', unit: 'CASH_FRACTION', financeAction: action }); const state = seed(template), result = executeEvent(state, template, 1, midpoint); balanced(result);
    if (action === 'EQUITY_ISSUE') { assert.ok(BigInt(result.companies[0]!.issuedShares) > BigInt(state.companies[0]!.issuedShares)); assert.equal(result.actions[0]!.kind, 'FINANCING'); }
    if (action === 'COLLECTION_DELAY') assert.equal(result.companies[0]!.workingCapital[0]!.dueTick, state.companies[0]!.workingCapital[0]!.dueTick + 3);
    if (action === 'DEBT_REPAYMENT') assert.ok(BigInt(result.companies[0]!.balances.debt) < BigInt(state.companies[0]!.balances.debt));
    if (action === 'CONDITIONAL_SUPPORT') assert.ok(BigInt(result.companies[0]!.balances.contract_liability) > 0n);
  }
});
test('MILESTONE failure fixes the project terminal state and cannot reuse its cause as later success', () => {
  const template = t('MILESTONE', { subjects: ['LMB'], operation: 'CANCEL', mode: 'FOLLOWUP', hazardWeight: '0', target: 'successProbability', unit: 'PERCENTAGE_POINTS', magnitude: { min: '-0.1', max: '-0.1' }, projectKey: 'test:pipeline', eligibility: ['OPERATING', 'ACTIVE_PROJECT'] }); const state = seed(template), result = executeEvent(state, template, 1, midpoint); balanced(result);
  assert.equal(result.events.projects[0]!.status, 'FAILED'); assert.throws(() => executeEvent(stateAfter(state, result, 1), { ...template, id: 'TEST-success', magnitude: { min: '0.1', max: '0.1' } }, 2, midpoint));
});
test('BELIEF changes only disclosed sentiment, decays by half-life, and hidden lag does not affect value', () => {
  const template = t('BELIEF', { target: 'sentiment', halfLifeTicks: 3, decay: 'HALF_LIFE', duration: { min: 12, max: 12 }, publishLagTicks: 2 }); const state = seed(template), start = executeEvent(state, template, 1, midpoint); assert.equal(start.entries.length, 0); assert.deepEqual(start.companies, state.companies);
  const prior = createPublicEconomy(INITIAL_COMPANIES, 0, state.marketId), hidden = publishEconomy(prior, start.publications, 1).state; assert.deepEqual(valueCompanies(prior).map(item => item.continuationValuePerShare), valueCompanies(hidden).map(item => item.continuationValuePerShare));
  const step = advanceEvents(stateAfter(state, start, 1), start.macro, 3, midpoint, [template]), published = publishEconomy(hidden, step.publications, 3).state;
  const now = publicBeliefSentiment(state.companies[0]!.issuerId, published.eventDisclosures, 3); const later = publicBeliefSentiment(state.companies[0]!.issuerId, published.eventDisclosures, 6); assert.ok(new D(later).mul(2).eq(now));
});
test('positive actual news below public expectation reduces growth; public schema rejects private future state', () => {
  const publicState = createPublicEconomy(INITIAL_COMPANIES, 0, 'event_test'), company = publicState.companies[0]!;
  const event: EventDisclosure = { id: 'pub_news', causeId: 'cause_news', templateId: 'TEST-news', templateVersion: 1, profile: 'DEMAND', title: '매출 증가', publicCopy: '실제20%, 기대35%', issuerIds: [company.issuerId], symbols: ['HGI'], effectiveTick: 1, publishTick: 2, actual: { demand: '0.2' }, expected: { demand: '0.35' }, previous: { demand: '0.1' }, certainty: 'CONFIRMED', sourceType: 'COMPANY', target: 'demand', magnitude: '0.2', duration: 63, halfLifeTicks: null, decay: 'NONE', sectorExposure: '1', reversalRule: 'EXPIRE' };
  assert.ok(new D(publicEventCompany(company, [event], 2).forecast.annualRevenueGrowth).lt(company.forecast.annualRevenueGrowth));
  assert.throws(() => validatePublicEconomy({ ...publicState, events: createEconomyState('event_test').events }));
});
test('regular policy outcomes emit one consistent title without independent hazard or repeated rate effect', () => {
  const state = createEconomyState('event_test'); const macro = { ...state.macro, policyRate: '0.0325' }; const expectation = { meetingTick: 42, decreaseProbability: '0.2', unchangedProbability: '0.6', increaseProbability: '0.2', expectedRate: '0.0325' };
  const publications = domainEventPublications(state, [{ id: 'macro_result', kind: 'MACRO', effectiveTick: 21, publishTick: 21, macro, expectation, previousPolicyRate: '0.03' }], [], 21);
  const policies = publications.filter(item => item.kind === 'EVENT' && ['MAC-01', 'MAC-02', 'MAC-03'].includes(item.disclosure.templateId)); assert.equal(policies.length, 1);
  assert.ok(policies[0]!.kind === 'EVENT' && /인상/.test(policies[0]!.disclosure.title)); assert.equal(state.macro.policyRate, '0.03');
});
test('legacy private snapshot default upgrade preserves original objects and uses explicit fixture projects', () => {
  const state = createEconomyState('event_test'); const legacy = structuredClone(state) as unknown as Record<string, unknown>; delete legacy.events;
  const normalized = validateEconomyState(legacy); assert.ok(normalized.events.projects.length > 0); assert.ok(!('events' in legacy));
});
test('private cash and project probabilities do not leak into expected/previous public event observations', () => {
  const template = t('MILESTONE', { subjects: ['LMB'], target: 'successProbability', unit: 'PERCENTAGE_POINTS', eligibility: ['OPERATING', 'ACTIVE_PROJECT'], projectKey: 'test:probability', mode: 'FOLLOWUP', hazardWeight: '0' });
  const state = seed(template), publicState = createPublicEconomy(INITIAL_COMPANIES, 0, state.marketId);
  const changed = { ...state, events: { ...state.events, projects: state.events.projects.map(project => ({ ...project, successProbability: '0.8' })) } };
  const first = executeEvent(state, template, 1, midpoint, undefined, publicState).events.occurrences[0]!, second = executeEvent(changed, template, 1, midpoint, undefined, publicState).events.occurrences[0]!;
  assert.deepEqual(first.previous, second.previous); assert.deepEqual(first.expected, second.expected); assert.notDeepEqual(first.actual, second.actual);
  assert.equal(first.previous.successProbability, publicState.companies.find(company => company.baseSymbol === 'LMB')!.forecast.successProbability);
});
test('disclosed supplier advance adds matching cash and liability, preserving value before completion', () => {
  const template = t('CAPEX', { subjects: ['VTR', 'HGI'], scope: 'RELATION', target: 'cash', unit: 'CASH_FRACTION', investmentAccounting: 'CAPITALIZE' }); const state = seed(template), step = executeEvent(state, template, 1, midpoint);
  const prior = createPublicEconomy(INITIAL_COMPANIES, 0, state.marketId), after = publishEconomy(prior, step.publications, 1).state;
  const supplier = after.companies.find(company => company.baseSymbol === 'VTR')!;
  assert.equal(supplier.corporateCashAdjustmentAtoms, supplier.corporateLiabilityAdjustmentAtoms);
  assert.equal(valueCompanies(prior).find(company => company.symbol === 'VTR')!.continuationValuePerShare, valueCompanies(after).find(company => company.symbol === 'VTR')!.continuationValuePerShare);
  assert.ok(BigInt(after.companies[0]!.corporateCashAdjustmentAtoms) < 0n);
});
test('realized foreign receivable movement records one cash gain/loss and an explicit one-time report component', () => {
  const state = createEconomyState('event_test'), owner = state.companies[0]!;
  const companies = state.companies.map(company => company.issuerId === owner.issuerId ? { ...company, workingCapital: company.workingCapital.map(item => item.kind === 'AR' ? { ...item, fxAtOrigination: '100', foreignExposure: '0.22' } : item) } : company);
  const result = advanceCorporations(state.marketId, companies, state.contracts, { ...state.macro, fx: '80' }, 14, midpoint); result.companies.forEach(checkCorporateBalance);
  const losses = result.entries.filter(entry => entry.issuerId === owner.issuerId && entry.kind === 'REALIZED_FOREIGN_EXCHANGE_LOSS'); assert.equal(losses.length, 1);
  assert.equal(result.companies[0]!.currentQuarter.foreignExchangeProfitAtoms, (-BigInt(losses[0]!.lines[0]!.amountAtoms)).toString());
});
test('new acquired pipeline creates a new active research instance while retaining the old failed cause', () => {
  const template = { ...getEventTemplate('LMB-21'), sectorExposure: '1', duration: { min: 3, max: 3 }, outcomes: [{ id: 'commissioned', probability: '1', magnitudeMultiplier: '1' }] };
  const state = createEconomyState('event_test'); const old = state.events.projects.find(project => project.key === 'LMB:pipeline')!;
  const failed = { ...state, events: { ...state.events, projects: state.events.projects.map(project => project.id === old.id ? { ...project, status: 'FAILED' as const, successorTemplateId: null } : project) } };
  const start = executeEvent(failed, template, 1, midpoint), complete = advanceEvents(stateAfter(failed, start, 1), start.macro, 4, midpoint);
  assert.equal(complete.events.projects.find(project => project.id === old.id)!.status, 'FAILED');
  const fresh = complete.events.projects.find(project => project.key === 'LMB:pipeline' && project.status === 'ACTIVE')!; assert.ok(fresh); assert.notEqual(fresh.id, old.id); assert.notEqual(fresh.causeId, old.causeId);
});
test('natural budget-free project followup cancels an uncommissioned equipment contract and refunds both books', () => {
  const template = { ...getEventTemplate('XCO-11'), duration: { min: 8, max: 8 }, outcomes: [{ id: 'agreed', probability: '1', magnitudeMultiplier: '1' }] };
  const state = seed(template), start = executeEvent(state, template, 1, midpoint);
  const cancelled = advanceEvents(stateAfter(state, start, 1), start.macro, 5, { uniform: () => '0' }); balanced(cancelled);
  assert.ok(cancelled.events.occurrences.some(occurrence => occurrence.templateId === 'XCO-22' && occurrence.causeId === start.events.occurrences[0]!.causeId));
  const source = cancelled.events.projects.find(project => project.key === template.projectKey)!; assert.equal(source.status, 'CANCELLED');
  assert.equal(cancelled.companies.find(company => company.symbol === 'DNL')!.balances.construction_in_progress, '0'); assert.equal(cancelled.companies.find(company => company.symbol === 'VTR')!.balances.contract_liability, '0');
  assert.ok(cancelled.companies.find(company => company.symbol === 'DNL')!.investments.every(investment => investment.status === 'CANCELLED'));
  const later = advanceEvents(stateAfter(state, cancelled, 5), cancelled.macro, 9, midpoint); assert.ok(!later.entries.some(entry => entry.kind === 'EVENT_CAPEX_COMMISSIONED'));
});

test('expired cooldown never reselects a template already executed for its project cause', () => {
  const template = t('COST', { target: 'energy', projectKey: 'test:ongoing', eligibility: ['OPERATING', 'ACTIVE_PROJECT'] });
  const state = seed(template), first = executeEvent(state, template, 1, midpoint), prior = stateAfter(state, first, 1);
  assert.equal(eventEligible(template, prior, 5), false);
  const again = advanceEvents(prior, prior.macro, 5, { uniform: () => '0.8' }, [template]);
  assert.equal(again.events.occurrences.length, 1); balanced(again);
  const renewed = { ...prior, events: { ...prior.events, projects: prior.events.projects.map(project => ({ ...project, id: `${project.id}_new`, causeId: `${project.causeId}_new` })) } };
  assert.equal(eventEligible(template, renewed, 5), true);
  assert.equal(advanceEvents(renewed, renewed.macro, 5, { uniform: () => '0.8' }, [template]).events.occurrences.length, 2);
});
