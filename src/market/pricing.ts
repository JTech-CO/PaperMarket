import { z } from 'zod';
import { FinancialDecimal as D, checkedDecimal, parsePrice, parseRate } from '../domain/numeric.js';
import { issuerIdSchema, listingIdSchema, parseEngineVersion, parseIssuerId, parseListingId, parseTickNo, tickNoSchema } from '../domain/identifiers.js';
import { publicCorporateActionSchema, validatePublicEconomy, type PublicEconomy } from '../economy/public.js';
import type { CorporateAction, EconomyRandom, PublicCompanyState } from '../economy/types.js';
import { dividendRightMark, transformCorporateRights, type CorporateRightMark } from '../domain/corporate-rights.js';
import { valueCompanies, type CompanyValuation } from './valuation.js';
import { publicBeliefSentiment } from '../events/public.js';

type DecimalValue = InstanceType<typeof D>;
export const PRICE_ENGINE_VERSION = 'public-fcff-v1' as const;
export const PRICE_PARAMETERS = Object.freeze({
  HGI: Object.freeze({ sigma: '0.009', beta: '1', kappa: '0.020' }),
  DNL: Object.freeze({ sigma: '0.006', beta: '0.6', kappa: '0.020' }),
  TLR: Object.freeze({ sigma: '0.013', beta: '1.1', kappa: '0.018' }),
  NXC: Object.freeze({ sigma: '0.016', beta: '1.3', kappa: '0.014' }),
  VTR: Object.freeze({ sigma: '0.018', beta: '1.2', kappa: '0.014' }),
  AUR: Object.freeze({ sigma: '0.027', beta: '1.4', kappa: '0.010' }),
  LMB: Object.freeze({ sigma: '0.030', beta: '0.8', kappa: '0.010' }),
  RVI: Object.freeze({ sigma: '0.006', beta: '0.6', kappa: '0.020' }),
});
const rateSchema = z.string().max(96).refine((value) => { try { parseRate(value); return true; } catch { return false; } });
const positiveWeight = rateSchema.refine((value) => new D(value).gte(0) && new D(value).lte(1));
const nonnegative = rateSchema.refine((value) => new D(value).gte(0));
export const groupWeightsSchema = z.strictObject({
  value: positiveWeight, growth: positiveWeight, dividend: positiveWeight, trend: positiveWeight, riskAverse: positiveWeight,
}).refine((weights) => Object.values(weights).reduce((total, weight) => total.plus(weight), new D(0)).eq(1), 'Participant weights must sum to one');
export type GroupWeights = z.infer<typeof groupWeightsSchema>;
const groupSentimentSchema = z.strictObject({ value: rateSchema, growth: rateSchema, dividend: rateSchema, trend: rateSchema, riskAverse: rateSchema })
  .refine((states) => Object.values(states).every((state) => new D(state).abs().lte('0.1')));
