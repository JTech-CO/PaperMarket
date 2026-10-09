import { z } from 'zod';
import { FinancialDecimal as D, moneyFromAtoms, moneyToAtoms, parseMoney, parseRate } from '../domain/numeric.js';
import { issuerCategorySchema, issuerIdSchema, listingIdSchema, marketIdSchema, slotIdSchema, tickNoSchema } from '../domain/identifiers.js';
import type { InitialCompany } from '../fixtures/initial-companies.js';
import type { CorporateAction, EconomicSymbol, EconomyPublication, FinancialReport, PublicEconomyState } from './types.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { INITIAL_PUBLIC_REPORTS } from './corporate.js';
import { eventDisclosureSchema } from '../events/validator.js';
import type { EventDisclosure } from '../events/types.js';

type DecimalValue = InstanceType<typeof D>;
const signedTick = z.number().int().min(-1_000_000).max(Number.MAX_SAFE_INTEGER);
const atoms = z.string().max(51).regex(/^(?:0|-?[1-9]\d*)$/).refine((value) => {
  try { moneyFromAtoms(value); return true; } catch { return false; }
});
const nonnegativeAtoms = atoms.refine((value) => BigInt(value) >= 0n);
const decimal = z.string().max(96).refine((value) => {
  try { parseRate(value); return true; } catch { return false; }
});
const bounded = (minimum: string, maximum: string) => decimal.refine((value) => new D(value).gte(minimum) && new D(value).lte(maximum));
const issuedShares = z.string().min(1).max(19).regex(/^[1-9]\d*$/).refine((value) => BigInt(value) <= 1_000_000_000_000_000_000n);
const identity = z.string().min(1).max(128).regex(/^[A-Za-z0-9._:-]+$/);
const symbol = z.enum(['HGI', 'DNL', 'TLR', 'NXC', 'VTR', 'AUR', 'LMB', 'RVI']);
const publicSymbol = z.string().min(1).max(12).regex(/^(?:HGI|DNL|TLR|NXC|VTR|AUR|LMB|RVI)(?:[2-9]\d*|1\d+)?$/);
const lifecycle = z.enum(['OPERATING', 'WATCH', 'DISTRESSED', 'RESTRUCTURING', 'LIQUIDATING', 'EXTINGUISHED']);
export const publicDividendSchema = z.strictObject({ id: identity, issuerId: issuerIdSchema, listingId: listingIdSchema,
  declaredTick: tickNoSchema, exTick: tickNoSchema, payTick: tickNoSchema,
  status: z.enum(['DECLARED', 'EX_ENTITLED', 'PAID', 'IMPAIRED', 'SETTLED']),
  issuedShares, totalNominalAtoms: nonnegativeAtoms, dps: bounded('0', '1e30'),
  remainingPayableAtoms: nonnegativeAtoms, recoveryRatio: bounded('0', '1'), paidAtoms: nonnegativeAtoms,
}).refine((dividend) => dividend.exTick === dividend.declaredTick + 3 && dividend.payTick === dividend.declaredTick + 5
  && BigInt(dividend.paidAtoms) <= BigInt(dividend.totalNominalAtoms)
  && BigInt(dividend.remainingPayableAtoms) <= BigInt(dividend.totalNominalAtoms), 'Invalid public dividend contract');
const actionIdentity = { id: identity, effectiveTick: tickNoSchema, issuerId: issuerIdSchema, listingId: listingIdSchema, symbol: publicSymbol };
export const publicCorporateActionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...actionIdentity, kind: z.enum(['DIVIDEND_DECLARED', 'DIVIDEND_EX', 'DIVIDEND_PAYMENT', 'DIVIDEND_IMPAIRED']), dividend: publicDividendSchema }),
  z.strictObject({ ...actionIdentity, kind: z.literal('FINANCING'), raisedAtoms: nonnegativeAtoms, issuedSharesBefore: issuedShares, issuedSharesAfter: issuedShares }),
  z.strictObject({ ...actionIdentity, kind: z.literal('LIFECYCLE_CHANGED'), previousLifecycle: lifecycle, lifecycle }),
  z.strictObject({ ...actionIdentity, kind: z.literal('LIQUIDATION_STARTED'), liquidationId: identity, settlementTick: tickNoSchema,
    estimatedRecoveryPerShare: bounded('0', '1e30'), dividendRecoveryRatio: bounded('0', '1').default('1') }),
  z.strictObject({ ...actionIdentity, kind: z.literal('LIQUIDATION_SETTLED'), liquidationId: identity, realizedRecoveryPerShare: bounded('0', '1e30'),
    commonPaidAtoms: nonnegativeAtoms, eligibleShares: issuedShares,
    dividendRecoveries: z.array(z.strictObject({ dividendId: identity, recoveryRatio: bounded('0', '1'), paidAtoms: nonnegativeAtoms })).max(256) }),
  z.strictObject({ ...actionIdentity, kind: z.literal('REPLACEMENT'), baseSymbol: symbol, generation: z.number().int().min(2).max(1_000_000), createdTick: tickNoSchema,
    newIssuerId: issuerIdSchema, newListingId: listingIdSchema, newSymbol: publicSymbol, newName: z.string().min(1).max(100), issuedShares }),
]).superRefine((action, context) => {
  if ('dividend' in action && (action.dividend.issuerId !== action.issuerId || action.dividend.listingId !== action.listingId
    || action.dividend.declaredTick > action.effectiveTick)) context.addIssue({ code: 'custom', message: 'Dividend action identity mismatch' });
  if (action.kind === 'DIVIDEND_DECLARED' && action.effectiveTick !== action.dividend.declaredTick) context.addIssue({ code: 'custom', message: 'Declaration tick mismatch' });
  if (action.kind === 'DIVIDEND_EX' && action.effectiveTick !== action.dividend.exTick) context.addIssue({ code: 'custom', message: 'Ex tick mismatch' });
  if (action.kind === 'FINANCING' && new D(action.issuedSharesAfter).lte(action.issuedSharesBefore)) context.addIssue({ code: 'custom', message: 'Financing shares must increase' });
  if (action.kind === 'REPLACEMENT' && (action.createdTick !== action.effectiveTick || action.newSymbol !== `${action.baseSymbol}${action.generation}`
    || action.newIssuerId === action.issuerId || action.newListingId === action.listingId)) context.addIssue({ code: 'custom', message: 'Replacement identity mismatch' });
});

