import { z } from 'zod';
import { FinancialDecimal, moneyFromAtoms, parseFraction, parseRate } from '../domain/numeric.js';
import { parseMarketId, parseTickNo } from '../domain/identifiers.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { ASSET_ACCOUNTS, EQUITY_ACCOUNTS, INITIAL_CONTRACTS, LIABILITY_ACCOUNTS, advanceCorporations, checkCorporateBalance, initialCorporateState } from './corporate.js';
import { INITIAL_MACRO, advanceMacro, observeMacro, policyExpectation } from './macro.js';
import { advanceDividendBoundary, advanceFinancialLifecycle, declareDividend, settleLiquidation, settleLiquidationCreditors } from './actions.js';
import { advanceEvents, domainEventPublications, initialEventState } from '../events/engine.js';
import { eventRuntimeSchema } from '../events/validator.js';
import { validatePublicEconomy, type PublicEconomy } from './public.js';
import type { CompanyTrueState, CorporateAction, CorporateJournalEntry, EconomyAdvanceResult, EconomyPublication, EconomyRandom, EconomyState, FinancialReport } from './types.js';

const atom = z.string().max(51).regex(/^(?:0|-?[1-9]\d*)$/).refine((input) => { try { moneyFromAtoms(input); return true; } catch { return false; } });
const positiveAtom = atom.refine((input) => BigInt(input) >= 0n);
const decimal = z.string().max(96).refine((input) => { try { return parseRate(input) === input; } catch { return false; } });
const positiveDecimal = decimal.refine((input) => new FinancialDecimal(input).gt('0'));
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const identifier = z.string().min(1).max(180).regex(/^[A-Za-z0-9_-]+$/);
const symbol = z.enum(['HGI', 'DNL', 'TLR', 'NXC', 'VTR', 'AUR', 'LMB', 'RVI']);
const macroSchema = z.strictObject({
  policyRate: decimal, inflation: decimal, outputGap: decimal, industrialDemand: positiveDecimal, consumerDemand: positiveDecimal,
  metals: positiveDecimal, energy: positiveDecimal, fx: positiveDecimal, creditStress: decimal, riskAppetite: decimal,
  regime: z.enum(['EXPANSION', 'SLOWDOWN', 'RECESSION', 'RECOVERY', 'SUPPLY_SHOCK']), regimeSinceTick: counter,
}).superRefine((value, ctx) => {
  if (new FinancialDecimal(value.policyRate).lt('0') || new FinancialDecimal(value.policyRate).gt('0.15') || new FinancialDecimal(value.creditStress).lt('0') || new FinancialDecimal(value.creditStress).gt('1') || new FinancialDecimal(value.riskAppetite).lt('-1') || new FinancialDecimal(value.riskAppetite).gt('1')) ctx.addIssue({ code: 'custom', message: 'Invalid macro range' });
});
const reportSchema = z.strictObject({
  kind: z.enum(['SYNTHETIC_INITIALIZATION', 'ACTUAL']), quarterNo: z.number().int().min(-4).max(Number.MAX_SAFE_INTEGER), closedTick: counter, publishTick: counter,
  revenueAtoms: positiveAtom, operatingProfitAtoms: atom, interestExpenseAtoms: positiveAtom, pretaxProfitAtoms: atom,
  corporateTaxAtoms: positiveAtom, netProfitAtoms: atom, depreciationAtoms: positiveAtom, operatingCashFlowAtoms: atom,
  capexAtoms: positiveAtom, debtIssuedAtoms: positiveAtom, debtRepaidAtoms: positiveAtom, cashAtoms: positiveAtom,
  debtAtoms: positiveAtom, assetsAtoms: positiveAtom, liabilitiesAtoms: positiveAtom, equityAtoms: atom,
  receivablesAtoms: positiveAtom, payablesAtoms: positiveAtom, issuedShares: z.string().max(19).regex(/^[1-9]\d*$/).refine(value=>BigInt(value)<=1000000000000000000n), operatingAssetsAtoms: positiveAtom, dividendPayableAtoms: positiveAtom.default('0'), oneOffProfitAtoms: atom.default('0'), foreignExchangeProfitAtoms: atom.default('0'),
});
const fractionSchema = z.strictObject({ numerator: z.string().max(4096).regex(/^(?:0|-?[1-9]\d*)$/), denominator: z.string().max(4096).regex(/^[1-9]\d*$/) });
const quarterSchema = z.strictObject({ revenueAtoms: positiveAtom, rawMaterialsAtoms: positiveAtom, energyAtoms: positiveAtom, laborAtoms: positiveAtom, serviceAtoms: positiveAtom, researchAtoms: positiveAtom, depreciationAtoms: positiveAtom, interestAtoms: positiveAtom, taxAtoms: positiveAtom, operatingCashFlowAtoms: atom, capexAtoms: positiveAtom, debtRepaidAtoms: positiveAtom, debtIssuedAtoms: positiveAtom, oneOffProfitAtoms: atom.default('0'), foreignExchangeProfitAtoms: atom.default('0') });
const lifecycleSchema = z.enum(['OPERATING', 'WATCH', 'DISTRESSED', 'RESTRUCTURING', 'LIQUIDATING', 'EXTINGUISHED']);
const dividendSchema = z.strictObject({ id: identifier, issuerId: identifier, listingId: identifier, declaredTick: counter, exTick: counter, payTick: counter, status: z.enum(['DECLARED', 'EX_ENTITLED', 'PAID', 'IMPAIRED', 'SETTLED']), issuedShares: z.string().max(19).regex(/^[1-9]\d*$/).refine(value=>BigInt(value)<=1000000000000000000n), totalNominalAtoms: positiveAtom, dps: decimal, remainingPayableAtoms: positiveAtom, recoveryRatio: decimal, paidAtoms: positiveAtom });
const companySchema = z.strictObject({
    issuerId: identifier, listingId: identifier, slotId: z.enum(['O1', 'O2', 'O3', 'G1', 'G2', 'T1', 'T2', 'D1']), category: z.enum(['ORDINARY', 'GROWTH', 'THEMATIC', 'DIVIDEND']), symbol, name: z.string().min(1).max(128), issuedShares: z.string().max(19).regex(/^[1-9]\d*$/).refine(value=>BigInt(value)<=1000000000000000000n), status: z.enum(['NORMAL', 'STRESSED']),
    generation: counter.min(1).max(100000).default(1), createdTick: counter.default(0), lifecycle: lifecycleSchema.default('OPERATING'), lifecycleSinceTick: counter.default(0), dividendBan: z.boolean().default(false), financingAttempts: counter.max(2).default(0), eventEquityIssues: counter.default(0), reservedDividendAtoms: positiveAtom.default('0'), dividends: z.array(dividendSchema).max(100000).default([]),
    liquidation: z.strictObject({ id: identifier, enteredTick: counter, settlementTick: counter, estimatedRealizedAssetsAtoms: positiveAtom, liquidationCostAtoms: positiveAtom, estimatedRecoveryPerShare: decimal, realizedRecoveryPerShare: decimal.nullable() }).nullable().default(null),
    balances: z.strictObject({ cash: positiveAtom, receivables: positiveAtom, inventory: positiveAtom, operating_assets: positiveAtom, intangible_assets: positiveAtom, construction_in_progress: positiveAtom, trade_payables: positiveAtom, debt: positiveAtom, interest_payable: positiveAtom, tax_payable: positiveAtom, dividend_payable: positiveAtom.default('0'), contract_liability: positiveAtom.default('0'), paid_in_capital: positiveAtom, retained_earnings: atom }),
    debtContracts: z.array(z.strictObject({ id: identifier, rateType: z.enum(['FIXED', 'VARIABLE']), principalAtoms: positiveAtom, annualEffectiveRate: decimal, spread: decimal, maturityTick: counter, nextResetTick: counter, nextInterestPaymentTick: counter, accruedInterestAtoms: positiveAtom, interestCarry: fractionSchema })).max(256),
    workingCapital: z.array(z.strictObject({ id: identifier, causeId: identifier, contractId: identifier.nullable(), counterparty: z.union([symbol, z.literal('EXTERNAL')]), counterpartyIssuerId: identifier.nullable().default(null), amountAtoms: positiveAtom, dueTick: counter, kind: z.enum(['AR', 'AP']), overdueSinceTick: counter.nullable(), fxAtOrigination: positiveDecimal.nullable().default(null), foreignExposure: decimal.default('0') })).max(100000),
    investments: z.array(z.strictObject({ id: identifier, causeId: identifier, contractId: identifier.nullable(), amountAtoms: positiveAtom, startedTick: counter, completionTick: counter, status: z.enum(['PLANNED', 'IN_PROGRESS', 'OPERATING', 'CANCELLED']), usefulLifeTicks: z.number().int().min(1).max(100000), depreciatedAtoms: positiveAtom, productivityEffect: decimal, assetAccount: z.enum(['operating_assets', 'intangible_assets']).default('operating_assets') })).max(100000),
    currentQuarter: quarterSchema, sealedQuarters: z.array(reportSchema).min(4).max(100000), unitPrice: positiveDecimal, unitPriceBasis: positiveDecimal.optional(), volume: decimal, capacity: positiveDecimal, productivity: positiveDecimal, customerBase: positiveDecimal,
  }).transform(company => ({ ...company, unitPriceBasis: company.unitPriceBasis ?? company.unitPrice }));
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1), marketId: z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/), tickNo: counter, macro: macroSchema,
  lastPublishedMacro: macroSchema, macroPublishedTick: counter,
  companies: z.array(companySchema).length(8), retiredCompanies: z.array(companySchema).max(100000).default([]),
  contracts: z.array(z.strictObject({ contractId: identifier, supplier: symbol, customer: symbol, kind: z.enum(['RAW_MATERIALS', 'SERVICE', 'CAPEX']), costBucket: z.enum(['rawMaterials', 'service', 'capex']), exposure: decimal, settlementLagTicks: z.number().int().min(1).max(252) })).max(100000),
  events: eventRuntimeSchema.optional(),
}).transform(state => ({ ...state, events: state.events ?? initialEventState(state.companies, state.tickNo) }));
function validateReport(report: FinancialReport): void {
  if (BigInt(report.assetsAtoms) !== BigInt(report.liabilitiesAtoms) + BigInt(report.equityAtoms)
    || BigInt(report.pretaxProfitAtoms) !== BigInt(report.operatingProfitAtoms) - BigInt(report.interestExpenseAtoms)
    || BigInt(report.netProfitAtoms) !== BigInt(report.pretaxProfitAtoms) - BigInt(report.corporateTaxAtoms)) throw new Error('Sealed financial report does not reconcile');
  if (report.kind === 'ACTUAL' && (report.closedTick % 63 !== 0 || report.quarterNo !== report.closedTick / 63 || report.publishTick <= report.closedTick)) throw new Error('Invalid sealed quarter timing');
}
/** Strict persisted-state validation precedes replay, computation and every commit. */
export function validateEconomyState(input: unknown): EconomyState {
  const state: EconomyState = stateSchema.parse(input);
  if (state.macroPublishedTick > state.tickNo || state.macroPublishedTick % 21 !== 0 || state.macro.regimeSinceTick > state.tickNo || state.lastPublishedMacro.regimeSinceTick > state.macroPublishedTick) throw new Error('Invalid economic observation time');
  const identities = new Set<string>(); const activeSymbols = new Set<string>();
  for (const company of [...state.companies, ...state.retiredCompanies]) {
    const fixture = INITIAL_COMPANIES.find((item) => item.symbol === company.symbol);
    const initial = company.generation === 1;
    const expectedIssuer = initial ? fixture?.issuerId : `${company.symbol.toLowerCase()}_issuer_g${company.generation}`;
    const expectedListing = initial ? fixture?.listingId : `${company.symbol.toLowerCase()}_listing_g${company.generation}`;
    const expectedName = initial ? fixture?.name : `${fixture?.name} ${company.generation}세대`;
    if (!fixture || company.issuerId !== expectedIssuer || company.listingId !== expectedListing || company.slotId !== fixture.slotId || company.category !== fixture.category || company.name !== expectedName || BigInt(company.issuedShares) < BigInt(fixture.issuedShares) || (company.financingAttempts === 0 && company.eventEquityIssues === 0 && company.issuedShares !== fixture.issuedShares) || identities.has(company.issuerId)) throw new Error('Universe identity changed without a corporate action');
    if (company.createdTick > state.tickNo || company.lifecycleSinceTick > state.tickNo || (initial && company.createdTick !== 0)) throw new Error('Invalid corporate lifecycle time');
    if (state.companies.includes(company)) { if (activeSymbols.has(company.symbol) || company.lifecycle === 'LIQUIDATING' || company.lifecycle === 'EXTINGUISHED') throw new Error('Invalid active listing'); activeSymbols.add(company.symbol); }
    else if (company.lifecycle !== 'LIQUIDATING' && company.lifecycle !== 'EXTINGUISHED') throw new Error('Only retired rights may leave active slots');
    identities.add(company.issuerId); checkCorporateBalance(company);
    const dividendIds = new Set<string>();
    for (const dividend of company.dividends) {
      const nominal = BigInt(dividend.totalNominalAtoms); const paid = BigInt(dividend.paidAtoms); const payable = BigInt(dividend.remainingPayableAtoms);
      if (dividendIds.has(dividend.id) || dividend.issuerId !== company.issuerId || dividend.listingId !== company.listingId || dividend.exTick !== dividend.declaredTick + 3 || dividend.payTick !== dividend.declaredTick + 5 || dividend.declaredTick > state.tickNo || nominal <= 0n || paid + payable > nominal || new FinancialDecimal(dividend.recoveryRatio).lt('0') || new FinancialDecimal(dividend.recoveryRatio).gt('1') || !new FinancialDecimal(dividend.dps).eq(new FinancialDecimal(nominal.toString()).div('1000000000000').div(dividend.issuedShares))) throw new Error('Invalid immutable dividend obligation');
      dividendIds.add(dividend.id);
    }
    if (company.liquidation && (company.liquidation.enteredTick > state.tickNo || company.liquidation.settlementTick !== company.liquidation.enteredTick + 5 || (company.lifecycle === 'EXTINGUISHED' && company.liquidation.realizedRecoveryPerShare === null))) throw new Error('Invalid liquidation timing');
    if ((company.lifecycle === 'LIQUIDATING' || company.lifecycle === 'EXTINGUISHED') !== (company.liquidation !== null)) throw new Error('Liquidation state does not match its plan');
    if (company.lifecycle === 'EXTINGUISHED' && (Object.values(company.balances).some((value) => value !== '0') || company.volume !== '0' || company.reservedDividendAtoms !== '0')) throw new Error('Extinguished business must retain only its settled history');
    if (new FinancialDecimal(company.volume).lt('0') || new FinancialDecimal(company.volume).gt(company.capacity)) throw new Error('Sales volume exceeds production capacity');
    const workingIds = new Set<string>();
    for (const item of company.workingCapital) {
      if (workingIds.has(item.id)) throw new Error('Duplicate working-capital obligation'); workingIds.add(item.id);
      if (item.overdueSinceTick !== null && (item.overdueSinceTick > state.tickNo || item.dueTick > item.overdueSinceTick)) throw new Error('Invalid overdue obligation timing');
    }
    const debtIds = new Set<string>();
    for (const debt of company.debtContracts) {
      if (debtIds.has(debt.id)) throw new Error('Duplicate debt contract'); debtIds.add(debt.id);
      const carry = parseFraction(debt.interestCarry);
      if (carry.numerator < 0n || carry.numerator * 1000000000000n >= carry.denominator || new FinancialDecimal(debt.annualEffectiveRate).lt('0')) throw new Error('Invalid debt interest carry');
    }
    let previousQuarter = -5;
    for (const report of company.sealedQuarters) { validateReport(report); if (report.quarterNo <= previousQuarter || report.closedTick > state.tickNo) throw new Error('Sealed quarters must be immutable chronological results'); previousQuarter = report.quarterNo; }
    for (const project of company.investments) if (project.completionTick < project.startedTick || BigInt(project.depreciatedAtoms) > BigInt(project.amountAtoms)) throw new Error('Invalid investment lifecycle');
  }
  const contractIds = new Set<string>(); const exposures = new Map<string, InstanceType<typeof FinancialDecimal>>();
  for (const company of state.companies) {
    const previous = state.retiredCompanies.filter((retired) => retired.symbol === company.symbol).reduce((latest, retired) => Math.max(latest, retired.generation), 0);
    if (company.generation !== previous + 1) throw new Error('Replacement generations must preserve the prior issuer history');
  }
  for (const contract of state.contracts) {
    if (contractIds.has(contract.contractId) || contract.supplier === contract.customer) throw new Error('Invalid intercompany contract identity'); contractIds.add(contract.contractId);
    const exposure = new FinancialDecimal(contract.exposure);
    if (exposure.lt('0') || exposure.gt('0.2')) throw new Error('Contract exposure exceeds baseline limit');
    const key = `${contract.customer}_${contract.costBucket}`; const total = (exposures.get(key) ?? new FinancialDecimal('0')).plus(exposure);
    if (total.gt('1')) throw new Error('Contract costs exceed customer cost bucket'); exposures.set(key, total);
  }
  for (const company of [...state.companies, ...state.retiredCompanies]) for (const item of company.workingCapital) {
    if (item.counterparty === 'EXTERNAL' && item.contractId === null) { if (item.counterpartyIssuerId !== null) throw new Error('External claim cannot name an internal issuer'); continue; }
    if (item.counterpartyIssuerId !== null && ![...state.companies, ...state.retiredCompanies].some((counterparty) => counterparty.issuerId === item.counterpartyIssuerId && counterparty.symbol === item.counterparty)) throw new Error('Claim generation does not match its counterparty');
    const contract = state.contracts.find((entry) => entry.contractId === item.contractId);
    if (!contract || (item.kind === 'AR' ? company.symbol !== contract.supplier || item.counterparty !== contract.customer : company.symbol !== contract.customer || item.counterparty !== contract.supplier)) throw new Error('Working-capital item is not linked to its contract counterparties');
  }
  return state;
}
export function createEconomyState(marketId: string, tickNo = 0): EconomyState {
  parseMarketId(marketId); parseTickNo(tickNo);
  if (tickNo !== 0) throw new Error('A new economic epoch starts at tick zero');
  return validateEconomyState({ schemaVersion: 1, marketId, tickNo, macro: { ...INITIAL_MACRO }, lastPublishedMacro: { ...INITIAL_MACRO }, macroPublishedTick: 0, companies: initialCorporateState(), retiredCompanies: [], contracts: INITIAL_CONTRACTS.map((item) => ({ ...item })) });
}
export function advanceEconomy(input: EconomyState, nextTick: number, random: EconomyRandom, priorPublicInput?: PublicEconomy): EconomyAdvanceResult {
  const previous = validateEconomyState(input); parseTickNo(nextTick);
  const priorPublic = priorPublicInput ? validatePublicEconomy(priorPublicInput) : undefined;
  if (priorPublic && (priorPublic.marketId !== previous.marketId || priorPublic.tickNo !== previous.tickNo)) throw new Error('Event expectations require the prior public snapshot');
  if (nextTick !== previous.tickNo + 1) throw new Error('Economic ticks must advance exactly once in order');
  let macro = advanceMacro(previous.macro, nextTick, random);
  const entries: CorporateJournalEntry[] = []; const actions: CorporateAction[] = [];
  let boundary: readonly CompanyTrueState[] = previous.companies.map((company) => { const result = advanceDividendBoundary(company, previous.marketId, nextTick); entries.push(...result.entries); actions.push(...result.actions); return result.company; });
  const retired = previous.retiredCompanies.map((company) => {
    const dividendBoundary = advanceDividendBoundary(company, previous.marketId, nextTick); entries.push(...dividendBoundary.entries); actions.push(...dividendBoundary.actions);
    const result = settleLiquidation(dividendBoundary.company, previous.marketId, nextTick); entries.push(...result.entries); actions.push(...result.actions);
    const creditors = settleLiquidationCreditors(company, result, boundary, previous.marketId, nextTick); boundary = creditors.companies; entries.push(...creditors.entries); return result.company;
  });
  const eventStep = advanceEvents({ ...previous, companies: boundary }, macro, nextTick, random, undefined, priorPublic); entries.push(...eventStep.entries); actions.push(...eventStep.actions); macro = eventStep.macro;
  const corporate = advanceCorporations(previous.marketId, eventStep.companies, eventStep.contracts, macro, nextTick, random, eventStep.modifiers); entries.push(...corporate.entries);
  const companies: CompanyTrueState[] = [];
  for (const company of corporate.companies) {
    const lifecycle = advanceFinancialLifecycle(company, previous.marketId, nextTick, macro, random); entries.push(...lifecycle.entries); actions.push(...lifecycle.actions);
    if (lifecycle.replacement) {
      retired.push(lifecycle.company); companies.push(lifecycle.replacement);
      entries.push({ entryId: `${previous.marketId}_opening_${lifecycle.replacement.issuerId}`, causeId: `${lifecycle.replacement.issuerId}_opening`, marketId: previous.marketId, issuerId: lifecycle.replacement.issuerId, tickNo: nextTick, kind: 'REPLACEMENT_OPENING', contractId: null,
        lines: [...ASSET_ACCOUNTS.map((account) => ({ account, side: 'DR' as const, amountAtoms: lifecycle.replacement!.balances[account] })), ...[...LIABILITY_ACCOUNTS, ...EQUITY_ACCOUNTS].map((account) => ({ account, side: 'CR' as const, amountAtoms: lifecycle.replacement!.balances[account] }))].filter((line) => BigInt(line.amountAtoms) > 0n) });
    }
    else { const declaration = declareDividend(lifecycle.company, previous.marketId, nextTick); entries.push(...declaration.entries); actions.push(...declaration.actions); companies.push(declaration.company); }
  }
  const monthly = nextTick % 21 === 0;
  const observation = monthly ? observeMacro(macro, nextTick, random) : previous.lastPublishedMacro;
  const expectation = policyExpectation(observation, (Math.floor(nextTick / 21) + 1) * 21);
  const publications: EconomyPublication[] = [...eventStep.publications];
  if (monthly) publications.push({ id: `${previous.marketId}_macro_${nextTick}`, kind: 'MACRO', effectiveTick: nextTick, publishTick: nextTick, macro: { ...observation }, expectation, previousPolicyRate: previous.macro.policyRate });
  for (const company of corporate.companies) for (const report of company.sealedQuarters) {
    if (report.kind === 'ACTUAL' && report.publishTick === nextTick) publications.push({ id: `${previous.marketId}_${company.issuerId}_earnings_${report.quarterNo}`, kind: 'EARNINGS', effectiveTick: report.closedTick, publishTick: nextTick, issuerId: company.issuerId, symbol: company.symbol, report: { ...report } });
  }
  const fresh = companies.filter(company => !previous.companies.some(prior => prior.issuerId === company.issuerId));
  const replacementProjects = fresh.length ? initialEventState(companies, nextTick).projects.filter(project => project.issuerIds.some(id => fresh.some(company => company.issuerId === id))) : [];
  const state = validateEconomyState({ ...previous, tickNo: nextTick, macro, companies, retiredCompanies: retired, events: { ...eventStep.events, projects: [...eventStep.events.projects, ...replacementProjects] }, contracts: eventStep.contracts, lastPublishedMacro: observation, macroPublishedTick: monthly ? nextTick : previous.macroPublishedTick });
  publications.push(...domainEventPublications(previous, publications, actions, nextTick));
  return { state, corporateEntries: entries, publications, policyExpectation: expectation, actions };
}
