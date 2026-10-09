export type BenchmarkKind = 'CASH' | 'HOLD8' | 'PM8';
export type BenchmarkOpeningPolicy = 'EXACT_ACTIVE_OFFSET' | 'LEGACY_BOUNDARY_ONLY' | 'MARKET_ADOPTION';
export interface BenchmarkView {
  readonly kind: BenchmarkKind;
  readonly startTick: number;
  readonly tickNo: number;
  readonly equity: string;
  readonly cash: string;
  readonly totalReturnPct: string;
  readonly fees: string;
  readonly cashInterest: string;
  readonly dividends: string;
  readonly liquidationReceipts: string;
  readonly receivables: string;
  readonly openingPolicy: BenchmarkOpeningPolicy;
  readonly index: string;
}
export interface BenchmarkComparison {
  readonly cash: BenchmarkView;
  readonly hold8: BenchmarkView;
}