export const publicMacroSchema = z.strictObject({
  policyRate: bounded('0', '0.15'), inflation: bounded('-0.1', '0.3'), outputGap: bounded('-1', '1'),
  industrialDemand: bounded('0', '1000'), consumerDemand: bounded('0', '1000'),
  metals: bounded('0.000001', '1000'), energy: bounded('0.000001', '1000'), fx: bounded('0.000001', '1000'),
  creditStress: bounded('0', '1'), riskAppetite: bounded('-1', '1'),
  regime: z.enum(['EXPANSION', 'SLOWDOWN', 'RECESSION', 'RECOVERY', 'SUPPLY_SHOCK']), regimeSinceTick: tickNoSchema,
});
export const policyExpectationSchema = z.strictObject({
  meetingTick: tickNoSchema, decreaseProbability: bounded('0', '1'), unchangedProbability: bounded('0', '1'),
  increaseProbability: bounded('0', '1'), expectedRate: bounded('0', '0.15'),
}).refine((value) => new D(value.decreaseProbability).plus(value.unchangedProbability).plus(value.increaseProbability).eq(1), 'Policy probabilities must sum to one');
export const publicFinancialReportSchema = z.strictObject({
  kind: z.enum(['SYNTHETIC_INITIALIZATION', 'ACTUAL']), quarterNo: signedTick, closedTick: tickNoSchema, publishTick: tickNoSchema,
  revenueAtoms: nonnegativeAtoms, operatingProfitAtoms: atoms, interestExpenseAtoms: nonnegativeAtoms,
  pretaxProfitAtoms: atoms, corporateTaxAtoms: nonnegativeAtoms, netProfitAtoms: atoms,
  operatingCashFlowAtoms: atoms, capexAtoms: nonnegativeAtoms, depreciationAtoms: nonnegativeAtoms,
  debtIssuedAtoms: nonnegativeAtoms, debtRepaidAtoms: nonnegativeAtoms,
  cashAtoms: nonnegativeAtoms, debtAtoms: nonnegativeAtoms, assetsAtoms: nonnegativeAtoms,
  liabilitiesAtoms: nonnegativeAtoms, equityAtoms: atoms, receivablesAtoms: nonnegativeAtoms,
  payablesAtoms: nonnegativeAtoms, issuedShares, operatingAssetsAtoms: nonnegativeAtoms,
  dividendPayableAtoms: nonnegativeAtoms.default('0'), oneOffProfitAtoms: atoms.default('0'), foreignExchangeProfitAtoms: atoms.default('0'),
}).refine((value) => BigInt(value.assetsAtoms) === BigInt(value.liabilitiesAtoms) + BigInt(value.equityAtoms), 'Public balance sheet must balance')
  .refine((value) => BigInt(value.pretaxProfitAtoms) === BigInt(value.operatingProfitAtoms) - BigInt(value.interestExpenseAtoms), 'Public pretax profit differs')
  .refine((value) => BigInt(value.netProfitAtoms) === BigInt(value.pretaxProfitAtoms) - BigInt(value.corporateTaxAtoms), 'Public net profit differs')
  .refine((value) => value.publishTick >= value.closedTick, 'Publication cannot precede the report close');
