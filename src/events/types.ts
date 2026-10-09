import type { CorporateAction, CorporateJournalEntry, EconomicSymbol, EconomyPublication } from '../economy/types.js';

export const EVENT_PROFILES = ['CONTRACT', 'DEMAND', 'COST', 'PRICING', 'OPERATE', 'CAPEX', 'INCIDENT', 'FINANCE', 'BELIEF', 'MILESTONE', 'DISCLOSURE', 'MACRO'] as const;
export type EventProfile = typeof EVENT_PROFILES[number];
export const EVENT_TARGETS = ['demand', 'exportDemand', 'rawMaterials', 'energy', 'labor', 'service', 'research', 'unitPrice', 'productivity', 'productMix', 'inventoryTurnover', 'capacity', 'customerBase', 'cash', 'inventory', 'operatingAssets', 'intangibleAssets', 'receivables', 'payables', 'contractLiability', 'creditSpread', 'sentiment', 'successProbability', 'industrialDemand', 'consumerDemand', 'metals', 'fx', 'inflation', 'policyRate', 'creditStress', 'riskAppetite'] as const;
export type EventTarget = typeof EVENT_TARGETS[number];
export type FinanceAction = 'SPREAD' | 'EQUITY_ISSUE' | 'ASSET_DISPOSAL' | 'DEBT_REPAYMENT' | 'COLLECTION_DELAY' | 'PAYMENT_EXTENSION' | 'CONDITIONAL_SUPPORT' | 'SUPPORT_WITHDRAWAL' | 'FAILED_FUNDING';
export type EventOperation = 'START' | 'INCREASE' | 'DECREASE' | 'RENEW' | 'CANCEL' | 'DELAY' | 'COMPLETE' | 'RESTORE' | 'OBSERVE' | 'REFINANCE';
export type EventEligibility = 'OPERATING' | 'ACTIVE_NEGOTIATION' | 'ACTIVE_CONTRACT' | 'ACTIVE_PROJECT' | 'COMPLETED_INVESTMENT' | 'SPARE_CAPACITY' | 'MATURE_DEBT' | 'ASSET_PRESENT' | 'CASH_AVAILABLE' | 'POLICY_MEETING' | 'DOMAIN_RESULT';
/** Financial inputs are decimal strings; templates contain no direct price instruction. */
export interface EventTemplate {
  readonly id: string; readonly version: 1; readonly title: string; readonly scope: 'COMPANY' | 'MACRO' | 'RELATION';
  readonly subjects: readonly EconomicSymbol[]; readonly profile: EventProfile;
  readonly mode: 'NEW' | 'FOLLOWUP' | 'DOMAIN_ONLY'; readonly operation: EventOperation;
  readonly target: EventTarget; readonly unit: 'RATIO' | 'PERCENTAGE_POINTS' | 'CASH_FRACTION' | 'ASSET_FRACTION' | 'INDEX_RATIO' | 'OBSERVATION';
  readonly magnitude: { readonly min: string; readonly max: string };
  readonly duration: { readonly min: number; readonly max: number }; readonly halfLifeTicks: number | null;
  readonly decay: 'NONE' | 'HALF_LIFE' | 'LINEAR'; readonly reversalRule: 'EXPIRE' | 'MANUAL_RECOVERY' | 'PROJECT_RESULT' | 'NONE';
  readonly publishLagTicks: number; readonly cooldownTicks: number; readonly hazardWeight: string;
  readonly eligibility: readonly EventEligibility[]; readonly exclusionGroup: string; readonly projectKey: string | null;
  readonly successors: readonly string[];
  readonly outcomes: readonly { readonly id: string; readonly probability: string; readonly magnitudeMultiplier: string }[];
  readonly publicCopy: string; readonly certainty: 'CONFIRMED' | 'ESTIMATE' | 'RUMOR'; readonly sourceType: 'COMPANY' | 'STATISTICS' | 'POLICY' | 'PRESS';
  readonly observedTarget: string; readonly sector: string; readonly sectorExposure: string; readonly eligibilityNotes: string; readonly effectNotes: string;
  readonly investmentOwner: 'SUPPLIER' | 'CUSTOMER'; readonly contractRole: 'SUPPLIER' | 'CUSTOMER'; readonly financeAction: FinanceAction | null; readonly investmentAccounting: 'CAPITALIZE' | 'RESEARCH_EXPENSE' | 'MARKETING_EXPENSE' | null;
  readonly investmentPurpose: 'RELOCATION' | 'MAINTENANCE' | 'ACQUISITION' | 'EXPANSION' | 'EFFICIENCY';
}
/** Sealed domain evidence enables revisions/FX/forecast disclosures without a second random financial event. */
export interface EventDomainEvidence {
  readonly id: string; readonly causeId: string; readonly templateId: string; readonly issuerId: string;
  readonly effectiveTick: number; readonly publishTick: number;
  readonly actual: Readonly<Record<string, string>>; readonly expected: Readonly<Record<string, string>>; readonly previous: Readonly<Record<string, string>>;
}
export interface EventOccurrence {
  readonly id: string; readonly causeId: string; readonly templateId: string; readonly templateVersion: 1; readonly profile: EventProfile;
  readonly issuerIds: readonly string[]; readonly symbols: readonly EconomicSymbol[];
  readonly effectiveTick: number; readonly publishTick: number; readonly duration: number;
  readonly magnitude: string; readonly outcomeId: string; readonly projectId: string | null;
  readonly status: 'ACTIVE' | 'RESOLVED' | 'CANCELLED';
  readonly expected: Readonly<Record<string, string>>; readonly previous: Readonly<Record<string, string>>;
  readonly actual: Readonly<Record<string, string>>;
}
export interface EventProject {
  readonly id: string; readonly causeId: string; readonly key: string; readonly issuerIds: readonly string[];
  readonly status: 'NEGOTIATING' | 'ACTIVE' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  readonly startedTick: number; readonly completionTick: number; readonly sourceTemplateId: string;
  readonly amountAtoms: string; readonly recognizedAtoms: string; readonly paidAtoms: string;
  readonly investmentId: string | null; readonly supportAtoms: string;
  readonly successorTemplateId: string | null;
  readonly stage: number; readonly successProbability: string;
  readonly supportByIssuer: Readonly<Record<string, string>>;
}
export interface EventRuntimeState {
  readonly schemaVersion: 1; readonly occurrences: readonly EventOccurrence[]; readonly projects: readonly EventProject[];
  readonly cooldowns: Readonly<Record<string, number>>;
}
export interface EventDisclosure {
  readonly id: string; readonly causeId: string; readonly templateId: string; readonly templateVersion: 1; readonly profile: EventProfile;
  readonly title: string; readonly publicCopy: string; readonly issuerIds: readonly string[];
  readonly symbols: readonly string[]; readonly effectiveTick: number; readonly publishTick: number;
  readonly actual: Readonly<Record<string, string>>; readonly expected: Readonly<Record<string, string>>;
  readonly previous: Readonly<Record<string, string>>; readonly certainty: EventTemplate['certainty']; readonly sourceType: EventTemplate['sourceType'];
  readonly target: EventTarget; readonly magnitude: string; readonly duration: number; readonly halfLifeTicks: number | null;
  readonly decay: EventTemplate['decay']; readonly sectorExposure: string;
  readonly reversalRule: EventTemplate['reversalRule'];
}
export interface CompanyEventModifier {
  readonly demand: string; readonly exportDemand: string; readonly unitPrice: string;
  readonly productivity: string; readonly productMix: string; readonly inventoryTurnover: string; readonly capacity: string; readonly customerBase: string;
  readonly rawMaterials: string; readonly energy: string; readonly labor: string; readonly service: string; readonly research: string;
  readonly reservedVolume: string;
}
export interface EventAdvanceEffects {
  readonly entries: readonly CorporateJournalEntry[]; readonly actions: readonly CorporateAction[];
  readonly publications: readonly EconomyPublication[]; readonly disclosures: readonly EventDisclosure[];
}
