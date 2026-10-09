import { z } from 'zod';
import { FinancialDecimal as D, moneyFromAtoms, parseRate } from '../domain/numeric.js';
import { EVENT_PROFILES, EVENT_TARGETS, type EventTemplate } from './types.js';

const id = z.string().min(1).max(180).regex(/^[A-Za-z0-9_:.-]+$/);
const decimal = z.string().max(96).refine(value => { try { return parseRate(value) === value; } catch { return false; } });
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const atom = z.string().max(51).regex(/^(?:0|[1-9]\d*)$/).refine(value => { try { moneyFromAtoms(value); return true; } catch { return false; } });
const text = z.string().min(1).max(2000);
const records = z.record(z.string().min(1).max(80), z.string().max(300)).refine(value => Object.keys(value).length <= 24);
const exposure = decimal.refine(value => new D(value).gt(0) && new D(value).lte(1));
const decay = z.enum(['NONE', 'HALF_LIFE', 'LINEAR']);
const symbols = z.array(z.enum(['HGI', 'DNL', 'TLR', 'NXC', 'VTR', 'AUR', 'LMB', 'RVI'])).max(8);
export const eventTemplateSchema = z.strictObject({
  id, version: z.literal(1), title: text, scope: z.enum(['COMPANY', 'MACRO', 'RELATION']), subjects: symbols,
  profile: z.enum(EVENT_PROFILES), mode: z.enum(['NEW', 'FOLLOWUP', 'DOMAIN_ONLY']),
  operation: z.enum(['START', 'INCREASE', 'DECREASE', 'RENEW', 'CANCEL', 'DELAY', 'COMPLETE', 'RESTORE', 'OBSERVE', 'REFINANCE']),
  target: z.enum(EVENT_TARGETS), unit: z.enum(['RATIO', 'PERCENTAGE_POINTS', 'CASH_FRACTION', 'ASSET_FRACTION', 'INDEX_RATIO', 'OBSERVATION']),
  magnitude: z.strictObject({ min: decimal, max: decimal }), duration: z.strictObject({ min: counter.min(1).max(2520), max: counter.min(1).max(2520) }),
  halfLifeTicks: counter.min(1).max(2520).nullable(), decay,
  reversalRule: z.enum(['EXPIRE', 'MANUAL_RECOVERY', 'PROJECT_RESULT', 'NONE']), publishLagTicks: counter.max(126), cooldownTicks: counter.max(2520),
  hazardWeight: decimal.refine(value => new D(value).gte(0) && new D(value).lte(100)),
  eligibility: z.array(z.enum(['OPERATING', 'ACTIVE_NEGOTIATION', 'ACTIVE_CONTRACT', 'ACTIVE_PROJECT', 'COMPLETED_INVESTMENT', 'SPARE_CAPACITY', 'MATURE_DEBT', 'ASSET_PRESENT', 'CASH_AVAILABLE', 'POLICY_MEETING', 'DOMAIN_RESULT'])).min(1).max(12),
  exclusionGroup: id, projectKey: id.nullable(), successors: z.array(id).max(12),
  outcomes: z.array(z.strictObject({ id, probability: decimal, magnitudeMultiplier: decimal })).min(1).max(8),
  publicCopy: text, certainty: z.enum(['CONFIRMED', 'ESTIMATE', 'RUMOR']), sourceType: z.enum(['COMPANY', 'STATISTICS', 'POLICY', 'PRESS']),
  observedTarget: text, sector: text, sectorExposure: exposure, eligibilityNotes: text, effectNotes: text,
  investmentOwner: z.enum(['SUPPLIER', 'CUSTOMER']), contractRole: z.enum(['SUPPLIER', 'CUSTOMER']), financeAction: z.enum(['SPREAD', 'EQUITY_ISSUE', 'ASSET_DISPOSAL', 'DEBT_REPAYMENT', 'COLLECTION_DELAY', 'PAYMENT_EXTENSION', 'CONDITIONAL_SUPPORT', 'SUPPORT_WITHDRAWAL', 'FAILED_FUNDING']).nullable(),
  investmentAccounting: z.enum(['CAPITALIZE', 'RESEARCH_EXPENSE', 'MARKETING_EXPENSE']).nullable(),
  investmentPurpose: z.enum(['RELOCATION', 'MAINTENANCE', 'ACQUISITION', 'EXPANSION', 'EFFICIENCY']),
}).superRefine((template, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (new D(template.magnitude.min).gt(template.magnitude.max) || template.duration.min > template.duration.max) issue('Invalid event range');
  if (new Set(template.subjects).size !== template.subjects.length || (template.scope === 'COMPANY' && template.subjects.length !== 1) || (template.scope === 'RELATION' && template.subjects.length !== 2)) issue('Invalid event subjects');
  if (template.mode !== 'NEW' && !new D(template.hazardWeight).isZero()) issue('Followups and domain disclosures cannot consume independent hazard');
  if (template.profile === 'DISCLOSURE' && template.mode !== 'DOMAIN_ONLY') issue('Disclosures must derive from domain results');
  if ((template.decay === 'HALF_LIFE') !== (template.halfLifeTicks !== null)) issue('Half-life decay requires an explicit half-life');
  if (template.profile === 'BELIEF' && (template.target !== 'sentiment' || template.decay !== 'HALF_LIFE' || template.halfLifeTicks! < 3 || template.halfLifeTicks! > 12)) issue('Belief must be a bounded public sentiment with decay');
  if (template.profile === 'FINANCE' && template.financeAction === null) issue('Finance requires an executable financial operation');
  if (template.profile === 'CAPEX' && template.investmentAccounting === null) issue('Investment accounting must be specified');
  if (template.outcomes.some(outcome => new D(outcome.probability).lt(0) || new D(outcome.probability).gt(1)) || !template.outcomes.reduce((sum, outcome) => sum.plus(outcome.probability), new D(0)).eq(1)) issue('Outcome probabilities must sum to one');
  const supported = new Set(['subject', 'actual', 'expected', 'previous', 'effectiveTick', 'publishTick', 'duration', 'unit']);
  for (const placeholder of template.publicCopy.matchAll(/\{([^}]+)\}/g)) if (!supported.has(placeholder[1]!)) issue('Unsupported public-copy placeholder');
});