const publicDebtTermSchema = z.strictObject({
  rateType: z.enum(['FIXED', 'VARIABLE']), principalAtoms: nonnegativeAtoms, annualEffectiveRate: bounded('0', '1'),
  spread: bounded('0', '1'), maturityTick: tickNoSchema, nextResetTick: tickNoSchema,
});
export const publicForecastSchema = z.strictObject({
  annualRevenueGrowth: bounded('-0.5', '0.6'), operatingMargin: bounded('-5', '0.6'),
  expectedQuarterRevenueAtoms: nonnegativeAtoms, targetPayoutRatio: bounded('0', '1'),
  successProbability: bounded('0', '1'), fundingFailureProbability: bounded('0', '1'),
}).refine((value) => new D(value.successProbability).plus(value.fundingFailureProbability).lte(1));
const companySchema = z.strictObject({
  issuerId: issuerIdSchema, listingId: listingIdSchema, slotId: slotIdSchema, category: issuerCategorySchema,
  symbol: publicSymbol, baseSymbol: symbol.optional(), generation: z.number().int().min(1).max(1_000_000).default(1),
  createdTick: tickNoSchema.default(tickNoSchema.parse(0)), lifecycle: lifecycle.default('OPERATING'), dividends: z.array(publicDividendSchema).max(256).default([]),
  corporateCashAdjustmentAtoms: atoms.default('0'), corporateDebtAdjustmentAtoms: atoms.default('0'),
  corporateLiabilityAdjustmentAtoms: atoms.default('0'),
  name: z.string().min(1).max(100), issuedShares,
  reports: z.array(publicFinancialReportSchema).min(1).max(8), latestReport: publicFinancialReportSchema,
  nextEarningsTick: tickNoSchema, forecast: publicForecastSchema, debtTerms: z.array(publicDebtTermSchema).max(32),
}).transform((company) => ({ ...company, baseSymbol: company.baseSymbol ?? symbol.parse(company.symbol) }));
export const publicationCandidateSchema = z.discriminatedUnion('kind', [
  z.strictObject({ id: identity, kind: z.literal('MACRO'), effectiveTick: tickNoSchema, publishTick: tickNoSchema,
    macro: publicMacroSchema, expectation: policyExpectationSchema, previousPolicyRate: bounded('0', '0.15') }),
  z.strictObject({ id: identity, kind: z.literal('EARNINGS'), effectiveTick: tickNoSchema, publishTick: tickNoSchema,
    issuerId: issuerIdSchema, symbol, report: publicFinancialReportSchema }),
  z.strictObject({ id: identity, kind: z.literal('EVENT'), effectiveTick: tickNoSchema, publishTick: tickNoSchema, disclosure: eventDisclosureSchema }),
]);

/** Strict shape: a private EconomyState or a hidden field is rejected, including nested fields. */
export const publicEconomySchema = z.strictObject({
  schemaVersion: z.literal(1), marketId: marketIdSchema, tickNo: tickNoSchema,
  observedMacro: publicMacroSchema, macroObservedTick: tickNoSchema, policyExpectation: policyExpectationSchema,
  companies: z.array(companySchema).length(8), publications: z.array(publicationCandidateSchema).max(256),
  corporateActions: z.array(publicCorporateActionSchema).max(1024).default([]),
  eventDisclosures: z.array(eventDisclosureSchema).max(100000).default([]),
}).superRefine((state, context) => {
  const issuerKeys = new Set<string>(); const listingKeys = new Set<string>(); const slots = new Set<string>();
  if (state.macroObservedTick > state.tickNo || state.observedMacro.regimeSinceTick > state.tickNo) context.addIssue({ code: 'custom', message: 'Future macro information' });
  for (const company of state.companies) {
    if (issuerKeys.has(company.issuerId) || listingKeys.has(company.listingId) || slots.has(company.slotId)) context.addIssue({ code: 'custom', message: 'Duplicate public company identity' });
    issuerKeys.add(company.issuerId); listingKeys.add(company.listingId); slots.add(company.slotId);
    if (company.latestReport.publishTick > state.tickNo || company.reports.some((report) => report.publishTick > state.tickNo)) context.addIssue({ code: 'custom', message: 'Future report cannot be public' });
    if (JSON.stringify(company.latestReport) !== JSON.stringify(company.reports.at(-1))) context.addIssue({ code: 'custom', message: 'Latest report does not match report history' });
    const category = company.slotId.startsWith('O') ? 'ORDINARY' : company.slotId.startsWith('G') ? 'GROWTH' : company.slotId.startsWith('T') ? 'THEMATIC' : 'DIVIDEND';
    if (category !== company.category) context.addIssue({ code: 'custom', message: 'Slot category mismatch' });
    if (company.symbol !== (company.generation === 1 ? company.baseSymbol : `${company.baseSymbol}${company.generation}`)
      || company.createdTick > state.tickNo || company.dividends.some((dividend) => dividend.issuerId !== company.issuerId
        || dividend.listingId !== company.listingId || dividend.declaredTick > state.tickNo)
      || new Set(company.dividends.map((dividend) => dividend.id)).size !== company.dividends.length) context.addIssue({ code: 'custom', message: 'Invalid public corporate state' });
  }
  const actionIds = new Set<string>();
  for (const action of state.corporateActions) {
    if (action.effectiveTick > state.tickNo || actionIds.has(action.id)) context.addIssue({ code: 'custom', message: 'Invalid public corporate action time or identity' });
    actionIds.add(action.id);
  }
  const ids = new Set<string>();
  const eventIds = new Set<string>();
  for (const event of state.eventDisclosures) {
    if (event.publishTick > state.tickNo || event.effectiveTick > event.publishTick || eventIds.has(event.id)) context.addIssue({ code: 'custom', message: 'Future/duplicate public event' });
    eventIds.add(event.id);
  }
  for (const publication of state.publications) {
    if (publication.publishTick > state.tickNo || publication.effectiveTick > publication.publishTick || ids.has(publication.id)) context.addIssue({ code: 'custom', message: 'Invalid public publication time or identity' });
    ids.add(publication.id);
  }
});
declare const publicEconomyBrand: unique symbol;
export type PublicEconomy = Readonly<PublicEconomyState> & { readonly [publicEconomyBrand]: true };