type GroupSentiments = z.infer<typeof groupSentimentSchema>;
export const pricingStateSchema = z.strictObject({
  schemaVersion: z.literal(1), engineVersion: z.literal(PRICE_ENGINE_VERSION), tickNo: tickNoSchema,
  groupWeights: groupWeightsSchema,
  companies: z.array(z.strictObject({ issuerId: issuerIdSchema, listingId: listingIdSchema, price: nonnegative,
    continuationValuePerShare: nonnegative, sentiment: rateSchema, lastReturn: rateSchema, groupSentiments: groupSentimentSchema,
    attachedRightsMark: nonnegative.default('0'), continuationMark: nonnegative.optional(),
    priceMode: z.enum(['ORDINARY', 'RIGHTS_ONLY', 'EXTINGUISHED']).default('ORDINARY'),
  }).transform((company) => ({ ...company, continuationMark: company.continuationMark ?? company.price }))).length(8),
}).superRefine((state, context) => {
  if (new Set(state.companies.map((company) => company.listingId)).size !== 8
      || new Set(state.companies.map((company) => company.issuerId)).size !== 8) context.addIssue({ code: 'custom', message: 'Duplicate pricing company' });
  for (const company of state.companies) {
    if (new D(company.sentiment).abs().gt('0.1') || new D(company.lastReturn).lt('-0.3') || new D(company.lastReturn).gt('0.3')) context.addIssue({ code: 'custom', message: 'Invalid pricing state bounds' });
    if (!new D(company.continuationMark).plus(company.attachedRightsMark).eq(company.price)
      || new D(company.price).isZero() !== (company.priceMode === 'EXTINGUISHED')
      || (company.priceMode === 'RIGHTS_ONLY' && !new D(company.continuationMark).isZero())) context.addIssue({ code: 'custom', message: 'Invalid pricing right decomposition' });
  }
});
export type PricingState = Readonly<z.infer<typeof pricingStateSchema>>;
export interface PriceContribution {
  readonly issuerId: string; readonly listingId: string; readonly tickNo: number;
  readonly referencePrice: string; readonly price: string; readonly actualReturn: string;
  readonly publicRevaluation: string; readonly commonRisk: string; readonly sentiment: string; readonly residual: string;
  readonly clippingAdjustment: string; readonly roundingAdjustment: string;
  readonly gapLog: string; readonly valueInnovationLog: string; readonly marketResidualLog: string;
  readonly sentimentLog: string; readonly residualLog: string; readonly totalLogReturn: string;
  readonly unclippedReturn: string; readonly wasClipped: boolean;
  readonly referenceAdjustment?: string; readonly continuationMark?: string; readonly attachedRightsMark?: string;
  readonly detachedRights?: readonly Omit<CorporateRightMark, 'detach'>[];
  readonly priceMode?: 'ORDINARY' | 'RIGHTS_ONLY' | 'EXTINGUISHED' | 'REPLACEMENT';
}
export interface MarketPricingResult {
  readonly state: PricingState;
  readonly prices: readonly { readonly listingId: string; readonly issuerId: string; readonly symbol: string; readonly price: string;
    readonly priceMode?: 'ORDINARY' | 'RIGHTS_ONLY' | 'EXTINGUISHED' | 'REPLACEMENT' }[];
  readonly contributions: readonly PriceContribution[];
}
const text = (value: DecimalValue) => parseRate(checkedDecimal(value).toString());
const clamp = (value: DecimalValue, minimum: string, maximum: string) => D.max(minimum, D.min(maximum, value));
const zero = () => new D(0);
const initialWeights: GroupWeights = { value: '0.25', growth: '0.2', dividend: '0.15', trend: '0.2', riskAverse: '0.2' };

function updateWeights(previous: GroupWeights, publicState: PublicEconomy): GroupWeights {
  const stress = new D(publicState.observedMacro.creditStress);
  const appetite = new D(publicState.observedMacro.riskAppetite);
  const target = { value: new D('0.3'), growth: clamp(new D('0.2').plus(appetite.mul('0.08')).minus(stress.mul('0.08')), '0.06', '0.3'),
    dividend: new D('0.15'), trend: clamp(new D('0.2').plus(appetite.mul('0.04')), '0.1', '0.25'), riskAverse: new D('0.15').plus(stress.mul('0.12')) };
  const sum = Object.values(target).reduce((total, value) => total.plus(value), zero());
  const weights = {} as Record<keyof GroupWeights, string>;
  for (const key of ['value', 'growth', 'dividend', 'trend', 'riskAverse'] as const) weights[key] = text(new D(previous[key]).mul('0.97').plus(target[key].div(sum).mul('0.03')));
  // One explicit remainder avoids five individually rounded weights drifting from one.
  weights.riskAverse = text(new D(1).minus(new D(weights.value).plus(weights.growth).plus(weights.dividend).plus(weights.trend)));
  return groupWeightsSchema.parse(weights);
}

