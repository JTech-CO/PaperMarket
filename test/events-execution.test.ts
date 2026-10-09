import assert from 'node:assert/strict';
import test from 'node:test';
import { FinancialDecimal as D, parseMoney } from '../src/domain/numeric.js';
import { INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { checkCorporateBalance } from '../src/economy/corporate.js';
import { createEconomyState, validateEconomyState } from '../src/economy/engine.js';
import { createPublicEconomy, publishEconomy, validatePublicEconomy } from '../src/economy/public.js';
import type { CompanyTrueState, CorporateAction, CorporateDividend, EconomyPublication, EconomyRandom, EconomyState, InvestmentProject } from '../src/economy/types.js';
import { EVENT_CATALOG, getEventTemplate } from '../src/events/catalog.js';
import { advanceEvents, domainEventPublications, eventEligible, executeEvent, initialEventState } from '../src/events/engine.js';
import type { EventProject, EventTemplate } from '../src/events/types.js';
import type { EventDomainEvidence } from '../src/events/types.js';
import { eventDisclosureSchema, eventRuntimeSchema } from '../src/events/validator.js';

const random: EconomyRandom = { uniform: () => '0.5' };
const executionTick = 1;
const money = (value: string) => parseMoney(value).toString();
const sum = (state: EconomyState, key: 'cash' | 'contract_liability') => state.companies.reduce((total, company) => total + BigInt(company.balances[key]), 0n);
function updateCompany(state: EconomyState, issuerId: string, update: (company: CompanyTrueState) => CompanyTrueState): EconomyState {
  return { ...state, companies: state.companies.map(company => company.issuerId === issuerId ? update(company) : company) };
}
/** Preconditions represent existing commitments; every synthetic balance change has its counterpart. */
function eligibleFixture(template: EventTemplate): EconomyState {
  let state = createEconomyState(`catalog_execution_${template.id.replace('-', '_')}`);
  const ids = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!.issuerId);
  let project: EventProject | undefined;
  if (template.projectKey) {
    project = initialEventState(state.companies, 0, [{ ...template, eligibility: ['ACTIVE_PROJECT'] }]).projects[0]!;
    const negotiation = template.eligibility.includes('ACTIVE_NEGOTIATION');
    const contract = template.eligibility.includes('ACTIVE_CONTRACT');
    project = { ...project, status: negotiation ? 'NEGOTIATING' : 'ACTIVE', completionTick: 6, amountAtoms: contract ? money('1000000') : '0' };
  }
  state = { ...state, events: { schemaVersion: 1, projects: project ? [project] : [], occurrences: [], cooldowns: {} } };
  if (template.eligibility.includes('MATURE_DEBT')) for (const id of ids) state = updateCompany(state, id, company => ({ ...company, debtContracts: company.debtContracts.map((debt, index) => index === 0 ? { ...debt, maturityTick: executionTick } : debt) }));
  if (template.eligibility.includes('COMPLETED_INVESTMENT')) {
    assert.ok(project, template.id);
    const owner = ids.at(-1)!;
    const investment: InvestmentProject = { id: `${project.id}_asset`, causeId: project.causeId, contractId: null, amountAtoms: money('1000'), startedTick: 0, completionTick: 0, status: 'OPERATING', usefulLifeTicks: 2520, depreciatedAtoms: '0', productivityEffect: '0.03' };
    project = { ...project, status: 'COMPLETED', amountAtoms: investment.amountAtoms, recognizedAtoms: investment.amountAtoms, paidAtoms: investment.amountAtoms, investmentId: investment.id, completionTick: 0 };
    state = updateCompany(state, owner, company => ({ ...company, investments: [investment] }));
    state = { ...state, events: { ...state.events, projects: [project] } };
  }
  if (template.financeAction === 'SUPPORT_WITHDRAWAL') {
    assert.ok(project, template.id);
    const each = parseMoney('1000');
    for (const id of ids) state = updateCompany(state, id, company => ({ ...company, balances: { ...company.balances, cash: (BigInt(company.balances.cash) + each).toString(), contract_liability: (BigInt(company.balances.contract_liability) + each).toString() } }));
    project = { ...project, status: 'ACTIVE', supportAtoms: (each * BigInt(ids.length)).toString(), supportByIssuer: Object.fromEntries(ids.map(id => [id, each.toString()])) };
    state = { ...state, events: { ...state.events, projects: [project] } };
  }
  if (template.financeAction === 'COLLECTION_DELAY' || template.financeAction === 'PAYMENT_EXTENSION') {
    const creditor = ids[0]!, debtor = ids[1];
    const amount = parseMoney('1000'), causeId = project?.causeId ?? `claim_cause_${template.id}`, contractId = debtor ? `claim_${template.id}` : null;
    state = updateCompany(state, creditor, company => ({ ...company, balances: { ...company.balances, receivables: (BigInt(company.balances.receivables) + amount).toString(), retained_earnings: (BigInt(company.balances.retained_earnings) + amount).toString() }, workingCapital: [...company.workingCapital, { id: `${template.id}_target_ar`, causeId, contractId, counterparty: debtor ? template.subjects[1]! : 'EXTERNAL', counterpartyIssuerId: debtor ?? null, amountAtoms: amount.toString(), dueTick: 10, kind: 'AR', overdueSinceTick: null }] }));
    if (debtor) {
      state = updateCompany(state, debtor, company => ({ ...company, balances: { ...company.balances, trade_payables: (BigInt(company.balances.trade_payables) + amount).toString(), retained_earnings: (BigInt(company.balances.retained_earnings) - amount).toString() }, workingCapital: [...company.workingCapital, { id: `${template.id}_target_ap`, causeId, contractId, counterparty: template.subjects[0]!, counterpartyIssuerId: creditor, amountAtoms: amount.toString(), dueTick: 10, kind: 'AP', overdueSinceTick: null }] }));
      state = { ...state, contracts: [...state.contracts, { contractId: contractId!, supplier: template.subjects[0]!, customer: template.subjects[1]!, kind: 'RAW_MATERIALS', costBucket: 'rawMaterials', exposure: '0', settlementLagTicks: 7 }] };
    }
  }
  return validateEconomyState(state);
}
function stateAfter(prior: EconomyState, result: ReturnType<typeof executeEvent>, tick = executionTick): EconomyState {
  return validateEconomyState({ ...prior, tickNo: tick, companies: result.companies, macro: result.macro, contracts: result.contracts, events: result.events });
}
function balanced(result: ReturnType<typeof executeEvent>): void {
  for (const company of result.companies) checkCorporateBalance(company);
  for (const entry of result.entries) {
    assert.equal(entry.lines.filter(line => line.side === 'DR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n), entry.lines.filter(line => line.side === 'CR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n));
    assert.ok(entry.lines.every(line => BigInt(line.amountAtoms) > 0n));
  }
  eventRuntimeSchema.parse(result.events);
  for (const publication of result.publications) if (publication.kind === 'EVENT') {
    eventDisclosureSchema.parse(publication.disclosure);
    assert.equal(publication.publishTick, publication.disclosure.publishTick);
    assert.equal(publication.id, publication.disclosure.id);
  }
}