export const eventOccurrenceSchema = z.strictObject({ id, causeId: id, templateId: id, templateVersion: z.literal(1), profile: z.enum(EVENT_PROFILES), issuerIds: z.array(id).max(8), symbols,
  effectiveTick: counter, publishTick: counter, duration: counter.min(1).max(2520), magnitude: decimal, outcomeId: id, projectId: id.nullable(), status: z.enum(['ACTIVE', 'RESOLVED', 'CANCELLED']), expected: records, previous: records, actual: records });
export const eventProjectSchema = z.strictObject({ id, causeId: id, key: id, issuerIds: z.array(id).min(1).max(8), status: z.enum(['NEGOTIATING', 'ACTIVE', 'COMPLETED', 'FAILED', 'CANCELLED']), startedTick: counter, completionTick: counter, sourceTemplateId: id, amountAtoms: atom, recognizedAtoms: atom, paidAtoms: atom, investmentId: id.nullable(), supportAtoms: atom, successorTemplateId: id.nullable(), stage: counter.default(0), successProbability: decimal.refine(value => new D(value).gte(0) && new D(value).lte(1)).default('0.22'), supportByIssuer: z.record(id, atom).default({}) });
export const eventRuntimeSchema = z.strictObject({ schemaVersion: z.literal(1), occurrences: z.array(eventOccurrenceSchema).max(100000), projects: z.array(eventProjectSchema).max(100000), cooldowns: z.record(id, counter) }).superRefine((state, ctx) => {
  if (new Set(state.occurrences.map(item => item.id)).size !== state.occurrences.length || new Set(state.projects.map(item => item.id)).size !== state.projects.length) ctx.addIssue({ code: 'custom', message: 'Duplicate event/project identity' });
  const causes = new Set<string>();
  for (const item of state.occurrences) {
    const key = `${item.causeId}_${item.templateId}`;
    if (causes.has(key) || item.publishTick < item.effectiveTick) ctx.addIssue({ code: 'custom', message: 'Duplicate cause effect or invalid event time' });
    causes.add(key);
  }
  for (const project of state.projects) if (BigInt(project.recognizedAtoms) > BigInt(project.amountAtoms) || BigInt(project.paidAtoms) > BigInt(project.amountAtoms) || project.completionTick < project.startedTick) ctx.addIssue({ code: 'custom', message: 'Project cash/recognition exceeds its approved amount' });
});
export const eventDisclosureSchema = z.strictObject({ id, causeId: id, templateId: id, templateVersion: z.literal(1), profile: z.enum(EVENT_PROFILES), title: text, publicCopy: text,
  issuerIds: z.array(id).max(8), symbols: z.array(z.string().max(12)).max(8), effectiveTick: counter, publishTick: counter,
  actual: records, expected: records, previous: records, certainty: z.enum(['CONFIRMED', 'ESTIMATE', 'RUMOR']), sourceType: z.enum(['COMPANY', 'STATISTICS', 'POLICY', 'PRESS']), target: z.enum(EVENT_TARGETS), magnitude: decimal, duration: counter.min(1).max(2520), halfLifeTicks: counter.min(1).max(2520).nullable(), decay, sectorExposure: exposure, reversalRule: z.enum(['EXPIRE', 'MANUAL_RECOVERY', 'PROJECT_RESULT', 'NONE']).default('EXPIRE') });
export const eventDomainEvidenceSchema = z.strictObject({ id, causeId: id, templateId: id, issuerId: id, effectiveTick: counter, publishTick: counter, actual: records, expected: records, previous: records }).refine(evidence => evidence.publishTick >= evidence.effectiveTick && Object.keys(evidence.actual).length > 0, 'Domain evidence must contain an actual sealed result');
export function validateEventCatalog(input: unknown): readonly EventTemplate[] {
  const catalog = z.array(eventTemplateSchema).length(240).parse(input);
  const keys = new Set(catalog.map(item => item.id));
  if (keys.size !== 240 || EVENT_PROFILES.some(profile => !catalog.some(item => item.profile === profile))) throw new Error('Event catalog must contain 240 unique templates and all twelve profiles');
  for (const item of catalog) {
    if (item.successors.some(successor => !keys.has(successor) || successor === item.id)) throw new Error('Unknown/self event successor');
  }
  return Object.freeze(catalog.map(item => Object.freeze(item))) as readonly EventTemplate[];
}
