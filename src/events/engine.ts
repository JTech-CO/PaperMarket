import { FinancialDecimal as D, MONEY_SCALE, moneyFromAtoms, parseMoney } from '../domain/numeric.js';
import { createHash } from 'node:crypto';
import { parseEngineVersion, parseIssuerId, parseTickNo } from '../domain/identifiers.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { ASSET_ACCOUNTS, checkCorporateBalance } from '../economy/corporate.js';
import type { CompanyTrueState, CorporateAccount, CorporateAction, CorporateJournalEntry, EconomyPublication, EconomyRandom, EconomyState, IntercompanyContract, MacroState, QuarterTotals, PublicEconomyState } from '../economy/types.js';
import { EVENT_CATALOG } from './catalog.js';
import type { CompanyEventModifier, EventDisclosure, EventDomainEvidence, EventOccurrence, EventProject, EventRuntimeState, EventTemplate } from './types.js';
import { eventRuntimeSchema, eventTemplateSchema, eventDomainEvidenceSchema } from './validator.js';

export const EVENT_ENGINE_VERSION = 'events-v1';
export const NEW_EVENT_MEAN = '0.35';
type Decimal = InstanceType<typeof D>;
const round = (value: Decimal) => moneyFromAtoms(value.toDecimalPlaces(0, D.ROUND_HALF_EVEN).toFixed(0));
const fractionAtoms = (atoms: string, ratio: string) => round(new D(atoms).mul(ratio));
const clamp = (value: Decimal, lo: string, hi: string) => D.max(lo, D.min(hi, value));
const empty = (): EventRuntimeState => ({ schemaVersion: 1, occurrences: [], projects: [], cooldowns: {} });
function uniform(random: EconomyRandom, tick: number, channel: string, index = 0): Decimal {
  const eventChannel = channel.length <= 64 && /^[A-Za-z0-9._-]+$/.test(channel) ? channel : `event_${createHash('sha256').update(channel).digest('hex').slice(0, 48)}`;
  const input = random.uniform({ engineVersion: parseEngineVersion(EVENT_ENGINE_VERSION), tick: parseTickNo(tick), issuerId: parseIssuerId('event_market'), eventChannel, drawIndex: index });
  if (typeof input !== 'string' || input.length > 300 || !/^0(?:\.\d+)?$/.test(input)) throw new Error('Invalid event random input');
  const value = new D(input); if (value.lt(0) || value.gte(1)) throw new Error('Event random must lie in [0,1)'); return value;
}
/** Inverse Poisson CDF; the residual tail is folded into the ninth bounded candidate. */
export function newEventCandidateCount(random: EconomyRandom, tick: number): number {
  const draw = uniform(random, tick, 'event-count'); let probability = new D(NEW_EVENT_MEAN).negated().exp(); let cumulative = probability;
  for (let count = 0; count < 8; count++) { if (draw.lt(cumulative)) return count; probability = probability.mul(NEW_EVENT_MEAN).div(count + 1); cumulative = cumulative.plus(probability); }
  return 8;
}
const projectFor = (template: EventTemplate, companies: readonly CompanyTrueState[], tick: number, status: EventProject['status']): EventProject => {
  const issuerIds = template.subjects.map(symbol => companies.find(company => company.symbol === symbol)!.issuerId);
  const identity = `${issuerIds.join('_')}_${(template.projectKey ?? template.id).replaceAll(':', '_')}_${tick}`;
  return { id: `project_${identity}`, causeId: `cause_${identity}`, key: template.projectKey ?? template.id, issuerIds, status,
    startedTick: tick, completionTick: tick + Math.max(6, template.duration.min), sourceTemplateId: template.id,
    amountAtoms: '0', recognizedAtoms: '0', paidAtoms: '0', investmentId: null, supportAtoms: '0', successorTemplateId: null, stage: 0, successProbability: '0.22', supportByIssuer: {} };
};
/** Fixture projects are explicit observations/negotiations, never invented completed investments. */
export function initialEventState(companies: readonly CompanyTrueState[], tick = 0, catalog: readonly EventTemplate[] = EVENT_CATALOG): EventRuntimeState {
  const projects: EventProject[] = []; const seen = new Set<string>();
  for (const template of catalog) {
    if (!template.projectKey || template.subjects.length === 0 || (!template.eligibility.includes('ACTIVE_NEGOTIATION') && !template.eligibility.includes('ACTIVE_PROJECT'))) continue;
    const identity = `${template.projectKey}_${template.subjects.map(symbol => companies.find(company => company.symbol === symbol)?.issuerId).join('_')}`;
    if (seen.has(identity)) continue; seen.add(identity);
    const project = projectFor(template, companies, tick, template.eligibility.includes('ACTIVE_NEGOTIATION') ? 'NEGOTIATING' : 'ACTIVE');
    const successors = catalog.filter(candidate => candidate.projectKey === template.projectKey && candidate.mode === 'FOLLOWUP' && candidate.profile === 'MILESTONE');
    projects.push({ ...project, completionTick: tick + Math.max(6, template.duration.min), successorTemplateId: successors[0]?.id ?? null });
  }
  return { ...empty(), projects };
}
function matchingProject(template: EventTemplate, state: EconomyState): EventProject | undefined {
  const ids = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!.issuerId);
  return state.events.projects.find(project => project.key === template.projectKey && ids.every(id => project.issuerIds.includes(id)) && (['NEGOTIATING', 'ACTIVE'].includes(project.status) || (template.eligibility.includes('ACTIVE_CONTRACT') || template.eligibility.includes('COMPLETED_INVESTMENT')) && project.status === 'COMPLETED'));
}
export function eventEligible(template: EventTemplate, state: EconomyState, tick: number): boolean {
  const companies = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!);
  if (companies.some(company => company.lifecycle === 'LIQUIDATING' || company.lifecycle === 'EXTINGUISHED')) return false;
  if ((state.events.cooldowns[`${template.id}_${companies.map(company => company.issuerId).join('_')}`] ?? 0) > tick) return false;
  const project = matchingProject(template, state);
  if (project && state.events.occurrences.some(occurrence => occurrence.causeId === project.causeId && occurrence.templateId === template.id)) return false;
  for (const condition of template.eligibility) {
    if (condition === 'OPERATING' && companies.some(company => company.lifecycle !== 'OPERATING')) return false;
    if (condition === 'ACTIVE_NEGOTIATION' && project?.status !== 'NEGOTIATING') return false;
    if (condition === 'ACTIVE_CONTRACT' && (!project || !['ACTIVE', 'COMPLETED'].includes(project.status) || BigInt(project.amountAtoms) === 0n || template.operation === 'CANCEL' && project.status === 'COMPLETED')) return false;
    if (condition === 'ACTIVE_PROJECT' && project?.status !== 'ACTIVE') return false;
    if (condition === 'COMPLETED_INVESTMENT' && !state.events.projects.some(known => known.key === template.projectKey && known.status === 'COMPLETED' && known.issuerIds.some(id => companies.some(company => company.issuerId === id && company.investments.some(investment => investment.id === known.investmentId && investment.status === 'OPERATING' && investment.completionTick <= tick))))) return false;
    if (condition === 'SPARE_CAPACITY' && companies.length > 0 && new D(companies[0]!.capacity).minus(companies[0]!.volume).div(companies[0]!.capacity).lt('0.1')) return false;
    if (condition === 'MATURE_DEBT' && !companies.some(company => company.debtContracts.some(debt => BigInt(debt.principalAtoms) > 0n && debt.maturityTick <= tick + 21))) return false;
    if (condition === 'ASSET_PRESENT' && !companies.some(company => ['inventory', 'operating_assets', 'intangible_assets'].some(account => BigInt(company.balances[account as CorporateAccount]) > 0n))) return false;
    if (condition === 'CASH_AVAILABLE' && companies.some(company => BigInt(company.balances.cash) <= BigInt(company.reservedDividendAtoms))) return false;
    if (condition === 'POLICY_MEETING' && tick % 21 !== 0) return false;
    if (condition === 'DOMAIN_RESULT') return false;
  }
  if (state.events.occurrences.some(occurrence => occurrence.status === 'ACTIVE' && occurrence.effectiveTick + occurrence.duration > tick
    && occurrence.issuerIds.some(id => companies.some(company => company.issuerId === id))
    && EVENT_CATALOG.find(candidate => candidate.id === occurrence.templateId)?.exclusionGroup === template.exclusionGroup
    && !(occurrence.causeId === project?.causeId && (template.mode === 'FOLLOWUP' || template.investmentPurpose === 'MAINTENANCE' || EVENT_CATALOG.find(candidate => candidate.id === occurrence.templateId)?.successors.includes(template.id))))) return false;
  return true;
}
/** Conditional risk uses only issuer operations and funding state, never investor activity. */
export function conditionalHazardWeight(template: EventTemplate, state: EconomyState): string {
  const companies = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!);
  const stress = new D(state.macro.creditStress); let factor = new D(1);
  for (const company of companies) {
    const utilization = new D(company.volume).div(company.capacity); const due = company.workingCapital.filter(item => item.kind === 'AP' && item.dueTick <= state.tickNo + 21).reduce((sum, item) => sum + BigInt(item.amountAtoms), 0n);
    const cashCover = new D(company.balances.cash).div(D.max(1, due.toString()));
    if (template.profile === 'FINANCE') factor = factor.mul(new D(1).plus(stress).plus(cashCover.lt(1) ? '0.75' : '0'));
    if (template.profile === 'INCIDENT') factor = factor.mul(new D('0.5').plus(utilization).plus(stress.mul('0.25')));
    if (template.profile === 'CONTRACT' || template.profile === 'CAPEX') factor = factor.mul(D.max('0.05', new D(1).minus(stress.mul('0.6')).mul(new D('1.5').minus(utilization))));
    if (template.profile === 'DEMAND') factor = factor.mul(new D('0.75').plus(new D(state.macro.industrialDemand).minus(100).abs().div(100)));
  }
  return new D(template.hazardWeight).mul(clamp(factor, '0.01', '10')).toString();
}
export function conditionalOutcomeProbabilities(template: EventTemplate, state: EconomyState): readonly string[] {
  const companies = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!);
  const stress = new D(state.macro.creditStress); const averageProductivity = companies.length ? companies.reduce((sum, company) => sum.plus(company.productivity), new D(0)).div(companies.length) : new D(1);
  const weights = template.outcomes.map(outcome => {
    const failure = /fail|failure|cancel|실패/i.test(outcome.id) || new D(outcome.magnitudeMultiplier).lt(0);
    const progress = clamp(averageProductivity.minus(1), '0', '0.5');
    return new D(outcome.probability).mul(failure ? new D(1).plus(stress).minus(progress) : D.max('0.05', new D(1).minus(stress.mul('0.5')).plus(progress)));
  });
  const total = weights.reduce((sum, value) => sum.plus(value), new D(0));
  return weights.map(value => value.div(total).toString());
}
export function eventEffectAt(occurrence: Pick<EventOccurrence, 'effectiveTick' | 'duration' | 'magnitude'>, template: Pick<EventTemplate, 'decay' | 'halfLifeTicks'> & Partial<Pick<EventTemplate, 'profile' | 'reversalRule'>>, tick: number): string {
  const age = tick - occurrence.effectiveTick; if (age < 0 || age >= occurrence.duration && !(template.profile === 'INCIDENT' && template.reversalRule === 'MANUAL_RECOVERY')) return '0';
  const coefficient = template.decay === 'HALF_LIFE' ? new D('0.5').pow(new D(age).div(template.halfLifeTicks!)) : template.decay === 'LINEAR' ? new D(1).minus(new D(age).div(occurrence.duration)) : new D(1);
  return new D(occurrence.magnitude).mul(coefficient).toString();
}
export interface EventStepResult {
  readonly companies: readonly CompanyTrueState[]; readonly macro: MacroState; readonly contracts: readonly IntercompanyContract[];
  readonly events: EventRuntimeState; readonly entries: readonly CorporateJournalEntry[]; readonly actions: readonly CorporateAction[];
  readonly publications: readonly EconomyPublication[]; readonly modifiers: Readonly<Record<string, CompanyEventModifier>>;
}
class Execution {
  companies: CompanyTrueState[]; macro: MacroState; contracts: IntercompanyContract[]; events: EventRuntimeState;
  entries: CorporateJournalEntry[] = []; actions: CorporateAction[] = [];
  constructor(readonly state: EconomyState, readonly tick: number, macro: MacroState) { this.companies = structuredClone(state.companies) as CompanyTrueState[]; this.macro = { ...macro }; this.contracts = [...state.contracts]; this.events = structuredClone(state.events); }
  company(id: string): CompanyTrueState { const company = this.companies.find(company => company.issuerId === id); if (!company) throw new Error('Event issuer no longer active'); return company; }
  set(company: CompanyTrueState): void { this.companies = this.companies.map(item => item.issuerId === company.issuerId ? company : item); }
  project(project: EventProject): void { this.events = { ...this.events, projects: [...this.events.projects.filter(item => item.id !== project.id), project] }; }
  q(id: string, key: keyof QuarterTotals, amount: bigint): void { const company = this.company(id); this.set({ ...company, currentQuarter: { ...company.currentQuarter, [key]: (BigInt(company.currentQuarter[key]) + amount).toString() } }); }
  cash(id: string): bigint { const company = this.company(id); const value = BigInt(company.balances.cash) - BigInt(company.reservedDividendAtoms); return value > 0n ? value : 0n; }
  post(id: string, kind: string, cause: string, debit: CorporateAccount, credit: CorporateAccount, amount: bigint, contractId: string | null = null): void {
    if (amount <= 0n) return; const company = this.company(id); const balances = { ...company.balances };
    for (const [account, side] of [[debit, 'DR'], [credit, 'CR']] as const) balances[account] = moneyFromAtoms((BigInt(balances[account]) + ((side === 'DR') === ASSET_ACCOUNTS.includes(account) ? amount : -amount)).toString()).toString();
    this.set({ ...company, balances }); this.entries.push({ entryId: `${this.state.marketId}_event_${this.tick}_${this.entries.length}`, causeId: cause, issuerId: id, marketId: this.state.marketId, tickNo: this.tick, kind, contractId, lines: [{ account: debit, side: 'DR', amountAtoms: amount.toString() }, { account: credit, side: 'CR', amountAtoms: amount.toString() }] });
  }
  working(id: string, cause: string, amount: bigint, kind: 'AR' | 'AP', dueTick: number, contractId: string | null = null, counterpartyId: string | null = null): void {
    if (amount <= 0n) return; const company = this.company(id); const counterparty = counterpartyId === null ? null : this.company(counterpartyId);
    const identity = createHash('sha256').update(JSON.stringify([cause, id, kind, this.tick, contractId])).digest('hex').slice(0, 48);
    this.set({ ...company, workingCapital: [...company.workingCapital, { id: `claim_${identity}`, causeId: cause, contractId, counterparty: counterparty?.symbol ?? 'EXTERNAL', counterpartyIssuerId: counterparty?.issuerId ?? null, amountAtoms: amount.toString(), dueTick, kind, overdueSinceTick: null }] });
  }
}
function cancelInvestment(ex: Execution, project: EventProject, failed: boolean): void {
  const customer = ex.company(project.issuerIds.at(-1)!); const investmentOwner = ex.companies.find(company => company.investments.some(investment => investment.id === project.investmentId));
  const supplier = project.issuerIds.length === 2 ? ex.company(project.issuerIds[0]!) : null;
  const prepaid = BigInt(project.paidAtoms);
  if (supplier) {
    const refund = prepaid < ex.cash(supplier.issuerId) ? prepaid : ex.cash(supplier.issuerId);
    ex.post(supplier.issuerId, 'EVENT_ADVANCE_REFUND', project.causeId, 'contract_liability', 'cash', refund);
    ex.post(customer.issuerId, 'EVENT_PREPAYMENT_REFUND', project.causeId, 'cash', 'construction_in_progress', refund);
    const remaining = prepaid - refund;
    if (remaining > 0n) {
      const contractId = `event_${project.id}_refund`;
      if (!ex.contracts.some(contract => contract.contractId === contractId)) ex.contracts.push({ contractId, supplier: customer.symbol, customer: supplier.symbol, kind: 'SERVICE', costBucket: 'service', exposure: '0', settlementLagTicks: 1 });
      ex.post(supplier.issuerId, 'EVENT_REFUND_OBLIGATION', project.causeId, 'contract_liability', 'trade_payables', remaining, contractId); ex.working(supplier.issuerId, project.causeId, remaining, 'AP', ex.tick + 1, contractId, customer.issuerId);
      ex.post(customer.issuerId, 'EVENT_REFUND_RECEIVABLE', project.causeId, 'receivables', 'construction_in_progress', remaining, contractId); ex.working(customer.issuerId, project.causeId, remaining, 'AR', ex.tick + 1, contractId, supplier.issuerId);
    }
  }
  if (investmentOwner) {
    if (!supplier || investmentOwner.issuerId === supplier.issuerId) { const invested = supplier ? BigInt(project.amountAtoms) : prepaid; const loss = invested < BigInt(ex.company(investmentOwner.issuerId).balances.construction_in_progress) ? invested : BigInt(ex.company(investmentOwner.issuerId).balances.construction_in_progress); ex.post(investmentOwner.issuerId, 'EVENT_CANCELLED_INVESTMENT_LOSS', project.causeId, 'retained_earnings', 'construction_in_progress', loss); ex.q(investmentOwner.issuerId, 'serviceAtoms', loss); ex.q(investmentOwner.issuerId, 'oneOffProfitAtoms', -loss); }
    ex.set({ ...ex.company(investmentOwner.issuerId), investments: investmentOwner.investments.map(investment => investment.id === project.investmentId ? { ...investment, status: 'CANCELLED' } : investment) });
  }
  ex.project({ ...project, status: failed ? 'FAILED' : 'CANCELLED', successorTemplateId: null, paidAtoms: '0' });
}
function underlying(template: EventTemplate, company: CompanyTrueState | undefined, macro: MacroState): string {
  if (template.target in macro) return String(macro[template.target as keyof MacroState]);
  if (!company) return '0';
  if (template.target === 'cash') return new D(company.balances.cash).div(MONEY_SCALE.toString()).toString();
  if (template.target === 'creditSpread') return company.debtContracts[0]?.spread ?? '0';
  if (template.target === 'successProbability') return company.category === 'THEMATIC' ? '0.22' : '0.45';
  return '0';
}
function publicPrevious(template: EventTemplate, company: CompanyTrueState | undefined, state: EconomyState, publicState?: PublicEconomyState): string {
  const macro = publicState?.observedMacro ?? state.lastPublishedMacro;
  if (template.target in macro) return String(macro[template.target as keyof MacroState]);
  if (!company) return '0';
  const publicCompany = publicState?.companies.find(item => item.issuerId === company.issuerId);
  const report = publicCompany?.latestReport ?? company.sealedQuarters.filter(item => item.publishTick <= state.tickNo).at(-1)!;
  if (template.target === 'cash') return new D(report.cashAtoms).div(MONEY_SCALE.toString()).toString();
  if (template.target === 'creditSpread') return publicCompany?.debtTerms[0]?.spread ?? INITIAL_COMPANIES.find(fixture => fixture.symbol === company.symbol)!.debtTranches[0]!.initialVariableSpread;
  if (template.target === 'successProbability') return publicCompany?.forecast.successProbability ?? (company.category === 'THEMATIC' ? '0.22' : company.category === 'GROWTH' ? '0.45' : '0.6');
  return '0';
}
function financialFacts(entries: readonly CorporateJournalEntry[], issuerIds: readonly string[], causeId: string): Record<string, string> {
  const facts: Record<string, string> = {};
  for (const issuerId of issuerIds) {
    const lines = entries.filter(entry => entry.issuerId === issuerId && entry.causeId === causeId).flatMap(entry => entry.lines);
    const movement = (accounts: readonly CorporateAccount[], debitNormal: boolean) => lines.filter(line => accounts.includes(line.account)).reduce((sum, line) => sum + BigInt(line.amountAtoms) * ((line.side === 'DR') === debitNormal ? 1n : -1n), 0n).toString();
    facts[`cashDelta_${issuerId}`] = movement(['cash'], true); facts[`debtDelta_${issuerId}`] = movement(['debt'], false);
    facts[`liabilityDelta_${issuerId}`] = movement(['trade_payables', 'interest_payable', 'tax_payable', 'contract_liability'], false);
  }
  return facts;
}
function applyFinance(ex: Execution, template: EventTemplate, occurrence: EventOccurrence, project: EventProject | null): void {
  const ids = occurrence.issuerIds.length > 0 ? occurrence.issuerIds : ex.companies.filter(company => ['WATCH', 'DISTRESSED'].includes(company.lifecycle)).map(company => company.issuerId);
  const processedClaims = new Set<string>();
  for (const id of ids) {
    let company = ex.company(id); const magnitude = new D(occurrence.magnitude).abs();
    const amount = fractionAtoms(company.balances.cash, magnitude.toString());
    switch (template.financeAction) {
      case 'EQUITY_ISSUE': {
        const raised = amount > 0n ? amount : parseMoney('1'); const before = company.issuedShares;
        const newShares = raised / parseMoney('250') || 1n;
        ex.post(id, 'EVENT_EXTERNAL_EQUITY', occurrence.causeId, 'cash', 'paid_in_capital', raised);
        company = ex.company(id); ex.set({ ...company, issuedShares: (BigInt(before) + newShares).toString(), eventEquityIssues: company.eventEquityIssues + 1 });
        ex.actions.push({ id: `${occurrence.id}_${id}_financing`, kind: 'FINANCING', issuerId: id, listingId: company.listingId, symbol: company.generation === 1 ? company.symbol : `${company.symbol}${company.generation}`, effectiveTick: ex.tick, raisedAtoms: raised.toString(), issuedSharesBefore: before, issuedSharesAfter: (BigInt(before) + newShares).toString() }); break;
      }
      case 'SPREAD': {
        const index = company.debtContracts.findIndex(debt => BigInt(debt.principalAtoms) > 0n && debt.maturityTick <= ex.tick + 21);
        if (index < 0) break; const old = company.debtContracts[index]!; const principal = BigInt(old.principalAtoms);
        ex.post(id, 'EVENT_REFINANCE_ISSUE', occurrence.causeId, 'cash', 'debt', principal); ex.q(id, 'debtIssuedAtoms', principal);
        ex.post(id, 'EVENT_REFINANCE_REPAY', occurrence.causeId, 'debt', 'cash', principal); ex.q(id, 'debtRepaidAtoms', principal);
        const fee = fractionAtoms(old.principalAtoms, '0.002'); const paidFee = fee < ex.cash(id) ? fee : ex.cash(id);
        ex.post(id, 'EVENT_REFINANCE_FEE', occurrence.causeId, 'retained_earnings', 'cash', paidFee); ex.q(id, 'serviceAtoms', paidFee); ex.q(id, 'operatingCashFlowAtoms', -paidFee);
        company = ex.company(id); const spread = clamp(new D(old.spread).plus(occurrence.magnitude), '0', '0.3');
        ex.set({ ...company, debtContracts: company.debtContracts.map((debt, debtIndex) => debtIndex === index ? { ...debt, id: `loan_${createHash('sha256').update(JSON.stringify([id, old.id, occurrence.causeId, ex.tick])).digest('hex').slice(0, 48)}`, spread: spread.toString(), annualEffectiveRate: clamp(new D(ex.macro.policyRate).plus(spread), '0', '1').toString(), maturityTick: ex.tick + 252, nextResetTick: ex.tick + 21 } : debt) }); break;
      }
      case 'DEBT_REPAYMENT': {
        let budget = amount < ex.cash(id) ? amount : ex.cash(id); const contracts = company.debtContracts.map(debt => {
          const principal = BigInt(debt.principalAtoms); const paid = principal < budget ? principal : budget; budget -= paid;
          ex.post(id, 'EVENT_DEBT_REPAYMENT', occurrence.causeId, 'debt', 'cash', paid); ex.q(id, 'debtRepaidAtoms', paid); return { ...debt, principalAtoms: (principal - paid).toString() };
        }); ex.set({ ...ex.company(id), debtContracts: contracts }); break;
      }
      case 'COLLECTION_DELAY': case 'PAYMENT_EXTENSION': {
        if (occurrence.issuerIds.length === 2 && id !== occurrence.issuerIds[0]) break;
        const kind = template.target === 'receivables' ? 'AR' : template.target === 'payables' ? 'AP' : template.financeAction === 'COLLECTION_DELAY' ? 'AR' : 'AP'; const lag = Math.max(1, occurrence.duration);
        const matches = company.workingCapital.filter(item => item.kind === kind && (project ? item.causeId === occurrence.causeId : occurrence.issuerIds.length === 1 || occurrence.issuerIds.includes(item.counterpartyIssuerId ?? '')));
        const targeted = project ? matches : matches.slice(0, 1);
        ex.set({ ...company, workingCapital: company.workingCapital.map(item => targeted.includes(item) && !processedClaims.has(`${id}_${item.id}`) ? { ...item, dueTick: item.dueTick + lag, overdueSinceTick: null } : item) });
        // A negotiated internal extension applies to both linked obligations exactly once.
        for (const item of targeted.filter(item => item.counterpartyIssuerId !== null)) {
          const other = ex.companies.find(candidate => candidate.issuerId === item.counterpartyIssuerId); if (!other) continue;
          ex.set({ ...other, workingCapital: other.workingCapital.map(claim => { if (claim.causeId !== item.causeId || claim.contractId !== item.contractId || processedClaims.has(`${other.issuerId}_${claim.id}`)) return claim; processedClaims.add(`${other.issuerId}_${claim.id}`); return { ...claim, dueTick: claim.dueTick + lag, overdueSinceTick: null }; }) });
        } break;
      }
      case 'ASSET_DISPOSAL': {
        const account = BigInt(company.balances.operating_assets) > 0n ? 'operating_assets' : 'intangible_assets'; const book = fractionAtoms(company.balances[account], magnitude.toString());
        const premium = /유휴|매각/.test(template.title) ? new D('0.98') : new D('1'); const proceeds = round(new D(book.toString()).mul(premium));
        ex.post(id, 'EVENT_ASSET_DISPOSAL', occurrence.causeId, 'cash', account, proceeds);
        if (proceeds < book) { const loss = book - proceeds; ex.post(id, 'EVENT_DISPOSAL_LOSS', occurrence.causeId, 'retained_earnings', account, loss); ex.q(id, 'serviceAtoms', loss); ex.q(id, 'oneOffProfitAtoms', -loss); }
        break;
      }
      case 'CONDITIONAL_SUPPORT': {
        ex.post(id, 'EVENT_CONDITIONAL_SUPPORT', occurrence.causeId, 'cash', 'contract_liability', amount);
        const current = ex.events.projects.find(item => item.id === project?.id) ?? project;
        const support = current ?? { ...projectFor(template, ex.companies, ex.tick, 'ACTIVE'), causeId: occurrence.causeId, issuerIds: ids };
        ex.project({ ...support, status: 'ACTIVE', completionTick: ex.tick + occurrence.duration, supportAtoms: (BigInt(support.supportAtoms) + amount).toString(), supportByIssuer: { ...support.supportByIssuer, [id]: (BigInt(support.supportByIssuer[id] ?? '0') + amount).toString() }, successorTemplateId: template.successors[0] ?? null }); break;
      }
      case 'SUPPORT_WITHDRAWAL': {
        const currentProject = ex.events.projects.find(item => item.id === project?.id); const owed = currentProject ? BigInt(currentProject.supportByIssuer[id] ?? '0') : 0n; const paid = owed < ex.cash(id) ? owed : ex.cash(id);
        ex.post(id, 'EVENT_SUPPORT_WITHDRAWAL', occurrence.causeId, 'contract_liability', 'cash', paid);
        if (project) { const current = ex.events.projects.find(item => item.id === project.id)!; ex.project({ ...current, supportAtoms: (BigInt(current.supportAtoms) - paid).toString(), supportByIssuer: { ...current.supportByIssuer, [id]: (owed - paid).toString() }, status: BigInt(current.supportAtoms) === paid ? 'COMPLETED' : 'ACTIVE', successorTemplateId: null }); } break;
      }
      case 'FAILED_FUNDING': ex.set({ ...company, status: 'STRESSED' }); break;
      default: throw new Error('Unsupported financial event action');
    }
  }
}
function startEffect(ex: Execution, template: EventTemplate, occurrence: EventOccurrence, priorProject: EventProject | undefined): void {
  const company = occurrence.issuerIds[0] ? ex.company(occurrence.issuerIds[0]) : undefined;
  let project: EventProject | null = priorProject ?? null;
  if (template.profile === 'CONTRACT') {
    if (template.operation === 'CANCEL') { if (project?.investmentId) cancelInvestment(ex, project, false); else if (project) ex.project({ ...project, status: 'CANCELLED' }); return; }
    if (template.operation === 'DELAY') { if (project) ex.project({ ...project, completionTick: project.completionTick + occurrence.duration }); return; }
    if (template.operation === 'RENEW' && project) { ex.project({ ...project, completionTick: ex.tick + occurrence.duration, amountAtoms: (BigInt(project.recognizedAtoms) + fractionAtoms((BigInt(project.amountAtoms) - BigInt(project.recognizedAtoms)).toString(), new D(1).plus(occurrence.magnitude).toString())).toString() }); return; }
    if (template.investmentAccounting === 'CAPITALIZE') { startEffect(ex, { ...template, profile: 'CAPEX' }, occurrence, priorProject); return; }
    const base = INITIAL_COMPANIES.find(fixture => fixture.symbol === company!.symbol)!;
    const amount = fractionAtoms(parseMoney(base.annualRevenue).toString(), new D(occurrence.magnitude).abs().mul(template.sectorExposure).toString());
    project = { ...(project ?? projectFor(template, ex.companies, ex.tick, 'ACTIVE')), status: 'ACTIVE', sourceTemplateId: template.id, startedTick: ex.tick, completionTick: ex.tick + occurrence.duration,
      amountAtoms: amount.toString(), recognizedAtoms: '0', paidAtoms: '0', successorTemplateId: template.successors[0] ?? null };
    if (occurrence.issuerIds.length === 2) {
      const supplier = ex.company(occurrence.issuerIds[0]!); const customer = ex.company(occurrence.issuerIds[1]!); const contractId = `event_${project.id}`;
      if (!ex.contracts.some(contract => contract.contractId === contractId)) ex.contracts.push({ contractId, supplier: supplier.symbol, customer: customer.symbol, kind: template.target === 'service' ? 'SERVICE' : 'RAW_MATERIALS', costBucket: template.target === 'service' ? 'service' : 'rawMaterials', exposure: '0', settlementLagTicks: 7 });
    }
    ex.project(project); return;
  }
  if (template.profile === 'CAPEX') {
    if (template.operation === 'DELAY') { if (project) { ex.project({ ...project, completionTick: project.completionTick + occurrence.duration }); for (const id of project.issuerIds) { const owner = ex.company(id); ex.set({ ...owner, investments: owner.investments.map(investment => investment.id === project!.investmentId ? { ...investment, completionTick: investment.completionTick + occurrence.duration } : investment) }); } } return; }
    if (template.operation === 'COMPLETE' || template.operation === 'RESTORE') return;
    const customer = occurrence.issuerIds.length === 2 ? ex.company(occurrence.issuerIds[1]!) : company!;
    const owner = template.investmentOwner === 'SUPPLIER' ? company! : customer;
    const budget = fractionAtoms(owner.balances.cash, new D(occurrence.magnitude).abs().toString()); const amount = budget < ex.cash(owner.issuerId) ? budget : ex.cash(owner.issuerId);
    if (template.investmentAccounting !== 'CAPITALIZE') {
      ex.post(customer.issuerId, template.investmentAccounting === 'RESEARCH_EXPENSE' ? 'EVENT_RESEARCH_EXPENSE' : 'EVENT_MARKETING_EXPENSE', occurrence.causeId, 'retained_earnings', 'cash', amount);
      ex.q(customer.issuerId, template.investmentAccounting === 'RESEARCH_EXPENSE' ? 'researchAtoms' : 'serviceAtoms', amount); ex.q(customer.issuerId, 'operatingCashFlowAtoms', -amount); return;
    }
    const projectId = project?.id ?? projectFor(template, ex.companies, ex.tick, 'ACTIVE').id; const investmentId = `investment_${projectId}`;
    const contractId = occurrence.issuerIds.length === 2 ? `event_${projectId}_CAPEX` : null;
    const advance = occurrence.issuerIds.length === 2 ? amount * 3n / 10n : amount;
    ex.post(customer.issuerId, 'EVENT_CAPEX_ADVANCE', occurrence.causeId, 'construction_in_progress', 'cash', advance, contractId); ex.q(customer.issuerId, 'capexAtoms', advance);
    if (occurrence.issuerIds.length === 2) {
      ex.post(company!.issuerId, 'EVENT_SUPPLIER_ADVANCE', occurrence.causeId, 'cash', 'contract_liability', advance, contractId);
      ex.contracts.push({ contractId: contractId!, supplier: company!.symbol, customer: customer.symbol, kind: 'CAPEX', costBucket: 'capex', exposure: '0', settlementLagTicks: 7 });
    }
    if (template.investmentOwner === 'SUPPLIER' && occurrence.issuerIds.length === 2) { ex.post(owner.issuerId, 'EVENT_OWNED_FACILITY_SPEND', occurrence.causeId, 'construction_in_progress', 'cash', amount, contractId); ex.q(owner.issuerId, 'capexAtoms', amount); }
    const completionTick = ex.tick + occurrence.duration;
    ex.set({ ...ex.company(owner.issuerId), investments: [...ex.company(owner.issuerId).investments, { id: investmentId, causeId: occurrence.causeId, contractId, amountAtoms: amount.toString(), startedTick: ex.tick, completionTick, status: 'IN_PROGRESS', usefulLifeTicks: 2520, depreciatedAtoms: '0', productivityEffect: '0.03', assetAccount: template.target === 'intangibleAssets' ? 'intangible_assets' : 'operating_assets' }] });
    project = { ...(project ?? projectFor(template, ex.companies, ex.tick, 'ACTIVE')), id: projectId, causeId: occurrence.causeId, status: 'ACTIVE', startedTick: ex.tick, completionTick, sourceTemplateId: template.id, amountAtoms: amount.toString(), recognizedAtoms: '0', paidAtoms: advance.toString(), investmentId, successorTemplateId: template.successors[0] ?? null };
    ex.project(project); return;
  }
  if (template.profile === 'FINANCE' || template.financeAction !== null) { if (/rejected|failed/i.test(occurrence.outcomeId)) { for (const id of occurrence.issuerIds) ex.set({ ...ex.company(id), status: 'STRESSED' }); return; } applyFinance(ex, template, occurrence, project); return; }
  if (template.profile === 'INCIDENT' && template.operation !== 'RESTORE') {
    if (!project && template.projectKey) { project = { ...projectFor(template, ex.companies, ex.tick, 'ACTIVE'), causeId: occurrence.causeId, completionTick: ex.tick + Math.max(1, Math.floor(occurrence.duration / 2)), successorTemplateId: template.successors[0] ?? null }; ex.project(project); }
    const affected = project?.investmentId ? occurrence.issuerIds.filter(id => ex.company(id).investments.some(investment => investment.id === project!.investmentId)) : occurrence.issuerIds;
    for (const id of affected) {
      const owner = ex.company(id);
      if (template.target === 'cash') { const compensation = fractionAtoms(owner.balances.cash, new D(occurrence.magnitude).abs().mul(template.sectorExposure).toString()); ex.post(id, 'EVENT_COMPENSATION_ACCRUAL', occurrence.causeId, 'retained_earnings', 'trade_payables', compensation); ex.working(id, occurrence.causeId, compensation, 'AP', ex.tick + 7); ex.q(id, 'serviceAtoms', compensation); ex.q(id, 'oneOffProfitAtoms', -compensation); continue; }
      if (!['inventory', 'intangibleAssets', 'operatingAssets'].includes(template.target)) continue;
      const account: CorporateAccount = template.target === 'inventory' ? 'inventory' : template.target === 'intangibleAssets' ? 'intangible_assets' : 'operating_assets';
      const investment = owner.investments.find(investment => investment.id === project?.investmentId);
      const relatedBook = investment ? BigInt(investment.amountAtoms) - BigInt(investment.depreciatedAtoms) : BigInt(owner.balances[account]); const availableBook = relatedBook < BigInt(owner.balances[account]) ? relatedBook : BigInt(owner.balances[account]);
      const loss = fractionAtoms(availableBook.toString(), new D(occurrence.magnitude).abs().mul(template.sectorExposure).toString());
      ex.post(id, 'EVENT_ASSET_IMPAIRMENT', occurrence.causeId, 'retained_earnings', account, loss); ex.q(id, 'serviceAtoms', loss); ex.q(id, 'oneOffProfitAtoms', -loss);
    }
    if (project?.investmentId && occurrence.issuerIds.length === 2) {
      const supplier = ex.company(occurrence.issuerIds[0]!), customer = ex.company(occurrence.issuerIds[1]!); const compensation = fractionAtoms(project.amountAtoms, new D(occurrence.magnitude).abs().mul(template.sectorExposure).toString()); const contractId = `event_${project.id}_warranty`;
      if (!ex.contracts.some(contract => contract.contractId === contractId)) ex.contracts.push({ contractId, supplier: customer.symbol, customer: supplier.symbol, kind: 'SERVICE', costBucket: 'service', exposure: '0', settlementLagTicks: 7 });
      ex.post(supplier.issuerId, 'EVENT_WARRANTY_OBLIGATION', occurrence.causeId, 'retained_earnings', 'trade_payables', compensation, contractId); ex.working(supplier.issuerId, occurrence.causeId, compensation, 'AP', ex.tick + 7, contractId, customer.issuerId); ex.q(supplier.issuerId, 'serviceAtoms', compensation);
      ex.post(customer.issuerId, 'EVENT_WARRANTY_RECEIVABLE', occurrence.causeId, 'receivables', 'retained_earnings', compensation, contractId); ex.working(customer.issuerId, occurrence.causeId, compensation, 'AR', ex.tick + 7, contractId, supplier.issuerId); ex.q(customer.issuerId, 'revenueAtoms', compensation); ex.q(customer.issuerId, 'oneOffProfitAtoms', compensation);
    }
  }
  if (template.profile === 'MILESTONE') {
    if (!project) throw new Error('Milestone requires an existing project');
    const failed = /fail|failure|실패/i.test(occurrence.outcomeId) || template.operation === 'CANCEL';
    const terminalSuccess = !failed && template.successors.length === 0 && template.operation !== 'DELAY' && template.operation !== 'DECREASE';
    ex.project({ ...project, sourceTemplateId: template.id, stage: project.stage + (template.operation === 'INCREASE' ? 1 : 0), successProbability: failed ? '0' : clamp(new D(project.successProbability).plus(occurrence.magnitude), '0', '1').toString(), status: failed ? 'FAILED' : terminalSuccess ? 'COMPLETED' : 'ACTIVE', completionTick: ex.tick + occurrence.duration, successorTemplateId: failed || terminalSuccess ? null : template.successors[0] ?? null });
    if (!failed && BigInt(project.supportAtoms) > 0n && company) { const grant = BigInt(project.supportAtoms); ex.post(company.issuerId, 'EVENT_SUPPORT_EARNED', occurrence.causeId, 'contract_liability', 'retained_earnings', grant); ex.q(company.issuerId, 'revenueAtoms', grant); ex.q(company.issuerId, 'oneOffProfitAtoms', grant); }
    if (failed && company && BigInt(company.balances.intangible_assets) > 0n) { const loss = fractionAtoms(company.balances.intangible_assets, new D(occurrence.magnitude).abs().mul(template.sectorExposure).toString()); ex.post(company.issuerId, 'EVENT_PIPELINE_IMPAIRMENT', occurrence.causeId, 'retained_earnings', 'intangible_assets', loss); ex.q(company.issuerId, 'serviceAtoms', loss); ex.q(company.issuerId, 'oneOffProfitAtoms', -loss); }
  }
}
/** The executor is a pure domain API: eligibility, duplicate cause and generation checks are mandatory. */
export function executeEvent(state: EconomyState, templateInput: EventTemplate, tick: number, random: EconomyRandom, causeId?: string, publicState?: PublicEconomyState): EventStepResult {
  const template: EventTemplate = eventTemplateSchema.parse(templateInput);
  if (!eventEligible(template, state, tick)) throw new Error('Ineligible event');
  const ex = new Execution(state, tick, state.macro); const project = matchingProject(template, state);
  const cause = causeId ?? project?.causeId ?? `${state.marketId}_cause_${template.id}_${tick}`;
  if (state.events.occurrences.some(item => item.causeId === cause && item.templateId === template.id)) throw new Error('Duplicate event cause');
  const outcomeDraw = uniform(random, tick, `outcome-${template.id}`); const probabilities = conditionalOutcomeProbabilities(template, state); let cumulative = new D(0); const outcome = template.outcomes.find((_item, index) => { cumulative = cumulative.plus(probabilities[index]!); return outcomeDraw.lt(cumulative); }) ?? template.outcomes.at(-1)!;
  const magnitude = new D(template.magnitude.min).plus(new D(template.magnitude.max).minus(template.magnitude.min).mul(uniform(random, tick, `magnitude-${template.id}`))).mul(outcome.magnitudeMultiplier).toString();
  const duration = template.duration.min + Math.floor(uniform(random, tick, `duration-${template.id}`).mul(template.duration.max - template.duration.min + 1).toNumber());
  const companies = template.subjects.map(symbol => state.companies.find(company => company.symbol === symbol)!);
  const previous = ['RATIO', 'CASH_FRACTION', 'ASSET_FRACTION'].includes(template.unit) && template.profile !== 'MACRO' ? '0' : publicPrevious(template, companies[0], state, publicState);
  const actualBase = template.profile === 'MILESTONE' && project ? project.successProbability : underlying(template, companies[0], state.macro);
  const expectedChange = new D(template.magnitude.min).plus(template.magnitude.max).div(2).mul(template.outcomes.reduce((sum, item) => sum.plus(new D(item.probability).mul(item.magnitudeMultiplier)), new D(0)));
  const macroIndex = template.profile === 'MACRO' && ['INDEX_RATIO', 'RATIO'].includes(template.unit) && template.target in state.macro;
  const actualValue = template.target === 'successProbability' && template.operation === 'CANCEL' ? '0' : macroIndex ? new D(actualBase).mul(new D(1).plus(magnitude)).toString() : template.unit === 'PERCENTAGE_POINTS' || template.profile === 'MACRO' ? new D(actualBase).plus(magnitude).toString() : magnitude;
  let occurrence: EventOccurrence = { id: `event_${createHash('sha256').update(JSON.stringify([state.marketId, template.id, tick, cause])).digest('hex').slice(0, 48)}`, causeId: cause, templateId: template.id, templateVersion: template.version, profile: template.profile, issuerIds: companies.map(company => company.issuerId), symbols: template.subjects,
    effectiveTick: tick, publishTick: tick + template.publishLagTicks, duration, magnitude, outcomeId: outcome.id, projectId: project?.id ?? null, status: 'ACTIVE', previous: { [template.target]: previous }, expected: { [template.target]: (macroIndex ? new D(previous).mul(new D(1).plus(expectedChange)) : template.unit === 'PERCENTAGE_POINTS' || template.profile === 'MACRO' ? new D(previous).plus(expectedChange) : expectedChange).toString() }, actual: { [template.target]: actualValue } };
  startEffect(ex, template, occurrence, project);
  const monetary = ex.entries.filter(entry => entry.issuerId === companies[0]?.issuerId);
  const delta = (account: CorporateAccount) => monetary.reduce((sum, entry) => sum + entry.lines.filter(line => line.account === account).reduce((entrySum, line) => entrySum + BigInt(line.amountAtoms) * (line.side === 'DR' ? 1n : -1n), 0n), 0n).toString();
  occurrence = { ...occurrence, actual: { ...occurrence.actual, ...(monetary.length && template.financeAction !== 'EQUITY_ISSUE' ? { cashDeltaAtoms: delta('cash'), debtDeltaAtoms: (-BigInt(delta('debt'))).toString(), ...financialFacts(ex.entries, occurrence.issuerIds, occurrence.causeId) } : {}), ...(template.profile === 'CAPEX' ? { projectStatus: template.investmentAccounting === 'CAPITALIZE' ? 'IN_PROGRESS' : 'EXPENSED', completionTick: String(tick + duration) } : {}) } };
  const newProject = ex.events.projects.find(item => item.causeId === cause && item.status === 'ACTIVE'); if (newProject) occurrence = { ...occurrence, projectId: newProject.id };
  const cooldownKey = `${template.id}_${companies.map(company => company.issuerId).join('_')}`;
  ex.events = { ...ex.events, occurrences: [...ex.events.occurrences, occurrence], cooldowns: { ...ex.events.cooldowns, [cooldownKey]: tick + template.cooldownTicks } };
  return finish(ex, [template], tick);
}
function recognizeProjects(ex: Execution, catalog: readonly EventTemplate[]): void {
  for (let project of ex.events.projects) {
    const source = catalog.find(item => item.id === project.sourceTemplateId);
    if (project.status === 'COMPLETED' && source?.profile === 'CAPEX' && source.investmentOwner === 'SUPPLIER' && project.issuerIds.length === 2 && ex.tick > project.completionTick && BigInt(project.recognizedAtoms) < BigInt(project.amountAtoms)) {
      const target = BigInt(project.amountAtoms) * BigInt(Math.min(63, ex.tick - project.completionTick)) / 63n; const earned = target - BigInt(project.recognizedAtoms);
      const supplier = ex.companies.find(company => company.issuerId === project.issuerIds[0]); const customer = ex.companies.find(company => company.issuerId === project.issuerIds[1]);
      if (supplier && customer) { ex.post(supplier.issuerId, 'EVENT_RESERVED_CAPACITY_REVENUE', project.causeId, 'contract_liability', 'retained_earnings', earned); ex.q(supplier.issuerId, 'revenueAtoms', earned); const used = earned < BigInt(customer.balances.intangible_assets) ? earned : BigInt(customer.balances.intangible_assets); ex.post(customer.issuerId, 'EVENT_RESERVED_CAPACITY_USE', project.causeId, 'retained_earnings', 'intangible_assets', used); ex.q(customer.issuerId, 'serviceAtoms', used); ex.project({ ...project, recognizedAtoms: target.toString() }); } continue;
    }
    if (project.status !== 'ACTIVE' || project.amountAtoms === '0' || project.startedTick >= ex.tick) continue;
    const template = catalog.find(item => item.id === project.sourceTemplateId); if (!template) throw new Error('Unknown project template');
    if (project.issuerIds.some(id => !ex.companies.some(company => company.issuerId === id))) { ex.project({ ...project, status: 'CANCELLED' }); continue; }
    if (project.investmentId) {
      if (ex.tick < project.completionTick) continue;
      const customer = ex.company(project.issuerIds.at(-1)!); const remainder = BigInt(project.amountAtoms) - BigInt(project.paidAtoms);
      const owner = template.investmentOwner === 'SUPPLIER' ? ex.company(project.issuerIds[0]!) : customer;
      const outcome = ex.events.occurrences.find(occurrence => occurrence.projectId === project.id && occurrence.profile === 'CAPEX')?.outcomeId;
      if (outcome === 'delayed') { ex.project({ ...project, completionTick: ex.tick + 3 }); ex.events = { ...ex.events, occurrences: ex.events.occurrences.map(item => item.projectId === project.id && item.outcomeId === 'delayed' ? { ...item, outcomeId: 'commissioned' } : item) }; ex.set({ ...owner, investments: owner.investments.map(item => item.id === project.investmentId ? { ...item, completionTick: ex.tick + 3 } : item) }); continue; }
      if (outcome === 'failed') {
        cancelInvestment(ex, project, true); continue;
      }
      if (ex.cash(customer.issuerId) < remainder) { ex.project({ ...project, completionTick: ex.tick + 1 }); ex.set({ ...customer, investments: customer.investments.map(item => item.id === project.investmentId ? { ...item, completionTick: ex.tick + 1 } : item) }); continue; }
      const contractId = project.issuerIds.length === 2 ? `event_${project.id}_CAPEX` : null;
      ex.post(customer.issuerId, 'EVENT_CAPEX_FINAL', project.causeId, 'construction_in_progress', 'cash', remainder, contractId); ex.q(customer.issuerId, 'capexAtoms', remainder);
      if (project.issuerIds.length === 2) {
        const supplier = ex.company(project.issuerIds[0]!); ex.post(supplier.issuerId, 'EVENT_SUPPLIER_FINAL', project.causeId, 'cash', 'contract_liability', remainder, contractId);
        if (template.investmentOwner === 'CUSTOMER') { ex.post(supplier.issuerId, 'EVENT_CAPEX_SUPPLY_REVENUE', project.causeId, 'contract_liability', 'retained_earnings', BigInt(project.amountAtoms), contractId); ex.q(supplier.issuerId, 'revenueAtoms', BigInt(project.amountAtoms)); const cost = BigInt(project.amountAtoms) * 3n / 4n; ex.post(supplier.issuerId, 'EVENT_SUPPLY_COST', project.causeId, 'retained_earnings', 'trade_payables', cost, contractId); ex.working(supplier.issuerId, project.causeId, cost, 'AP', ex.tick + 7); ex.q(supplier.issuerId, 'rawMaterialsAtoms', cost); }
      }
      const intangible = template.target === 'intangibleAssets';
      ex.post(owner.issuerId, 'EVENT_CAPEX_COMMISSIONED', project.causeId, intangible ? 'intangible_assets' : 'operating_assets', 'construction_in_progress', BigInt(project.amountAtoms), contractId);
      if (template.investmentOwner === 'SUPPLIER' && project.issuerIds.length === 2) ex.post(customer.issuerId, 'EVENT_RESERVED_CAPACITY_RIGHT', project.causeId, 'intangible_assets', 'construction_in_progress', BigInt(project.amountAtoms), contractId);
      const current = ex.company(owner.issuerId); const efficient = !intangible && template.investmentPurpose === 'EFFICIENCY'; const expansion = !intangible && template.investmentPurpose === 'EXPANSION';
      const improvement = new D('0.03').mul(template.sectorExposure); const customerEffect = new D('0.02').mul(template.sectorExposure);
      const acquiredCustomers = intangible && template.id !== 'LMB-21';
      ex.set({ ...current, productivity: efficient ? D.min('1.4', new D(current.productivity).plus(improvement)).toString() : current.productivity, customerBase: acquiredCustomers ? D.min('2', new D(current.customerBase).mul(new D(1).plus(customerEffect))).toString() : current.customerBase, capacity: expansion ? new D(current.capacity).mul(new D(1).plus(improvement)).toString() : current.capacity, investments: current.investments.map(item => item.id === project.investmentId ? { ...item, status: 'OPERATING', productivityEffect: efficient ? improvement.toString() : '0' } : item) });
      if (template.investmentPurpose === 'MAINTENANCE') ex.events = { ...ex.events, occurrences: ex.events.occurrences.map(item => item.profile === 'INCIDENT' && item.causeId === project.causeId ? { ...item, status: 'RESOLVED' } : item) };
      ex.project({ ...project, status: 'COMPLETED', recognizedAtoms: template.investmentOwner === 'SUPPLIER' ? '0' : project.amountAtoms, paidAtoms: project.amountAtoms }); continue;
    }
    if (template.profile !== 'CONTRACT') continue;
    const supplier = ex.company(project.issuerIds[0]!); const age = Math.min(ex.tick - project.startedTick, project.completionTick - project.startedTick); const span = Math.max(1, project.completionTick - project.startedTick);
    const cumulative = BigInt(project.amountAtoms) * BigInt(age) / BigInt(span); const planned = cumulative - BigInt(project.recognizedAtoms);
    const spare = round(D.max(0, new D(supplier.capacity).minus(supplier.volume)).mul(supplier.unitPrice).mul(MONEY_SCALE.toString())); const delivered = planned < spare ? planned : spare;
    if (delivered <= 0n) continue;
    const customer = project.issuerIds.length === 2 ? ex.company(project.issuerIds[1]!) : null; const contractId = customer ? `event_${project.id}` : null;
    const billingTick = project.startedTick + Math.ceil(age / 21) * 21 + 7;
    if (template.contractRole === 'CUSTOMER') {
      ex.post(supplier.issuerId, 'EVENT_PROCUREMENT_DELIVERY', project.causeId, 'inventory', 'trade_payables', delivered); ex.working(supplier.issuerId, project.causeId, delivered, 'AP', billingTick);
      project = { ...project, recognizedAtoms: (BigInt(project.recognizedAtoms) + delivered).toString() }; if (project.recognizedAtoms === project.amountAtoms) project = { ...project, status: 'COMPLETED' }; ex.project(project); continue;
    }
    ex.post(supplier.issuerId, 'EVENT_CONTRACT_RECOGNITION', project.causeId, 'receivables', 'retained_earnings', delivered, contractId); ex.q(supplier.issuerId, 'revenueAtoms', delivered); ex.working(supplier.issuerId, project.causeId, delivered, 'AR', billingTick, contractId, customer?.issuerId ?? null);
    const cost = delivered * 3n / 4n; ex.post(supplier.issuerId, 'EVENT_CONTRACT_VARIABLE_COST', project.causeId, 'retained_earnings', 'trade_payables', cost); ex.q(supplier.issuerId, 'rawMaterialsAtoms', cost); ex.working(supplier.issuerId, project.causeId, cost, 'AP', ex.tick + 7);
    if (customer) { ex.post(customer.issuerId, 'EVENT_CONTRACT_PURCHASE', project.causeId, template.investmentAccounting === 'CAPITALIZE' ? 'construction_in_progress' : 'retained_earnings', 'trade_payables', delivered, contractId); ex.working(customer.issuerId, project.causeId, delivered, 'AP', billingTick, contractId, supplier.issuerId); if (template.investmentAccounting !== 'CAPITALIZE') ex.q(customer.issuerId, template.investmentAccounting === 'RESEARCH_EXPENSE' ? 'researchAtoms' : template.target === 'service' ? 'serviceAtoms' : 'rawMaterialsAtoms', delivered); }
    project = { ...project, recognizedAtoms: (BigInt(project.recognizedAtoms) + delivered).toString() }; if (project.recognizedAtoms === project.amountAtoms) project = { ...project, status: 'COMPLETED' }; ex.project(project);
  }
}
function disclosure(occurrence: EventOccurrence, template: EventTemplate, companies: readonly CompanyTrueState[]): EventDisclosure {
  const variables: Record<string, string> = { subject: occurrence.issuerIds.map(id => companies.find(company => company.issuerId === id)?.name ?? id).join(' · '), actual: Object.values(occurrence.actual).join(', '), expected: Object.values(occurrence.expected).join(', '), previous: Object.values(occurrence.previous).join(', '), effectiveTick: String(occurrence.effectiveTick), publishTick: String(occurrence.publishTick), duration: String(occurrence.duration), unit: template.unit };
  return { id: `${occurrence.id}_public`, causeId: occurrence.causeId, templateId: template.id, templateVersion: template.version, profile: template.profile, title: template.title, publicCopy: template.publicCopy.replace(/\{([^}]+)\}/g, (_, key: string) => variables[key]!), issuerIds: occurrence.issuerIds, symbols: occurrence.issuerIds.map(id => { const company = companies.find(company => company.issuerId === id); return company ? company.generation === 1 ? company.symbol : `${company.symbol}${company.generation}` : id; }), effectiveTick: occurrence.effectiveTick, publishTick: occurrence.publishTick, actual: occurrence.actual, expected: occurrence.expected, previous: occurrence.previous, certainty: template.certainty, sourceType: template.sourceType, target: template.target, magnitude: occurrence.magnitude, duration: occurrence.duration, halfLifeTicks: template.halfLifeTicks, decay: template.decay, sectorExposure: template.sectorExposure, reversalRule: template.reversalRule };
}
function finish(ex: Execution, catalog: readonly EventTemplate[], tick: number): EventStepResult {
  const modifiers: Record<string, CompanyEventModifier> = {}; const publications: EconomyPublication[] = [];
  for (const company of ex.companies) {
    const delivered = ex.entries.filter(entry => entry.issuerId === company.issuerId && entry.kind === 'EVENT_CONTRACT_RECOGNITION').reduce((sum, entry) => sum + BigInt(entry.lines[0]!.amountAtoms), 0n);
    modifiers[company.issuerId] = { demand: '0', exportDemand: '0', unitPrice: '0', productivity: '0', productMix: '0', inventoryTurnover: '0', capacity: '0', customerBase: '0', rawMaterials: '0', energy: '0', labor: '0', service: '0', research: '0', reservedVolume: new D(delivered.toString()).div(MONEY_SCALE.toString()).div(company.unitPrice).toString() };
  }
  for (const project of ex.events.projects.filter(project => project.status === 'ACTIVE' && project.investmentId)) {
    const template = catalog.find(item => item.id === project.sourceTemplateId) ?? EVENT_CATALOG.find(item => item.id === project.sourceTemplateId);
    if (template?.investmentPurpose === 'RELOCATION') { const id = template.investmentOwner === 'SUPPLIER' ? project.issuerIds[0]! : project.issuerIds.at(-1)!; if (modifiers[id]) modifiers[id] = { ...modifiers[id], capacity: '-0.25' }; }
  }
  for (const occurrence of ex.events.occurrences) {
    const template = catalog.find(item => item.id === occurrence.templateId) ?? EVENT_CATALOG.find(item => item.id === occurrence.templateId); if (!template) throw new Error('Unknown event template');
    if (occurrence.publishTick === tick) { const publicEvent = disclosure(occurrence, template, [...ex.companies, ...ex.state.retiredCompanies]); publications.push({ id: publicEvent.id, kind: 'EVENT', effectiveTick: occurrence.effectiveTick, publishTick: tick, disclosure: publicEvent }); }
    if (occurrence.status !== 'ACTIVE') continue;
    const magnitude = new D(eventEffectAt(occurrence, template, tick)).mul(template.sectorExposure);
    if (template.profile === 'MACRO' && template.financeAction === null && template.target in ex.macro) {
      const delta = magnitude.minus(new D(eventEffectAt(occurrence, template, tick - 1)).mul(template.sectorExposure));
      const key = template.target as keyof MacroState;
      if (typeof ex.macro[key] === 'string' && !['regime'].includes(key)) {
        const previous = new D(ex.macro[key] as string); const value = template.unit === 'INDEX_RATIO' || template.unit === 'RATIO' ? previous.mul(new D(1).plus(delta)) : previous.plus(delta);
        const bounds = key === 'policyRate' ? ['0', '0.15'] : key === 'inflation' ? ['-0.1', '0.3'] : key === 'creditStress' ? ['0', '1'] : key === 'riskAppetite' ? ['-1', '1'] : ['0.000001', '1000'];
        ex.macro = { ...ex.macro, [key]: clamp(value, bounds[0]!, bounds[1]!).toString() };
        if (template.id === 'MAC-24') ex.macro = { ...ex.macro, riskAppetite: clamp(new D(ex.macro.riskAppetite).minus(delta), '-1', '1').toString() };
      }
    }
    if (!['DEMAND', 'COST', 'PRICING', 'OPERATE', 'INCIDENT', 'MILESTONE'].includes(template.profile) && !(template.profile === 'MACRO' && template.target === 'exportDemand')) continue;
    const project = ex.events.projects.find(project => project.id === occurrence.projectId);
    const affectedIds = template.profile === 'INCIDENT' && project?.investmentId ? occurrence.issuerIds.filter(id => ex.companies.find(company => company.issuerId === id)?.investments.some(investment => investment.id === project.investmentId)) : occurrence.issuerIds;
    for (const id of template.profile === 'MACRO' && template.target === 'exportDemand' ? ex.companies.map(company => company.issuerId) : affectedIds) {
      const modifier = modifiers[id]; if (!modifier) continue;
      const target = template.profile === 'INCIDENT' && template.operation !== 'RESTORE' ? 'capacity' : template.target;
      if (target in modifier) modifiers[id] = { ...modifier, [target]: clamp(new D(modifier[target as keyof CompanyEventModifier]).plus(template.profile === 'INCIDENT' ? magnitude.abs().negated() : magnitude), '-0.95', '0.95').toString() };
      if (template.profile === 'MILESTONE' && template.operation === 'CANCEL') modifiers[id] = { ...modifiers[id]!, research: '-0.35' };
    }
  }
  for (const company of ex.companies) checkCorporateBalance(company);
  for (const project of ex.events.projects.filter(project => project.status === 'FAILED' && /pipeline|technology/.test(project.key))) {
    for (const id of project.issuerIds) if (modifiers[id] && !ex.events.projects.some(known => known.key === project.key && known.status === 'ACTIVE' && known.issuerIds.includes(id))) modifiers[id] = { ...modifiers[id], research: '-0.35' };
  }
  for (let index = 0; index < publications.length; index++) {
    const publication = publications[index]!;
    if (publication.kind === 'EVENT' && publication.disclosure.profile === 'MACRO' && publication.disclosure.target in ex.macro && publication.effectiveTick === tick) {
      const event = publication.disclosure; const actual = { ...event.actual, [event.target]: String(ex.macro[event.target as keyof MacroState]), ...(event.templateId === 'MAC-24' ? { riskAppetite: ex.macro.riskAppetite } : {}) };
      const occurrence = ex.events.occurrences.find(item => item.templateId === event.templateId && item.effectiveTick === tick)!;
      const template = catalog.find(item => item.id === event.templateId) ?? EVENT_CATALOG.find(item => item.id === event.templateId)!;
      publications[index] = { ...publication, disclosure: disclosure({ ...occurrence, actual }, template, ex.companies) };
    }
  }
  for (const project of ex.events.projects.filter(project => project.status === 'COMPLETED' && project.investmentId && project.completionTick === tick)) {
    const template = catalog.find(item => item.id === project.sourceTemplateId); if (!template) continue;
    const customer = ex.companies.find(company => company.issuerId === (template.investmentOwner === 'SUPPLIER' ? project.issuerIds[0] : project.issuerIds.at(-1))); if (!customer) continue;
    const target = template.target === 'intangibleAssets' ? 'customerBase' : template.investmentPurpose === 'EXPANSION' ? 'capacity' : 'productivity';
    const improved = !['RELOCATION', 'MAINTENANCE'].includes(template.investmentPurpose) && template.id !== 'LMB-21';
    const occurrence: EventOccurrence = { id: `${project.id}_commission_${tick}`, causeId: project.causeId, templateId: template.id, templateVersion: template.version, profile: 'CAPEX', issuerIds: [customer.issuerId], symbols: [customer.symbol], effectiveTick: tick, publishTick: tick, duration: 126, magnitude: improved ? target === 'customerBase' ? '0.02' : '0.03' : '0', outcomeId: 'commissioned', projectId: project.id, status: 'RESOLVED', actual: { [target]: improved ? target === 'customerBase' ? '0.02' : '0.03' : '0', projectStatus: 'COMPLETED' }, expected: { [target]: improved ? target === 'customerBase' ? '0.015' : '0.025' : '0' }, previous: { [target]: '0' } };
    const completed = disclosure({ ...occurrence, actual: { ...occurrence.actual, ...financialFacts(ex.entries, project.issuerIds, project.causeId), ...(template.investmentPurpose === 'MAINTENANCE' ? { recoveredCauseId: project.causeId } : {}) } }, { ...template, target, title: `${template.title} - 운영 개시`, publicCopy: '{subject}: 검수 완료와 운영 개시, 실제 {actual}, 예상 {expected}' }, ex.companies);
    publications.push({ id: completed.id, kind: 'EVENT', effectiveTick: tick, publishTick: tick, disclosure: completed });
    if (template.id === 'LMB-21') {
      const nextPipeline = projectFor({ ...template, subjects: [customer.symbol], projectKey: 'LMB:pipeline' }, ex.companies, tick, 'ACTIVE');
      ex.project({ ...nextPipeline, causeId: `${project.causeId}_pipeline`, sourceTemplateId: 'LMB-01', successorTemplateId: 'LMB-01', completionTick: tick + 6 });
    }
  }
  return { companies: ex.companies, macro: ex.macro, contracts: ex.contracts, events: eventRuntimeSchema.parse(ex.events), entries: ex.entries, actions: ex.actions, publications, modifiers };
}
/** One random domain, no account or order access. Followups and scheduled results use no new-event budget. */
export function advanceEvents(state: EconomyState, macro: MacroState, tick: number, random: EconomyRandom, catalog: readonly EventTemplate[] = EVENT_CATALOG, publicState?: PublicEconomyState): EventStepResult {
  let ex = new Execution(state, tick, macro);
  ex.events = { ...ex.events, projects: ex.events.projects.map(project => ['ACTIVE', 'NEGOTIATING'].includes(project.status) && project.issuerIds.some(id => !ex.companies.some(company => company.issuerId === id)) ? { ...project, status: 'CANCELLED', successorTemplateId: null } : project) };
  for (const project of [...ex.events.projects]) {
    if (project.status !== 'ACTIVE' || !project.investmentId || tick < project.startedTick + Math.max(1, Math.floor((project.completionTick - project.startedTick) / 2)) || tick >= project.completionTick) continue;
    const source = catalog.find(item => item.id === project.sourceTemplateId); const current = { ...state, companies: ex.companies, macro: ex.macro, events: ex.events, contracts: ex.contracts };
    const candidates = source?.successors.map(id => catalog.find(item => item.id === id)!).filter(template => ['CANCEL', 'DELAY'].includes(template.operation) && !ex.events.occurrences.some(item => item.templateId === template.id && item.causeId === project.causeId) && eventEligible(template, current, tick)) ?? [];
    const threshold = new D('0.15').plus(new D(ex.macro.creditStress).mul('0.3')); const draw = uniform(random, tick, `project-interruption-${project.id}`);
    if (!candidates.length || draw.gte(threshold)) continue;
    const candidate = candidates[Math.min(candidates.length - 1, Math.floor(uniform(random, tick, `project-interruption-choice-${project.id}`).mul(candidates.length).toNumber()))]!;
    const result = executeEvent(current, { ...candidate, mode: 'FOLLOWUP', hazardWeight: '0' }, tick, random, project.causeId, publicState); ex.companies = [...result.companies]; ex.contracts = [...result.contracts]; ex.events = result.events; ex.entries.push(...result.entries); ex.actions.push(...result.actions);
  }
  recognizeProjects(ex, catalog);
  if (tick % 21 === 0) {
    const keys = new Set<string>();
    for (const template of catalog.filter(item => item.eligibility.includes('ACTIVE_NEGOTIATION'))) {
      const identity = `${template.projectKey}_${template.subjects.join('_')}`; if (keys.has(identity)) continue; keys.add(identity);
      const current = { ...state, companies: ex.companies, events: ex.events };
      if (!matchingProject(template, current) && template.subjects.every(symbol => ex.companies.find(company => company.symbol === symbol)?.lifecycle === 'OPERATING')) ex.project(projectFor(template, ex.companies, tick, 'NEGOTIATING'));
    }
  }
  for (const parent of [...ex.events.occurrences]) {
    if (parent.status !== 'ACTIVE' || parent.projectId || parent.effectiveTick + parent.duration !== tick) continue;
    const template = catalog.find(item => item.id === parent.templateId); if (!template?.successors.length) continue;
    const candidateState = { ...state, companies: ex.companies, macro: ex.macro, events: ex.events, contracts: ex.contracts };
    const candidates = template.successors.map(id => catalog.find(item => item.id === id)!).filter(item => item.mode !== 'DOMAIN_ONLY' && eventEligible(item, candidateState, tick) && !ex.events.occurrences.some(occurrence => occurrence.templateId === item.id && occurrence.causeId === parent.causeId));
    const chosen = candidates[Math.min(candidates.length - 1, Math.floor(uniform(random, tick, `confirmation-${parent.id}`).mul(candidates.length).toNumber()))];
    if (chosen) { const result = executeEvent(candidateState, { ...chosen, mode: 'FOLLOWUP', hazardWeight: '0' }, tick, random, parent.causeId, publicState); ex.companies = [...result.companies]; ex.contracts = [...result.contracts]; ex.events = result.events; ex.entries.push(...result.entries); ex.actions.push(...result.actions); }
  }
  for (const project of [...ex.events.projects]) {
    if (!project.successorTemplateId || project.completionTick > tick || !['ACTIVE', 'COMPLETED'].includes(project.status)) continue;
    const source = catalog.find(item => item.id === project.sourceTemplateId);
    const allowed = project.stage === 0 ? [project.successorTemplateId, ...catalog.filter(item => item.projectKey === project.key && item.profile === 'MILESTONE' && item.operation === 'CANCEL').map(item => item.id)] : source?.successors ?? [];
    const siblingResults = catalog.filter(item => allowed.includes(item.id) && item.mode === 'FOLLOWUP' && item.projectKey === project.key && item.profile === 'MILESTONE' && !ex.events.occurrences.some(occurrence => occurrence.templateId === item.id && occurrence.causeId === project.causeId) && item.subjects.every(symbol => project.issuerIds.includes(ex.companies.find(company => company.symbol === symbol)?.issuerId ?? '')));
    const candidates = siblingResults.length ? siblingResults : catalog.filter(item => item.id === project.successorTemplateId && !ex.events.occurrences.some(occurrence => occurrence.templateId === item.id && occurrence.causeId === project.causeId));
    const projectedState = { ...state, companies: ex.companies, events: ex.events, macro: ex.macro };
    const failureProbability = clamp(new D(1).minus(project.successProbability).plus(new D(ex.macro.creditStress).mul('0.15')).minus(new D(ex.company(project.issuerIds[0]!).productivity).minus(1).mul('0.2')), '0.1', '0.9');
    const resultWeights = candidates.map(candidate => /fail|failure|실패/.test(candidate.id.toLowerCase()) || new D(candidate.magnitude.min).lt(0) ? failureProbability : new D(1).minus(failureProbability));
    const weightTotal = resultWeights.reduce((sum, value) => sum.plus(value), new D(0)); const draw = uniform(random, tick, `followup-${project.id}`).mul(weightTotal); let cumulative = new D(0);
    const chosen = candidates.find((_candidate, index) => { cumulative = cumulative.plus(resultWeights[index]!); return draw.lt(cumulative); }); if (!chosen) continue;
    const candidateState = { ...projectedState, contracts: ex.contracts };
    if (!eventEligible(chosen, candidateState, tick)) { if (project.status === 'COMPLETED') ex.project({ ...project, successorTemplateId: null }); continue; }
    const result = executeEvent(candidateState, chosen, tick, random, project.causeId, publicState); ex.companies = [...result.companies]; ex.contracts = [...result.contracts]; ex.events = result.events; ex.entries.push(...result.entries); ex.actions.push(...result.actions);
    if (chosen.profile !== 'MILESTONE') { const currentProject = ex.events.projects.find(item => item.id === project.id)!; ex.project({ ...currentProject, successorTemplateId: null }); }
  }
  const count = newEventCandidateCount(random, tick);
  for (let index = 0; index < count; index++) {
    const candidateState = { ...state, companies: ex.companies, macro: ex.macro, events: ex.events, contracts: ex.contracts };
    const candidates = catalog.filter(template => template.mode === 'NEW' && new D(template.hazardWeight).gt(0) && eventEligible(template, candidateState, tick));
    const total = candidates.reduce((sum, template) => sum.plus(conditionalHazardWeight(template, candidateState)), new D(0)); if (total.isZero()) break;
    const draw = uniform(random, tick, 'event-selection', index).mul(total); let cumulative = new D(0);
    const template = candidates.find(template => { cumulative = cumulative.plus(conditionalHazardWeight(template, candidateState)); return draw.lt(cumulative); })!;
    const result = executeEvent(candidateState, template, tick, random, undefined, publicState); ex.companies = [...result.companies]; ex.contracts = [...result.contracts]; ex.events = result.events; ex.entries.push(...result.entries); ex.actions.push(...result.actions);
  }
  ex.events = { ...ex.events, occurrences: ex.events.occurrences.map(item => item.status === 'ACTIVE' && !ex.companies.some(company => item.issuerIds.includes(company.issuerId)) && item.issuerIds.length > 0 ? { ...item, status: 'CANCELLED' } : item) };
  return finish(ex, catalog, tick);
}
/** Regular macro/earnings/dividend disclosures describe one existing cause; they never re-execute it. */
export function domainEventPublications(state: EconomyState, publications: readonly EconomyPublication[], actions: readonly CorporateAction[], tick: number, catalog: readonly EventTemplate[] = EVENT_CATALOG, evidenceInput: readonly EventDomainEvidence[] = []): readonly EconomyPublication[] {
  const output: EconomyPublication[] = [];
  const evidence: EventDomainEvidence[] = [...evidenceInput];
  for (const publication of publications) {
    if (publication.kind !== 'EARNINGS' || publication.symbol !== 'HGI') continue;
    const owner = state.companies.find(company => company.issuerId === publication.issuerId); const previous = owner?.sealedQuarters.filter(report => report.publishTick <= state.tickNo).at(-1)?.foreignExchangeProfitAtoms ?? '0';
    if (BigInt(publication.report.foreignExchangeProfitAtoms) < BigInt(previous)) evidence.push({ id: `${publication.id}_fx`, causeId: publication.id, templateId: 'HGI-20', issuerId: publication.issuerId, effectiveTick: publication.effectiveTick, publishTick: tick, actual: { foreignExchangeProfitAtoms: publication.report.foreignExchangeProfitAtoms }, expected: { foreignExchangeProfitAtoms: previous }, previous: { foreignExchangeProfitAtoms: previous } });
  }
  const evidenceIds = new Set<string>(); const evidenceCauses = new Set<string>();
  for (const input of evidence) {
    const evidence = eventDomainEvidenceSchema.parse(input); const template = catalog.find(item => item.id === evidence.templateId); const company = [...state.companies, ...state.retiredCompanies].find(company => company.issuerId === evidence.issuerId);
    if (!template || template.mode !== 'DOMAIN_ONLY' || template.profile !== 'DISCLOSURE' || !company || !template.subjects.includes(company.symbol)) throw new Error('Domain evidence does not match its disclosure issuer/template');
    const causeKey = `${evidence.causeId}_${evidence.templateId}_${evidence.issuerId}`;
    if (evidence.publishTick !== tick || evidence.effectiveTick > tick || evidenceIds.has(evidence.id) || evidenceCauses.has(causeKey)) throw new Error('Domain evidence time/identity mismatch');
    evidenceIds.add(evidence.id); evidenceCauses.add(causeKey);
    const occurrence: EventOccurrence = { id: evidence.id, causeId: evidence.causeId, templateId: template.id, templateVersion: template.version, profile: 'DISCLOSURE', issuerIds: [company.issuerId], symbols: [company.symbol], effectiveTick: evidence.effectiveTick, publishTick: tick, duration: 1, magnitude: '0', outcomeId: 'domain', projectId: null, status: 'RESOLVED', actual: evidence.actual, expected: evidence.expected, previous: evidence.previous };
    const event = disclosure(occurrence, template, [...state.companies, ...state.retiredCompanies]); output.push({ id: event.id, kind: 'EVENT', effectiveTick: evidence.effectiveTick, publishTick: tick, disclosure: event });
  }
  for (const template of catalog.filter(item => item.mode === 'DOMAIN_ONLY')) {
    const macro = publications.find(item => item.kind === 'MACRO');
    const dividend = actions.find(item => item.kind === 'DIVIDEND_DECLARED' && template.subjects.some(symbol => state.companies.find(company => company.issuerId === item.issuerId)?.symbol === symbol));
    const earnings = publications.find(item => item.kind === 'EARNINGS' && template.subjects.includes(item.symbol));
    if (template.profile === 'MACRO' ? !macro : /배당/.test(template.title) ? !dividend : !earnings) continue;
    if (template.profile === 'DISCLOSURE') {
      if (dividend && 'dividend' in dividend) {
        const owner = state.companies.find(company => company.issuerId === dividend.issuerId); const prior = owner?.dividends.at(-1)?.dps ?? '0';
        const change = new D(dividend.dividend.dps).minus(prior);
        if (/증액|확대|상향/.test(template.title) && !change.gt(0)) continue;
        if (/감액|감소|감축|축소|하향/.test(template.title) && !change.lt(0)) continue;
      } else if (!/(?:실적 발표|분기 실적|분기실적|결산)/.test(template.title)) continue;
    }
    if (template.profile === 'MACRO' && macro?.kind === 'MACRO') {
      const actual = new D(String(macro.macro[template.target as keyof MacroState] ?? macro.macro.policyRate));
      const previous = new D(String(state.lastPublishedMacro[template.target as keyof MacroState] ?? state.lastPublishedMacro.policyRate));
      const comparison = template.target === 'policyRate' ? actual.minus(state.macro.policyRate) : actual.minus(previous);
      if ((/인상|상회|상향|회복|개선/.test(template.title) || template.operation === 'INCREASE') && !comparison.gt(0)) continue;
      if ((/인하|하회|하향|둔화|악화/.test(template.title) || template.operation === 'DECREASE') && !comparison.lt(0)) continue;
      if (/동결/.test(template.title) && !comparison.isZero()) continue;
    }
    const company = template.subjects.length ? state.companies.find(company => company.symbol === template.subjects[0]) : undefined;
    const actual: Record<string, string> = template.profile === 'MACRO' && macro?.kind === 'MACRO' ? { [template.target]: String(macro.macro[template.target as keyof MacroState] ?? macro.macro.policyRate) }
      : dividend && 'dividend' in dividend ? { dps: dividend.dividend.dps, exTick: String(dividend.dividend.exTick), payTick: String(dividend.dividend.payTick) }
      : earnings?.kind === 'EARNINGS' ? { revenueAtoms: earnings.report.revenueAtoms, operatingProfitAtoms: earnings.report.operatingProfitAtoms } : {};
    const domainId = macro && template.profile === 'MACRO' ? macro.id : dividend?.id ?? earnings!.id;
    const occurrence: EventOccurrence = { id: `${domainId}_${template.id}`, causeId: domainId, templateId: template.id, templateVersion: template.version, profile: template.profile, issuerIds: company ? [company.issuerId] : [], symbols: template.subjects,
      effectiveTick: tick, publishTick: tick, duration: 1, magnitude: '0', outcomeId: 'domain', projectId: null, status: 'RESOLVED', actual, expected: template.profile === 'MACRO' ? { [template.target]: underlying(template, company, state.lastPublishedMacro) } : {}, previous: template.profile === 'MACRO' ? { [template.target]: underlying(template, company, state.lastPublishedMacro) } : {} };
    const publicEvent = disclosure(occurrence, template, state.companies); output.push({ id: publicEvent.id, kind: 'EVENT', effectiveTick: tick, publishTick: tick, disclosure: publicEvent });
  }
  return output;
}