for (const template of EVENT_CATALOG) {
  if (template.mode === 'DOMAIN_ONLY') {
    test(`${template.id} ${template.title}: domain source required; independent execution rejected`, () => {
      const state = createEconomyState(`domain_execution_${template.id.replace('-', '_')}`);
      assert.equal(eventEligible(template, state, executionTick), false);
      assert.throws(() => executeEvent(state, template, executionTick, random), /Ineligible/);
      assert.deepEqual(domainEventPublications(state, [], [], 21, [template]), []);
    });
    continue;
  }
  test(`${template.id} ${template.title}: execute eligible real channel and preserve accounting`, () => {
    const state = eligibleFixture(template);
    assert.equal(eventEligible(template, state, executionTick), true);
    const result = executeEvent(state, template, executionTick, random);
    balanced(result);
    const after = stateAfter(state, result);
    const occurrence = result.events.occurrences.find(item => item.templateId === template.id)!;
    assert.ok(occurrence);
    assert.equal(occurrence.templateVersion, template.version);
    assert.deepEqual(occurrence.symbols, template.subjects);
    const magnitudeBounds = template.outcomes.flatMap(outcome => [new D(template.magnitude.min).mul(outcome.magnitudeMultiplier), new D(template.magnitude.max).mul(outcome.magnitudeMultiplier)]);
    assert.ok(new D(occurrence.magnitude).gte(D.min(...magnitudeBounds)) && new D(occurrence.magnitude).lte(D.max(...magnitudeBounds)), template.id);
    assert.ok(occurrence.duration >= template.duration.min && occurrence.duration <= template.duration.max);
    assert.throws(() => executeEvent(after, template, 2, random, occurrence.causeId), /Duplicate|Ineligible/);
    const publicBefore = createPublicEconomy(INITIAL_COMPANIES, 0, state.marketId);
    const publicAfter = publishEconomy(publicBefore, result.publications, executionTick, result.actions).state;
    validatePublicEconomy(publicAfter);
    assert.equal(publicAfter.tickNo, executionTick);
    if (template.profile === 'BELIEF') {
      assert.deepEqual(result.companies, state.companies);
      assert.equal(result.entries.length, 0);
      assert.equal(result.actions.length, 0);
    }
    if (template.profile === 'MILESTONE') {
      const project = result.events.projects.find(item => item.key === template.projectKey)!;
      assert.ok(project);
      if (template.operation === 'CANCEL') assert.equal(project.status, 'FAILED');
      else if (template.operation === 'DELAY') {
        assert.equal(project.status, 'ACTIVE', `${template.id} postponement must preserve the remaining project`);
        assert.ok(project.completionTick > state.events.projects[0]!.completionTick);
      } else {
        assert.notEqual(project.status, 'FAILED', `${template.id} a probability revision is not terminal failure`);
        if (template.operation === 'DECREASE') assert.ok(new D(project.successProbability).lt(state.events.projects[0]!.successProbability));
        if (template.operation === 'INCREASE') assert.ok(new D(project.successProbability).gt(state.events.projects[0]!.successProbability));
      }
    }
    if (template.profile === 'INCIDENT') {
      for (const symbol of template.subjects) {
        const before = state.companies.find(company => company.symbol === symbol)!;
        const next = result.companies.find(company => company.symbol === symbol)!;
        assert.equal(next.balances.cash, before.balances.cash, `${template.id}: record liability/impairment, no duplicate cash debit`);
        if (template.unit === 'RATIO') assert.equal(next.balances.operating_assets, before.balances.operating_assets, `${template.id}: interruption does not imply destruction of unrelated assets`);
        if (template.unit === 'CASH_FRACTION') assert.equal(next.balances.operating_assets, before.balances.operating_assets, `${template.id}: compensation obligation does not impair equipment`);
      }
    }
    if (template.profile === 'CAPEX' && template.investmentAccounting === 'RESEARCH_EXPENSE') {
      const owner = result.companies.find(company => company.symbol === template.subjects.at(-1))!;
      const before = state.companies.find(company => company.issuerId === owner.issuerId)!;
      assert.equal(owner.balances.construction_in_progress, before.balances.construction_in_progress);
      assert.ok(BigInt(owner.currentQuarter.researchAtoms) > BigInt(before.currentQuarter.researchAtoms));
    }
    if (template.profile === 'CAPEX' && template.investmentAccounting === 'MARKETING_EXPENSE') {
      const owner = result.companies.find(company => company.symbol === template.subjects.at(-1))!;
      assert.equal(owner.balances.construction_in_progress, '0');
      assert.ok(BigInt(owner.currentQuarter.serviceAtoms) > 0n);
    }
    if (template.financeAction === 'EQUITY_ISSUE') {
      for (const symbol of template.subjects) {
        const before = state.companies.find(company => company.symbol === symbol)!;
        const next = result.companies.find(company => company.symbol === symbol)!;
        assert.ok(BigInt(next.issuedShares) > BigInt(before.issuedShares));
        const action = result.actions.find(item => item.kind === 'FINANCING' && item.issuerId === next.issuerId);
        assert.ok(action && action.kind === 'FINANCING');
        assert.equal(BigInt(next.balances.cash) - BigInt(before.balances.cash), BigInt(action.raisedAtoms));
      }
    }
    if (template.financeAction === 'DEBT_REPAYMENT') {
      for (const symbol of template.subjects) {
        const before = state.companies.find(company => company.symbol === symbol)!;
        const next = result.companies.find(company => company.symbol === symbol)!;
        assert.ok(BigInt(next.balances.debt) < BigInt(before.balances.debt));
        assert.ok(BigInt(next.balances.cash) < BigInt(before.balances.cash));
      }
    }
    if (template.financeAction === 'COLLECTION_DELAY' || template.financeAction === 'PAYMENT_EXTENSION') {
      assert.equal(sum(after, 'cash'), sum(state, 'cash'));
      const targetClaims = after.companies.flatMap(company => company.workingCapital).filter(item => item.id.startsWith(`${template.id}_target_`));
      assert.ok(targetClaims.every(item => item.dueTick === 10 + occurrence.duration), `${template.id}: matched claims change exactly once`);
      for (const company of after.companies) {
        const before = state.companies.find(prior => prior.issuerId === company.issuerId)!;
        for (const item of before.workingCapital.filter(item => !item.id.startsWith(`${template.id}_target_`))) assert.deepEqual(company.workingCapital.find(next => next.id === item.id), item, `${template.id}: unrelated claim ${item.id} must stay unchanged`);
      }
    }
    if (template.financeAction === 'CONDITIONAL_SUPPORT') {
      assert.ok(sum(after, 'cash') > sum(state, 'cash'));
      assert.equal(sum(after, 'cash') - sum(state, 'cash'), sum(after, 'contract_liability') - sum(state, 'contract_liability'));
      assert.ok(result.events.projects.some(project => project.key === template.projectKey && project.issuerIds.length > 0 && BigInt(project.supportAtoms) > 0n));
    }
    if (template.financeAction === 'SUPPORT_WITHDRAWAL') assert.ok(sum(after, 'contract_liability') < sum(state, 'contract_liability'));
    if (['MAC-20', 'MAC-21'].includes(template.id)) assert.ok(Object.values(result.modifiers).some(modifier => !new D(modifier.exportDemand).isZero()), `${template.id}: exported demand must actually reach production`);
    if (template.profile === 'MACRO' && template.financeAction === null && template.unit === 'INDEX_RATIO' && template.target !== 'exportDemand') {
      const before = state.macro[template.target as keyof typeof state.macro];
      const next = result.macro[template.target as keyof typeof result.macro];
      assert.equal(occurrence.actual[template.target], next, `${template.id}: publication must match the resulting macro value`);
      assert.notEqual(next, before, `${template.id}: named macro variable must change`);
    }
    // Investments/contracts are verified through their actual later recognition, not just a balanced opening.
    if (template.profile === 'CONTRACT' && template.operation !== 'CANCEL' && template.operation !== 'DELAY' && template.investmentAccounting !== 'CAPITALIZE') {
      const step = advanceEvents(after, result.macro, 2, { uniform: () => '0' }, [template]);
      balanced(step);
      const purchase = step.entries.find(entry => /CONTRACT_PURCHASE|PROCUREMENT_DELIVERY/.test(entry.kind));
      if (template.contractRole === 'CUSTOMER') {
        assert.ok(purchase, `${template.id}: procurement needs inventory/AP`);
        assert.equal(step.entries.some(entry => entry.kind === 'EVENT_CONTRACT_RECOGNITION'), false);
      } else assert.ok(step.entries.some(entry => entry.kind === 'EVENT_CONTRACT_RECOGNITION'), `${template.id}: delivery revenue must be recognized`);
      if (template.scope === 'RELATION' && template.investmentAccounting === 'RESEARCH_EXPENSE') {
        const customer = step.companies.find(company => company.symbol === template.subjects[1])!;
        assert.ok(BigInt(customer.currentQuarter.researchAtoms) > BigInt(after.companies.find(company => company.issuerId === customer.issuerId)!.currentQuarter.researchAtoms));
      }
    }
    if (['CAPEX', 'CONTRACT'].includes(template.profile) && template.investmentAccounting === 'CAPITALIZE' && template.operation === 'START') {
      const payer = template.subjects.at(-1)!;
      assert.ok(BigInt(after.companies.find(company => company.symbol === payer)!.balances.cash) < BigInt(state.companies.find(company => company.symbol === payer)!.balances.cash), `${template.id}: approved investment must have a real customer outlay`);
      const step = advanceEvents(after, result.macro, executionTick + occurrence.duration, { uniform: () => '0' }, [template]);
      balanced(step);
      const ownerSymbol = template.investmentOwner === 'SUPPLIER' ? template.subjects[0] : template.subjects.at(-1);
      const owner = step.companies.find(company => company.symbol === ownerSymbol)!;
      if (template.target === 'intangibleAssets') {
        const before = state.companies.find(company => company.issuerId === owner.issuerId)!;
        assert.ok(BigInt(owner.balances.intangible_assets) > BigInt(before.balances.intangible_assets), `${template.id}: acquired IP/brand must remain intangible`);
        assert.equal(owner.capacity, before.capacity, `${template.id}: acquired IP is not a new physical factory`);
      }
      if (template.investmentPurpose === 'RELOCATION' || template.investmentPurpose === 'MAINTENANCE') assert.equal(owner.capacity, state.companies.find(company => company.issuerId === owner.issuerId)!.capacity, `${template.id}: moving or repairing existing facilities cannot create additional capacity`);
    }
  });
}

