import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { cashTimeInterest, settleTickCashInterest } from '../domain/cash-interest.js';
import { dividendRightMark } from '../domain/corporate-rights.js';
import { marketIdSchema, accountIdSchema, listingIdSchema, tickNoSchema } from '../domain/identifiers.js';
import {
  FinancialDecimal as D, MONEY_SCALE, addFractions, decimalFraction, fraction,
  moneyFromAtoms, moneyToString, multiplyFractions, parseFraction, parseOrderQuantity, parsePrice, parseQuantity,
  parseRate, quantizeMoney, serializeFraction, type Fraction,
} from '../domain/numeric.js';
import { STANDARD_RULESET } from '../domain/ruleset.js';
import { maxAffordableQuantity, settleAccrual, settleBuy, settleSell } from '../domain/settlement.js';
import { canonicalEconomyJson, economySnapshotHash } from '../economy/repository.js';
import { publicCorporateActionSchema, validatePublicEconomy } from '../economy/public.js';
import type { CorporateAction, CorporateDividend } from '../economy/types.js';
import { pricingStateSchema } from '../market/pricing.js';
import { LedgerIntegrityError } from '../storage/replay.js';
import { verifyDatabaseSchema } from '../storage/migrations.js';
import type { BenchmarkComparison, BenchmarkKind, BenchmarkOpeningPolicy, BenchmarkView } from './benchmark-types.js';

const atom = z.string().max(51).refine(value => { try { return moneyFromAtoms(value) >= 0n; } catch { return false; } });
const quantity = z.string().max(96).refine(value => { try { return parseQuantity(value) === value; } catch { return false; } });
const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:-]+$/);
const exact = z.strictObject({ numerator: z.string().max(4096).regex(/^(?:0|[1-9]\d*)$/), denominator: z.string().max(4096).regex(/^[1-9]\d*$/) });
const position = z.strictObject({ listingId: listingIdSchema, quantity, costAtoms: atom });
const right = z.strictObject({ id, listingId: listingIdSchema, kind: z.enum(['DIVIDEND', 'LIQUIDATION']), quantity,
  nominal: exact, mark: exact, costAtoms: atom, paymentTick: tickNoSchema, attached: z.boolean(),
  totalNominalAtoms: atom, dps: z.string().max(96), recoveryRatio: z.string().max(96) });
const stateSchema = z.strictObject({
  cashAtoms: atom, feesAtoms: atom, interestAtoms: atom, dividendAtoms: atom, liquidationAtoms: atom,
  realizedProfitAtoms: z.string().max(51).refine(value => { try { moneyFromAtoms(value); return true; } catch { return false; } }),
  interestCarry: exact, dividendCarry: exact, liquidationCarry: exact,
  positions: z.array(position).max(8), rights: z.array(right).max(1024),
  // Optional fields preserve the exact canonical JSON and hashes of legacy snapshots.
  contributionsAtoms: atom.optional(),
  timeWeightedFactor: z.string().max(96).refine(value => { try { return new D(parseRate(value)).gte(0); } catch { return false; } }).optional(),
}).superRefine((state, context) => {
  if (new Set(state.positions.map(item => item.listingId)).size !== state.positions.length || new Set(state.rights.map(item => item.id)).size !== state.rights.length)
    context.addIssue({ code: 'custom', message: 'Duplicate benchmark ownership' });
  for (const carry of [state.interestCarry, state.dividendCarry, state.liquidationCarry]) {
    const parsed = parseFraction(carry);
    if (parsed.numerator * MONEY_SCALE >= parsed.denominator) context.addIssue({ code: 'custom', message: 'Benchmark carry exceeds one atom' });
  }
  for (const item of state.rights) { parseFraction(item.nominal); parseFraction(item.mark); parseRate(item.dps); parseRate(item.recoveryRatio); }
});
type State = z.infer<typeof stateSchema>;
/** Shared exact shadow-account contract for offline, public-information model validation. */
export type BenchmarkState = State;
interface Series { market_id: string; series_id: string; account_id: string | null; kind: BenchmarkKind;
  start_tick: number; opening_elapsed_ms: number; opening_policy: BenchmarkOpeningPolicy }
interface Snapshot { market_id: string; series_id: string; tick_no: number; market_version: number; source_hash: string;
  previous_hash: string; state_json: string; equity_json: string; state_hash: string }
interface Frame { tick: number; version: number; engineTick: number; hash: string; dailyRate: string; annualRate: string;
  prices: ReadonlyMap<string, string>; actions: readonly CorporateAction[]; dividends: readonly CorporateDividend[] }
export type BenchmarkFrame = Frame;
interface PublicSource { snapshot_json: string; snapshot_hash: string; market_version: number; engine_tick: number }
const zero = () => serializeFraction(fraction(0n));
const points = (atoms: bigint | string) => moneyToString(moneyFromAtoms(atoms.toString()));
const signed = (atoms: bigint) => moneyFromAtoms(atoms.toString()).toString();
function snapshotHash(row: Omit<Snapshot, 'state_hash'>): string {
  return createHash('sha256').update(canonicalEconomyJson(row)).digest('hex');
}
export { initialState as createBenchmarkState, equity as benchmarkEquity, buyEqual as buyBenchmarkEqual,
  sellAll as sellBenchmarkAll, advanceState as advanceBenchmarkState };
