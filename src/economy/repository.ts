import { createHash, createHmac, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { EconomyView } from '../application/contracts.js';
import { accumulateCashInterest, settleTickCashInterest } from '../domain/cash-interest.js';
import { TICK_INTERVAL_MILLISECONDS } from '../domain/clock.js';
import {
  FinancialDecimal, MONEY_SCALE, addFractions, moneyFromAtoms, moneyToString, parseFraction, parsePrice,
  parseRate, quantizeMoney, serializeFraction, type Fraction,
} from '../domain/numeric.js';
import { DeterministicRandom } from '../domain/random.js';
import { annualEffectiveRateForDays } from '../domain/rates.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { LedgerIntegrityError } from '../storage/replay.js';
import { FoundationRepository } from '../storage/repository.js';
import { createEconomyState, advanceEconomy, validateEconomyState } from './engine.js';
import type { EconomyState } from './types.js';
import { createPublicEconomy, publishEconomy, publicCorporateActionSchema, publicEconomySchema, validatePublicEconomy } from './public.js';
import { createMarketState, priceMarket, pricingStateSchema } from '../market/pricing.js';
import { RightsRepository } from '../rights/repository.js';
import type { PublicDisclosureRecord } from './public.js';
import { getEventTemplate } from '../events/catalog.js';

export const ECONOMY_ENGINE_VERSION = '0.4.0';

type PublicState = ReturnType<typeof createPublicEconomy>;
type PricingState = ReturnType<typeof createMarketState>;
export interface EconomySnapshot {
  readonly engineVersion: '0.2.0' | '0.3.0' | typeof ECONOMY_ENGINE_VERSION;
  readonly economy: EconomyState;
  readonly public: PublicState;
  readonly pricing: PricingState;
}

function validateSnapshotIdentities(snapshot:EconomySnapshot):void {
  for(const company of snapshot.public.companies) {
    const privateCompany=snapshot.economy.companies.find(item=>item.issuerId===company.issuerId&&item.listingId===company.listingId);
    if(!privateCompany||privateCompany.slotId!==company.slotId||privateCompany.category!==company.category||privateCompany.symbol!==company.baseSymbol||privateCompany.generation!==company.generation||privateCompany.createdTick!==company.createdTick)
      throw new LedgerIntegrityError('Economic company identities differ.');
    if(!snapshot.pricing.companies.some(item=>item.issuerId===company.issuerId&&item.listingId===company.listingId)) throw new LedgerIntegrityError('Pricing company identities differ.');
  }
}
interface EconomyRow { market_id:string; epoch_tick:number;current_tick:number;seed_check:string;current_hash:string;initialized_at:string }
interface SnapshotRow {tick_no:number;engine_tick:number;market_version:number;engine_version:string;snapshot_json:string;snapshot_hash:string;committed_at:string}
interface InterestRow {
  market_id:string;account_id:string;tick_no:number;elapsed_ms:number;cash_atoms:string;
  accrued_numerator:string;accrued_denominator:string;carry_numerator:string;carry_denominator:string;
  state_hash:string;
}
interface MarketMetadata {market_id:string; tick_no:number;market_version:number;sequence_no:number;engine_version:string;ruleset_version:string;next_boundary_at:string}

/** Stable data-only encoding. Wall-clock timestamps, account commands and sequence numbers are not inputs. */
export function canonicalEconomyJson(value: unknown): string {
  function encode(item: unknown): unknown {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return item;
    if (typeof item === 'number' && Number.isSafeInteger(item)) return item;
    if (Array.isArray(item)) return item.map(encode);
    if (typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype) throw new LedgerIntegrityError('Invalid economic snapshot shape.');
    return Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,child])=>[key,encode(child)]));
  }
  return JSON.stringify(encode(value));
}
export function economySnapshotHash(snapshot: unknown): string {
  return createHash('sha256').update(canonicalEconomyJson(snapshot)).digest('hex');
}
function text(atoms:string|bigint):string { return moneyToString(moneyFromAtoms(atoms.toString())); }
function checkedFraction(numerator:string,denominator:string):Fraction {
  const parsed=parseFraction({numerator,denominator});
  if(parsed.numerator<0n) throw new LedgerIntegrityError('Negative interest accrual.');
  return parsed;
}
function safeCounter(value:number):number {
  if(!Number.isSafeInteger(value)||value<0) throw new LedgerIntegrityError('Invalid economic counter.');
  return value;
}
function interestHash(row:Omit<InterestRow,'state_hash'>):string {
  return economySnapshotHash([row.market_id,row.account_id,row.tick_no,row.elapsed_ms,row.cash_atoms,
    row.accrued_numerator,row.accrued_denominator,row.carry_numerator,row.carry_denominator]);
}