test('actual dividend evidence routes an increase, a decrease or unchanged policy to one consistent title', () => {
  const base = createEconomyState('dividend_evidence');
  const issuer = base.companies.find(company => company.symbol === 'RVI')!;
  const dividend = (dps: string, tick: number): CorporateDividend => {
    const total = new D(dps).mul(issuer.issuedShares).mul('1000000000000').toFixed(0);
    return { id: `dividend_${tick}_${dps}`, issuerId: issuer.issuerId, listingId: issuer.listingId, declaredTick: tick, exTick: tick + 3, payTick: tick + 5, status: tick === 0 ? 'PAID' : 'DECLARED', issuedShares: issuer.issuedShares, totalNominalAtoms: total, dps, remainingPayableAtoms: tick === 0 ? '0' : total, recoveryRatio: '1', paidAtoms: tick === 0 ? total : '0' };
  };
  const prior = { ...updateCompany(base, issuer.issuerId, company => ({ ...company, dividends: [dividend('10', 0)] })), tickNo: 6 };
  const policyCatalog = [getEventTemplate('RVI-10'), getEventTemplate('RVI-20')];
  for (const [dps, expected] of [['20', 'RVI-10'], ['5', 'RVI-20'], ['10', undefined]] as const) {
    const action: CorporateAction = { id: `declared_${dps}`, kind: 'DIVIDEND_DECLARED', issuerId: issuer.issuerId, listingId: issuer.listingId, symbol: issuer.symbol, effectiveTick: 7, dividend: dividend(dps, 7) };
    const results = domainEventPublications(prior, [], [action], 7, policyCatalog);
    assert.equal(results.length, expected ? 1 : 0);
    if (expected) assert.ok(results[0]?.kind === 'EVENT' && results[0].disclosure.templateId === expected);
  }
});

