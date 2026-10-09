import type { InitialCompanyCategory, InitialSlotId } from '../fixtures/initial-companies.js';
import type { RandomContext } from '../domain/random.js';
import type { EventRuntimeState, EventDisclosure } from '../events/types.js';

/** All monetary state is canonical 1e-12-point integer text, never a JS number. */
export type Atoms = string;
export type EconomicSymbol = 'HGI' | 'DNL' | 'TLR' | 'NXC' | 'VTR' | 'AUR' | 'LMB' | 'RVI';
export type Regime = 'EXPANSION' | 'SLOWDOWN' | 'RECESSION' | 'RECOVERY' | 'SUPPLY_SHOCK';
export type CorporateLifecycle = 'OPERATING' | 'WATCH' | 'DISTRESSED' | 'RESTRUCTURING' | 'LIQUIDATING' | 'EXTINGUISHED';
export interface EconomyRandom { uniform(context: RandomContext): string }
export interface MacroState {
  readonly policyRate: string;
  readonly inflation: string;
  readonly outputGap: string;
  readonly industrialDemand: string;
  readonly consumerDemand: string;
  readonly metals: string;
  readonly energy: string;
  readonly fx: string;
  readonly creditStress: string;
  readonly riskAppetite: string;
  readonly regime: Regime;
  readonly regimeSinceTick: number;
}
export interface PolicyExpectation {
  readonly meetingTick: number;
  readonly decreaseProbability: string;
  readonly unchangedProbability: string;
  readonly increaseProbability: string;
  readonly expectedRate: string;
}
export type CorporateAccount = 'cash' | 'receivables' | 'inventory' | 'operating_assets' | 'intangible_assets'
  | 'construction_in_progress' | 'trade_payables' | 'debt' | 'interest_payable' | 'tax_payable'
  | 'dividend_payable' | 'contract_liability' | 'paid_in_capital' | 'retained_earnings';
