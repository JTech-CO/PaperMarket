import { FinancialDecimal as D, parseMoney, parseRate } from './numeric.js';

/** External cash enters only after this server-valued equity checkpoint. */
export interface CapitalFlow {
  readonly tickNo: number;
  readonly sequenceNo: number;
  readonly eventId: string;
  readonly beforeEquity: string;
  readonly amount: string;
}
export interface LinkedCapitalFlow {
  readonly tickNo: number;
  readonly postEquity: string;
  readonly factor: string;
}

/** Link subperiods at the exact funding boundary, never treating added cash as profit. */
export function linkCapitalFlows(initialCapital: string, flows: readonly CapitalFlow[]): readonly LinkedCapitalFlow[] {
  if (parseMoney(initialCapital) <= 0n) throw new RangeError('Initial capital must be positive.');
  let base = new D(initialCapital); let factor = new D(1);
  let priorTick = -1; let priorSequence = -1;
  const ids = new Set<string>();
  return flows.map(flow => {
    if (!Number.isSafeInteger(flow.tickNo) || flow.tickNo < 0 || !Number.isSafeInteger(flow.sequenceNo) || flow.sequenceNo < 0
        || flow.tickNo < priorTick || (flow.tickNo === priorTick && flow.sequenceNo <= priorSequence)
        || ids.has(flow.eventId) || parseMoney(flow.beforeEquity) < 0n || parseMoney(flow.amount) <= 0n)
      throw new RangeError('Invalid external capital checkpoint.');
    ids.add(flow.eventId); priorTick = flow.tickNo; priorSequence = flow.sequenceNo;
    const before = new D(flow.beforeEquity);
    // A complete loss remains a complete loss in a linked return series after new funding.
    factor = base.gt(0) ? factor.mul(before.div(base)) : new D(0);
    base = before.plus(flow.amount);
    return { tickNo: flow.tickNo, postEquity: base.toString(), factor: parseRate(factor.toString()) };
  });
}

/** Binary search keeps a long tick history linear apart from the infrequent funding checkpoints. */
export function capitalReturnFactor(initialCapital: string, equity: string, linked: readonly LinkedCapitalFlow[], throughTick: number): string {
  if (parseMoney(initialCapital) <= 0n || parseMoney(equity) < 0n || !Number.isSafeInteger(throughTick) || throughTick < 0)
    throw new RangeError('Invalid capital return observation.');
  let low = 0; let high = linked.length;
  while (low < high) { const middle = Math.floor((low + high) / 2); if (linked[middle]!.tickNo <= throughTick) low = middle + 1; else high = middle; }
  const checkpoint = linked[low - 1];
  const factor = checkpoint ? new D(checkpoint.factor).mul(new D(equity).div(checkpoint.postEquity)) : new D(equity).div(initialCapital);
  return parseRate(factor.toString());
}