test('ordinary earnings do not fabricate performance/data corrections or FX mismatch losses', () => {
  const state = createEconomyState('evidence_only');
  for (const id of ['AUR-16', 'LMB-16', 'HGI-20']) {
    const template = getEventTemplate(id), issuer = state.companies.find(company => company.symbol === template.subjects[0])!;
    const publication: EconomyPublication = { id: `earnings_${id}`, kind: 'EARNINGS', issuerId: issuer.issuerId, symbol: issuer.symbol, effectiveTick: 63, publishTick: 64, report: { ...issuer.sealedQuarters.at(-1)!, kind: 'ACTUAL', quarterNo: 1, closedTick: 63, publishTick: 64 } };
    assert.deepEqual(domainEventPublications(state, [publication], [], 64, [template]), [], id);
  }
});

for (const id of ['HGI-20', 'AUR-16', 'LMB-16', 'NXC-07', 'NXC-17', 'NXC-19']) {
  test(`${id}: sealed source evidence publishes actual, expected and previous exactly once`, () => {
    const state = createEconomyState(`sealed_evidence_${id.replace('-', '_')}`);
    const template = getEventTemplate(id), issuer = state.companies.find(company => company.symbol === template.subjects[0])!;
    const key = template.target;
    const evidence: EventDomainEvidence = { id: `sealed_${id}`, causeId: `actual_source_${id}`, templateId: id, issuerId: issuer.issuerId, effectiveTick: 2, publishTick: 3, actual: { [key]: id === 'HGI-20' ? '-0.04' : '0.2' }, expected: { [key]: '0.35' }, previous: { [key]: '0.4' } };
    const before = structuredClone(state);
    const publications = domainEventPublications(state, [], [], 3, [template], [evidence]);
    assert.equal(publications.length, 1);
    const item = publications[0]!;
    assert.ok(item.kind === 'EVENT');
    assert.equal(item.disclosure.templateId, id);
    assert.equal(item.disclosure.causeId, evidence.causeId);
    assert.equal(item.disclosure.effectiveTick, 2);
    assert.equal(item.disclosure.publishTick, 3);
    assert.deepEqual(item.disclosure.actual, evidence.actual);
    assert.deepEqual(item.disclosure.expected, evidence.expected);
    assert.deepEqual(item.disclosure.previous, evidence.previous);
    assert.deepEqual(state, before, 'evidence publication must not repeat financial or project effects');
    eventDisclosureSchema.parse(item.disclosure);
    const publicBefore = createPublicEconomy(INITIAL_COMPANIES, 0, state.marketId);
    assert.equal(publishEconomy(publicBefore, publications, 3).state.eventDisclosures.filter(disclosure => disclosure.causeId === evidence.causeId).length, 1);
    assert.throws(() => domainEventPublications(state, [], [], 3, [template], [evidence, evidence]), /Duplicate|duplicate|Invalid|invalid|evidence/i);
    assert.throws(() => domainEventPublications(state, [], [], 3, [template], [{ ...evidence, issuerId: state.companies.find(company => company.symbol !== issuer.symbol)!.issuerId }]));
  });
}