function sentiment(company: PublicCompanyState, valuation: CompanyValuation, previous: PricingState['companies'][number], weights: GroupWeights, state: PublicEconomy): Readonly<{ value: DecimalValue; groups: GroupSentiments }> {
  const value = new D(valuation.continuationValuePerShare);
  const denominator = D.max(value, previous.price);
  const valueView = denominator.isZero() ? zero() : value.minus(previous.price).div(denominator).mul('0.01');
  const recurringPretax = new D(company.latestReport.pretaxProfitAtoms).minus(company.latestReport.oneOffProfitAtoms);
  const recurringNet = recurringPretax.minus(D.max(0, recurringPretax).mul('0.2'));
  const publicYield = new D(company.forecast.targetPayoutRatio).mul(D.max(0, recurringNet.div('1e12'))).mul(4)
    .div(company.issuedShares).div(D.max(1, value));
  const growthView = clamp(new D(company.forecast.annualRevenueGrowth).mul('0.07').minus(new D(company.forecast.fundingFailureProbability).mul('0.025')), '-0.04', '0.04');
  const dividendView = clamp(publicYield.minus(state.observedMacro.policyRate).mul('0.2'), '-0.025', '0.025');
  const trendView = clamp(new D(previous.lastReturn).mul('0.15'), '-0.03', '0.03');
  const riskView = new D(state.observedMacro.creditStress).mul('-0.025').minus(new D(company.forecast.fundingFailureProbability).mul('0.02'));
  const targets = { value: valueView, growth: growthView, dividend: dividendView, trend: trendView, riskAverse: riskView };
  const groups = {} as Record<keyof GroupWeights, string>;
  let aggregate = zero();
  for (const key of ['value', 'growth', 'dividend', 'trend', 'riskAverse'] as const) {
    groups[key] = text(new D(previous.groupSentiments[key]).mul('0.85').plus(targets[key].mul('0.15')));
    aggregate = aggregate.plus(new D(groups[key]).mul(weights[key]));
  }
  return { value: clamp(aggregate.plus(publicBeliefSentiment(company.issuerId, state.eventDisclosures, state.tickNo)), '-0.06', '0.06'), groups: groupSentimentSchema.parse(groups) };
}

/** Twelve independent uniform context draws approximate a zero-mean unit-variance residual. */
function innovation(random: EconomyRandom, tick: number, issuerId: string, channel: string): DecimalValue {
  let sum = zero();
  for (let drawIndex = 0; drawIndex < 12; drawIndex++) {
    const uniform = random.uniform({ engineVersion: parseEngineVersion(PRICE_ENGINE_VERSION), tick: parseTickNo(tick), issuerId: parseIssuerId(issuerId), eventChannel: channel, drawIndex });
    if (typeof uniform !== 'string' || uniform.length > 300 || !/^0(?:\.\d+)?$/.test(uniform)) throw new Error('INVALID_MARKET_RANDOM');
    const value = new D(uniform);
    if (value.lt(0) || value.gte(1)) throw new Error('INVALID_MARKET_RANDOM');
    sum = sum.plus(value);
  }
  return sum.minus(6);
}

