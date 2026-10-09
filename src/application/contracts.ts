import type { InitialCompanyCategory, InitialSlotId } from '../fixtures/initial-companies.js';
import type { BenchmarkComparison, BenchmarkView } from '../reporting/benchmark-types.js';
import type { AlertSettingsView, InboxView, NotificationDelivery } from '../notifications/types.js';

/** Created by the Gateway adapter. Never take identity/permissions/time from command options. */
export interface ServiceContext {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly interactionId: string;
  readonly receivedAt: string;
  readonly guildPermissions: string;
}
export type ServiceRequest =
  | { readonly type: 'setup'; readonly context: ServiceContext; readonly channelId: string }
  | { readonly type: 'save-board'; readonly context: ServiceContext; readonly channelId: string; readonly messageId: string }
  | { readonly type: 'open'; readonly context: ServiceContext; readonly age14Plus: boolean; readonly agreeTerms: boolean }
  | { readonly type: 'funding'; readonly context: ServiceContext; readonly enabled?: boolean }
  | { readonly type: 'market' | 'portfolio' | 'status' | 'orders'; readonly context: ServiceContext }
  | { readonly type:'company';readonly context:ServiceContext;readonly symbol:string;readonly generation?:number }
  | { readonly type:'news';readonly context:ServiceContext;readonly beforeTick?:number;readonly symbol?:string;readonly cursor?:string }
  | { readonly type:'calendar'|'performance';readonly context:ServiceContext }
  | { readonly type:'chart';readonly context:ServiceContext;readonly symbol:string;readonly generation?:number;readonly series?:'PRICE'|'TOTAL_RETURN';readonly scale?:'LINEAR'|'LOG';readonly limit?:number }
  | { readonly type:'export';readonly context:ServiceContext;readonly format:'CSV'|'JSON';readonly beforeSequence?:number;readonly beforeEventId?:string;readonly limit?:number }
  | { readonly type:'alerts';readonly context:ServiceContext;readonly dmEnabled?:boolean;readonly symbol?:string;readonly direction?:'ABOVE'|'BELOW';readonly threshold?:string;readonly removePriceAlertId?:string;readonly watch?:boolean;readonly beforeId?:string;readonly markRead?:boolean }
  | { readonly type:'cancel-order';readonly context:ServiceContext;readonly orderId:string }
  | { readonly type: 'history'; readonly context: ServiceContext; readonly limit?: number;readonly beforeSequence?:number;readonly beforeEventId?:string }
  | { readonly type: 'quote'; readonly context: ServiceContext; readonly symbol: string;
      readonly side: 'BUY' | 'SELL'; readonly quantity?: string; readonly budget?: string; readonly budgetPercent?: 25 | 50 | 100; readonly all?: boolean;readonly generation?:number;
      readonly orderType?:'MARKET'|'LIMIT'|'STOP';readonly conditionPrice?:string;readonly timeInForce?:'TICK_COUNT'|'UNTIL_CANCELLED';readonly validForTicks?:number }
  | { readonly type: 'confirm' | 'cancel'; readonly context: ServiceContext; readonly token: string }
  | { readonly type: 'close'; readonly context: ServiceContext; readonly confirmed: boolean }
  | { readonly type: 'tick'; readonly now: string }
  | { readonly type: 'recover'; readonly now: string }
  | InternalNotificationRequest;
export type InternalNotificationRequest =
  | {readonly type:'notification-poll';readonly now:string;readonly limit?:number}
  | {readonly type:'notification-check';readonly now:string;readonly jobId:string;readonly leaseToken:string}
  | {readonly type:'notification-ack';readonly now:string;readonly jobId:string;readonly leaseToken:string;readonly delivered:boolean;readonly retryAfterMs?:number};
export type BackendRequest = ServiceRequest;

