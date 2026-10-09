import { FinancialDecimal as D, checkedDecimal } from '../domain/numeric.js';
import { validatePublicEconomy, type PublicEconomy } from '../economy/public.js';
import type { PublicCompanyState, MacroState } from '../economy/types.js';

export interface QuarterForecast {
  readonly quarter: number; readonly revenue: string; readonly operatingProfit: string;
  readonly unleveredTax: string; readonly depreciation: string; readonly capex: string;
  readonly changeWorkingCapital: string; readonly fcff: string; readonly discountFactor: string;
}
export interface ValuationScenario {
  readonly kind: 'BASE' | 'SUCCESS' | 'FAILURE' | 'FUNDING_FAILURE'; readonly probability: string;
  readonly annualNominalWacc: string; readonly quarters: readonly QuarterForecast[];
  readonly residualKind: 'OPERATING_VALUE' | 'ASSET_RECOVERY'; readonly residualValue: string;
  readonly enterpriseValue: string;
}
export interface CompanyValuation {
  readonly issuerId: string; readonly listingId: string; readonly symbol: string;
  readonly scenarios: readonly ValuationScenario[]; readonly enterpriseValue: string;
  readonly cash: string; readonly debt: string; readonly otherFinancingClaims: string;
  readonly declaredDividendLiability: string; readonly continuationValuePerShare: string;
}
type DecimalValue = InstanceType<typeof D>;
const points = (atoms: string) => new D(atoms).div('1e12');
const text = (value: DecimalValue) => checkedDecimal(value).toString();
const clamp = (value: DecimalValue, minimum: string, maximum: string) => D.max(minimum, D.min(maximum, value));

function scenario(company: PublicCompanyState, macro: MacroState, expectedPolicyRate: string, kind: ValuationScenario['kind'], probability: DecimalValue): ValuationScenario {
  const report = company.latestReport;
  const growing = company.category === 'GROWTH' || company.category === 'THEMATIC';
  const thematic = company.category === 'THEMATIC';
  const failure = kind === 'FAILURE' || kind === 'FUNDING_FAILURE';
  // A disclosed policy distribution contributes its mean to the nominal forward
  // discount assumption. This lets an anticipated decision differ from a surprise.
  const forwardPolicy = new D(macro.policyRate).mul('0.4').plus(new D(expectedPolicyRate).mul('0.6'));
  const annualWacc = clamp(forwardPolicy.plus(growing ? '0.065' : '0.04')
    .plus(new D(macro.creditStress).mul('0.035')).plus(kind === 'FUNDING_FAILURE' ? '0.08' : kind === 'FAILURE' ? '0.025' : '0'), '0.025', '0.45');
  const economicGrowth = new D(macro.outputGap).mul('0.12').minus(forwardPolicy.minus('0.03').mul('0.4'));
  const nominalLongRun = clamp(new D(macro.inflation).plus('0.005'), '-0.02', '0.04');
  const startingGrowth = clamp(new D(company.forecast.annualRevenueGrowth).plus(economicGrowth)
    .plus(kind === 'SUCCESS' ? (thematic ? '0.4' : growing ? '0.1' : '0.025') : failure ? '-0.18' : '0'), '-0.45', '0.6');
  let quarterlyRevenue = points(report.revenueAtoms);
  if (kind === 'SUCCESS' && thematic) quarterlyRevenue = quarterlyRevenue.mul('2');
  const priorNwc = points(report.receivablesAtoms).minus(points(report.payablesAtoms));
  const nwcRatio = clamp(priorNwc.div(D.max(1, quarterlyRevenue)), '0.03', '0.5');
  const revenueForRatios = D.max(1, points(report.revenueAtoms));
  // Historical depreciation and CAPEX are separate; the synthetic initialization
  // has no actual reinvestment history, so the explicit baseline is used there.
  const depreciationRatio = report.kind === 'SYNTHETIC_INITIALIZATION' ? new D('0.025')
    : clamp(points(report.depreciationAtoms).div(revenueForRatios), '0', '0.25');
  const baseCapexRatio = report.kind === 'SYNTHETIC_INITIALIZATION' ? new D(growing ? '0.07' : '0.035')
    : clamp(points(report.capexAtoms).div(revenueForRatios), '0.025', '0.4');
  const targetMargin = kind === 'SUCCESS' ? new D(thematic ? '0.18' : growing ? '0.2' : company.forecast.operatingMargin).plus(growing ? '0' : '0.015')
    : new D(company.forecast.operatingMargin).plus(kind === 'BASE' && growing ? '0.09' : failure ? '-0.035' : '0');
  let previousRevenue = quarterlyRevenue;
  let discounted = new D(0);
  const quarters: QuarterForecast[] = [];
  for (let quarter = 1; quarter <= 20; quarter++) {
    const growth = nominalLongRun.plus(startingGrowth.minus(nominalLongRun).mul(new D('0.9').pow(quarter - 1)));
    quarterlyRevenue = quarterlyRevenue.mul(new D(1).plus(growth).pow('0.25'));
    if (failure && quarter > (kind === 'FUNDING_FAILURE' ? 4 : 8)) quarterlyRevenue = new D(0);
    const transition = D.min(1, new D(quarter).div(thematic ? 12 : 8));
    const margin = new D(company.forecast.operatingMargin).mul(new D(1).minus(transition)).plus(targetMargin.mul(transition));
    const operatingProfit = quarterlyRevenue.mul(margin);
    const unleveredTax = D.max(0, operatingProfit).mul('0.2');
    const depreciation = quarterlyRevenue.mul(depreciationRatio);
    const growthCapex = D.max(0, quarterlyRevenue.minus(previousRevenue)).mul(growing ? '0.65' : '0.3');
    const capex = quarterlyRevenue.mul(baseCapexRatio).plus(growthCapex);
    const deltaNwc = quarterlyRevenue.minus(previousRevenue).mul(nwcRatio);
    const fcff = operatingProfit.minus(unleveredTax).plus(depreciation).minus(capex).minus(deltaNwc);
    const discountFactor = new D(1).plus(annualWacc).pow(new D(quarter).div(4));
    discounted = discounted.plus(fcff.div(discountFactor));
    quarters.push({ quarter, revenue: text(quarterlyRevenue), operatingProfit: text(operatingProfit), unleveredTax: text(unleveredTax),
      depreciation: text(depreciation), capex: text(capex), changeWorkingCapital: text(deltaNwc), fcff: text(fcff), discountFactor: text(discountFactor) });
    previousRevenue = quarterlyRevenue;
  }
  // Alternative residual branches, never asset recovery plus an operating terminal value.
  const lastFcff = new D(quarters.at(-1)!.fcff);
  const residual = failure
    ? D.max(0, points(report.operatingAssetsAtoms)).mul(kind === 'FUNDING_FAILURE' ? '0.2' : '0.35')
    : D.max(0, lastFcff).mul(4).mul(growing ? '8' : '7');
  const enterpriseValue = discounted.plus(residual.div(new D(1).plus(annualWacc).pow(5)));
  return Object.freeze({ kind, probability: text(probability), annualNominalWacc: text(annualWacc), quarters: Object.freeze(quarters),
    residualKind: failure ? 'ASSET_RECOVERY' : 'OPERATING_VALUE', residualValue: text(residual), enterpriseValue: text(enterpriseValue) });
}