test('typed domain evidence cannot activate a random hazard or inject unsealed private fields', () => {
  const state = createEconomyState('strict_evidence');
  const evidence: EventDomainEvidence = { id: 'sealed_bad', causeId: 'source_bad', templateId: 'HGI-02', issuerId: state.companies[0]!.issuerId, effectiveTick: 2, publishTick: 3, actual: { exportDemand: '0.2' }, expected: { exportDemand: '0.1' }, previous: { exportDemand: '0' } };
  assert.throws(() => domainEventPublications(state, [], [], 3, EVENT_CATALOG, [evidence]));
  assert.throws(() => domainEventPublications(state, [], [], 3, EVENT_CATALOG, [{ ...evidence, templateId: 'HGI-20', trueState: state } as EventDomainEvidence]));
});

for (const [id, actualValue] of [['MAC-01', '0.0325'], ['MAC-02', '0.0275'], ['MAC-03', '0.03'], ['MAC-04', '0.025'], ['MAC-05', '0.015'], ['MAC-06', '103'], ['MAC-07', '97'], ['MAC-08', '103'], ['MAC-09', '97']] as const) {
  test(`${id}: actual scheduled macro source publishes the matching observation without rerolling it`, () => {
    const state = createEconomyState(`observed_source_${id.replace('-', '_')}`);
    const template = getEventTemplate(id);
    const observation = { ...state.macro, [template.target]: actualValue };
    const publication: EconomyPublication = { id: `scheduled_${id}`, kind: 'MACRO', effectiveTick: 21, publishTick: 21, macro: observation, expectation: { meetingTick: 42, decreaseProbability: '0.2', unchangedProbability: '0.6', increaseProbability: '0.2', expectedRate: actualValue }, previousPolicyRate: state.macro.policyRate };
    const results = domainEventPublications(state, [publication], [], 21, [template]);
    assert.equal(results.length, 1);
    const result = results[0]!;
    assert.ok(result.kind === 'EVENT');
    assert.equal(result.disclosure.actual[template.target], actualValue);
    assert.equal(result.disclosure.causeId, publication.id);
    assert.equal(result.disclosure.magnitude, '0', 'scheduled publication must not apply the physical outcome again');
    eventDisclosureSchema.parse(result.disclosure);
    assert.equal(state.macro.policyRate, '0.03');
  });
}