export function validateBenchmarkState(input:unknown):BenchmarkState {return stateSchema.parse(input);}
const verifiedSourceHashes=new Map<string,{json:string;rate:string;actions:readonly string[];hash:string}>();
const positionValuations=new Map<string,Fraction>();
function sourceHash(row: PublicSource, dailyRate: string, actions: readonly { action_json: string }[]): string {
  const prior=verifiedSourceHashes.get(row.snapshot_hash);
  if(prior?.json===row.snapshot_json&&prior.rate===dailyRate&&prior.actions.length===actions.length&&prior.actions.every((action,index)=>action===actions[index]!.action_json))return prior.hash;
  if (createHash('sha256').update(row.snapshot_json).digest('hex') !== row.snapshot_hash)
    throw new LedgerIntegrityError('Benchmark public snapshot hash differs.');
  const encodedActions=actions.map(item=>item.action_json);
  const hash=economySnapshotHash([row.snapshot_hash,parseRate(dailyRate),encodedActions]);
  verifiedSourceHashes.set(row.snapshot_hash,{json:row.snapshot_json,rate:dailyRate,actions:encodedActions,hash});
  if(verifiedSourceHashes.size>64)verifiedSourceHashes.delete(verifiedSourceHashes.keys().next().value!);
  return hash;
}
function initialState(): State {
  return { cashAtoms: STANDARD_RULESET.initialCash.toString(), feesAtoms: '0', interestAtoms: '0', dividendAtoms: '0', liquidationAtoms: '0',
    realizedProfitAtoms: '0', interestCarry: zero(), dividendCarry: zero(), liquidationCarry: zero(), positions: [], rights: [] };
}
function equity(state: State, frame: Frame): Fraction {
  let result = fraction(BigInt(state.cashAtoms), MONEY_SCALE);
  const inputs=state.positions.map(item=>{
    const price = frame.prices.get(item.listingId);
    if (!price) throw new LedgerIntegrityError('Benchmark holding lost its price without a corporate action.');
    return [item.quantity,price] as const;
  });
  // Cache only a pure sum of exact string inputs, never cash, rights, owner or accrued interest.
  const key=JSON.stringify(inputs);
  let positions=positionValuations.get(key);
  if(!positions){positions=inputs.reduce((sum,[quantity,price])=>addFractions(sum,multiplyFractions(decimalFraction(quantity),decimalFraction(price))),fraction(0n));positionValuations.set(key,positions);if(positionValuations.size>256)positionValuations.delete(positionValuations.keys().next().value!);}
  result=addFractions(result,positions);
  for (const item of state.rights) if (!item.attached) result = addFractions(result, parseFraction(item.mark));
  for (const carry of [state.interestCarry, state.dividendCarry, state.liquidationCarry]) result = addFractions(result, parseFraction(carry));
  return result;
}
function buyEqual(state: State, prices: ReadonlyMap<string, string>): State {
  if (prices.size !== 8) throw new LedgerIntegrityError('Equal-weight benchmark requires eight active listings.');
  const budget = BigInt(state.cashAtoms) / 8n;
  const result = structuredClone(state);
  for (const [listingId, priceText] of [...prices].toSorted(([a], [b]) => a.localeCompare(b))) {
    const price = parsePrice(priceText);
    const unit = multiplyFractions(decimalFraction(price), addFractions(fraction(1n), decimalFraction(STANDARD_RULESET.tradeFeeRate)));
    // The six-decimal quantity boundary may leave an unspendable budget in cash.
    if (budget * unit.denominator * 1_000_000n < MONEY_SCALE * unit.numerator) continue;
    const amount = maxAffordableQuantity(moneyFromAtoms(budget.toString()), price, STANDARD_RULESET.tradeFeeRate);
    const trade = settleBuy(price, amount, STANDARD_RULESET.tradeFeeRate);
    result.cashAtoms = signed(BigInt(result.cashAtoms) - trade.money);
    result.feesAtoms = signed(BigInt(result.feesAtoms) + quantizeMoney(trade.fee, 'floor').money);
    result.positions.push({ listingId: listingIdSchema.parse(listingId), quantity: amount, costAtoms: trade.money.toString() });
  }
  return stateSchema.parse(result);
}
function sellAll(state: State, frame: Frame): State {
  const result = structuredClone(state);
  for (const item of result.positions) {
    const price = frame.prices.get(item.listingId);
    if (!price) throw new LedgerIntegrityError('A retired benchmark position must first become a claim.');
    const trade = settleSell(parsePrice(price), parseOrderQuantity(item.quantity), STANDARD_RULESET.tradeFeeRate);
    result.cashAtoms = signed(BigInt(result.cashAtoms) + trade.money);
    result.feesAtoms = signed(BigInt(result.feesAtoms) + quantizeMoney(trade.fee, 'floor').money);
    result.realizedProfitAtoms = signed(BigInt(result.realizedProfitAtoms) + trade.money - BigInt(item.costAtoms));
  }
  result.positions = [];
  return result;
}
function payout(state: State, claim: State['rights'][number], amount: Fraction): void {
  const field = claim.kind === 'DIVIDEND' ? 'dividendCarry' : 'liquidationCarry';
  const result = settleAccrual(amount, parseFraction(state[field]));
  state.cashAtoms = signed(BigInt(state.cashAtoms) + result.money);
  state[field] = serializeFraction(result.carry);
  const total = claim.kind === 'DIVIDEND' ? 'dividendAtoms' : 'liquidationAtoms';
  state[total] = signed(BigInt(state[total]) + result.money);
  if (claim.kind === 'LIQUIDATION') state.realizedProfitAtoms = signed(BigInt(state.realizedProfitAtoms) + result.money - BigInt(claim.costAtoms));
  state.rights = state.rights.filter(item => item.id !== claim.id);
}
function dividendClaim(dividend: CorporateDividend, held: State['positions'][number], frame: Frame, attached = false): State['rights'][number] {
  return { id: dividend.id, listingId: listingIdSchema.parse(dividend.listingId), kind: 'DIVIDEND', quantity: held.quantity,
    nominal: serializeFraction(multiplyFractions(decimalFraction(held.quantity), fraction(BigInt(dividend.totalNominalAtoms), MONEY_SCALE * BigInt(dividend.issuedShares)))),
    mark: serializeFraction(multiplyFractions(decimalFraction(held.quantity), decimalFraction(dividendRightMark(dividend.dps, dividend.recoveryRatio, frame.annualRate, Math.max(0, dividend.payTick - frame.engineTick))))),
    costAtoms: '0', paymentTick: tickNoSchema.parse(dividend.payTick), attached, totalNominalAtoms: dividend.totalNominalAtoms, dps: dividend.dps, recoveryRatio: dividend.recoveryRatio };
}
function advanceState(prior: State, previous: Frame, current: Frame, elapsed: number): State {
  const state = structuredClone(prior);
  const paid = settleTickCashInterest(cashTimeInterest(state.cashAtoms, previous.dailyRate, elapsed), parseFraction(state.interestCarry));
  state.cashAtoms = signed(BigInt(state.cashAtoms) + paid.money);
  state.interestAtoms = signed(BigInt(state.interestAtoms) + paid.money);
  state.interestCarry = serializeFraction(paid.carry);
  for (const action of current.actions) {
    const held = state.positions.find(item => item.listingId === action.listingId);
    if (action.kind === 'DIVIDEND_EX') {
      const attached = state.rights.find(item => item.id === action.dividend.id);
      if (attached) attached.attached = false;
      else if (held) state.rights.push(dividendClaim(action.dividend, held, current));
    } else if (action.kind === 'DIVIDEND_IMPAIRED') {
      const claim = state.rights.find(item => item.id === action.dividend.id);
      if (claim) claim.recoveryRatio = action.dividend.recoveryRatio;
    } else if (action.kind === 'DIVIDEND_PAYMENT') {
      const claim = state.rights.find(item => item.id === action.dividend.id);
      if (claim) payout(state, claim, BigInt(claim.totalNominalAtoms) === 0n ? fraction(0n)
        : multiplyFractions(parseFraction(claim.nominal), fraction(BigInt(action.dividend.paidAtoms), BigInt(claim.totalNominalAtoms))));
    } else if (action.kind === 'LIQUIDATION_STARTED') {
      if (held) for (const dividend of current.dividends.filter(item => item.listingId === held.listingId && item.exTick > action.effectiveTick && item.remainingPayableAtoms !== '0')) {
        if (!state.rights.some(item => item.id === dividend.id)) state.rights.push(dividendClaim({ ...dividend, recoveryRatio: action.dividendRecoveryRatio }, held, current, true));
      }
      for (const claim of state.rights.filter(item => item.listingId === action.listingId && item.kind === 'DIVIDEND')) {
        claim.recoveryRatio = action.dividendRecoveryRatio;
        // On retirement an attached claim moves out of the old stock with its recovery right.
        claim.attached = false;
      }
      if (held) {
      state.positions = state.positions.filter(item => item.listingId !== held.listingId);
      state.rights.push({ id: action.liquidationId, listingId: held.listingId, kind: 'LIQUIDATION', quantity: held.quantity,
        nominal: zero(), mark: serializeFraction(multiplyFractions(decimalFraction(held.quantity), decimalFraction(action.estimatedRecoveryPerShare))),
        costAtoms: held.costAtoms, paymentTick: tickNoSchema.parse(action.settlementTick), attached: false, totalNominalAtoms: '0', dps: '0', recoveryRatio: '1' });
      }
    } else if (action.kind === 'LIQUIDATION_SETTLED') {
      const claim = state.rights.find(item => item.id === action.liquidationId);
      if (claim) payout(state, claim, multiplyFractions(decimalFraction(claim.quantity), fraction(BigInt(action.commonPaidAtoms), MONEY_SCALE * BigInt(action.eligibleShares))));
      for (const recovered of action.dividendRecoveries) {
        const dividend = state.rights.find(item => item.id === recovered.dividendId);
        if (dividend) payout(state, dividend, BigInt(dividend.totalNominalAtoms) === 0n ? fraction(0n)
          : multiplyFractions(parseFraction(dividend.nominal), fraction(BigInt(recovered.paidAtoms), BigInt(dividend.totalNominalAtoms))));
      }
    }
  }
  const known = new Map(current.dividends.map(item => [item.id, item]));
  for (const claim of state.rights.filter(item => item.kind === 'DIVIDEND')) {
    const dividend = known.get(claim.id);
    if (dividend) claim.recoveryRatio = dividend.recoveryRatio;
    claim.mark = serializeFraction(multiplyFractions(decimalFraction(claim.quantity), decimalFraction(dividendRightMark(claim.dps, claim.recoveryRatio, current.annualRate, Math.max(0, claim.paymentTick - current.engineTick)))));
  }
  return stateSchema.parse(state);
}