export interface ListingView {
  readonly listingId: string; readonly symbol: string; readonly name: string;
  readonly slotId: InitialSlotId; readonly category: InitialCompanyCategory;
  readonly price: string;
  readonly changePct?: string;
  readonly generation?: number; readonly lifecycle?: string;
}
export interface FinancialView {
  readonly symbol: string; readonly name: string;
  readonly reportKind: 'SYNTHETIC_INITIALIZATION' | 'ACTUAL';
  readonly quarterNo: number; readonly closedTick: number; readonly publishedTick: number; readonly nextEarningsTick: number;
  readonly revenue: string; readonly operatingProfit: string; readonly interestExpense: string; readonly netProfit: string;
  readonly cash: string; readonly debt: string; readonly operatingCashFlow: string; readonly capex: string;
  readonly annualRevenueForecast: string; readonly operatingMarginForecast: string; readonly growthForecast: string;
  readonly generation?: number; readonly lifecycle?: string;
  readonly dividends?: readonly { readonly id:string; readonly dps:string; readonly status:string; readonly declaredTick:number; readonly exTick:number; readonly payTick:number; readonly recoveryRatio:string }[];
}
export interface DisclosureView {
  readonly id: string; readonly kind: 'MACRO' | 'EARNINGS' | 'CORPORATE_ACTION' | 'EVENT'; readonly publishedTick: number;
  readonly symbol: string | null; readonly title: string; readonly summary: string;
}
/** Committed, already disclosed facts and estimates only. No seed, private ledgers or future results. */
export interface EconomyView {
  readonly engineVersion: string; readonly economyTick: number;
  readonly macro: {
    readonly policyRate: string; readonly cashAnnualRate: string; readonly cashDailyRate: string;
    readonly inflation: string; readonly outputGap: string; readonly industrialDemand: string; readonly consumerDemand: string;
    readonly metals: string; readonly energy: string; readonly fx: string; readonly creditStress: string; readonly riskAppetite: string;
    readonly observedTick: number; readonly nextMeetingTick: number;
    readonly policyProbabilities: { readonly decrease: string; readonly unchanged: string; readonly increase: string };
  };
  readonly companies: readonly FinancialView[]; readonly disclosures: readonly DisclosureView[];
}
export interface MarketView {
  readonly marketId: string; readonly state: string; readonly tickNo: number;
  readonly marketVersion: number; readonly sequenceNo: number;
  readonly nextBoundaryAt: string; readonly updatedAt: string; readonly priceSource: 'TRIAL' | 'ECONOMY';
  readonly channelId: string | null; readonly boardMessageId: string | null;
  readonly listings: readonly ListingView[];
  readonly economy?: EconomyView;
  readonly pm8?:BenchmarkView;
}
export interface AccountView {
  readonly accountId: string; readonly status: 'ACTIVE' | 'CLOSED';
  readonly accountVersion: number; readonly createdAt: string; readonly cash: string;
}
export interface QuoteView {
  readonly token: string; readonly orderIntentId: string; readonly symbol: string;
  readonly side: 'BUY' | 'SELL'; readonly quantity: string; readonly price: string;
  readonly gross: string; readonly fee: string; readonly total: string; readonly cashAfter: string;
  readonly marketVersion: number; readonly expiresAt: string;
  readonly orderType?:'MARKET'|'LIMIT'|'STOP';readonly conditionPrice?:string;readonly timeInForce?:'TICK_COUNT'|'UNTIL_CANCELLED';readonly expiresTick?:number|null;
  readonly reservedCash?:string;readonly reservedQuantity?:string;
}
export interface ScheduledOrderView {
  readonly orderId:string;readonly symbol:string;readonly side:'BUY'|'SELL';readonly orderType:'LIMIT'|'STOP';readonly quantity:string;readonly conditionPrice:string;
  readonly timeInForce:'TICK_COUNT'|'UNTIL_CANCELLED';readonly expiresTick:number|null;readonly status:'OPEN'|'FILLED'|'CANCELLED'|'EXPIRED';
  readonly reservedCash:string;readonly reservedQuantity:string;readonly sequenceNo:number;readonly createdTick:number;readonly terminationReason?:string;
}
export interface FillView {
  readonly orderId: string; readonly fillId: string; readonly symbol: string;
  readonly side: 'BUY' | 'SELL'; readonly quantity: string; readonly price: string;
  readonly gross: string; readonly fee: string; readonly total: string; readonly cashAfter: string;
  readonly realizedPnl: string; readonly createdAt: string; readonly marketVersion: number; readonly tickNo: number;
}
export interface PositionView {
  readonly listingId: string; readonly symbol: string; readonly name: string;
  readonly quantity: string; readonly price: string; readonly value: string;
  readonly cost: string; readonly unrealizedPnl: string;
  readonly availableQuantity?:string;readonly reservedQuantity?:string;
}
export interface PortfolioView {
  readonly account: AccountView; readonly marketVersion: number;
  readonly positions: readonly PositionView[];
  readonly equity: string; readonly totalReturnPct: string;
  readonly initialCapital?: string; readonly contributions?: string; readonly netInvestmentPnl?: string;
  readonly nextContributionTick?: number | null;
  readonly accruedCashInterest?: string; readonly cashInterestTotal?: string;
  readonly rights?: readonly RightsView[];
  readonly dividendTotal?: string; readonly liquidationTotal?: string;
  readonly availableCash?:string;readonly reservedCash?:string;
}
export interface RightsView {
  readonly rightId:string; readonly kind:'DIVIDEND'|'LIQUIDATION'; readonly symbol:string;
  readonly status:'ATTACHED'|'OPEN'|'IMPAIRED'|'SETTLED'; readonly quantity:string;
  readonly nominal:string; readonly currentValue:string; readonly paid:string; readonly cost:string; readonly realizedPnl:string;
  readonly eligibleTick:number; readonly paymentTick:number;
}
export interface PublicViewMeta {
  readonly tickNo:number;readonly marketVersion:number;readonly updatedAt:string;readonly nextBoundaryAt:string;readonly state:string;
}
export interface StockView extends PublicViewMeta {
  readonly listing:ListingView;readonly currentPrice:string;readonly referencePrice:string;readonly previousRawPrice:string|null;
  readonly exAdjustment:boolean;readonly financial:FinancialView|null;readonly latestDisclosures:readonly DisclosureView[];
  readonly lifecycle:string;readonly generation:number;readonly businessSummary:string;
}
export interface CalendarItem {
  readonly kind:'EARNINGS'|'POLICY'|'DIVIDEND_EX'|'DIVIDEND_PAYMENT';readonly title:string;readonly symbol:string|null;
  readonly announcedTick:number;readonly eventTick:number;readonly generation:number|null;
}
export interface CalendarView extends PublicViewMeta {readonly items:readonly CalendarItem[]}
export interface NewsView extends PublicViewMeta {readonly items:readonly DisclosureView[];readonly more:boolean;readonly nextBeforeTick:number|null;readonly nextCursor?:string|null}
export interface ChartView extends PublicViewMeta {
  readonly listingId:string;readonly symbol:string;readonly name:string;readonly generation:number;
  readonly series:'PRICE'|'TOTAL_RETURN';readonly scale:'LINEAR'|'LOG';readonly lifecycle:string;
  readonly points:readonly {readonly tickNo:number;readonly at:string;readonly value:string}[];
  readonly annotations:readonly {readonly tickNo:number;readonly label:string}[];
}
export interface PerformanceView extends PublicViewMeta {
  readonly equity:string;readonly totalReturnPct:string;readonly previousTickChangePct:string|null;readonly maxDrawdownPct:string;
  readonly initialCapital?: string; readonly contributions?: string; readonly netInvestmentPnl?: string;
  readonly nextContributionTick?: number | null;
  readonly realizedPnl:string;readonly unrealizedPnl:string;readonly fees:string;readonly cashInterest:string;readonly dividends:string;
  readonly liquidation:string;readonly otherRightsPnl:string;readonly rounding:string;readonly reconciled:boolean;readonly cashWeightPct:string;
  readonly startedTick:number;readonly currentTick:number;readonly missingHistory:boolean;readonly sampleCount:number;
  readonly drawdownDefinition:string;readonly baselines:BenchmarkComparison;readonly pm8:BenchmarkView;
}
export interface HistoryEntry {
  readonly eventId:string;readonly kind:'FILL'|'DIVIDEND'|'INTEREST'|'LIQUIDATION'|'CORRECTION'|'INITIAL_GRANT'|'CONTRIBUTION';
  readonly tickNo:number;readonly sequenceNo:number;readonly marketVersion:number;readonly createdAt:string;
  readonly symbol:string|null;readonly title:string;readonly amount:string;
}
export interface ExportView {
  readonly files:readonly {readonly name:string;readonly content:string;readonly mimeType:string}[];
  readonly recordCount:number;readonly nextBeforeSequence:number|null;readonly nextBeforeEventId?:string|null;readonly truncated:boolean;
}
export interface AlertsView {readonly settings:AlertSettingsView;readonly inbox:InboxView;readonly dmEnabled:boolean}
export interface FundingView {
  readonly enabled: boolean; readonly amount: string; readonly intervalTicks: number;
  readonly startTick: number; readonly nextContributionTick: number | null; readonly contributions: string;
}
export type ServiceErrorCode =
  | 'INVALID_INPUT' | 'PERMISSION_DENIED' | 'MARKET_NOT_FOUND' | 'MARKET_PAUSED' | 'MARKET_UPDATING'
  | 'ACCOUNT_NOT_FOUND' | 'ACCOUNT_CLOSED' | 'ACKNOWLEDGEMENTS_REQUIRED'
  | 'INSUFFICIENT_CASH' | 'INSUFFICIENT_SHARES' | 'STALE_QUOTE' | 'ORDER_EXPIRED'
  | 'ORDER_CANCELLED' | 'CORPORATE_ACTION_CANCELLED' | 'INTENT_NOT_FOUND' | 'LISTING_NOT_TRADABLE' | 'INVALID_PRECISION'
  | 'IDEMPOTENCY_CONFLICT' | 'BUSY' | 'INTEGRITY_ERROR' | 'INTERNAL_ERROR';