for (const insufficientCash of [false, true]) {
  test(`XCO-11 → XCO-22: cancellation settles actual advance${insufficientCash ? ' as a matched refund claim when cash is insufficient' : ' without stranded assets'}`, () => {
    const order = getEventTemplate('XCO-11'), cancellation = getEventTemplate('XCO-22');
    const before = eligibleFixture(order);
    const started = executeEvent(before, order, 1, { uniform: () => '0' });
    let state = stateAfter(before, started);
    const project = started.events.projects.find(item => item.key === order.projectKey)!;
    const supplier = state.companies.find(company => company.symbol === 'VTR')!;
    const customer = state.companies.find(company => company.symbol === 'DNL')!;
    const advance = BigInt(project.paidAtoms);
    assert.ok(advance > 0n);
    if (insufficientCash) state = updateCompany(state, supplier.issuerId, company => ({ ...company, balances: { ...company.balances, cash: '0', retained_earnings: (BigInt(company.balances.retained_earnings) - BigInt(company.balances.cash)).toString() } }));
    const tick = project.completionTick;
    assert.equal(eventEligible(cancellation, state, tick), true);
    const result = executeEvent(state, cancellation, tick, { uniform: () => '0' });
    balanced(result);
    const after = stateAfter(state, result, tick);
    const finalSupplier = after.companies.find(company => company.issuerId === supplier.issuerId)!;
    const finalCustomer = after.companies.find(company => company.issuerId === customer.issuerId)!;
    assert.equal(finalCustomer.balances.construction_in_progress, before.companies.find(company => company.issuerId === customer.issuerId)!.balances.construction_in_progress);
    assert.equal(finalSupplier.balances.contract_liability, before.companies.find(company => company.issuerId === supplier.issuerId)!.balances.contract_liability);
    assert.equal(finalCustomer.investments.find(investment => investment.id === project.investmentId)?.status, 'CANCELLED');
    assert.equal(after.events.projects.find(item => item.id === project.id)?.status, 'CANCELLED');
    assert.equal(sum(after, 'cash'), sum(state, 'cash'), 'internal refund cannot create market cash');
    assert.ok(result.entries.every(entry => entry.causeId === project.causeId));
    if (insufficientCash) {
      const payable = finalSupplier.workingCapital.find(item => item.causeId === project.causeId && item.kind === 'AP')!;
      const receivable = finalCustomer.workingCapital.find(item => item.causeId === project.causeId && item.kind === 'AR')!;
      assert.equal(BigInt(payable.amountAtoms), advance);
      assert.equal(payable.amountAtoms, receivable.amountAtoms);
      assert.equal(payable.contractId, receivable.contractId);
      assert.equal(payable.counterpartyIssuerId, customer.issuerId);
      assert.equal(receivable.counterpartyIssuerId, supplier.issuerId);
    } else assert.equal(finalCustomer.balances.cash, before.companies.find(company => company.issuerId === customer.issuerId)!.balances.cash);
    const later = advanceEvents(after, after.macro, tick + 1, { uniform: () => '0' }, [order, cancellation]);
    balanced(later);
    assert.equal(later.entries.some(entry => entry.kind === 'EVENT_CAPEX_COMMISSIONED' || entry.kind === 'EVENT_CAPEX_SUPPLY_REVENUE'), false, 'cancelled equipment cannot subsequently become an operating investment');
  });
}

