import { FinancialDecimal as D } from '../domain/numeric.js';
import type { PublicCompanyState } from '../economy/types.js';
import type { EventDisclosure } from './types.js';

const clamp = (value: InstanceType<typeof D>, min: string, max: string) => D.max(min, D.min(max, value));
/** Only published observations enter valuation. The report forecast remains the baseline. */
export function publicEventCompany(company: PublicCompanyState, events: readonly EventDisclosure[], tick: number): PublicCompanyState {
  let growth = new D(company.forecast.annualRevenueGrowth); let margin = new D(company.forecast.operatingMargin); let success = new D(company.forecast.successProbability); let failure = new D(company.forecast.fundingFailureProbability);
  for (const event of events) {
    const globalExport = event.profile === 'MACRO' && event.target === 'exportDemand' && event.issuerIds.length === 0;
    if ((!event.issuerIds.includes(company.issuerId) && !globalExport) || event.publishTick > tick || event.effectiveTick <= company.latestReport.closedTick || event.profile === 'BELIEF' || event.profile === 'DISCLOSURE') continue;
    const age = tick - event.effectiveTick; if (age >= event.duration && !['MILESTONE', 'CAPEX'].includes(event.profile) && !(event.profile === 'INCIDENT' && event.reversalRule === 'MANUAL_RECOVERY')) continue;
    if (event.profile === 'INCIDENT' && events.some(followup => followup.publishTick <= tick && followup.actual.recoveredCauseId === event.causeId)) continue;
    if (event.profile === 'CAPEX' && event.actual.projectStatus !== 'COMPLETED') continue;
    const actual = event.actual[event.target]; const expected = event.expected[event.target]; if (!actual || !expected || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(actual) || !/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(expected)) continue;
    const decay = event.decay === 'HALF_LIFE' ? new D('0.5').pow(new D(age).div(event.halfLifeTicks!)) : event.decay === 'LINEAR' ? D.max(0, new D(1).minus(new D(age).div(event.duration))) : new D(1);
    const exportExposure = company.baseSymbol === 'HGI' ? '0.22' : company.baseSymbol === 'TLR' ? '0.18' : company.baseSymbol === 'VTR' ? '0.12' : '0';
    const surprise = new D(actual).minus(expected).mul(event.sectorExposure).mul(decay).mul(globalExport ? exportExposure : '1');
    if (['demand', 'exportDemand', 'unitPrice', 'customerBase', 'industrialDemand', 'consumerDemand'].includes(event.target) || event.profile === 'CONTRACT') growth = growth.plus(surprise.mul('0.35').mul(D.min(1, new D(event.duration).div(63))));
    if (['rawMaterials', 'energy', 'labor', 'service', 'research'].includes(event.target)) margin = margin.minus(surprise.mul('0.2'));
    if (['productivity', 'capacity', 'productMix', 'inventoryTurnover'].includes(event.target)) margin = margin.plus(surprise.mul('0.25'));
    if (event.profile === 'INCIDENT' && ['inventory', 'operatingAssets', 'intangibleAssets'].includes(event.target)) margin = margin.plus(surprise.mul('0.25'));
    if (event.target === 'successProbability') success = success.plus(surprise);
    if (event.profile === 'FINANCE' && event.target === 'creditSpread') failure = failure.plus(surprise.mul(4));
  }
  failure = clamp(failure, '0', '0.9'); success = clamp(success, '0', new D(1).minus(failure).toString());
  return { ...company, forecast: { ...company.forecast, annualRevenueGrowth: clamp(growth, '-0.5', '0.6').toString(), operatingMargin: clamp(margin, '-5', '0.6').toString(), successProbability: success.toString(), fundingFailureProbability: failure.toString() } };
}
export function publicBeliefSentiment(issuerId: string, events: readonly EventDisclosure[], tick: number): string {
  let value = new D(0);
  for (const event of events) {
    if (event.profile !== 'BELIEF' || event.publishTick > tick || !event.issuerIds.includes(issuerId) || tick >= event.effectiveTick + event.duration) continue;
    value = value.plus(new D(event.magnitude).mul(event.sectorExposure).mul(new D('0.5').pow(new D(tick - event.effectiveTick).div(event.halfLifeTicks!))));
  }
  return clamp(value, '-0.08', '0.08').toString();
}