export interface PublicDisclosureRecord {
  readonly id: string; readonly kind: 'MACRO' | 'EARNINGS' | 'CORPORATE_ACTION' | 'EVENT'; readonly issuerId: string | null;
  readonly effectiveTick: number; readonly publishedTick: number;
  readonly actual: Readonly<Record<string, string>>; readonly expected: Readonly<Record<string, string>>;
  readonly previous: Readonly<Record<string, string>>;
  readonly event?: EventDisclosure;
}

export function validatePublicEconomy(value: unknown): PublicEconomy {
  return publicEconomySchema.parse(value) as unknown as PublicEconomy;
}
const offset = (companySymbol: string) => ['HGI', 'DNL'].includes(companySymbol) ? 1 : ['TLR', 'RVI'].includes(companySymbol) ? 2 : ['NXC', 'VTR'].includes(companySymbol) ? 3 : 4;
const a = (points: string) => moneyToAtoms(parseMoney(points));
const clamp = (value: DecimalValue, minimum: string, maximum: string) => D.max(minimum, D.min(maximum, value));
const atomRound = (value: DecimalValue) => moneyFromAtoms(value.toDecimalPlaces(0, D.ROUND_HALF_EVEN).toFixed(0)).toString();

export function createPublicEconomy(fixtures: readonly InitialCompany[], tickNo = 0, marketId = 'initial_market'): PublicEconomy {
  tickNoSchema.parse(tickNo);
  const companies = fixtures.map((fixture) => {
    const initialPublicReports = INITIAL_PUBLIC_REPORTS[fixture.symbol as EconomicSymbol];
    if (!initialPublicReports || initialPublicReports.length !== 4) throw new Error('UNKNOWN_INITIAL_PUBLIC_REPORTS');
    const reports = fixture.syntheticHistory.map((quarter, index): FinancialReport => ({
      kind: 'SYNTHETIC_INITIALIZATION', quarterNo: index - 4, closedTick: tickNo, publishTick: tickNo,
      revenueAtoms: a(quarter.revenue), operatingProfitAtoms: a(quarter.operatingProfit),
      interestExpenseAtoms: a(quarter.interestExpense), pretaxProfitAtoms: a(quarter.pretaxProfit),
      corporateTaxAtoms: a(quarter.corporateTax), netProfitAtoms: a(quarter.netProfit),
      operatingCashFlowAtoms: initialPublicReports[index]!.operatingCashFlowAtoms,
      capexAtoms: initialPublicReports[index]!.capexAtoms, depreciationAtoms: initialPublicReports[index]!.depreciationAtoms, debtIssuedAtoms: '0', debtRepaidAtoms: '0',
      cashAtoms: a(fixture.cash), debtAtoms: a(fixture.interestBearingDebt), assetsAtoms: a(fixture.totalAssets),
      liabilitiesAtoms: a(fixture.totalLiabilities), equityAtoms: a(fixture.totalEquity),
      receivablesAtoms: a(fixture.balanceSheet.assets.find((account) => account.code === 'trade_receivables')?.amount ?? '0'),
      payablesAtoms: a(fixture.balanceSheet.liabilities.find((account) => account.code === 'trade_payables')?.amount ?? '0'),
      issuedShares: fixture.issuedShares, dividendPayableAtoms: '0', oneOffProfitAtoms: '0', foreignExchangeProfitAtoms: '0',
      operatingAssetsAtoms: fixture.balanceSheet.assets.filter((account) => ['property_plant_equipment', 'intangible_assets'].includes(account.code)).reduce((total, account) => total + BigInt(a(account.amount)), 0n).toString(),
    }));
    const latestReport = reports.at(-1)!;
    return {
      issuerId: fixture.issuerId, listingId: fixture.listingId, slotId: fixture.slotId, category: fixture.category,
      symbol: fixture.symbol, baseSymbol: fixture.symbol as EconomicSymbol, generation: 1, createdTick: tickNo, lifecycle: 'OPERATING' as const,
      dividends: [], corporateCashAdjustmentAtoms: '0', corporateDebtAdjustmentAtoms: '0',
      name: fixture.name, issuedShares: fixture.issuedShares, reports, latestReport,
      nextEarningsTick: tickNo + 63 + offset(fixture.symbol),
      forecast: { annualRevenueGrowth: fixture.nominalRevenueGrowth ?? '0', operatingMargin: fixture.operatingMargin,
        expectedQuarterRevenueAtoms: atomRound(new D(latestReport.revenueAtoms).mul(new D(1).plus(fixture.nominalRevenueGrowth ?? '0').pow('0.25'))),
        targetPayoutRatio: fixture.targetPayoutRatio, successProbability: fixture.category === 'THEMATIC' ? '0.22' : fixture.category === 'GROWTH' ? '0.45' : '0.6',
        fundingFailureProbability: fixture.category === 'THEMATIC' ? '0.18' : fixture.category === 'GROWTH' ? '0.2' : '0.05' },
      debtTerms: fixture.debtTranches.flatMap((tranche) => [
        { rateType: 'FIXED', principalAtoms: a(tranche.fixedPrincipal), annualEffectiveRate: tranche.initialAnnualEffectiveRate,
          spread: tranche.initialVariableSpread, maturityTick: tickNo + tranche.maturityTick, nextResetTick: tickNo + tranche.maturityTick },
        { rateType: 'VARIABLE', principalAtoms: a(tranche.variablePrincipal), annualEffectiveRate: tranche.initialAnnualEffectiveRate,
          spread: tranche.initialVariableSpread, maturityTick: tickNo + tranche.maturityTick, nextResetTick: tickNo + 21 },
      ]),
    };
  });
  return validatePublicEconomy({ schemaVersion: 1, marketId, tickNo,
    observedMacro: { policyRate: '0.03', inflation: '0.02', outputGap: '0', industrialDemand: '100', consumerDemand: '100', metals: '100', energy: '100', fx: '100', creditStress: '0.2', riskAppetite: '0', regime: 'EXPANSION', regimeSinceTick: tickNo },
    macroObservedTick: tickNo, policyExpectation: { meetingTick: tickNo + 21, decreaseProbability: '0.2', unchangedProbability: '0.6', increaseProbability: '0.2', expectedRate: '0.03' }, companies, publications: [] });
}

