import type { FinancialView, MarketView, PerformanceView, StockView } from '../../src/application/contracts.js';
import type { BenchmarkView } from '../../src/reporting/benchmark-types.js';
import { INITIAL_COMPANIES } from '../../src/fixtures/initial-companies.js';
import { errorEmbed } from '../../src/discord/messages.js';
import { renderFinancial, renderMarket, renderPerformance, renderStock, replyView, type ReplyView } from '../../src/discord/render.js';

const at = '2026-10-09T00:00:00.000Z';
const meta = { tickNo: 68, marketVersion: 69, updatedAt: at, nextBoundaryAt: '2026-10-09T00:05:00.000Z', state: 'OPEN' };
const financial: FinancialView = {
  symbol: 'RVI', name: '리버인프라', reportKind: 'ACTUAL', quarterNo: 1, closedTick: 63, publishedTick: 67, nextEarningsTick: 130,
  revenue: '450000000', operatingProfit: '72000000', interestExpense: '6000000', netProfit: '49500000', cash: '175000000', debt: '400000000',
  operatingCashFlow: '60000000', capex: '25000000', annualRevenueForecast: '1850000000', operatingMarginForecast: '0.16', growthForecast: '0.04',
  generation: 1, lifecycle: 'OPERATING', dividends: [{ id: 'fixture-dividend', dps: '15', status: 'EX_ENTITLED', declaredTick: 67, exTick: 68, payTick: 70, recoveryRatio: '1' }],
};
const stock: StockView = {
  ...meta, listing: { listingId: 'fixture-listing', symbol: 'RVI', name: '리버인프라', slotId: 'D1', category: 'DIVIDEND', price: '985', generation: 1 },
  currentPrice: '985', referencePrice: '985', previousRawPrice: '1000', exAdjustment: true, financial,
  latestDisclosures: [{ id: 'fixture-disclosure', kind: 'CORPORATE_ACTION', publishedTick: 67, symbol: 'RVI', title: '분기배당 결의', summary: '주당 15.00 · 권리 확정 68틱 · 지급 70틱. 지급과 가격 변동 위험이 있습니다.' }],
  lifecycle: 'OPERATING', generation: 1, businessSummary: '장기 계약 기반 인프라 운영 · 실적·현금흐름·금리와 시장 기대가 모의 시세에 반영됩니다.',
};
function baseline(kind: BenchmarkView['kind'], totalReturnPct: string): BenchmarkView {
  return { kind, startTick: kind === 'PM8' ? 5 : 12, tickNo: 68, equity: '10120', cash: '520', totalReturnPct, fees: '8', cashInterest: '20', dividends: '25', liquidationReceipts: '0', receivables: '15', openingPolicy: kind === 'PM8' ? 'MARKET_ADOPTION' : 'LEGACY_BOUNDARY_ONLY', index: '101.2' };
}

/** Synthetic DTO fixtures passed through production renderers; these do not depict a live Discord client. */
export function visualQaFixtures(): Readonly<Record<string, ReplyView>> {
  const market: MarketView = {
    ...meta, marketId: 'fixture-market', sequenceNo: 100, priceSource: 'ECONOMY', channelId: null, boardMessageId: null,
    listings: INITIAL_COMPANIES.map((company, index) => ({ listingId: company.listingId, symbol: company.symbol, name: company.name, category: company.category, slotId: company.slotId, price: index === 7 ? '985' : '1000', changePct: index % 3 === 0 ? '1.25' : index % 3 === 1 ? '-0.75' : '0', generation: 1 })),
    pm8: baseline('PM8', '1.2'),
  };
  const performance: PerformanceView = {
    ...meta, equity: '10120', totalReturnPct: '1.2', previousTickChangePct: '-0.5', maxDrawdownPct: '4.3',
    realizedPnl: '20', unrealizedPnl: '50', fees: '8', cashInterest: '20', dividends: '25', liquidation: '0', otherRightsPnl: '5', rounding: '0',
    reconciled: true, cashWeightPct: '5.15', startedTick: 12, currentTick: 68, missingHistory: true, sampleCount: 12,
    drawdownDefinition: '매 확정 틱의 순자산 표본에서 직전 최고 순자산 대비 하락률의 최댓값을 계산합니다. 지급 전 권리와 발생 이자를 한 번 포함합니다.',
    baselines: { cash: baseline('CASH', '0.4'), hold8: baseline('HOLD8', '1.3') }, pm8: market.pm8!,
  };
  return {
    'company-ex': renderStock(stock),
    'company-retired': renderStock({ ...stock, lifecycle: 'EXTINGUISHED', currentPrice: '0', referencePrice: '0', previousRawPrice: '120', exAdjustment: false, financial: { ...financial, lifecycle: 'EXTINGUISHED', dividends: [] } }),
    'financial-paused': renderFinancial(financial, { ...meta, state: 'PAUSED' }),
    market: renderMarket(market), performance: renderPerformance(performance), 'stale-quote': replyView(errorEmbed('STALE_QUOTE')),
  };
}