test('LMB-21 acquires a new research instance while the old failed pipeline remains failed', () => {
  const failure = getEventTemplate('LMB-13'), acquisition = getEventTemplate('LMB-21'), validation = getEventTemplate('LMB-01');
  const initial = eligibleFixture(failure);
  const failed = executeEvent(initial, failure, 1, { uniform: () => '0' });
  const old = failed.events.projects.find(project => project.key === 'LMB:pipeline')!;
  assert.equal(old.status, 'FAILED');
  const failedState = stateAfter(initial, failed);
  const acquired = executeEvent(failedState, acquisition, 2, { uniform: () => '0' });
  const acquiredState = stateAfter(failedState, acquired, 2);
  const purchase = acquired.events.projects.find(project => project.key === 'LMB:newPipeline')!;
  const commissioned = advanceEvents(acquiredState, acquired.macro, purchase.completionTick, { uniform: () => '0' }, [acquisition, validation]);
  balanced(commissioned);
  const state = stateAfter(acquiredState, commissioned, purchase.completionTick);
  assert.equal(state.companies.find(company => company.symbol === 'LMB')!.customerBase, initial.companies.find(company => company.symbol === 'LMB')!.customerBase, 'acquiring an unvalidated research right cannot create commercial customers');
  const next = state.events.projects.find(project => project.key === 'LMB:pipeline' && project.status === 'ACTIVE')!;
  assert.ok(next);
  assert.notEqual(next.id, old.id);
  assert.notEqual(next.causeId, old.causeId);
  assert.equal(state.events.projects.find(project => project.id === old.id)?.status, 'FAILED');
  const advanced = executeEvent(state, validation, purchase.completionTick + 1, { uniform: () => '0' });
  balanced(advanced);
  assert.equal(advanced.events.occurrences.at(-1)?.causeId, next.causeId);
  assert.equal(advanced.events.projects.find(project => project.id === old.id)?.status, 'FAILED');
});