/** The only runtime boundary is the separately validated public information domain. */
export function valueCompanies(input: PublicEconomy): readonly CompanyValuation[] {
  const state = validatePublicEconomy(input);
  return Object.freeze(state.companies.map((baseCompany) => {
    const company = publicEventCompany(baseCompany, state.eventDisclosures, state.tickNo);
    const success = new D(company.forecast.successProbability);
    const fundingFailure = new D(company.forecast.fundingFailureProbability);
    const remaining = new D(1).minus(success).minus(fundingFailure);
    const scenarios = [scenario(company, state.observedMacro, state.policyExpectation.expectedRate, 'SUCCESS', success),
      scenario(company, state.observedMacro, state.policyExpectation.expectedRate, company.category === 'THEMATIC' ? 'FAILURE' : 'BASE', remaining),
      scenario(company, state.observedMacro, state.policyExpectation.expectedRate, 'FUNDING_FAILURE', fundingFailure)];
    const ev = scenarios.reduce((total, branch) => total.plus(new D(branch.enterpriseValue).mul(branch.probability)), new D(0));
    const cash = D.max(0, points(company.latestReport.cashAtoms).plus(points(company.corporateCashAdjustmentAtoms)));
    const debt = D.max(0, points(company.latestReport.debtAtoms).plus(points(company.corporateDebtAdjustmentAtoms)));
    // Trade payables are operating working capital. Accrued financing/tax claims
    // remain senior claims and are counted once alongside debt.
    const other = D.max(0, points(company.latestReport.liabilitiesAtoms).minus(points(company.latestReport.debtAtoms))
      .minus(points(company.latestReport.payablesAtoms)).minus(points(company.latestReport.dividendPayableAtoms)).plus(points(company.corporateLiabilityAdjustmentAtoms)));
    // Reserved cash remains cash. Its payable is deducted here exactly once,
    // independently of whether the right is still attached to the stock.
    const declared = company.dividends.reduce((total, dividend) => total.plus(points(dividend.remainingPayableAtoms)), new D(0));
    const equity = D.max(0, ev.plus(cash).minus(debt).minus(other).minus(declared));
    return Object.freeze({ issuerId: company.issuerId, listingId: company.listingId, symbol: company.symbol,
      scenarios: Object.freeze(scenarios), enterpriseValue: text(ev), cash: text(cash), debt: text(debt),
      otherFinancingClaims: text(other), declaredDividendLiability: text(declared), continuationValuePerShare: text(equity.div(company.issuedShares)) });
  }));
}

import { publicEventCompany } from '../events/public.js';