export type AccountBalances = Readonly<Record<CorporateAccount, Atoms>>;
export interface CorporateJournalLine { readonly account: CorporateAccount; readonly side: 'DR' | 'CR'; readonly amountAtoms: Atoms }
export interface CorporateJournalEntry {
  readonly entryId: string; readonly causeId: string; readonly marketId: string; readonly issuerId: string;
  readonly tickNo: number; readonly kind: string; readonly contractId: string | null;
  readonly lines: readonly CorporateJournalLine[];
}
export interface WorkingCapitalItem {
  readonly id: string; readonly causeId: string; readonly contractId: string | null;
  readonly counterparty: EconomicSymbol | 'EXTERNAL'; readonly amountAtoms: Atoms;
  readonly dueTick: number; readonly kind: 'AR' | 'AP'; readonly overdueSinceTick: number | null;
  readonly counterpartyIssuerId: string | null;
  readonly fxAtOrigination?: string | null; readonly foreignExposure?: string;
}
export interface DebtContract {
  readonly id: string; readonly rateType: 'FIXED' | 'VARIABLE'; readonly principalAtoms: Atoms;
  readonly annualEffectiveRate: string; readonly spread: string; readonly maturityTick: number;
  readonly nextResetTick: number; readonly nextInterestPaymentTick: number;
  readonly accruedInterestAtoms: Atoms; readonly interestCarry: { readonly numerator: string; readonly denominator: string };
}
export interface InvestmentProject {
  readonly id: string; readonly causeId: string; readonly contractId: string | null;
  readonly amountAtoms: Atoms; readonly startedTick: number; readonly completionTick: number;
  readonly status: 'PLANNED' | 'IN_PROGRESS' | 'OPERATING' | 'CANCELLED'; readonly usefulLifeTicks: number;
  readonly depreciatedAtoms: Atoms; readonly productivityEffect: string;
  readonly assetAccount?: 'operating_assets' | 'intangible_assets';
}
export interface QuarterTotals {
  readonly revenueAtoms: Atoms; readonly rawMaterialsAtoms: Atoms; readonly energyAtoms: Atoms;
  readonly laborAtoms: Atoms; readonly serviceAtoms: Atoms; readonly researchAtoms: Atoms;
  readonly depreciationAtoms: Atoms; readonly interestAtoms: Atoms; readonly taxAtoms: Atoms;
  readonly operatingCashFlowAtoms: Atoms; readonly capexAtoms: Atoms;
  readonly debtRepaidAtoms: Atoms; readonly debtIssuedAtoms: Atoms;
  readonly oneOffProfitAtoms: Atoms;
  readonly foreignExchangeProfitAtoms: Atoms;
}
export interface FinancialReport {
  readonly kind: 'SYNTHETIC_INITIALIZATION' | 'ACTUAL'; readonly quarterNo: number;
  readonly closedTick: number; readonly publishTick: number;
  readonly revenueAtoms: Atoms; readonly operatingProfitAtoms: Atoms;
  readonly interestExpenseAtoms: Atoms; readonly pretaxProfitAtoms: Atoms;
  readonly corporateTaxAtoms: Atoms; readonly netProfitAtoms: Atoms;
  readonly depreciationAtoms: Atoms;
  readonly operatingCashFlowAtoms: Atoms; readonly capexAtoms: Atoms;
  readonly debtIssuedAtoms: Atoms; readonly debtRepaidAtoms: Atoms;
  readonly cashAtoms: Atoms; readonly debtAtoms: Atoms; readonly assetsAtoms: Atoms;
  readonly liabilitiesAtoms: Atoms; readonly equityAtoms: Atoms;
  readonly receivablesAtoms: Atoms; readonly payablesAtoms: Atoms;
  readonly issuedShares: string; readonly operatingAssetsAtoms: Atoms;
  readonly dividendPayableAtoms: Atoms;
  readonly oneOffProfitAtoms: Atoms;
  readonly foreignExchangeProfitAtoms: Atoms;
}
export interface CompanyTrueState {
  readonly issuerId: string; readonly listingId: string; readonly slotId: InitialSlotId;
  readonly category: InitialCompanyCategory; readonly symbol: EconomicSymbol; readonly name: string;
  readonly issuedShares: string; readonly status: 'NORMAL' | 'STRESSED';
  readonly generation: number; readonly createdTick: number; readonly lifecycle: CorporateLifecycle;
  readonly lifecycleSinceTick: number; readonly dividendBan: boolean; readonly financingAttempts: number;
  readonly eventEquityIssues: number;
  readonly reservedDividendAtoms: Atoms; readonly dividends: readonly CorporateDividend[];
  readonly liquidation: LiquidationPlan | null;
  readonly balances: AccountBalances; readonly debtContracts: readonly DebtContract[];
  readonly workingCapital: readonly WorkingCapitalItem[]; readonly investments: readonly InvestmentProject[];
  readonly currentQuarter: QuarterTotals; readonly sealedQuarters: readonly FinancialReport[];
  readonly unitPrice: string; readonly unitPriceBasis: string; readonly volume: string; readonly capacity: string;
  readonly productivity: string; readonly customerBase: string;
}
export interface IntercompanyContract {
  readonly contractId: string; readonly supplier: EconomicSymbol; readonly customer: EconomicSymbol;
  readonly kind: 'RAW_MATERIALS' | 'SERVICE' | 'CAPEX'; readonly costBucket: 'rawMaterials' | 'service' | 'capex';
  readonly exposure: string; readonly settlementLagTicks: number;
}
/** Private state is never a valid input to value/price/public API rendering. */
export interface EconomyState {
  readonly schemaVersion: 1; readonly marketId: string; readonly tickNo: number;
  readonly macro: MacroState; readonly companies: readonly CompanyTrueState[];
  readonly lastPublishedMacro: MacroState; readonly macroPublishedTick: number;
  readonly contracts: readonly IntercompanyContract[];
  readonly retiredCompanies: readonly CompanyTrueState[];
  readonly events: EventRuntimeState;
}
export interface CorporateDividend {
  readonly id: string; readonly issuerId: string; readonly listingId: string;
  readonly declaredTick: number; readonly exTick: number; readonly payTick: number;
  readonly status: 'DECLARED' | 'EX_ENTITLED' | 'PAID' | 'IMPAIRED' | 'SETTLED';
  readonly issuedShares: string; readonly totalNominalAtoms: Atoms; readonly dps: string;
  readonly remainingPayableAtoms: Atoms; readonly recoveryRatio: string; readonly paidAtoms: Atoms;
}
export interface LiquidationPlan {
  readonly id: string; readonly enteredTick: number; readonly settlementTick: number;
  readonly estimatedRealizedAssetsAtoms: Atoms; readonly liquidationCostAtoms: Atoms;
  readonly estimatedRecoveryPerShare: string; readonly realizedRecoveryPerShare: string | null;
}
interface ActionIdentity {
  readonly id: string; readonly effectiveTick: number; readonly issuerId: string;
  readonly listingId: string; readonly symbol: string;
}
export type CorporateAction =
  | (ActionIdentity & { readonly kind: 'DIVIDEND_DECLARED' | 'DIVIDEND_EX' | 'DIVIDEND_PAYMENT' | 'DIVIDEND_IMPAIRED'; readonly dividend: CorporateDividend })
  | (ActionIdentity & { readonly kind: 'FINANCING'; readonly raisedAtoms: Atoms; readonly issuedSharesBefore: string; readonly issuedSharesAfter: string })
  | (ActionIdentity & { readonly kind: 'LIFECYCLE_CHANGED'; readonly previousLifecycle: CorporateLifecycle; readonly lifecycle: CorporateLifecycle })
  | (ActionIdentity & { readonly kind: 'LIQUIDATION_STARTED'; readonly liquidationId: string; readonly settlementTick: number; readonly estimatedRecoveryPerShare: string; readonly dividendRecoveryRatio: string })
  | (ActionIdentity & { readonly kind: 'LIQUIDATION_SETTLED'; readonly liquidationId: string; readonly realizedRecoveryPerShare: string; readonly commonPaidAtoms: Atoms; readonly eligibleShares: string; readonly dividendRecoveries: readonly { readonly dividendId: string; readonly recoveryRatio: string; readonly paidAtoms: Atoms }[] })
  | (ActionIdentity & { readonly kind: 'REPLACEMENT'; readonly baseSymbol: EconomicSymbol; readonly generation: number; readonly createdTick: number; readonly newIssuerId: string; readonly newListingId: string; readonly newSymbol: string; readonly newName: string; readonly issuedShares: string });