/** Ordinary price transformation is exported as a diagnostic kernel, not content. */
export function ordinaryPrice(referenceInput: string, components: Readonly<{ gap: string; valueInnovation: string; marketResidual: string; sentiment: string; residual: string }>): Readonly<{ price: string; contribution: Omit<PriceContribution, 'issuerId' | 'listingId' | 'tickNo'> }> {
  const reference = new D(parsePrice(referenceInput));
  const checkedComponents = z.strictObject({ gap: rateSchema, valueInnovation: rateSchema, marketResidual: rateSchema, sentiment: rateSchema, residual: rateSchema }).parse(components);
  const values = Object.values(checkedComponents).map((value) => new D(value));
  if (values.some((value) => value.abs().gt(3))) throw new Error('PRICE_COMPONENT_OUT_OF_RANGE');
  const zValue = values.reduce((sum, value) => sum.plus(value), zero());
  if (zValue.abs().gt(10)) throw new Error('PRICE_COMPONENT_OUT_OF_RANGE');
  const rawReturn = zValue.exp().minus(1);
  const limited = clamp(rawReturn, '-0.3', '0.3');
  const price = parsePrice(checkedDecimal(reference.mul(new D(1).plus(limited))).toString());
  const actual = new D(price).div(reference).minus(1);
  const factor = zValue.isZero() ? new D(1) : rawReturn.div(zValue);
  const publicRevaluation = new D(checkedComponents.gap).plus(checkedComponents.valueInnovation).mul(factor);
  const commonRisk = new D(checkedComponents.marketResidual).mul(factor);
  const sentimentReturn = new D(checkedComponents.sentiment).mul(factor);
  const residual = new D(checkedComponents.residual).mul(factor);
  const clipping = limited.minus(rawReturn);
  const rounding = actual.minus(publicRevaluation.plus(commonRisk).plus(sentimentReturn).plus(residual).plus(clipping));
  const contribution = { referencePrice: parsePrice(referenceInput), price, actualReturn: text(actual),
    publicRevaluation: text(publicRevaluation), commonRisk: text(commonRisk), sentiment: text(sentimentReturn), residual: text(residual),
    clippingAdjustment: text(clipping), roundingAdjustment: text(rounding), gapLog: text(new D(checkedComponents.gap)),
    valueInnovationLog: text(new D(checkedComponents.valueInnovation)), marketResidualLog: text(new D(checkedComponents.marketResidual)),
    sentimentLog: text(new D(checkedComponents.sentiment)), residualLog: text(new D(checkedComponents.residual)), totalLogReturn: text(zValue),
    unclippedReturn: text(rawReturn), wasClipped: !rawReturn.eq(limited) };
  return Object.freeze({ price, contribution: Object.freeze(contribution) });
}

export function createMarketState(input: PublicEconomy, initialPrices?: Readonly<Record<string, string>>): PricingState {
  const publicState = validatePublicEconomy(input);
  if (initialPrices && Object.keys(initialPrices).some((key) => !publicState.companies.some((company) => company.listingId === key))) throw new Error('UNKNOWN_INITIAL_PRICE_LISTING');
  const valuations = valueCompanies(publicState);
  return pricingStateSchema.parse({ schemaVersion: 1, engineVersion: PRICE_ENGINE_VERSION, tickNo: publicState.tickNo,
    groupWeights: initialWeights, companies: publicState.companies.map((company) => {
      const value = valuations.find((valuation) => valuation.issuerId === company.issuerId)!.continuationValuePerShare;
      const rights = publicAttachedRights(company, publicState).filter((right) => !right.detach);
      const transform = transformCorporateRights({ previousPrice: parsePrice(initialPrices?.[company.listingId] ?? '1000'),
        previousAttachedRightsMark: '0', nextRights: rights, declaration: true, modelContinuationMark: value });
      return { issuerId: company.issuerId, listingId: company.listingId, price: transform.referencePrice,
        continuationValuePerShare: value, attachedRightsMark: transform.attachedRightsMark, continuationMark: transform.continuationMark, priceMode: transform.priceMode,
        sentiment: '0', lastReturn: '0', groupSentiments: { value: '0', growth: '0', dividend: '0', trend: '0', riskAverse: '0' } };
    }) });
}

function publicAttachedRights(company: PublicCompanyState, publicState: PublicEconomy): CorporateRightMark[] {
  return company.dividends.filter((dividend) => dividend.declaredTick <= publicState.tickNo && dividend.exTick >= publicState.tickNo
    && dividend.status !== 'PAID' && dividend.status !== 'SETTLED').map((dividend): CorporateRightMark => ({ dividendId: dividend.id,
      nominalPerShare: dividend.dps, markPerShare: dividendRightMark(dividend.dps, dividend.recoveryRatio,
        D.max(0, new D(publicState.observedMacro.policyRate).minus('0.005')).toString(), Math.max(0, dividend.payTick - publicState.tickNo)),
      detach: dividend.exTick === publicState.tickNo }));
}