test('RVI-11 capacity interruption persists until the actual RVI-12 repair is commissioned', () => {
  const incident = getEventTemplate('RVI-11'), repair = getEventTemplate('RVI-12');
  const initial = eligibleFixture(incident);
  const issuer = initial.companies.find(company => company.symbol === 'RVI')!;
  const damaged = executeEvent(initial, incident, 1, { uniform: () => '0' });
  const occurrence = damaged.events.occurrences.find(item => item.templateId === incident.id)!;
  assert.ok(new D(damaged.modifiers[issuer.issuerId]!.capacity).lt(0));
  const expiry = 1 + occurrence.duration;
  const untreated = advanceEvents(stateAfter(initial, damaged), damaged.macro, expiry, { uniform: () => '0' }, [incident]);
  balanced(untreated);
  assert.ok(new D(untreated.modifiers[issuer.issuerId]!.capacity).lt(0), 'news duration ending cannot repair the damaged facility');
  const untreatedState = stateAfter(initial, untreated, expiry);
  const started = executeEvent(untreatedState, repair, expiry + 1, { uniform: () => '0' });
  const project = started.events.projects.find(item => item.key === repair.projectKey && item.investmentId)!;
  const repairingState = stateAfter(untreatedState, started, expiry + 1);
  const awaiting = advanceEvents(repairingState, started.macro, project.completionTick - 1, { uniform: () => '0' }, [incident, repair]);
  balanced(awaiting);
  assert.ok(new D(awaiting.modifiers[issuer.issuerId]!.capacity).lt(0), 'paying a repair advance is not completed inspection');
  const commissioned = advanceEvents(stateAfter(repairingState, awaiting, project.completionTick - 1), awaiting.macro, project.completionTick, { uniform: () => '0' }, [incident, repair]);
  balanced(commissioned);
  assert.equal(commissioned.modifiers[issuer.issuerId]!.capacity, '0');
  assert.equal(commissioned.companies.find(company => company.issuerId === issuer.issuerId)!.capacity, issuer.capacity, 'maintenance restores the original facility rather than constructing extra capacity');
});

test('XCO-12 requires the actual commissioned XCO-11 equipment and separates customer damage from supplier warranty', () => {
  const order = getEventTemplate('XCO-11'), warranty = getEventTemplate('XCO-12');
  const before = eligibleFixture(order);
  const started = executeEvent(before, order, 1, { uniform: () => '0' });
  const startedState = stateAfter(before, started);
  const project = started.events.projects.find(item => item.key === order.projectKey)!;
  assert.equal(eventEligible(warranty, startedState, 2), false, 'an undelivered investment cannot have an operating-equipment defect');
  const commissioned = advanceEvents(startedState, started.macro, project.completionTick, { uniform: () => '0' }, [order]);
  balanced(commissioned);
  const state = stateAfter(startedState, commissioned, project.completionTick);
  assert.equal(eventEligible(warranty, state, project.completionTick + 1), true);
  const result = executeEvent(state, warranty, project.completionTick + 1, { uniform: () => '0' }, project.causeId);
  balanced(result);
  const after = stateAfter(state, result, project.completionTick + 1);
  const supplierBefore = state.companies.find(company => company.symbol === 'VTR')!, customerBefore = state.companies.find(company => company.symbol === 'DNL')!;
  const supplier = after.companies.find(company => company.issuerId === supplierBefore.issuerId)!, customer = after.companies.find(company => company.issuerId === customerBefore.issuerId)!;
  assert.equal(supplier.balances.operating_assets, supplierBefore.balances.operating_assets, 'a supplier warranty does not impair the supplier factory');
  const loss = BigInt(customerBefore.balances.operating_assets) - BigInt(customer.balances.operating_assets);
  assert.ok(loss > 0n && loss <= BigInt(project.amountAtoms), 'the customer loss must be limited to the supplied equipment');
  const warrantyClaim = supplier.workingCapital.find(item => item.causeId === project.causeId && item.kind === 'AP' && !supplierBefore.workingCapital.some(prior => prior.id === item.id));
  assert.ok(warrantyClaim && BigInt(warrantyClaim.amountAtoms) > 0n);
  assert.ok(result.entries.every(entry => entry.causeId === project.causeId));
});

test('HGI-20 describes the sealed FX loss once without reapplying its cash or accounting effect', () => {
  const state = createEconomyState('actual_fx_report');
  const company = state.companies.find(item => item.symbol === 'HGI')!;
  const publication: EconomyPublication = { id: 'sealed_fx_quarter', kind: 'EARNINGS', issuerId: company.issuerId, symbol: company.symbol, effectiveTick: 63, publishTick: 64, report: { ...company.sealedQuarters.at(-1)!, kind: 'ACTUAL', quarterNo: 1, closedTick: 63, publishTick: 64, foreignExchangeProfitAtoms: (-parseMoney('1000')).toString() } };
  const before = structuredClone(state);
  const result = domainEventPublications(state, [publication], [], 64, [getEventTemplate('HGI-20')]);
  assert.equal(result.length, 1);
  assert.ok(result[0]?.kind === 'EVENT');
  assert.equal(result[0].disclosure.actual.foreignExchangeProfitAtoms, publication.report.foreignExchangeProfitAtoms);
  assert.equal(result[0].disclosure.causeId, publication.id);
  assert.deepEqual(state, before);
  eventDisclosureSchema.parse(result[0].disclosure);
});
