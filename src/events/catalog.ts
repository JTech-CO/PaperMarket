import { FinancialDecimal as D, parseRate } from '../domain/numeric.js';
import type { EconomicSymbol } from '../economy/types.js';
import { APPENDIX_CATALOG_ROWS, type AppendixCatalogRow } from './catalog-data.js';
import { CATALOG_RULES, type CatalogRule } from './catalog-rules.js';
import type { EventProfile, EventTemplate } from './types.js';
import { validateEventCatalog } from './validator.js';

export const EVENT_CATALOG_VERSION = 1 as const;
interface ProfileDefaults {
  readonly unit: EventTemplate['unit']; readonly min: string; readonly max: string;
  readonly duration: EventTemplate['duration']; readonly decay: EventTemplate['decay'];
  readonly reversalRule: EventTemplate['reversalRule']; readonly cooldownTicks: number;
}
const DEFAULTS: Readonly<Record<EventProfile, ProfileDefaults>> = {
  CONTRACT: { unit: 'RATIO', min: '0.005', max: '0.03', duration: { min: 63, max: 252 }, decay: 'NONE', reversalRule: 'PROJECT_RESULT', cooldownTicks: 63 },
  DEMAND: { unit: 'RATIO', min: '0.02', max: '0.08', duration: { min: 21, max: 63 }, decay: 'LINEAR', reversalRule: 'EXPIRE', cooldownTicks: 21 },
  COST: { unit: 'RATIO', min: '0.02', max: '0.08', duration: { min: 21, max: 63 }, decay: 'LINEAR', reversalRule: 'EXPIRE', cooldownTicks: 21 },
  PRICING: { unit: 'RATIO', min: '0.02', max: '0.08', duration: { min: 63, max: 252 }, decay: 'NONE', reversalRule: 'PROJECT_RESULT', cooldownTicks: 63 },
  OPERATE: { unit: 'PERCENTAGE_POINTS', min: '0.01', max: '0.05', duration: { min: 21, max: 126 }, decay: 'NONE', reversalRule: 'MANUAL_RECOVERY', cooldownTicks: 42 },
  CAPEX: { unit: 'CASH_FRACTION', min: '0.02', max: '0.10', duration: { min: 3, max: 12 }, decay: 'NONE', reversalRule: 'PROJECT_RESULT', cooldownTicks: 63 },
  INCIDENT: { unit: 'ASSET_FRACTION', min: '0.005', max: '0.03', duration: { min: 3, max: 21 }, decay: 'NONE', reversalRule: 'MANUAL_RECOVERY', cooldownTicks: 42 },
  FINANCE: { unit: 'PERCENTAGE_POINTS', min: '0.0025', max: '0.01', duration: { min: 63, max: 252 }, decay: 'NONE', reversalRule: 'PROJECT_RESULT', cooldownTicks: 63 },
  BELIEF: { unit: 'RATIO', min: '0.02', max: '0.08', duration: { min: 3, max: 12 }, decay: 'HALF_LIFE', reversalRule: 'EXPIRE', cooldownTicks: 21 },
  MILESTONE: { unit: 'PERCENTAGE_POINTS', min: '0.05', max: '0.15', duration: { min: 3, max: 12 }, decay: 'NONE', reversalRule: 'PROJECT_RESULT', cooldownTicks: 21 },
  DISCLOSURE: { unit: 'OBSERVATION', min: '0', max: '0', duration: { min: 1, max: 1 }, decay: 'NONE', reversalRule: 'NONE', cooldownTicks: 0 },
  MACRO: { unit: 'INDEX_RATIO', min: '0.02', max: '0.08', duration: { min: 21, max: 63 }, decay: 'LINEAR', reversalRule: 'EXPIRE', cooldownTicks: 21 },
};
const OUTCOMES: Readonly<Record<EventProfile, EventTemplate['outcomes']>> = {
  CONTRACT: [{ id: 'limited', probability: '0.25', magnitudeMultiplier: '0.75' }, { id: 'agreed', probability: '0.6', magnitudeMultiplier: '1' }, { id: 'extended', probability: '0.15', magnitudeMultiplier: '1' }],
  DEMAND: [{ id: 'mild', probability: '0.3', magnitudeMultiplier: '0.75' }, { id: 'central', probability: '0.5', magnitudeMultiplier: '1' }, { id: 'persistent', probability: '0.2', magnitudeMultiplier: '1' }],
  COST: [{ id: 'partial', probability: '0.3', magnitudeMultiplier: '0.75' }, { id: 'central', probability: '0.55', magnitudeMultiplier: '1' }, { id: 'persistent', probability: '0.15', magnitudeMultiplier: '1' }],
  PRICING: [{ id: 'limitedPassThrough', probability: '0.35', magnitudeMultiplier: '0.75' }, { id: 'agreed', probability: '0.5', magnitudeMultiplier: '1' }, { id: 'fullPassThrough', probability: '0.15', magnitudeMultiplier: '1' }],
  OPERATE: [{ id: 'partial', probability: '0.3', magnitudeMultiplier: '0.75' }, { id: 'verified', probability: '0.55', magnitudeMultiplier: '1' }, { id: 'sustained', probability: '0.15', magnitudeMultiplier: '1' }],
  CAPEX: [{ id: 'commissioned', probability: '0.7', magnitudeMultiplier: '1' }, { id: 'delayed', probability: '0.2', magnitudeMultiplier: '1' }, { id: 'failed', probability: '0.1', magnitudeMultiplier: '1' }],
  INCIDENT: [{ id: 'contained', probability: '0.6', magnitudeMultiplier: '0.75' }, { id: 'material', probability: '0.3', magnitudeMultiplier: '1' }, { id: 'extended', probability: '0.1', magnitudeMultiplier: '1' }],
  FINANCE: [{ id: 'accepted', probability: '0.7', magnitudeMultiplier: '1' }, { id: 'partial', probability: '0.2', magnitudeMultiplier: '0.75' }, { id: 'rejected', probability: '0.1', magnitudeMultiplier: '0' }],
  BELIEF: [{ id: 'limitedReach', probability: '0.35', magnitudeMultiplier: '0.75' }, { id: 'wideReach', probability: '0.5', magnitudeMultiplier: '1' }, { id: 'persistentAttention', probability: '0.15', magnitudeMultiplier: '1' }],
  MILESTONE: [{ id: 'verified', probability: '0.7', magnitudeMultiplier: '1' }, { id: 'conditional', probability: '0.2', magnitudeMultiplier: '0.75' }, { id: 'inconclusive', probability: '0.1', magnitudeMultiplier: '0' }],
  DISCLOSURE: [{ id: 'domainResult', probability: '1', magnitudeMultiplier: '0' }],
  MACRO: [{ id: 'mild', probability: '0.3', magnitudeMultiplier: '0.75' }, { id: 'central', probability: '0.5', magnitudeMultiplier: '1' }, { id: 'persistent', probability: '0.2', magnitudeMultiplier: '1' }],
};
const TERMINAL_OUTCOME = Object.freeze([{ id: 'confirmed', probability: '1', magnitudeMultiplier: '1' }]);
const DOMAIN_OUTCOME = Object.freeze([{ id: 'domainResult', probability: '1', magnitudeMultiplier: '0' }]);
const INVESTMENT_PURPOSES: Readonly<Record<string, EventTemplate['investmentPurpose']>> = {
  'HGI-21': 'EXPANSION', 'TLR-21': 'EXPANSION', 'VTR-22': 'EXPANSION', 'RVI-21': 'EXPANSION', 'XCO-19': 'EXPANSION',
  'HGI-22': 'ACQUISITION', 'DNL-24': 'ACQUISITION', 'NXC-23': 'ACQUISITION', 'LMB-21': 'ACQUISITION',
  'HGI-24': 'RELOCATION', 'RVI-12': 'MAINTENANCE',
};
function buildTemplate(row: AppendixCatalogRow, rule: CatalogRule): EventTemplate {
  const defaults = DEFAULTS[row.profile];
  const mode = row.profile === 'DISCLOSURE' ? 'DOMAIN_ONLY' : rule.mode ?? (row.profile === 'MILESTONE' ? 'FOLLOWUP' : 'NEW');
  const direction = rule.sign ?? (rule.operation === 'DECREASE' || rule.operation === 'CANCEL' || rule.operation === 'DELAY' || row.profile === 'INCIDENT' ? -1 : 1);
  const financialCash = rule.financeAction !== undefined && rule.unit === 'CASH_FRACTION';
  const min = financialCash ? '0.02' : defaults.min;
  const max = financialCash ? '0.1' : defaults.max;
  const magnitude = rule.magnitude ?? (direction === -1 ? { min: parseRate(new D(max).negated().toFixed()), max: parseRate(new D(min).negated().toFixed()) } : { min: parseRate(min), max: parseRate(max) });
  const subjects = rule.subjects ?? (row.group === 'MAC' ? [] : [row.group as EconomicSymbol]);
  const eligibility = rule.eligibility ?? (row.profile === 'DISCLOSURE' ? ['DOMAIN_RESULT'] : ['OPERATING']);
  const projectKey = rule.projectKey ?? (row.profile === 'MILESTONE' ? `${row.group}:technology` : null);
  const sectorExposure = row.group === 'MAC' || row.profile === 'FINANCE' || row.profile === 'DISCLOSURE' ? '1' : row.profile === 'MILESTONE' ? '0.35' : '0.25';
  const terminal = rule.operation === 'CANCEL' || rule.financeAction === 'FAILED_FUNDING';
  const actualOnly = mode === 'DOMAIN_ONLY';
  const duration = rule.duration ?? defaults.duration;
  const halfLifeTicks = row.profile === 'BELIEF' ? rule.halfLifeTicks ?? 6 : null;
  const policy = row.group === 'MAC' && Number(row.id.slice(4)) <= 3;
  return Object.freeze({
    id: row.id, version: EVENT_CATALOG_VERSION, title: row.title,
    scope: row.group === 'MAC' ? 'MACRO' : row.group === 'XCO' ? 'RELATION' : 'COMPANY',
    subjects: Object.freeze([...subjects]), profile: row.profile, mode,
    operation: rule.operation, target: rule.target, unit: rule.unit ?? defaults.unit,
    magnitude: Object.freeze({ min: parseRate(magnitude.min), max: parseRate(magnitude.max) }), duration: Object.freeze({ ...duration }),
    halfLifeTicks, decay: actualOnly ? 'NONE' : defaults.decay,
    reversalRule: actualOnly ? 'NONE' : defaults.reversalRule,
    publishLagTicks: rule.publishLagTicks ?? (row.profile === 'MILESTONE' ? 1 : 0),
    cooldownTicks: rule.cooldownTicks ?? defaults.cooldownTicks,
    hazardWeight: mode === 'NEW' ? (row.profile === 'INCIDENT' ? '0.7' : row.profile === 'BELIEF' ? '0.5' : '1') : '0',
    eligibility: Object.freeze([...eligibility]), exclusionGroup: projectKey ?? `${row.group}:${rule.target}:${rule.sector.replace(/[^A-Za-z0-9]/g, '') || row.id}`,
    projectKey, successors: Object.freeze([...(rule.successors ?? [])]),
    outcomes: Object.freeze((actualOnly ? DOMAIN_OUTCOME : terminal ? TERMINAL_OUTCOME : OUTCOMES[row.profile]).map(outcome => Object.freeze({ ...outcome }))),
    publicCopy: `{subject} · ${row.title}. 관찰 대상: ${row.observedTarget}. 실제 {actual}, 사전 예상 {expected}, 직전 {previous}. 효력 {effectiveTick}틱, 발표 {publishTick}틱, 기간 {duration}틱, 단위 {unit}. ${row.profile === 'BELIEF' ? '확인 수준에 따른 기대 자료이며 후속 확인이 필요합니다.' : actualOnly ? '확정된 도메인 결과와 공개 가정을 제공합니다.' : '영향 범위와 계약·회계 인식 시점은 공개 조건에 따릅니다.'}`,
    certainty: rule.certainty ?? 'CONFIRMED', sourceType: rule.sourceType ?? (policy ? 'POLICY' : row.group === 'MAC' ? 'STATISTICS' : 'COMPANY'),
    observedTarget: row.observedTarget, sector: rule.sector, sectorExposure,
    eligibilityNotes: `${rule.condition}. 발행회사별 상태·원인·현재 프로젝트를 확인하며 종료·실패 원인의 재실행은 금지.`,
    effectNotes: `${rule.effect} 공개 기대는 발표 전 정보만 사용하며 미래 결과를 정답으로 미리 제공하지 않음.`,
    financeAction: rule.financeAction ?? null, investmentAccounting: rule.investmentAccounting ?? null, contractRole: rule.contractRole ?? 'SUPPLIER', investmentOwner: rule.investmentOwner ?? 'CUSTOMER', investmentPurpose: rule.investmentPurpose ?? INVESTMENT_PURPOSES[row.id] ?? 'EFFICIENCY',
  });
}
const rulesById = new Map(CATALOG_RULES.map(rule => [rule.id, rule]));
if (CATALOG_RULES.length !== 240 || rulesById.size !== 240) throw new Error('All 240 appendix events require one explicit executable rule');
function freezeDefinition<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) freezeDefinition(child);
    Object.freeze(value);
  }
  return value;
}
/** Source order remains stable; issuer-specific runtime state is deliberately absent from templates. */
export const EVENT_CATALOG: readonly EventTemplate[] = freezeDefinition(validateEventCatalog(APPENDIX_CATALOG_ROWS.map(row => {
  const rule = rulesById.get(row.id);
  if (!rule) throw new Error(`Missing executable event rule: ${row.id}`);
  return buildTemplate(row, rule);
})));
const templatesById = new Map(EVENT_CATALOG.map(template => [template.id, template]));
export function getEventTemplate(id: string): EventTemplate {
  const template = templatesById.get(id);
  if (!template) throw new RangeError(`Unknown event template: ${id}`);
  return template;
}