/** Server-owned shadows use public market facts and matched external funding, never investor trades or random draws. */
export class ReportingBenchmarks {
  readonly #verifiedFrames = new Map<string, { json: string; hash: string; frame: Frame }>();
  readonly #verifiedSeries=new Map<string,{key:string;loaded:{snapshot:Snapshot;state:State;frame:Frame}}>();
  readonly #verifiedEquity=new Map<string,string>();
  #schemaVersion=-1;#dataVersion=-1;#cacheEligible=false;
  constructor(readonly db: Database.Database) {}
  #validationKey(series:Series):string|undefined {
    const schema=this.db.pragma('schema_version',{simple:true}) as number,data=this.db.pragma('data_version',{simple:true}) as number;
    if(schema!==this.#schemaVersion||data!==this.#dataVersion){
      this.#verifiedSeries.clear();this.#verifiedFrames.clear();this.#verifiedEquity.clear();this.#schemaVersion=schema;this.#dataVersion=data;
      // Missing, replaced or disabled immutable triggers never permit reuse.
      try{verifyDatabaseSchema(this.db);this.#cacheEligible=true;}catch{this.#cacheEligible=false;}
    }
    if(!this.#cacheEligible)return undefined;
    const market=this.#market(series.market_id);
    // Append-only tables can still gain a historical row. Counts + row IDs invalidate
    // same-connection inserts; data_version handles writes by other connections.
    const sources=this.db.prepare('SELECT (SELECT count(*) FROM economy_snapshots WHERE market_id=?) snapshots,(SELECT max(rowid) FROM economy_snapshots WHERE market_id=?) snapshotHead,(SELECT count(*) FROM economy_rate_intervals WHERE market_id=?) rates,(SELECT max(rowid) FROM economy_rate_intervals WHERE market_id=?) rateHead,(SELECT count(*) FROM corporate_actions WHERE market_id=?) actions,(SELECT max(rowid) FROM corporate_actions WHERE market_id=?) actionHead,(SELECT count(*) FROM trial_ticks WHERE market_id=?) trials,(SELECT max(rowid) FROM trial_ticks WHERE market_id=?) trialHead,(SELECT count(*) FROM benchmark_snapshots WHERE market_id=? AND series_id=?) benchmarks,(SELECT max(rowid) FROM benchmark_snapshots WHERE market_id=? AND series_id=?) benchmarkHead')
      .get(series.market_id,series.market_id,series.market_id,series.market_id,series.market_id,series.market_id,series.market_id,series.market_id,series.market_id,series.series_id,series.market_id,series.series_id);
    const listings=this.db.prepare('SELECT listing_id FROM listings WHERE market_id=? ORDER BY listing_id').all(series.market_id);
    const heads={
      snapshot:this.db.prepare('SELECT snapshot_hash FROM economy_snapshots WHERE market_id=? ORDER BY rowid DESC LIMIT 1').get(series.market_id)??null,
      rate:this.db.prepare('SELECT daily_cash_rate,rate_json FROM economy_rate_intervals WHERE market_id=? ORDER BY rowid DESC LIMIT 1').get(series.market_id)??null,
      action:this.db.prepare('SELECT action_json FROM corporate_actions WHERE market_id=? ORDER BY rowid DESC LIMIT 1').get(series.market_id)??null,
      trial:this.db.prepare('SELECT tick_no,market_version FROM trial_ticks WHERE market_id=? ORDER BY rowid DESC LIMIT 1').get(series.market_id)??null,
      benchmark:this.db.prepare('SELECT state_hash FROM benchmark_snapshots WHERE market_id=? AND series_id=? ORDER BY rowid DESC LIMIT 1').get(series.market_id,series.series_id)??null,
      funding:series.account_id===null?null:this.db.prepare("SELECT count(*) count,max(rowid) head FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='CONTRIBUTION'").get(series.market_id,series.account_id),
      fundingHead:series.account_id===null?null:this.db.prepare("SELECT event_id,account_delta_atoms,tick_no,sequence_no FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='CONTRIBUTION' ORDER BY rowid DESC LIMIT 1").get(series.market_id,series.account_id)??null,
    };
    // Rolled-back inserts may reuse their row IDs on a later transaction.
    return canonicalEconomyJson({series,market,sources,listings,heads});
  }
  /** Operator-only integrity audit; reads retained series including closed owners without adopting or advancing them. */
  auditAll(): { series: number; snapshots: number } {
    const series=this.db.prepare('SELECT * FROM benchmark_series ORDER BY market_id,series_id').all() as Series[];
    for(const item of series)this.#load(item);
    const count=this.db.prepare('SELECT count(*) AS count FROM benchmark_snapshots').get() as {count:number};
    return {series:series.length,snapshots:count.count};
  }
  #market(marketId: string): { tick_no: number; market_version: number } {
    marketIdSchema.parse(marketId);
    const row = this.db.prepare('SELECT tick_no,market_version FROM markets WHERE market_id=?').get(marketId) as { tick_no: number; market_version: number } | undefined;
    if (!row) throw new LedgerIntegrityError('Benchmark market scope differs.');
    return row;
  }
  #owner(marketId: string, accountId: string): void {
    marketIdSchema.parse(marketId); accountIdSchema.parse(accountId);
    if (!this.db.prepare('SELECT account_id FROM accounts WHERE market_id=? AND account_id=? AND status=?').get(marketId, accountId, 'ACTIVE'))
      throw new LedgerIntegrityError('Benchmark account scope differs.');
  }
  #frame(marketId: string, tick: number, recordedTrial=false): Frame {
    tickNoSchema.parse(tick);
    const market = this.#market(marketId);
    if (tick > market.tick_no) throw new LedgerIntegrityError('Future benchmark source forbidden.');
    const row = this.db.prepare('SELECT snapshot_json,snapshot_hash,market_version,engine_tick FROM economy_snapshots WHERE market_id=? AND tick_no=?')
      .get(marketId, tick) as PublicSource | undefined;
    if (row&&!recordedTrial) {
      if (row.market_version > market.market_version) throw new LedgerIntegrityError('Future benchmark market version forbidden.');
      const rate = this.db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE market_id=? AND tick_no=?').get(marketId, tick) as { daily_cash_rate: string } | undefined;
      if (!rate) throw new LedgerIntegrityError('Benchmark public rate missing.');
      const actions = this.db.prepare('SELECT action_json,tick_no FROM corporate_actions WHERE market_id=? AND tick_no<=? ORDER BY tick_no,rowid').all(marketId, tick) as { action_json: string; tick_no: number }[];
      const hash = sourceHash(row, rate.daily_cash_rate, actions.filter(action => action.tick_no === tick));
      const cacheKey = `${marketId}:${tick}`;
      const cached = this.#verifiedFrames.get(cacheKey);
      if (cached && cached.hash === hash && cached.json === row.snapshot_json && cached.frame.version === row.market_version && cached.frame.engineTick === row.engine_tick) return cached.frame;
      const stored = JSON.parse(row.snapshot_json) as { public: unknown; pricing: unknown };
      if (canonicalEconomyJson(stored) !== row.snapshot_json || economySnapshotHash(stored) !== row.snapshot_hash) throw new LedgerIntegrityError('Benchmark public snapshot hash differs.');
      const publicState = validatePublicEconomy(stored.public);
      const pricing = pricingStateSchema.parse(stored.pricing);
      if (publicState.marketId !== marketId || publicState.tickNo !== row.engine_tick || pricing.tickNo !== row.engine_tick || row.market_version > market.market_version)
        throw new LedgerIntegrityError('Benchmark public source identity differs.');
      const decoded = actions.map(action => ({ tick: action.tick_no, action: publicCorporateActionSchema.parse(JSON.parse(action.action_json)) as CorporateAction }));
      const dividends = new Map<string, CorporateDividend>();
      for (const action of decoded) {
        if ('dividend' in action.action) dividends.set(action.action.dividend.id, action.action.dividend);
        if (action.action.kind === 'LIQUIDATION_STARTED') {
          const started = action.action;
          for (const [key, dividend] of dividends) if (dividend.listingId === started.listingId)
            dividends.set(key, { ...dividend, recoveryRatio: started.dividendRecoveryRatio });
        }
      }
      for (const company of publicState.companies) for (const dividend of company.dividends) dividends.set(dividend.id, dividend);
      const frame: Frame = { tick, version: row.market_version, engineTick: row.engine_tick, hash, dailyRate: parseRate(rate.daily_cash_rate),
        annualRate: parseRate(D.max(0, new D(publicState.observedMacro.policyRate).minus('0.005')).toString()), prices: new Map(pricing.companies.map(item => [item.listingId, parsePrice(item.price)])),
        actions: decoded.filter(action => action.tick === tick).map(action => action.action), dividends: [...dividends.values()] };
      this.#verifiedFrames.set(cacheKey, { json: row.snapshot_json, hash, frame });
      if (this.#verifiedFrames.size > 64) this.#verifiedFrames.delete(this.#verifiedFrames.keys().next().value!);
      return frame;
    }
    // Before an economy epoch, STATIC_TRIAL is a documented fixed-1000, zero-interest regime.
    const epoch = this.db.prepare('SELECT epoch_tick FROM economy_markets WHERE market_id=?').get(marketId) as { epoch_tick: number } | undefined;
    const trail = this.db.prepare('SELECT market_version FROM trial_ticks WHERE market_id=? AND tick_no=?').get(marketId, tick) as { market_version: number } | undefined;
    if ((epoch && (recordedTrial?tick>epoch.epoch_tick:tick>=epoch.epoch_tick)) || (tick !== 0 && !trail && !epoch)) throw new LedgerIntegrityError('Recorded benchmark source is missing.');
    const listings = this.db.prepare('SELECT listing_id FROM listings WHERE market_id=? AND listing_id NOT IN (SELECT json_extract(action_json,\'$.newListingId\') FROM corporate_actions WHERE market_id=? AND json_extract(action_json,\'$.kind\')=\'REPLACEMENT\') ORDER BY listing_id')
      .all(marketId, marketId) as { listing_id: string }[];
    if (listings.length !== 8) throw new LedgerIntegrityError('Original trial listings differ.');
    const source = { marketId, tick, version: trail?.market_version ?? 0, mode: 'STATIC_TRIAL', prices: listings.map(item => [item.listing_id, '1000']), dailyRate: '0' };
    return { tick, version: source.version, engineTick: 0, hash: economySnapshotHash(source), prices: new Map(listings.map(item => [item.listing_id, '1000'])), dailyRate: '0', annualRate: '0', actions: [], dividends: [] };
  }
  #series(marketId: string, seriesId: string): Series | undefined {
    return this.db.prepare('SELECT * FROM benchmark_series WHERE market_id=? AND series_id=?').get(marketId, seriesId) as Series | undefined;
  }
  #funding(series:Series,throughTick:number):Map<number,bigint> {
    if(series.account_id===null)return new Map();
    const rows=this.db.prepare("SELECT tick_no,account_delta_atoms FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='CONTRIBUTION' AND tick_no<=? ORDER BY tick_no,sequence_no,journal_id")
      .all(series.market_id,series.account_id,throughTick) as {tick_no:number;account_delta_atoms:string}[];
    const totals=new Map<number,bigint>();
    for(const row of rows){const amount=moneyFromAtoms(row.account_delta_atoms);if(amount<=0n||row.tick_no<=series.start_tick)throw new LedgerIntegrityError('Benchmark external capital differs.');totals.set(row.tick_no,(totals.get(row.tick_no)??0n)+amount);}
    return totals;
  }
  #append(series: Series, frame: Frame, state: State, previousHash: string): void {
    const unsigned: Omit<Snapshot, 'state_hash'> = { market_id: series.market_id, series_id: series.series_id, tick_no: frame.tick,
      market_version: frame.version, source_hash: frame.hash, previous_hash: previousHash, state_json: canonicalEconomyJson(stateSchema.parse(state)),
      equity_json: canonicalEconomyJson(serializeFraction(equity(state, frame))) };
    this.db.prepare('INSERT INTO benchmark_snapshots(market_id,series_id,tick_no,market_version,source_hash,previous_hash,state_json,equity_json,state_hash) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(unsigned.market_id, unsigned.series_id, unsigned.tick_no, unsigned.market_version, unsigned.source_hash, unsigned.previous_hash, unsigned.state_json, unsigned.equity_json, snapshotHash(unsigned));
  }
  #load(series: Series): { snapshot: Snapshot; state: State; frame: Frame } {
    const key=this.#validationKey(series),cacheId=JSON.stringify([series.market_id,series.series_id]);
    const cached=this.#verifiedSeries.get(cacheId);if(key!==undefined&&cached?.key===key)return cached.loaded;
    const rows = this.db.prepare('SELECT * FROM benchmark_snapshots WHERE market_id=? AND series_id=? ORDER BY tick_no').all(series.market_id, series.series_id) as Snapshot[];
    if (!rows.length) throw new LedgerIntegrityError('Benchmark initial snapshot missing.');
    let previous = ''; let expected = series.start_tick;
    let state: State | undefined;
    const sourceRows = this.db.prepare('SELECT s.tick_no,s.snapshot_json,s.snapshot_hash,s.market_version,s.engine_tick,r.daily_cash_rate FROM economy_snapshots s JOIN economy_rate_intervals r ON r.market_id=s.market_id AND r.tick_no=s.tick_no WHERE s.market_id=? AND s.tick_no>=? AND s.tick_no<=? ORDER BY s.tick_no')
      .all(series.market_id, series.start_tick, rows.at(-1)!.tick_no) as (PublicSource & { tick_no: number; daily_cash_rate: string })[];
    const sources = new Map(sourceRows.map(row => [row.tick_no, row]));
    const actionRows = this.db.prepare('SELECT tick_no,action_json FROM corporate_actions WHERE market_id=? AND tick_no>=? AND tick_no<=? ORDER BY tick_no,rowid')
      .all(series.market_id, series.start_tick, rows.at(-1)!.tick_no) as { tick_no: number; action_json: string }[];
    const funding=this.#funding(series,rows.at(-1)!.tick_no);let contributed=0n;
    for (const row of rows) {
      const { state_hash, ...unsigned } = row;
      if (row.tick_no !== expected++ || row.previous_hash !== previous || snapshotHash(unsigned) !== state_hash) throw new LedgerIntegrityError('Benchmark immutable chain differs.');
      state = stateSchema.parse(JSON.parse(row.state_json));
      contributed+=funding.get(row.tick_no)??0n;
      if(BigInt(state.contributionsAtoms??'0')!==contributed||(contributed>0n&&state.timeWeightedFactor===undefined))
        throw new LedgerIntegrityError('Benchmark funding ledger differs.');
      const source = sources.get(row.tick_no);
      let hash = source ? sourceHash(source, source.daily_cash_rate, actionRows.filter(action => action.tick_no === row.tick_no)) : this.#frame(series.market_id, row.tick_no).hash;
      // A committed trial observation at the adoption boundary remains an immutable trial observation.
      if(row.source_hash!==hash)hash=this.#frame(series.market_id,row.tick_no,true).hash;
      if (row.source_hash !== hash || (source && row.market_version !== source.market_version) || canonicalEconomyJson(state) !== row.state_json)
        throw new LedgerIntegrityError('Benchmark immutable public source differs.');
      parseFraction(JSON.parse(row.equity_json));
      previous = state_hash;
    }
    let frame = this.#frame(series.market_id, rows.at(-1)!.tick_no);
    if(frame.hash!==rows.at(-1)!.source_hash)frame=this.#frame(series.market_id,rows.at(-1)!.tick_no,true);
    const equityKey=createHash('sha256').update(rows.at(-1)!.state_json).update(frame.hash).digest('hex');
    const calculated=this.#verifiedEquity.get(equityKey)??canonicalEconomyJson(serializeFraction(equity(state!,frame)));
    if(calculated!==rows.at(-1)!.equity_json)throw new LedgerIntegrityError('Benchmark valuation differs.');
    if(key!==undefined){this.#verifiedEquity.set(equityKey,calculated);if(this.#verifiedEquity.size>256)this.#verifiedEquity.delete(this.#verifiedEquity.keys().next().value!);}
    const loaded={snapshot:rows.at(-1)!,state:state!,frame};
    if(key!==undefined){this.#verifiedSeries.set(cacheId,{key,loaded});if(this.#verifiedSeries.size>4096)this.#verifiedSeries.delete(this.#verifiedSeries.keys().next().value!);}
    return loaded;
  }
  #create(series: Series): void {
    const frame = this.#frame(series.market_id, series.start_tick);
    this.db.prepare('INSERT INTO benchmark_series(market_id,series_id,account_id,kind,start_tick,opening_elapsed_ms,opening_policy) VALUES(?,?,?,?,?,?,?)')
      .run(series.market_id, series.series_id, series.account_id, series.kind, series.start_tick, series.opening_elapsed_ms, series.opening_policy);
    const state = series.kind === 'CASH' ? initialState() : buyEqual(initialState(), frame.prices);
    this.#append(series, frame, state, '');
  }
  #advance(series: Series, finalTick: number): void {
    let loaded = this.#load(series);
    const funding=this.#funding(series,finalTick);
    for (let tick = loaded.snapshot.tick_no + 1; tick <= finalTick; tick++) {
      const frame = this.#frame(series.market_id, tick);
      const elapsed = tick === series.start_tick + 1 ? 300000 - series.opening_elapsed_ms : 300000;
      let state = advanceState(loaded.state, loaded.frame, frame, elapsed);
      if (series.kind === 'PM8' && (tick - series.start_tick) % 21 === 0) state = buyEqual(sellAll(state, frame), frame.prices);
      const contribution=funding.get(tick)??0n;
      if(series.kind!=='PM8'&&(contribution>0n||BigInt(state.contributionsAtoms??'0')>0n)) {
        const prior=equity(loaded.state,loaded.frame);const before=equity(state,frame);
        const previousValue=new D(prior.numerator.toString()).div(prior.denominator.toString());
        const currentValue=new D(before.numerator.toString()).div(before.denominator.toString());
        const previousFactor=new D(loaded.state.timeWeightedFactor??previousValue.div('10000').toString());
        state.timeWeightedFactor=parseRate(previousValue.gt(0)?previousFactor.mul(currentValue.div(previousValue)).toString():'0');
        // HOLD8 buys only at account opening. Later matched inflows stay in its cash balance.
        state.cashAtoms=signed(BigInt(state.cashAtoms)+contribution);
        state.contributionsAtoms=signed(BigInt(state.contributionsAtoms??'0')+contribution);
      }
      this.#append(series, frame, state, loaded.snapshot.state_hash);
      const snapshot = this.db.prepare('SELECT * FROM benchmark_snapshots WHERE market_id=? AND series_id=? AND tick_no=?').get(series.market_id, series.series_id, tick) as Snapshot;
      loaded = { state, frame, snapshot };
    }
  }
  initializeMarket(marketId: string, openingElapsedMs = 0): void {
    const market = this.#market(marketId);
    if (!Number.isSafeInteger(openingElapsedMs) || openingElapsedMs < 0 || openingElapsedMs > 300000) throw new LedgerIntegrityError('Benchmark adoption interval invalid.');
    this.db.transaction(() => {
      let series = this.#series(marketId, 'PM8');
      if (!series) { series = { market_id: marketId, series_id: 'PM8', account_id: null, kind: 'PM8', start_tick: market.tick_no, opening_elapsed_ms: openingElapsedMs, opening_policy: 'MARKET_ADOPTION' }; this.#create(series); }
      this.#advance(series, market.tick_no);
    })();
  }
  initializeAccount(marketId: string, accountId: string, openingElapsedMs?: number): void {
    this.#owner(marketId, accountId);
    if (openingElapsedMs !== undefined && (!Number.isSafeInteger(openingElapsedMs) || openingElapsedMs < 0 || openingElapsedMs > 300000)) throw new LedgerIntegrityError('Benchmark opening interval invalid.');
    const grant = this.db.prepare("SELECT tick_no FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='INITIAL_GRANT'").get(marketId, accountId) as { tick_no: number } | undefined;
    if (!grant) throw new LedgerIntegrityError('Benchmark original grant missing.');
    const market = this.#market(marketId);
    const exactOffset = openingElapsedMs !== undefined && grant.tick_no === market.tick_no;
    this.db.transaction(() => {
      for (const kind of ['CASH', 'HOLD8'] as const) {
        const seriesId = `${kind}:${accountId}`;
        let series = this.#series(marketId, seriesId);
        if (!series) {
          series = { market_id: marketId, series_id: seriesId, account_id: accountId, kind, start_tick: grant.tick_no,
            opening_elapsed_ms: exactOffset ? openingElapsedMs! : 300000, opening_policy: exactOffset ? 'EXACT_ACTIVE_OFFSET' : 'LEGACY_BOUNDARY_ONLY' };
          this.#create(series);
        }
        this.#advance(series, market.tick_no);
      }
    })();
  }
  advanceBoundary(marketId: string): void {
    const market = this.#market(marketId);
    this.db.transaction(() => {
      const series = this.db.prepare("SELECT b.* FROM benchmark_series b LEFT JOIN accounts a ON a.market_id=b.market_id AND a.account_id=b.account_id WHERE b.market_id=? AND (b.kind='PM8' OR a.status='ACTIVE') ORDER BY b.series_id")
        .all(marketId) as Series[];
      for (const item of series) this.#advance(item, market.tick_no);
    })();
  }
  #view(series: Series,elapsedMs?:number): BenchmarkView {
    const { state, snapshot,frame } = this.#load(series);
    if(elapsedMs!==undefined&&(!Number.isSafeInteger(elapsedMs)||elapsedMs<0||elapsedMs>300000))throw new LedgerIntegrityError('Benchmark view interval invalid.');
    const elapsed=elapsedMs===undefined?0:snapshot.tick_no===series.start_tick?Math.max(0,elapsedMs-series.opening_elapsed_ms):elapsedMs;
    const accrued=cashTimeInterest(state.cashAtoms,frame.dailyRate,elapsed);
    const value = addFractions(parseFraction(JSON.parse(snapshot.equity_json)),accrued);
    const amount = new D(value.numerator.toString()).div(value.denominator.toString());
    const settled=parseFraction(JSON.parse(snapshot.equity_json));const settledAmount=new D(settled.numerator.toString()).div(settled.denominator.toString());
    const factor=state.timeWeightedFactor===undefined?amount.div('10000'):settledAmount.gt(0)?new D(state.timeWeightedFactor).mul(amount.div(settledAmount)):new D(0);
    const marks = state.rights.filter(item => !item.attached).reduce((sum, item) => addFractions(sum, parseFraction(item.mark)), fraction(0n));
    return { kind: series.kind, startTick: series.start_tick, tickNo: snapshot.tick_no, equity: points(quantizeMoney(value, 'floor').money), cash: points(state.cashAtoms),
      initialCapital:'10000',contributions:points(state.contributionsAtoms??'0'),netInvestmentPnl:points(quantizeMoney(value,'floor').money-STANDARD_RULESET.initialCash-BigInt(state.contributionsAtoms??'0')),
      contributionPolicy:series.kind==='PM8'?'시장 기준 포트폴리오에는 개인 납입을 반영하지 않습니다.':series.kind==='HOLD8'?'계좌 개설 시 8종목을 매수하고 보유합니다. 이후 같은 시점·금액의 납입은 현금으로 보유합니다.':'개인 계좌와 같은 시점·금액의 납입을 현금으로 보유합니다.',
      totalReturnPct: parseRate(factor.minus(1).mul(100).toString()), fees: points(state.feesAtoms), cashInterest: points(quantizeMoney(addFractions(fraction(BigInt(state.interestAtoms),MONEY_SCALE),addFractions(parseFraction(state.interestCarry),accrued)),'floor').money),
      dividends: points(state.dividendAtoms), liquidationReceipts: points(state.liquidationAtoms), receivables: points(quantizeMoney(marks, 'floor').money),
      openingPolicy: series.opening_policy, index: parseRate(factor.mul('1000').toString()) };
  }
  /** Caller must supply the broker's authenticated account ID; joins repeat the owner condition. */
  owned(marketId: string, accountId: string,elapsedMs?:number): BenchmarkComparison {
    this.#owner(marketId, accountId);
    const series = this.db.prepare("SELECT b.* FROM benchmark_series b JOIN accounts a ON a.market_id=b.market_id AND a.account_id=b.account_id WHERE b.market_id=? AND b.account_id=? AND a.status='ACTIVE' AND b.kind IN ('CASH','HOLD8')")
      .all(marketId, accountId) as Series[];
    const cash = series.find(item => item.kind === 'CASH'); const hold = series.find(item => item.kind === 'HOLD8');
    if (!cash || !hold) throw new LedgerIntegrityError('Owned benchmark pair missing.');
    return { cash: this.#view(cash,elapsedMs), hold8: this.#view(hold,elapsedMs) };
  }
  pm8(marketId: string,elapsedMs?:number): BenchmarkView {
    this.#market(marketId);
    const series = this.#series(marketId, 'PM8');
    if (!series) throw new LedgerIntegrityError('Market benchmark missing.');
    return this.#view(series,elapsedMs);
  }
}