/** Economy and investor interest share the broker's one SQLite transaction. No Discord calls occur here. */
export class EconomyRepository {
  readonly #db:Database.Database;
  readonly #seed:Buffer;
  constructor(db:Database.Database,seed:Buffer) {
    this.#db=db; new DeterministicRandom(seed);this.#seed=Buffer.from(seed);
    const existing=db.prepare('SELECT market_id FROM economy_markets').all() as Array<{market_id:string}>;
    for(const row of existing) {
      this.load(row.market_id);
      const owners=db.prepare('SELECT account_id FROM accounts WHERE market_id = ?').all(row.market_id) as {account_id:string}[];
      for(const owner of owners) new RightsRepository(db).replay(row.market_id,owner.account_id);
    }
  }
  has(marketId:string):boolean {return this.#row(marketId)!==undefined;}
  #seedCheck(marketId:string):string {
    return createHmac('sha256',this.#seed).update(JSON.stringify(['PaperMarket economic seed binding v1',marketId])).digest('hex');
  }
  #randomForMarket(marketId:string):DeterministicRandom {
    const key=createHmac('sha256',this.#seed).update(JSON.stringify(['PaperMarket economic draws v1',marketId])).digest();
    return new DeterministicRandom(key);
  }
  #row(marketId:string):EconomyRow|undefined {
    return this.#db.prepare('SELECT * FROM economy_markets WHERE market_id = ?').get(marketId) as EconomyRow|undefined;
  }
  initialize(market:MarketMetadata,now:string):void {
    if(this.has(market.market_id)) {this.load(market.market_id);return;}
    const prices=this.#db.prepare('SELECT listing_id,price FROM listings WHERE market_id = ? AND status = ? ORDER BY listing_id')
      .all(market.market_id,'ACTIVE') as Array<{listing_id:string;price:string}>;
    if(prices.length!==8) throw new LedgerIntegrityError('Initial economy requires eight existing listings.');
    const economy=createEconomyState(market.market_id,0);
    const publicState=createPublicEconomy(INITIAL_COMPANIES,0,market.market_id);
    const pricing=createMarketState(publicState,Object.fromEntries(prices.map(row=>[row.listing_id,parsePrice(row.price)])));
    const snapshot:EconomySnapshot={engineVersion:ECONOMY_ENGINE_VERSION,economy,public:publicState,pricing};
    this.#insertSnapshot(market.market_id,market.tick_no,market.market_version,now,now,snapshot);
    this.#db.prepare('INSERT INTO economy_markets(market_id,epoch_tick,current_tick,seed_check,current_hash,initialized_at) VALUES(?,?,?,?,?,?)')
      .run(market.market_id,market.tick_no,market.tick_no,this.#seedCheck(market.market_id),economySnapshotHash(snapshot),now);
    this.#db.prepare("UPDATE market_settings SET quote_provider = 'ECONOMY' WHERE market_id = ?").run(market.market_id);
    const remaining=this.#db.prepare('SELECT remaining_ms FROM market_settings WHERE market_id = ?').get(market.market_id) as {remaining_ms:number};
    const elapsed=TICK_INTERVAL_MILLISECONDS-remaining.remaining_ms;
    const accounts=this.#db.prepare("SELECT account_id,discord_user_id FROM accounts WHERE market_id = ? AND status = 'ACTIVE'")
      .all(market.market_id) as Array<{account_id:string;discord_user_id:string}>;
    const foundation=new FoundationRepository(this.#db);
    for(const row of accounts) {
      const balance=foundation.replayAccount({marketId:market.market_id,discordUserId:row.discord_user_id}).cashAtoms;
      this.initializeAccount(market.market_id,row.account_id,market.tick_no,balance.toString(),elapsed);
    }
  }
  load(marketId:string):EconomySnapshot {
    try {return this.#load(marketId);} catch(error) {
      if(error instanceof LedgerIntegrityError) throw error;
      throw new LedgerIntegrityError('Persisted economic snapshot failed validation.');
    }
  }
  #load(marketId:string):EconomySnapshot {
    const row=this.#row(marketId);
    if(!row||row.seed_check!==this.#seedCheck(marketId)) throw new LedgerIntegrityError('Persistent economic seed has changed.');
    const raw=this.#db.prepare('SELECT * FROM economy_snapshots WHERE market_id = ? AND tick_no = ?').get(marketId,row.current_tick) as SnapshotRow|undefined;
    if(!raw||raw.snapshot_hash!==row.current_hash||!['0.2.0','0.3.0',ECONOMY_ENGINE_VERSION].includes(raw.engine_version)||raw.engine_tick!==row.current_tick-row.epoch_tick) throw new LedgerIntegrityError('Economic snapshot metadata differs.');
    let parsed:unknown;
    try {parsed=JSON.parse(raw.snapshot_json);} catch {throw new LedgerIntegrityError('Invalid economic snapshot JSON.');}
    if(economySnapshotHash(parsed)!==raw.snapshot_hash||canonicalEconomyJson(parsed)!==raw.snapshot_json) throw new LedgerIntegrityError('Economic snapshot hash differs.');
    if(typeof parsed!=='object'||parsed===null||Object.keys(parsed).sort().join(',')!=='economy,engineVersion,pricing,public') throw new LedgerIntegrityError('Invalid economic snapshot contract.');
    const stored=parsed as EconomySnapshot;
    if(stored.engineVersion!==raw.engine_version) throw new LedgerIntegrityError('Economic engine version differs.');
    // Legacy hashes are checked before adding in-memory defaults. Historical snapshots stay immutable.
    const value:EconomySnapshot={...stored,economy:validateEconomyState(stored.economy),public:validatePublicEconomy(stored.public),pricing:pricingStateSchema.parse(stored.pricing)};
    validateSnapshotIdentities(value);
    if(value.economy.marketId!==marketId||value.public.marketId!==marketId||value.economy.tickNo!==raw.engine_tick||value.public.tickNo!==raw.engine_tick||value.pricing.tickNo!==raw.engine_tick) throw new LedgerIntegrityError('Economic snapshot identity differs.');
    const market=this.#db.prepare('SELECT tick_no,market_version FROM markets WHERE market_id = ?').get(marketId) as {tick_no:number;market_version:number}|undefined;
    if(!market||market.tick_no!==row.current_tick||market.market_version!==raw.market_version) throw new LedgerIntegrityError('Market and economic versions differ.');
    const listings=this.#db.prepare("SELECT listing_id,issuer_id,slot_id,symbol,price FROM listings WHERE market_id = ? AND status = 'ACTIVE'").all(marketId) as Array<{listing_id:string;issuer_id:string;slot_id:string;symbol:string;price:string}>;
    if(listings.length!==8||listings.some(listing=>{
      const company=value.public.companies.find(company=>company.listingId===listing.listing_id);
      return !company||company.issuerId!==listing.issuer_id||company.slotId!==listing.slot_id||company.symbol!==listing.symbol||value.pricing.companies.find(company=>company.listingId===listing.listing_id)?.price!==parsePrice(listing.price);
    })) throw new LedgerIntegrityError('Listing identities or prices differ from their committed snapshot.');
    const rate=this.#db.prepare('SELECT daily_cash_rate,rate_json FROM economy_rate_intervals WHERE market_id = ? AND tick_no = ?').get(marketId,row.current_tick) as {daily_cash_rate:string;rate_json:string}|undefined;
    const expectedRate=this.rates(value);
    if(!rate||rate.daily_cash_rate!==expectedRate.cashDailyRate||rate.rate_json!==canonicalEconomyJson(expectedRate)) throw new LedgerIntegrityError('Rate interval differs from the committed public snapshot.');
    return value;
  }
  advance(market:MarketMetadata,nextTick:number,nextVersion:number,now:string):EconomySnapshot {
    const prior=this.load(market.market_id);const row=this.#row(market.market_id)!;
    if(row.current_tick!==market.tick_no||nextTick!==market.tick_no+1) throw new LedgerIntegrityError('Economic tick is not consecutive.');
    const random=this.#randomForMarket(market.market_id);
    const advanced=advanceEconomy(prior.economy,safeCounter(prior.economy.tickNo+1),random,prior.public);
    const published=publishEconomy(prior.public,advanced.publications,advanced.state.tickNo,advanced.actions);
    const priced=priceMarket(published.state,prior.pricing,random,advanced.actions);
    if(priced.prices.some(price=>new FinancialDecimal(price.price).isZero())) throw new LedgerIntegrityError('ZERO_CORPORATE_REFERENCE');
    const snapshot:EconomySnapshot={engineVersion:ECONOMY_ENGINE_VERSION,economy:advanced.state,public:published.state,pricing:priced.state};
    for(const action of advanced.actions) {
      if(action.kind==='LIQUIDATION_STARTED') this.#db.prepare("UPDATE listings SET status = 'LIQUIDATING' WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'").run(market.market_id,action.listingId);
      if(action.kind==='LIQUIDATION_SETTLED') this.#db.prepare("UPDATE listings SET status = 'EXTINGUISHED' WHERE market_id = ? AND listing_id = ? AND status = 'LIQUIDATING'").run(market.market_id,action.listingId);
      if(action.kind==='REPLACEMENT') {
        const company=advanced.state.companies.find(value=>value.issuerId===action.newIssuerId);
        if(!company) throw new LedgerIntegrityError('Missing replacement company.');
        this.#db.prepare('INSERT INTO issuers(market_id,issuer_id,category) VALUES(?,?,?)').run(market.market_id,action.newIssuerId,company.category);
        this.#db.prepare("INSERT INTO listings(market_id,listing_id,issuer_id,slot_id,category,symbol,price,status,created_at) VALUES(?,?,?,?,?,?,'1000','ACTIVE',?)")
          .run(market.market_id,action.newListingId,action.newIssuerId,company.slotId,company.category,action.newSymbol,now);
      }
    }
    this.#insertSnapshot(market.market_id,nextTick,nextVersion,market.next_boundary_at,now,snapshot);
    for(const action of advanced.actions) this.#db.prepare('INSERT INTO corporate_actions(market_id,action_id,tick_no,action_json) VALUES(?,?,?,?)')
      .run(market.market_id,action.id,nextTick,canonicalEconomyJson(action));
    for(const [index,entry] of advanced.corporateEntries.entries()) {
      this.#db.prepare('INSERT INTO corporate_journal(market_id,tick_no,entry_index,issuer_id,entry_json) VALUES(?,?,?,?,?)')
        .run(market.market_id,nextTick,index,entry.issuerId,canonicalEconomyJson(entry));
    }
    for(const publication of published.publications) {
      this.#db.prepare('INSERT INTO economy_publications(market_id,tick_no,publication_id,publication_json) VALUES(?,?,?,?)')
        .run(market.market_id,nextTick,publication.id,canonicalEconomyJson(publication));
    }
    for(const price of priced.prices) {
      const contribution=priced.contributions.find((entry)=>entry.listingId===price.listingId);
      if(!contribution) throw new LedgerIntegrityError('Missing price contribution.');
      const parsedPrice=parsePrice(price.price);
      const changed=this.#db.prepare("UPDATE listings SET price = ? WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'")
        .run(parsedPrice,market.market_id,price.listingId);
      if(changed.changes!==1) throw new LedgerIntegrityError('Missing active economic listing.');
      this.#db.prepare('INSERT INTO economy_prices(market_id,tick_no,listing_id,price,contribution_json) VALUES(?,?,?,?,?)')
        .run(market.market_id,nextTick,price.listingId,parsedPrice,canonicalEconomyJson(contribution));
    }
    const changed=this.#db.prepare('UPDATE economy_markets SET current_tick = ?,current_hash = ? WHERE market_id = ? AND current_tick = ?')
      .run(nextTick,economySnapshotHash(snapshot),market.market_id,market.tick_no);
    if(changed.changes!==1) throw new LedgerIntegrityError('Economic tick was already committed.');
    return snapshot;
  }
  settleRights(market:MarketMetadata,now:string):void {
    const raw=this.#db.prepare('SELECT action_json FROM corporate_actions WHERE market_id = ? AND tick_no = ? ORDER BY rowid').all(market.market_id,market.tick_no) as {action_json:string}[];
    const rights=new RightsRepository(this.#db);
    const snapshot=this.load(market.market_id);const annualRate=this.rates(snapshot).cashAnnualRate;
    const dividends=snapshot.public.corporateActions.filter(action=>'dividend' in action).map(action=>action.dividend);
    const actions=raw.map(row=>publicCorporateActionSchema.parse(JSON.parse(row.action_json)));
    if(actions.some(action=>action.effectiveTick!==snapshot.public.tickNo)) throw new LedgerIntegrityError('Corporate action boundary differs.');
    rights.apply(actions,market,now,(accountId,status,cashBefore,cashAfter)=>{
      if(status==='ACTIVE') this.accrueAccount(market.market_id,accountId,market.tick_no,cashBefore,cashAfter,0);
    },annualRate,dividends);
    rights.revalue(market,now,snapshot.public.tickNo,annualRate,dividends);
  }
  #insertSnapshot(marketId:string,tick:number,version:number,boundary:string,now:string,snapshot:EconomySnapshot):void {
    validateEconomyState(snapshot.economy);publicEconomySchema.parse(snapshot.public);pricingStateSchema.parse(snapshot.pricing);
    validateSnapshotIdentities(snapshot);
    const json=canonicalEconomyJson(snapshot);
    this.#db.prepare('INSERT INTO economy_snapshots(market_id,tick_no,engine_tick,market_version,engine_version,snapshot_json,snapshot_hash,boundary_at,committed_at) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(marketId,tick,snapshot.economy.tickNo,version,ECONOMY_ENGINE_VERSION,json,economySnapshotHash(snapshot),boundary,now);
    const rate=this.rates(snapshot);
    this.#db.prepare('INSERT INTO economy_rate_intervals(market_id,tick_no,daily_cash_rate,rate_json) VALUES(?,?,?,?)')
      .run(marketId,tick,rate.cashDailyRate,canonicalEconomyJson(rate));
  }
  rates(snapshot:EconomySnapshot):{policyRate:string;cashAnnualRate:string;cashDailyRate:string} {
    const policyRate=parseRate(snapshot.public.observedMacro.policyRate);
    const cashAnnualRate=parseRate(FinancialDecimal.max(new FinancialDecimal(policyRate).minus('0.005'),'0').toString());
    return {policyRate,cashAnnualRate,cashDailyRate:annualEffectiveRateForDays(cashAnnualRate,1)};
  }
  dailyRate(marketId:string,tick:number):string {
    const row=this.#db.prepare('SELECT daily_cash_rate FROM economy_rate_intervals WHERE market_id = ? AND tick_no = ?').get(marketId,tick) as {daily_cash_rate:string}|undefined;
    if(!row) throw new LedgerIntegrityError('Missing fixed cash-interest rate.');
    const rate=parseRate(row.daily_cash_rate);
    if(new FinancialDecimal(rate).lt('0')) throw new LedgerIntegrityError('Negative cash-interest rate.');
    return rate;
  }
  initializeAccount(marketId:string,accountId:string,tick:number,cashAtoms:string,elapsed:number):void {
    const row:Omit<InterestRow,'state_hash'>={market_id:marketId,account_id:accountId,tick_no:tick,elapsed_ms:elapsed,cash_atoms:moneyFromAtoms(cashAtoms).toString(),
      accrued_numerator:'0',accrued_denominator:'1',carry_numerator:'0',carry_denominator:'1'};
    this.#db.prepare('INSERT OR IGNORE INTO account_interest(market_id,account_id,tick_no,elapsed_ms,cash_atoms,accrued_numerator,accrued_denominator,carry_numerator,carry_denominator,state_hash) VALUES(?,?,?,?,?,?,?,?,?,?)')
      .run(marketId,accountId,tick,elapsed,row.cash_atoms,row.accrued_numerator,row.accrued_denominator,row.carry_numerator,row.carry_denominator,interestHash(row));
  }
  #interest(marketId:string,accountId:string,tick:number):InterestRow {
    const row=this.#db.prepare('SELECT * FROM account_interest WHERE market_id = ? AND account_id = ?').get(marketId,accountId) as InterestRow|undefined;
    if(!row||row.tick_no!==tick||!Number.isSafeInteger(row.elapsed_ms)||row.elapsed_ms<0||row.elapsed_ms>TICK_INTERVAL_MILLISECONDS||row.state_hash!==interestHash(row)) throw new LedgerIntegrityError('Interest checkpoint differs from market tick.');
    moneyFromAtoms(row.cash_atoms);checkedFraction(row.accrued_numerator,row.accrued_denominator);
    const carry=checkedFraction(row.carry_numerator,row.carry_denominator);
    if(carry.numerator*MONEY_SCALE>=carry.denominator) throw new LedgerIntegrityError('Interest carry exceeds one atom.');
    return row;
  }
  validatePrincipal(marketId:string,accountId:string,tick:number,cashAtoms:string):void {
    if(this.#interest(marketId,accountId,tick).cash_atoms!==cashAtoms) throw new LedgerIntegrityError('Interest principal differs from replayed account cash.');
  }
  accrueAccount(marketId:string,accountId:string,tick:number,cashBefore:string,cashAfter:string,elapsed:number):void {
    const row=this.#interest(marketId,accountId,tick);
    if(row.cash_atoms!==cashBefore||elapsed<row.elapsed_ms) throw new LedgerIntegrityError('Interest cash or active time differs from ledger.');
    const accrued=accumulateCashInterest(checkedFraction(row.accrued_numerator,row.accrued_denominator),row.cash_atoms,this.dailyRate(marketId,tick),elapsed-row.elapsed_ms);
    const saved=serializeFraction(accrued);
    const next={...row,elapsed_ms:elapsed,cash_atoms:moneyFromAtoms(cashAfter).toString(),accrued_numerator:saved.numerator,accrued_denominator:saved.denominator};
    this.#db.prepare('UPDATE account_interest SET elapsed_ms = ?,cash_atoms = ?,accrued_numerator = ?,accrued_denominator = ?,state_hash = ? WHERE market_id = ? AND account_id = ? AND tick_no = ?')
      .run(elapsed,next.cash_atoms,saved.numerator,saved.denominator,interestHash(next),marketId,accountId,tick);
  }
  settleInterest(market:MarketMetadata,nextTick:number,nextVersion:number,sequence:number,now:string):void {
    const rows=this.#db.prepare('SELECT i.*,a.status,a.discord_user_id FROM account_interest i JOIN accounts a ON a.market_id=i.market_id AND a.account_id=i.account_id WHERE i.market_id = ? ORDER BY i.account_id')
      .all(market.market_id) as Array<InterestRow&{status:string;discord_user_id:string}>;
    const foundation=new FoundationRepository(this.#db);
    for(const raw of rows) {
      const row=this.#interest(market.market_id,raw.account_id,market.tick_no);
      const balance=foundation.replayAccount({marketId:market.market_id,discordUserId:raw.discord_user_id}).cashAtoms;
      if(raw.status==='ACTIVE'&&balance.toString()!==row.cash_atoms) throw new LedgerIntegrityError('Interest principal differs from replayed cash.');
      const accrued=accumulateCashInterest(checkedFraction(row.accrued_numerator,row.accrued_denominator),row.cash_atoms,this.dailyRate(market.market_id,market.tick_no),TICK_INTERVAL_MILLISECONDS-row.elapsed_ms);
      const settled=settleTickCashInterest(accrued,checkedFraction(row.carry_numerator,row.carry_denominator));
      const exact=serializeFraction(accrued);const carry=serializeFraction(settled.carry);
      this.#db.prepare('INSERT INTO interest_payouts(market_id,account_id,tick_no,paid_atoms,accrued_numerator,accrued_denominator,carry_numerator,carry_denominator,sequence_no,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)')
        .run(market.market_id,row.account_id,market.tick_no,settled.money.toString(),exact.numerator,exact.denominator,carry.numerator,carry.denominator,sequence,now);
      if(settled.money>0n) {
        const eventId=randomUUID();
        this.#db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES(?,?,?,?,?,'INTEREST',?,?,'INTEREST','PAPERMARKET_POINT',?,?,?,?,?,?,NULL)")
          .run(randomUUID(),eventId,eventId,market.market_id,row.account_id,settled.money.toString(),(-settled.money).toString(),nextTick,nextVersion,sequence,market.engine_version,market.ruleset_version,now);
        const changed=this.#db.prepare('UPDATE accounts SET account_version = account_version + 1 WHERE market_id = ? AND account_id = ? AND account_version < 9007199254740991')
          .run(market.market_id,row.account_id);
        if(changed.changes!==1) throw new LedgerIntegrityError('Account version exceeds the supported range.');
      }
      const nextCash=raw.status==='ACTIVE'?moneyFromAtoms((balance+settled.money).toString()).toString():'0';
      const next={...row,tick_no:nextTick,elapsed_ms:0,cash_atoms:nextCash,accrued_numerator:'0',accrued_denominator:'1',carry_numerator:carry.numerator,carry_denominator:carry.denominator};
      this.#db.prepare("UPDATE account_interest SET tick_no = ?,elapsed_ms = 0,cash_atoms = ?,accrued_numerator = '0',accrued_denominator = '1',carry_numerator = ?,carry_denominator = ?,state_hash = ? WHERE market_id = ? AND account_id = ? AND tick_no = ?")
        .run(nextTick,nextCash,carry.numerator,carry.denominator,interestHash(next),market.market_id,row.account_id,market.tick_no);
    }
  }
  unpaidInterest(marketId:string,accountId:string,tick:number,elapsed:number):Fraction {
    const row=this.#interest(marketId,accountId,tick);
    if(elapsed<row.elapsed_ms) throw new LedgerIntegrityError('Active time moved backward.');
    const accrued=accumulateCashInterest(checkedFraction(row.accrued_numerator,row.accrued_denominator),row.cash_atoms,this.dailyRate(marketId,tick),elapsed-row.elapsed_ms);
    return addFractions(accrued,checkedFraction(row.carry_numerator,row.carry_denominator));
  }
  interestView(marketId:string,accountId:string,tick:number,elapsed:number):{accruedCashInterest:string;cashInterestTotal:string} {
    const accrued=this.unpaidInterest(marketId,accountId,tick,elapsed);
    const paid=this.#db.prepare('SELECT paid_atoms FROM interest_payouts WHERE market_id = ? AND account_id = ?').all(marketId,accountId) as Array<{paid_atoms:string}>;
    const paidTotal=paid.reduce((sum,p)=>sum+moneyFromAtoms(p.paid_atoms),0n);
    const journal=this.#db.prepare("SELECT account_delta_atoms FROM cash_journal WHERE market_id = ? AND account_id = ? AND entry_type = 'INTEREST'")
      .all(marketId,accountId) as Array<{account_delta_atoms:string}>;
    if(journal.reduce((sum,row)=>sum+moneyFromAtoms(row.account_delta_atoms),0n)!==paidTotal) throw new LedgerIntegrityError('Interest payouts differ from the cash journal.');
    return {accruedCashInterest:text(quantizeMoney(accrued,'floor').money),cashInterestTotal:text(paidTotal)};
  }
  updatedAt(marketId:string):string {
    const row=this.#row(marketId);if(!row) throw new LedgerIntegrityError();
    return (this.#db.prepare('SELECT committed_at FROM economy_snapshots WHERE market_id = ? AND tick_no = ?').get(marketId,row.current_tick) as {committed_at:string}).committed_at;
  }
  priceChanges(marketId:string):ReadonlyMap<string,string> {
    return new Map(this.load(marketId).pricing.companies.map(company=>[company.listingId,parseRate(new FinancialDecimal(company.lastReturn).times('100').toString())]));
  }
  publicView(marketId:string):EconomyView {
    // Implemented solely from the independently sealed public/pricing state.
    const snapshot=this.load(marketId);
    const publications=this.#db.prepare('SELECT publication_json FROM economy_publications WHERE market_id = ? ORDER BY tick_no DESC,publication_id DESC LIMIT 8')
      .all(marketId) as Array<{publication_json:string}>;
    return projectEconomyView(snapshot,this.rates(snapshot),publications.map(row=>JSON.parse(row.publication_json)));
  }
}

export function projectEconomyView(snapshot:Pick<EconomySnapshot,'engineVersion'|'public'>,rates:{policyRate:string;cashAnnualRate:string;cashDailyRate:string},disclosures:readonly PublicDisclosureRecord[]):EconomyView {
  const state=snapshot.public;const macro=state.observedMacro;
  return {engineVersion:snapshot.engineVersion,economyTick:state.tickNo,
    macro:{...rates,inflation:macro.inflation,outputGap:macro.outputGap,industrialDemand:macro.industrialDemand,
      consumerDemand:macro.consumerDemand,metals:macro.metals,energy:macro.energy,fx:macro.fx,
      creditStress:macro.creditStress,riskAppetite:macro.riskAppetite,observedTick:state.macroObservedTick,
      nextMeetingTick:state.policyExpectation.meetingTick,policyProbabilities:{decrease:state.policyExpectation.decreaseProbability,
        unchanged:state.policyExpectation.unchangedProbability,increase:state.policyExpectation.increaseProbability}},
    companies:state.companies.map(company=>{
      const report=company.latestReport;
      return {symbol:company.symbol,name:company.name,reportKind:report.kind,quarterNo:report.quarterNo,
        closedTick:report.closedTick,publishedTick:report.publishTick,nextEarningsTick:company.nextEarningsTick,
        revenue:text(report.revenueAtoms),operatingProfit:text(report.operatingProfitAtoms),interestExpense:text(report.interestExpenseAtoms),
        netProfit:text(report.netProfitAtoms),cash:text(report.cashAtoms),debt:text(report.debtAtoms),
        operatingCashFlow:text(report.operatingCashFlowAtoms),capex:text(report.capexAtoms),
        annualRevenueForecast:text(moneyFromAtoms(company.forecast.expectedQuarterRevenueAtoms)*4n),
        operatingMarginForecast:company.forecast.operatingMargin,growthForecast:company.forecast.annualRevenueGrowth,generation:company.generation,lifecycle:company.lifecycle,
        dividends:company.dividends.slice(-4).map(dividend=>({id:dividend.id,dps:dividend.dps,status:dividend.status,declaredTick:dividend.declaredTick,exTick:dividend.exTick,payTick:dividend.payTick,recoveryRatio:dividend.recoveryRatio}))};
    }),
    disclosures:disclosures.map(disclosure=>{
      const company=state.companies.find(value=>value.issuerId===disclosure.issuerId);
      const publicSymbol=company?.symbol??disclosure.actual['symbol']??null;
      return {id:disclosure.id,kind:disclosure.kind,publishedTick:disclosure.publishedTick,symbol:publicSymbol,
        title:disclosure.kind==='EVENT'?(disclosure.event?.title??'사건 공시').slice(0,100):disclosure.kind==='MACRO'?'경제·금리 발표':disclosure.kind==='CORPORATE_ACTION'?`${publicSymbol??''} 기업행동`:`${publicSymbol??''} 실적 발표`,
        summary:disclosure.kind==='EVENT'?eventSummary(disclosure):disclosure.kind==='MACRO'?`정책금리 ${disclosure.actual['policyRate']??''} · 이전 ${disclosure.previous['policyRate']??''} · 기대 ${disclosure.expected['policyRate']??''}`:
          disclosure.kind==='CORPORATE_ACTION'?corporateSummary(disclosure.actual):`매출 ${text(disclosure.actual['revenueAtoms']??'0')} · 예상 ${text(disclosure.expected['revenueAtoms']??'0')} · 이전 ${text(disclosure.previous['revenueAtoms']??'0')}`};
    }),
  };
}
function eventSummary(disclosure:PublicDisclosureRecord):string {
  const event=disclosure.event;
  const template=event?getEventTemplate(event.templateId):undefined;
  const labels:Readonly<Record<string,string>>={demand:'수요',exportDemand:'수출 수요',rawMaterials:'소재 비용',energy:'에너지',labor:'인건비',service:'서비스 비용',research:'연구비',unitPrice:'판매 단가',productivity:'생산성',productMix:'제품 구성',inventoryTurnover:'재고 회전',capacity:'생산능력',customerBase:'고객 기반',cash:'현금',inventory:'재고',operatingAssets:'설비',intangibleAssets:'무형자산',receivables:'매출채권',payables:'매입채무',contractLiability:'계약 의무',creditSpread:'차입 가산금리',sentiment:'시장 기대',successProbability:'사업 성공 가능성',industrialDemand:'산업 수요',consumerDemand:'소비 수요',metals:'금속 지수',fx:'환율 지수',inflation:'물가',policyRate:'정책금리',creditStress:'신용 위험',riskAppetite:'위험 선호',cashDeltaAtoms:'현금 변동',debtDeltaAtoms:'차입 변동',revenueAtoms:'매출',operatingProfitAtoms:'영업이익',netProfitAtoms:'순이익',foreignExchangeProfitAtoms:'실현 외환손익',operatingMargin:'영업이익률',recurringOperatingMargin:'반복 영업이익률',dps:'주당 배당',exTick:'배당락',payTick:'지급',completionTick:'완료 예정',projectStatus:'진행 상태'};
  const ratios=new Set(['creditSpread','sentiment','successProbability','inflation','policyRate','operatingMargin','recurringOperatingMargin']);
  const status:Readonly<Record<string,string>>={IN_PROGRESS:'진행 중',COMPLETED:'완료',EXPENSED:'비용 반영',FAILED:'실패',CANCELLED:'종료'};
  const observation=(record:Readonly<Record<string,string>>)=>Object.entries(record).filter(([key])=>labels[key]!==undefined).slice(0,4).map(([key,value])=>{
    const relative=key===event?.target&&template!==undefined&&['RATIO','CASH_FRACTION','ASSET_FRACTION'].includes(template.unit)&&!(event.profile==='MACRO'&&['industrialDemand','consumerDemand','metals','energy','fx','creditStress','riskAppetite'].includes(key));
    const points=key===event?.target&&template?.unit==='PERCENTAGE_POINTS'&&!ratios.has(key);
    const rendered=key.endsWith('Atoms')?`${text(value)}포인트`:key.endsWith('Tick')?`${value}틱`:key==='projectStatus'?status[value]??'확인 중':points?`${new FinancialDecimal(value).mul(100).toFixed()}%p`:relative||ratios.has(key)?`${new FinancialDecimal(value).mul(100).toFixed()}%`:value;
    const label=relative&&template?.unit==='CASH_FRACTION'?'현금 대비 규모':relative&&template?.unit==='ASSET_FRACTION'?'대상 자산 변동 비율':labels[key];
    return `${label} ${rendered}`;
  }).join(', ')||'해당 없음';
  const certainty:Readonly<Record<string,string>>={CONFIRMED:'확정',ESTIMATE:'추정',RUMOR:'미확인 소식'};
  const source:Readonly<Record<string,string>>={COMPANY:'가상 회사',STATISTICS:'모의 통계',POLICY:'모의 정책회의',PRESS:'가상 보도'};
  return [template?.observedTarget??'가상 경제의 실제 관측',`실제 ${observation(disclosure.actual)}`,`예상 ${observation(disclosure.expected)}`,`이전 ${observation(disclosure.previous)}`,event?`${certainty[event.certainty]} · ${source[event.sourceType]} · 효력 ${event.effectiveTick}틱`:''].filter(Boolean).join(' · ').slice(0,1000);
}
function corporateSummary(actual:Readonly<Record<string,string>>):string {
  const labels:Readonly<Record<string,string>>={DIVIDEND_DECLARED:'배당 발표',DIVIDEND_EX:'배당락·권리 확정',DIVIDEND_PAYMENT:'배당 지급',DIVIDEND_IMPAIRED:'배당 회수금 손상',
    FINANCING:'외부 신주 자금조달',LIFECYCLE_CHANGED:'기업 상태 변경',LIQUIDATION_STARTED:'청산 진입·회수권 전환',LIQUIDATION_SETTLED:'청산 최종 정산',REPLACEMENT:'새 회사 편입'};
  const kind=actual['actionKind']??'';
  return [labels[kind]??'기업행동',actual['dps']===undefined?'':`명목 DPS ${actual['dps']}`,actual['exTick']===undefined?'':`권리 경제 ${actual['exTick']}틱`,
    actual['payTick']===undefined?'':`지급 경제 ${actual['payTick']}틱`,actual['newSymbol']===undefined?'':`신규 ${actual['newSymbol']}`].filter(Boolean).join(' · ');
}