/** Candidates are already sealed disclosure copies; non-public private state is never accepted. */
export function publishEconomy(priorInput: PublicEconomy, candidatesInput: readonly EconomyPublication[], tickNo: number, actionsInput: readonly CorporateAction[] = []): Readonly<{ state: PublicEconomy; publications: readonly PublicDisclosureRecord[] }> {
  const prior = validatePublicEconomy(priorInput);
  tickNoSchema.parse(tickNo);
  if (tickNo < prior.tickNo) throw new Error('PUBLIC_TIME_REGRESSION');
  const candidates = z.array(publicationCandidateSchema).max(64).parse(candidatesInput);
  let state = structuredClone(prior) as unknown as PublicEconomyState;
  const disclosures: PublicDisclosureRecord[] = [];
  const known = new Set(prior.publications.map((publication) => publication.id));
  for (const candidate of candidates.toSorted((left, right) => left.publishTick - right.publishTick || left.id.localeCompare(right.id))) {
    if (candidate.effectiveTick > candidate.publishTick) throw new Error('PUBLICATION_TIME_INVALID');
    if (candidate.publishTick > tickNo || known.has(candidate.id)) continue;
    if (candidate.publishTick <= prior.tickNo) throw new Error('LATE_PUBLICATION');
    if (candidate.kind === 'MACRO') {
      disclosures.push({ id: candidate.id, kind: 'MACRO', issuerId: null, effectiveTick: candidate.effectiveTick, publishedTick: candidate.publishTick,
        actual: { policyRate: candidate.macro.policyRate, inflation: candidate.macro.inflation, outputGap: candidate.macro.outputGap, industrialDemand: candidate.macro.industrialDemand, consumerDemand: candidate.macro.consumerDemand, metals: candidate.macro.metals, energy: candidate.macro.energy, fx: candidate.macro.fx, creditStress: candidate.macro.creditStress, riskAppetite: candidate.macro.riskAppetite },
        expected: { policyRate: prior.policyExpectation.expectedRate, inflation: prior.observedMacro.inflation, outputGap: prior.observedMacro.outputGap, industrialDemand: prior.observedMacro.industrialDemand, consumerDemand: prior.observedMacro.consumerDemand, metals: prior.observedMacro.metals, energy: prior.observedMacro.energy, fx: prior.observedMacro.fx, creditStress: prior.observedMacro.creditStress, riskAppetite: prior.observedMacro.riskAppetite },
        previous: { policyRate: prior.observedMacro.policyRate, inflation: prior.observedMacro.inflation, outputGap: prior.observedMacro.outputGap, industrialDemand: prior.observedMacro.industrialDemand, consumerDemand: prior.observedMacro.consumerDemand, metals: prior.observedMacro.metals, energy: prior.observedMacro.energy, fx: prior.observedMacro.fx, creditStress: prior.observedMacro.creditStress, riskAppetite: prior.observedMacro.riskAppetite } });
      state = { ...state, observedMacro: candidate.macro, macroObservedTick: candidate.publishTick, policyExpectation: candidate.expectation,
        companies: state.companies.map((company) => ({ ...company, debtTerms: company.debtTerms.map((term) => term.rateType === 'VARIABLE' && term.nextResetTick <= tickNo
          ? { ...term, annualEffectiveRate: new D(candidate.macro.policyRate).plus(term.spread).toString(), nextResetTick: tickNo + 21 } : term) })) };
    } else if (candidate.kind === 'EVENT') {
      let event: EventDisclosure = candidate.disclosure;
      if (event.id !== candidate.id || event.effectiveTick !== candidate.effectiveTick || event.publishTick !== candidate.publishTick) throw new Error('EVENT_PUBLICATION_IDENTITY_MISMATCH');
      const domain = disclosures.find(disclosure => disclosure.id === event.causeId && disclosure.kind !== 'EVENT');
      if (domain) event = { ...event, actual: { ...event.actual, ...domain.actual }, expected: { ...event.expected, ...domain.expected }, previous: { ...event.previous, ...domain.previous } };
      disclosures.push({ id: event.id, kind: 'EVENT', issuerId: event.issuerIds.length === 1 ? event.issuerIds[0]! : null, effectiveTick: event.effectiveTick, publishedTick: event.publishTick, actual: event.actual, expected: event.expected, previous: event.previous, event });
      state = { ...state, eventDisclosures: [...state.eventDisclosures, event] };
      if (event.profile === 'MACRO') {
        const updates: Record<string, string> = {};
        for (const key of ['policyRate', 'inflation', 'outputGap', 'industrialDemand', 'consumerDemand', 'metals', 'energy', 'fx', 'creditStress', 'riskAppetite']) if (event.actual[key] !== undefined) updates[key] = decimal.parse(event.actual[key]);
        state = { ...state, observedMacro: publicMacroSchema.parse({ ...state.observedMacro, ...updates }) };
      }
      state = { ...state, companies: state.companies.map(company => ({ ...company,
        corporateCashAdjustmentAtoms: (BigInt(cashAdjustmentAfter(state.corporateActions, company.issuerId, company.latestReport.closedTick)) + eventCashAdjustment(state.eventDisclosures, company.issuerId, company.latestReport.closedTick)).toString(),
        corporateDebtAdjustmentAtoms: eventDebtAdjustment(state.eventDisclosures, company.issuerId, company.latestReport.closedTick).toString(),
        corporateLiabilityAdjustmentAtoms: eventLiabilityAdjustment(state.eventDisclosures, company.issuerId, company.latestReport.closedTick).toString(),
      })) };
    } else {
      const company = state.companies.find((value) => value.issuerId === candidate.issuerId && value.baseSymbol === candidate.symbol);
      if (!company || candidate.report.publishTick !== candidate.publishTick || candidate.report.closedTick !== candidate.effectiveTick
        || candidate.publishTick !== candidate.effectiveTick + offset(candidate.symbol)) throw new Error('REPORT_IDENTITY_OR_TIME_MISMATCH');
      if (candidate.report.quarterNo <= company.latestReport.quarterNo) throw new Error('REPORT_PERIOD_REGRESSION');
      const expectedRevenue = company.forecast.expectedQuarterRevenueAtoms;
      const surprise = new D(expectedRevenue).isZero() ? new D(0) : new D(candidate.report.revenueAtoms).minus(expectedRevenue).div(expectedRevenue);
      const actualMargin = BigInt(candidate.report.revenueAtoms) === 0n ? new D(0) : new D(candidate.report.operatingProfitAtoms).div(candidate.report.revenueAtoms);
      const recurringMargin = BigInt(candidate.report.revenueAtoms) === 0n ? new D(0)
        : new D(candidate.report.operatingProfitAtoms).minus(candidate.report.oneOffProfitAtoms).div(candidate.report.revenueAtoms);
      const growth = clamp(new D(company.forecast.annualRevenueGrowth).plus(clamp(surprise, '-0.5', '0.5').mul('0.35')), '-0.5', '0.6');
      const margin = clamp(recurringMargin.mul('0.7').plus(new D(company.forecast.operatingMargin).mul('0.3')), '-5', '0.6');
      const quarterlyBurn = D.max(0, new D(candidate.report.operatingCashFlowAtoms).minus(candidate.report.capexAtoms).negated());
      const runway = quarterlyBurn.isZero() ? new D(20) : new D(candidate.report.cashAtoms).div(quarterlyBurn);
      const fundingRisk = clamp(new D(company.forecast.fundingFailureProbability).mul('0.85')
        .plus(clamp(new D('0.45').minus(runway.mul('0.04')), '0.02', '0.45').mul('0.15')), '0.02', '0.65');
      const successProbability = clamp(new D(company.forecast.successProbability).plus(clamp(surprise, '-0.5', '0.5').mul('0.08')), '0.02', new D(1).minus(fundingRisk).toString());
      disclosures.push({ id: candidate.id, kind: 'EARNINGS', issuerId: company.issuerId, effectiveTick: candidate.effectiveTick, publishedTick: candidate.publishTick,
        actual: { revenueAtoms: candidate.report.revenueAtoms, operatingMargin: actualMargin.toString(), recurringOperatingMargin: recurringMargin.toString(), netProfitAtoms: candidate.report.netProfitAtoms },
        expected: { revenueAtoms: expectedRevenue, operatingMargin: company.forecast.operatingMargin },
        previous: { revenueAtoms: company.latestReport.revenueAtoms, operatingMargin: new D(company.latestReport.operatingProfitAtoms).div(D.max(1, company.latestReport.revenueAtoms)).toString(), netProfitAtoms: company.latestReport.netProfitAtoms } });
      state = { ...state, companies: state.companies.map((value) => value.issuerId !== company.issuerId ? value : {
        ...value, issuedShares: state.corporateActions.filter((action) => action.kind === 'FINANCING' && action.issuerId === value.issuerId
          && action.effectiveTick > candidate.report.closedTick).reduce((shares, action) => action.kind === 'FINANCING' ? action.issuedSharesAfter : shares, candidate.report.issuedShares),
        reports: [...value.reports, candidate.report].slice(-8), latestReport: candidate.report,
        corporateCashAdjustmentAtoms: (BigInt(cashAdjustmentAfter(state.corporateActions, value.issuerId, candidate.report.closedTick)) + eventCashAdjustment(state.eventDisclosures, value.issuerId, candidate.report.closedTick)).toString(),
        corporateDebtAdjustmentAtoms: eventDebtAdjustment(state.eventDisclosures, value.issuerId, candidate.report.closedTick).toString(),
        corporateLiabilityAdjustmentAtoms: eventLiabilityAdjustment(state.eventDisclosures, value.issuerId, candidate.report.closedTick).toString(),
        nextEarningsTick: candidate.report.closedTick + 63 + offset(value.baseSymbol), forecast: { ...value.forecast, annualRevenueGrowth: growth.toString(), operatingMargin: margin.toString(),
          successProbability: successProbability.toString(), fundingFailureProbability: fundingRisk.toString(),
          expectedQuarterRevenueAtoms: atomRound(new D(candidate.report.revenueAtoms).mul(new D(1).plus(growth).pow('0.25'))) },
      }) };
    }
    known.add(candidate.id);
    state = { ...state, publications: [...state.publications, candidate as EconomyPublication].slice(-256) };
  }
  const actions = z.array(publicCorporateActionSchema).max(256).parse(actionsInput) as CorporateAction[];
  const knownActions = new Set(state.corporateActions.map((action) => action.id));
  for (const action of actions.toSorted((left, right) => left.effectiveTick - right.effectiveTick)) {
    if (action.effectiveTick > tickNo || knownActions.has(action.id)) continue;
    if (action.effectiveTick <= prior.tickNo) throw new Error('LATE_CORPORATE_ACTION');
    const company = state.companies.find((company) => company.issuerId === action.issuerId && company.listingId === action.listingId && company.symbol === action.symbol);
    const retiredIdentity = state.corporateActions.some((priorAction) => priorAction.kind === 'REPLACEMENT'
      && priorAction.issuerId === action.issuerId && priorAction.listingId === action.listingId && priorAction.symbol === action.symbol);
    if (!company && !retiredIdentity) throw new Error('CORPORATE_ACTION_IDENTITY_MISMATCH');
    const actual: Record<string, string> = { actionKind: action.kind, symbol: action.symbol };
    if ('dividend' in action) Object.assign(actual, { dividendId: action.dividend.id, dps: action.dividend.dps,
      exTick: String(action.dividend.exTick), payTick: String(action.dividend.payTick), recoveryRatio: action.dividend.recoveryRatio, paidAtoms: action.dividend.paidAtoms });
    if (action.kind === 'FINANCING') Object.assign(actual, { raisedAtoms: action.raisedAtoms, issuedSharesAfter: action.issuedSharesAfter });
    if (action.kind === 'LIFECYCLE_CHANGED') actual.lifecycle = action.lifecycle;
    if (action.kind === 'LIQUIDATION_STARTED') Object.assign(actual, { liquidationId: action.liquidationId, estimatedRecoveryPerShare: action.estimatedRecoveryPerShare,
      dividendRecoveryRatio: action.dividendRecoveryRatio, settlementTick: String(action.settlementTick) });
    if (action.kind === 'LIQUIDATION_SETTLED') Object.assign(actual, { liquidationId: action.liquidationId, realizedRecoveryPerShare: action.realizedRecoveryPerShare,
      commonPaidAtoms: action.commonPaidAtoms, eligibleShares: action.eligibleShares });
    if (action.kind === 'REPLACEMENT') Object.assign(actual, { newSymbol: action.newSymbol, newName: action.newName, generation: String(action.generation) });
    disclosures.push({ id: action.id, kind: 'CORPORATE_ACTION', issuerId: action.issuerId, effectiveTick: action.effectiveTick, publishedTick: action.effectiveTick,
      actual, expected: {}, previous: {} });
    const history = [...state.corporateActions, action].slice(-1024);
    if (company) {
      if (action.kind === 'REPLACEMENT') {
        const fixture = INITIAL_COMPANIES.find((fixture) => fixture.symbol === action.baseSymbol);
        if (!fixture || fixture.slotId !== company.slotId || company.lifecycle !== 'LIQUIDATING' || action.generation !== company.generation + 1
          || state.companies.some((company) => company.issuerId === action.newIssuerId || company.listingId === action.newListingId)) throw new Error('REPLACEMENT_TEMPLATE_MISMATCH');
        const fresh = createPublicEconomy(INITIAL_COMPANIES, action.createdTick, state.marketId).companies.find((company) => company.baseSymbol === action.baseSymbol)!;
        const reports = fresh.reports.map((report) => ({ ...report, issuedShares: action.issuedShares }));
        const replacement = { ...fresh, issuerId: action.newIssuerId, listingId: action.newListingId, symbol: action.newSymbol,
          name: action.newName, generation: action.generation, issuedShares: action.issuedShares, reports, latestReport: reports.at(-1)!,
          nextEarningsTick: (Math.floor(action.createdTick / 63) + 1) * 63 + offset(action.baseSymbol) };
        state = { ...state, companies: state.companies.map((value) => value.issuerId === company.issuerId ? replacement : value) };
      } else {
        let changed = company;
        if ('dividend' in action) {
          const existing = company.dividends.find((dividend) => dividend.id === action.dividend.id);
          if (action.kind !== 'DIVIDEND_DECLARED' && !existing) throw new Error('UNKNOWN_PUBLIC_DIVIDEND');
          if (existing && (existing.totalNominalAtoms !== action.dividend.totalNominalAtoms || existing.dps !== action.dividend.dps
            || existing.issuedShares !== action.dividend.issuedShares || existing.exTick !== action.dividend.exTick || existing.payTick !== action.dividend.payTick)) throw new Error('DIVIDEND_NOMINAL_CONTRACT_CHANGED');
          changed = { ...changed, dividends: [...company.dividends.filter((dividend) => dividend.id !== action.dividend.id), action.dividend].slice(-256) };
        }
        if (action.kind === 'FINANCING') {
          if (company.issuedShares !== action.issuedSharesBefore) throw new Error('FINANCING_PUBLIC_SHARE_MISMATCH');
          changed = { ...changed, issuedShares: action.issuedSharesAfter };
        }
        if (action.kind === 'LIFECYCLE_CHANGED') {
          if (company.lifecycle !== action.previousLifecycle) throw new Error('PUBLIC_LIFECYCLE_MISMATCH');
          changed = { ...changed, lifecycle: action.lifecycle };
        }
        if (action.kind === 'LIQUIDATION_STARTED') changed = { ...changed, lifecycle: 'LIQUIDATING', dividends: changed.dividends.map((dividend) =>
          BigInt(dividend.remainingPayableAtoms) > 0n ? { ...dividend, status: 'IMPAIRED' as const,
            recoveryRatio: new D(dividend.paidAtoms).plus(new D(dividend.remainingPayableAtoms).mul(action.dividendRecoveryRatio)).div(dividend.totalNominalAtoms).toString() } : dividend) };
        changed = { ...changed, corporateCashAdjustmentAtoms: (BigInt(cashAdjustmentAfter(history, company.issuerId, company.latestReport.closedTick)) + eventCashAdjustment(state.eventDisclosures, company.issuerId, company.latestReport.closedTick)).toString() };
        state = { ...state, companies: state.companies.map((value) => value.issuerId === company.issuerId ? changed : value) };
      }
    }
    state = { ...state, corporateActions: history };
    knownActions.add(action.id);
  }
  return Object.freeze({ state: validatePublicEconomy({ ...state, tickNo }), publications: Object.freeze(disclosures) });
}
function eventCashAdjustment(events: readonly EventDisclosure[], issuerId: string, closedTick: number): bigint {
  return events.filter(event => event.effectiveTick > closedTick && (event.actual[`cashDelta_${issuerId}`] !== undefined || event.issuerIds[0] === issuerId && event.actual.cashDeltaAtoms !== undefined)).reduce((sum, event) => sum + moneyFromAtoms(event.actual[`cashDelta_${issuerId}`] ?? event.actual.cashDeltaAtoms!), 0n);
}
function eventDebtAdjustment(events: readonly EventDisclosure[], issuerId: string, closedTick: number): bigint {
  return events.filter(event => event.effectiveTick > closedTick && (event.actual[`debtDelta_${issuerId}`] !== undefined || event.issuerIds[0] === issuerId && event.actual.debtDeltaAtoms !== undefined)).reduce((sum, event) => sum + moneyFromAtoms(event.actual[`debtDelta_${issuerId}`] ?? event.actual.debtDeltaAtoms!), 0n);
}
function eventLiabilityAdjustment(events: readonly EventDisclosure[], issuerId: string, closedTick: number): bigint {
  return events.filter(event => event.effectiveTick > closedTick && event.actual[`liabilityDelta_${issuerId}`] !== undefined).reduce((sum, event) => sum + moneyFromAtoms(event.actual[`liabilityDelta_${issuerId}`]!), 0n);
}

/** Disclosed financing/payments after the report close, not private daily cash. */
function cashAdjustmentAfter(actions: readonly CorporateAction[], issuerId: string, closedTick: number): string {
  let delta = 0n;
  const paid = new Map<string, bigint>();
  for (const action of actions) {
    if (action.issuerId !== issuerId) continue;
    if (action.kind === 'FINANCING' && action.effectiveTick > closedTick) delta += BigInt(action.raisedAtoms);
    if (action.kind === 'DIVIDEND_PAYMENT') {
      const previous = paid.get(action.dividend.id) ?? 0n;
      const next = BigInt(action.dividend.paidAtoms);
      if (next < previous) throw new Error('PUBLIC_DIVIDEND_PAYMENT_REGRESSION');
      if (action.effectiveTick > closedTick) delta -= next - previous;
      paid.set(action.dividend.id, next);
    }
  }
  return moneyFromAtoms(delta.toString()).toString();
}