/** No account, participant count, order, private report, or query counter exists in this contract. */
export function priceMarket(input: PublicEconomy, priorInput: PricingState, random: EconomyRandom, actionsInput: readonly CorporateAction[] = []): MarketPricingResult {
  const publicState = validatePublicEconomy(input); const prior = pricingStateSchema.parse(priorInput);
  if (publicState.tickNo !== prior.tickNo + 1) throw new Error('PRICE_TICK_SEQUENCE');
  const passedActions = z.array(publicCorporateActionSchema).max(256).parse(actionsInput);
  if (passedActions.some((action) => !publicState.corporateActions.some((published) => JSON.stringify(published) === JSON.stringify(action)))) throw new Error('UNPUBLISHED_PRICE_CORPORATE_ACTION');
  const actions = publicState.corporateActions.filter((action) => action.effectiveTick === publicState.tickNo);
  const weights = updateWeights(prior.groupWeights, publicState);
  const valuations = valueCompanies(publicState);
  // This shared component is a risk-preference residual only. Macro cash-flow
  // changes belong to FCFF/WACC and receive no additional event-price command.
  const common = innovation(random, publicState.tickNo, 'market_common_residual', 'common-risk-residual').mul('0.003');
  const output: PricingState['companies'][number][] = []; const contributions: PriceContribution[] = [];
  const prices: MarketPricingResult['prices'][number][] = [];
  for (const company of publicState.companies) {
    const old = prior.companies.find((value) => value.listingId === company.listingId && value.issuerId === company.issuerId);
    const valuation = valuations.find((value) => value.issuerId === company.issuerId)!;
    if (!old) {
      const replacement = actions.find((action) => action.kind === 'REPLACEMENT' && action.newIssuerId === company.issuerId && action.newListingId === company.listingId);
      if (!replacement || company.createdTick !== publicState.tickNo) throw new Error('PRICE_IDENTITY_MISMATCH');
      const fresh = { issuerId: parseIssuerId(company.issuerId), listingId: parseListingId(company.listingId), price: parsePrice('1000'),
        continuationValuePerShare: valuation.continuationValuePerShare, continuationMark: '1000', attachedRightsMark: '0', priceMode: 'ORDINARY' as const,
        sentiment: '0', lastReturn: '0', groupSentiments: { value: '0', growth: '0', dividend: '0', trend: '0', riskAverse: '0' } };
      output.push(fresh); prices.push(Object.freeze({ issuerId: company.issuerId, listingId: company.listingId, symbol: company.symbol, price: '1000', priceMode: 'REPLACEMENT' }));
      contributions.push(Object.freeze({ issuerId: company.issuerId, listingId: company.listingId, tickNo: publicState.tickNo,
        ...zeroContribution('1000'), referenceAdjustment: '0', continuationMark: '1000', attachedRightsMark: '0', detachedRights: [], priceMode: 'REPLACEMENT' }));
      continue;
    }
    const declared = actions.filter((action) => action.kind === 'DIVIDEND_DECLARED' && action.issuerId === company.issuerId);
    const rights = publicAttachedRights(company, publicState);
    const transform = transformCorporateRights({ previousPrice: old.price, previousAttachedRightsMark: old.attachedRightsMark,
      nextRights: rights, declaration: declared.length > 0, modelContinuationMark: valuation.continuationValuePerShare });
    const value = new D(valuation.continuationValuePerShare);
    const declarationPerShare = declared.reduce((sum, action) => sum.plus('dividend' in action ? new D(action.dividend.totalNominalAtoms).div('1e12').div(company.issuedShares) : '0'), zero());
    const oldValue = D.max(0, new D(old.continuationValuePerShare).minus(declarationPerShare));
    const reference = new D(transform.continuationMark);
    const gapDenominator = D.max(value, reference);
    const gap = gapDenominator.isZero() ? zero() : value.minus(reference).div(gapDenominator);
    const innovationDenominator = D.max(value, oldValue);
    const valueInnovation = innovationDenominator.isZero() ? zero() : value.minus(oldValue).div(innovationDenominator);
    const nextSentiment = sentiment(company, valuation, { ...old, price: transform.continuationMark }, weights, publicState);
    const parameters = PRICE_PARAMETERS[company.baseSymbol];
    const volatilityCluster = new D(1).plus(D.max(0, new D(publicState.observedMacro.creditStress).minus('0.2')).mul('0.7'));
    const residual = innovation(random, publicState.tickNo, company.issuerId, 'issuer-price-residual').mul(parameters.sigma).mul(volatilityCluster);
    const priced = reference.isZero() ? { price: '0', contribution: zeroContribution(transform.referencePrice) }
      : ordinaryPrice(transform.continuationMark, { gap: text(gap.mul(parameters.kappa)), valueInnovation: text(valueInnovation.mul('0.08')),
        marketResidual: text(common.mul(parameters.beta)), sentiment: text(nextSentiment.value.minus(old.sentiment)), residual: text(residual) });
    const finalPrice = text(new D(priced.price).plus(transform.attachedRightsMark));
    const wholeContribution = reference.isZero() ? priced.contribution : scaleContribution(priced.contribution, transform.referencePrice, finalPrice);
    contributions.push(Object.freeze({ issuerId: company.issuerId, listingId: company.listingId, tickNo: publicState.tickNo, ...wholeContribution,
      referenceAdjustment: transform.referenceAdjustment, continuationMark: transform.continuationMark, attachedRightsMark: transform.attachedRightsMark,
      detachedRights: transform.detachedRights, priceMode: transform.priceMode }));
    output.push({ issuerId: parseIssuerId(company.issuerId), listingId: parseListingId(company.listingId), price: finalPrice,
      continuationMark: priced.price, attachedRightsMark: transform.attachedRightsMark, priceMode: transform.priceMode,
      continuationValuePerShare: valuation.continuationValuePerShare, sentiment: text(nextSentiment.value), groupSentiments: nextSentiment.groups, lastReturn: wholeContribution.actualReturn });
    prices.push(Object.freeze({ issuerId: company.issuerId, listingId: company.listingId, symbol: company.symbol, price: finalPrice, priceMode: transform.priceMode }));
  }
  return Object.freeze({ state: pricingStateSchema.parse({ schemaVersion: 1, engineVersion: PRICE_ENGINE_VERSION,
    tickNo: publicState.tickNo, groupWeights: weights, companies: output }), prices: Object.freeze(prices), contributions: Object.freeze(contributions) });
}