export type ServiceResponse =
  | { readonly kind: 'SETUP'; readonly market: MarketView; readonly previousBoard?: { readonly channelId: string; readonly messageId: string } }
  | { readonly kind: 'MARKET' | 'STATUS'; readonly market: MarketView }
  | { readonly kind: 'ACCOUNT'; readonly account: AccountView }
  | { readonly kind: 'FUNDING'; readonly funding: FundingView }
  | { readonly kind: 'QUOTE'; readonly quote: QuoteView }
  | { readonly kind: 'FILLED'; readonly fill: FillView }
  | { readonly kind:'ORDER_OPENED';readonly order:ScheduledOrderView }
  | { readonly kind:'ORDERS';readonly orders:readonly ScheduledOrderView[] }
  | { readonly kind:'SCHEDULED_CANCELLED';readonly order:ScheduledOrderView }
  | { readonly kind: 'CANCELLED'; readonly orderIntentId: string }
  | { readonly kind: 'CLOSED'; readonly accountId: string }
  | { readonly kind: 'PORTFOLIO'; readonly portfolio: PortfolioView }
  | { readonly kind: 'HISTORY'; readonly fills: readonly FillView[];readonly entries?:readonly HistoryEntry[];readonly nextBeforeSequence?:number|null;readonly nextBeforeEventId?:string|null }
  | {readonly kind:'STOCK';readonly stock:StockView}
  | {readonly kind:'NEWS';readonly news:NewsView}
  | {readonly kind:'CALENDAR';readonly calendar:CalendarView}
  | {readonly kind:'CHART';readonly chart:ChartView}
  | {readonly kind:'PERFORMANCE';readonly performance:PerformanceView}
  | {readonly kind:'EXPORT';readonly export:ExportView}
  | {readonly kind:'ALERTS';readonly alerts:AlertsView}
  | {readonly kind:'NOTIFICATION_BATCH';readonly deliveries:readonly NotificationDelivery[]}
  | {readonly kind:'NOTIFICATION_AUTHORIZED';readonly authorized:boolean}
  | {readonly kind:'NOTIFICATION_ACK';readonly accepted:boolean}
  | { readonly kind: 'BOARD_SAVED' }
  | { readonly kind: 'TICKED'; readonly markets: readonly MarketView[] }
  | { readonly kind: 'RECOVERED' }
  | { readonly kind: 'ERROR'; readonly code: ServiceErrorCode };

export interface Backend {
  execute(request: BackendRequest): Promise<ServiceResponse>;
}