export type EconomyPublication =
  | { readonly id: string; readonly kind: 'MACRO'; readonly effectiveTick: number; readonly publishTick: number;
      readonly macro: MacroState; readonly expectation: PolicyExpectation; readonly previousPolicyRate: string }
  | { readonly id: string; readonly kind: 'EARNINGS'; readonly effectiveTick: number; readonly publishTick: number;
      readonly issuerId: string; readonly symbol: EconomicSymbol; readonly report: FinancialReport }
  | { readonly id: string; readonly kind: 'EVENT'; readonly effectiveTick: number; readonly publishTick: number; readonly disclosure: EventDisclosure };
export interface EconomyAdvanceResult {
  readonly state: EconomyState; readonly corporateEntries: readonly CorporateJournalEntry[];
  readonly publications: readonly EconomyPublication[]; readonly policyExpectation: PolicyExpectation;
  readonly actions: readonly CorporateAction[];
}
/** A sealed disclosure is copied into this independently stored public domain. */
export interface PublicCompanyState {
  readonly issuerId: string; readonly listingId: string; readonly slotId: InitialSlotId;
  readonly category: InitialCompanyCategory; readonly symbol: string; readonly baseSymbol: EconomicSymbol; readonly name: string;
  readonly generation: number; readonly createdTick: number; readonly lifecycle: CorporateLifecycle;
  readonly dividends: readonly CorporateDividend[]; readonly corporateCashAdjustmentAtoms: Atoms;
  readonly corporateDebtAdjustmentAtoms: Atoms;
  readonly corporateLiabilityAdjustmentAtoms: Atoms;
  readonly issuedShares: string; readonly reports: readonly FinancialReport[];
  readonly latestReport: FinancialReport; readonly nextEarningsTick: number;
  readonly forecast: {
    readonly annualRevenueGrowth: string; readonly operatingMargin: string;
    readonly expectedQuarterRevenueAtoms: Atoms; readonly targetPayoutRatio: string;
    readonly successProbability: string; readonly fundingFailureProbability: string;
  };
  readonly debtTerms: readonly {
    readonly rateType: 'FIXED' | 'VARIABLE'; readonly principalAtoms: Atoms;
    readonly annualEffectiveRate: string; readonly spread: string;
    readonly maturityTick: number; readonly nextResetTick: number;
  }[];
}
export interface PublicEconomyState {
  readonly schemaVersion: 1; readonly marketId: string; readonly tickNo: number;
  readonly observedMacro: MacroState; readonly macroObservedTick: number;
  readonly policyExpectation: PolicyExpectation; readonly companies: readonly PublicCompanyState[];
  readonly publications: readonly EconomyPublication[];
  readonly corporateActions: readonly CorporateAction[];
  readonly eventDisclosures: readonly EventDisclosure[];
}