function zeroContribution(reference: string): Omit<PriceContribution, 'issuerId' | 'listingId' | 'tickNo'> {
  return { referencePrice: reference, price: reference, actualReturn: '0', publicRevaluation: '0', commonRisk: '0', sentiment: '0', residual: '0',
    clippingAdjustment: '0', roundingAdjustment: '0', gapLog: '0', valueInnovationLog: '0', marketResidualLog: '0', sentimentLog: '0', residualLog: '0',
    totalLogReturn: '0', unclippedReturn: '0', wasClipped: false };
}
function scaleContribution(contribution: Omit<PriceContribution, 'issuerId' | 'listingId' | 'tickNo'>, reference: string, finalPrice: string): Omit<PriceContribution, 'issuerId' | 'listingId' | 'tickNo'> {
  const factor = new D(contribution.referencePrice).div(reference);
  const actual = new D(finalPrice).div(reference).minus(1);
  const publicRevaluation = new D(contribution.publicRevaluation).mul(factor);
  const commonRisk = new D(contribution.commonRisk).mul(factor); const sentimentMove = new D(contribution.sentiment).mul(factor);
  const residualMove = new D(contribution.residual).mul(factor); const clipping = new D(contribution.clippingAdjustment).mul(factor);
  return { ...contribution, referencePrice: reference, price: finalPrice, actualReturn: text(actual), publicRevaluation: text(publicRevaluation),
    commonRisk: text(commonRisk), sentiment: text(sentimentMove), residual: text(residualMove), clippingAdjustment: text(clipping),
    roundingAdjustment: text(actual.minus(publicRevaluation.plus(commonRisk).plus(sentimentMove).plus(residualMove).plus(clipping))),
    unclippedReturn: text(new D(contribution.unclippedReturn).mul(factor)), totalLogReturn: text(actual.plus(1).ln()) };
}

