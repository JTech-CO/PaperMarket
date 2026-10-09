import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { ScheduledOrderView } from '../application/contracts.js';
import { addFractions, decimalFraction, fraction, fractionToCanonicalDecimal, moneyFromAtoms, moneyToString, parseOrderQuantity, parsePrice, type Fraction } from '../domain/numeric.js';
import { utcTimestampSchema } from '../domain/identifiers.js';
import { STANDARD_RULESET } from '../domain/ruleset.js';
import { settleBuy } from '../domain/settlement.js';
import { LedgerIntegrityError } from '../storage/replay.js';

const opaque=z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const count=z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const quantity=z.string().max(128).refine(v=>{try{return parseOrderQuantity(v)===v;}catch{return false;}});
const price=z.string().max(128).refine(v=>{try{return parsePrice(v)===v;}catch{return false;}});
const rowSchema=z.strictObject({order_id:opaque,intent_id:opaque,market_id:opaque,account_id:opaque,actor_hash:z.string().regex(/^[a-f0-9]{64}$/),
  listing_id:opaque,symbol:z.string().regex(/^[A-Z][A-Z0-9]{0,11}$/),side:z.enum(['BUY','SELL']),order_type:z.enum(['LIMIT','STOP']),quantity,condition_price:price,
  time_in_force:z.enum(['TICK_COUNT','UNTIL_CANCELLED']),expires_tick:count.min(1).nullable(),created_tick:count,sequence_no:count.min(1),
  reserved_cash_atoms:z.string().max(50).regex(/^(?:0|[1-9][0-9]*)$/),reserved_quantity:z.string().max(128),status:z.enum(['OPEN','FILLED','CANCELLED','EXPIRED']),
  termination_reason:z.enum(['USER_CANCELLED','EXPIRED','CORPORATE_ACTION_CANCELLED','ACCOUNT_CLOSED','FILLED']).nullable(),fill_order_id:opaque.nullable(),created_at:utcTimestampSchema});
export type ScheduledRow=z.infer<typeof rowSchema>;
export interface ConditionalIntent {order_type:'LIMIT'|'STOP';condition_price:string;time_in_force:'TICK_COUNT'|'UNTIL_CANCELLED';valid_for_ticks:number|null}
const termsSchema=z.strictObject({order_type:z.enum(['LIMIT','STOP']),condition_price:price,time_in_force:z.enum(['TICK_COUNT','UNTIL_CANCELLED']),valid_for_ticks:count.min(1).max(10000).nullable()}).refine(value=>value.time_in_force==='TICK_COUNT'?value.valid_for_ticks!==null:value.valid_for_ticks===null);
export interface ReservationMetadata {market_id:string;tick_no:number;market_version:number;sequence_no:number}
function json(row:ScheduledRow):string {return JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a<b?-1:a>b?1:0)));}
function hash(previous:string,row:ScheduledRow,meta:ReservationMetadata,cash:string,shares:string,at:string):string {
  return createHash('sha256').update(JSON.stringify([previous,json(row),meta.tick_no,meta.market_version,meta.sequence_no,cash,shares,at])).digest('hex');
}
function opposite(v:string):string {const q=decimalFraction(v);return fractionToCanonicalDecimal(fraction(-q.numerator,q.denominator));}

/** Reservations are paired, append-only financial records. The mutable order is checked against their replay. */
export class ScheduledRepository {
  constructor(readonly db:Database.Database) {}
  terms(intentId:string):ConditionalIntent|undefined {
    const row=this.db.prepare('SELECT order_type,condition_price,time_in_force,valid_for_ticks FROM conditional_intents WHERE intent_id = ?').get(intentId);
    if(row===undefined) return undefined;const parsed=termsSchema.safeParse(row);if(!parsed.success) throw new LedgerIntegrityError('Persisted condition terms failed validation.');return parsed.data;
  }
  replay(marketId:string,accountId:string):ScheduledRow[] {
    try {
      const market=this.db.prepare('SELECT tick_no,market_version,sequence_no FROM markets WHERE market_id = ?').get(marketId) as {tick_no:number;market_version:number;sequence_no:number}|undefined;
      const subject=this.db.prepare('SELECT subject_hash,closed_at FROM account_subjects WHERE market_id = ? AND account_id = ?').get(marketId,accountId) as {subject_hash:string;closed_at:string|null}|undefined;
      const rows=this.db.prepare('SELECT * FROM scheduled_orders WHERE market_id = ? AND account_id = ? ORDER BY sequence_no').all(marketId,accountId).map(r=>rowSchema.parse(r));
      if(!market||(!subject&&rows.length)) throw new LedgerIntegrityError();
      const current=new Map(rows.map(r=>[r.order_id,r]));const states=new Map<string,ScheduledRow>();let previous='';let lastSequence=0;
      const journal=this.db.prepare('SELECT * FROM reservation_journal WHERE market_id = ? AND account_id = ? ORDER BY sequence_no').all(marketId,accountId) as Array<{order_id:string;tick_no:number;market_version:number;sequence_no:number;state_json:string;cash_delta_atoms:string;system_cash_delta_atoms:string;quantity_delta:string;system_quantity_delta:string;previous_hash:string;state_hash:string;created_at:string}>;
      for(const entry of journal) {
        const state=rowSchema.parse(JSON.parse(entry.state_json));const prior=states.get(state.order_id);const opening=prior===undefined;
        if(!current.has(state.order_id)||state.market_id!==marketId||state.account_id!==accountId||entry.order_id!==state.order_id||state.actor_hash!==subject?.subject_hash||entry.previous_hash!==previous||entry.sequence_no<=lastSequence||entry.sequence_no>market.sequence_no||entry.tick_no>market.tick_no||entry.market_version>market.market_version||!Number.isSafeInteger(entry.tick_no)||!Number.isSafeInteger(entry.market_version)||entry.tick_no<0||entry.market_version<0) throw new LedgerIntegrityError();
        utcTimestampSchema.parse(entry.created_at);
        if(opening ? state.status!=='OPEN'||entry.sequence_no!==state.sequence_no : prior.status!=='OPEN'||state.status==='OPEN'||json({...state,status:prior.status,termination_reason:prior.termination_reason,fill_order_id:prior.fill_order_id})!==json(prior)) throw new LedgerIntegrityError();
        if(opening&&(entry.tick_no!==state.created_tick||entry.created_at!==state.created_at)) throw new LedgerIntegrityError();
        if(state.status==='EXPIRED'&&(state.time_in_force!=='TICK_COUNT'||state.expires_tick!==entry.tick_no+1)) throw new LedgerIntegrityError();
        if(state.status==='FILLED') {
          const fill=this.db.prepare('SELECT tick_no,market_version,sequence_no,created_at FROM fills WHERE order_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?').get(state.fill_order_id,marketId,accountId,state.actor_hash) as {tick_no:number;market_version:number;sequence_no:number;created_at:string}|undefined;
          if(!fill||fill.tick_no!==entry.tick_no||fill.market_version!==entry.market_version||fill.sequence_no<=state.sequence_no||fill.sequence_no>=entry.sequence_no||fill.created_at!==entry.created_at||state.expires_tick!==null&&fill.tick_no>=state.expires_tick) throw new LedgerIntegrityError();
        }
        if(state.termination_reason==='CORPORATE_ACTION_CANCELLED'&&!this.db.prepare(`SELECT 1 FROM corporate_actions WHERE market_id = ? AND tick_no = ? AND json_extract(action_json,'$.listingId') = ? AND json_extract(action_json,'$.kind') IN ('DIVIDEND_EX','LIQUIDATION_STARTED')`).get(marketId,entry.tick_no,state.listing_id)&&!this.db.prepare("SELECT 1 FROM listings WHERE market_id = ? AND listing_id = ? AND status <> 'ACTIVE'").get(marketId,state.listing_id)) throw new LedgerIntegrityError();
        if(state.termination_reason==='ACCOUNT_CLOSED'&&subject?.closed_at!==null&&entry.created_at!==subject?.closed_at) throw new LedgerIntegrityError();
        const cash=(BigInt(state.reserved_cash_atoms)*(opening?1n:-1n)).toString();const shares=opening?state.reserved_quantity:opposite(state.reserved_quantity);
        if(entry.cash_delta_atoms!==cash||entry.system_cash_delta_atoms!==(-BigInt(cash)).toString()||entry.quantity_delta!==shares||entry.system_quantity_delta!==opposite(shares)||entry.state_hash!==hash(previous,state,{market_id:marketId,tick_no:entry.tick_no,market_version:entry.market_version,sequence_no:entry.sequence_no},cash,shares,entry.created_at)) throw new LedgerIntegrityError();
        states.set(state.order_id,state);previous=entry.state_hash;lastSequence=entry.sequence_no;
      }
      for(const row of rows) {
        if(!states.has(row.order_id)||json(states.get(row.order_id)!)!==json(row)||row.actor_hash!==subject?.subject_hash||row.sequence_no>market.sequence_no||row.created_tick>market.tick_no||row.order_type==='STOP'&&row.side!=='SELL') throw new LedgerIntegrityError();
        const terms=this.terms(row.intent_id);const intent=this.db.prepare('SELECT * FROM order_intents WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?').get(row.intent_id,marketId,accountId,row.actor_hash) as {status:string;quantity:string;listing_id:string;side:string}|undefined;
        if(!terms||!intent||intent.status!=='FILLED'||intent.quantity!==row.quantity||intent.listing_id!==row.listing_id||intent.side!==row.side||terms.order_type!==row.order_type||terms.condition_price!==row.condition_price||terms.time_in_force!==row.time_in_force|| (row.time_in_force==='TICK_COUNT'?terms.valid_for_ticks===null||terms.valid_for_ticks<1||terms.valid_for_ticks>10000||row.expires_tick!==row.created_tick+terms.valid_for_ticks:terms.valid_for_ticks!==null||row.expires_tick!==null)) throw new LedgerIntegrityError();
        const expected=row.side==='BUY'?settleBuy(parsePrice(row.condition_price),parseOrderQuantity(row.quantity),STANDARD_RULESET.tradeFeeRate).money:0n;
        if(BigInt(row.reserved_cash_atoms)!==expected||row.reserved_quantity!==(row.side==='SELL'?row.quantity:'0')) throw new LedgerIntegrityError();
        if(row.status==='OPEN') {if(row.termination_reason!==null||row.fill_order_id!==null||subject?.closed_at!==null) throw new LedgerIntegrityError();}
        else if(row.status==='FILLED') {
          const fill=this.db.prepare('SELECT intent_id,listing_id,side,quantity,price FROM fills WHERE order_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?').get(row.fill_order_id,marketId,accountId,row.actor_hash) as {intent_id:string;listing_id:string;side:string;quantity:string;price:string}|undefined;
          if(row.termination_reason!=='FILLED'||!fill||fill.intent_id!==row.intent_id||fill.listing_id!==row.listing_id||fill.side!==row.side||fill.quantity!==row.quantity||!this.triggered(row,fill.price)) throw new LedgerIntegrityError();
        } else if(row.fill_order_id!==null||row.status==='EXPIRED'&&row.termination_reason!=='EXPIRED'||row.status==='CANCELLED'&&!['USER_CANCELLED','ACCOUNT_CLOSED','CORPORATE_ACTION_CANCELLED'].includes(row.termination_reason??'')) throw new LedgerIntegrityError();
      }
      return rows;
    } catch(error) {if(error instanceof LedgerIntegrityError) throw error;throw new LedgerIntegrityError('Reservation journal integrity check failed.');}
  }
  reservations(marketId:string,accountId:string,exclude?:string):{cash:bigint;shares:Map<string,Fraction>} {
    let cash=0n;const shares=new Map<string,Fraction>();
    for(const row of this.replay(marketId,accountId)) if(row.status==='OPEN'&&row.order_id!==exclude) {cash+=BigInt(row.reserved_cash_atoms);shares.set(row.listing_id,addFractions(shares.get(row.listing_id)??fraction(0n),decimalFraction(row.reserved_quantity)));}
    return {cash,shares};
  }
  triggered(row:ScheduledRow,currentPrice:string):boolean {
    const current=decimalFraction(currentPrice);const limit=decimalFraction(row.condition_price);const cmp=current.numerator*limit.denominator-limit.numerator*current.denominator;
    return row.order_type==='STOP'||row.side==='BUY'?cmp<=0n:cmp>=0n;
  }
  open(row:ScheduledRow,meta:ReservationMetadata,at:string):void {
    this.db.prepare(`INSERT INTO scheduled_orders(order_id,intent_id,market_id,account_id,actor_hash,listing_id,symbol,side,order_type,quantity,condition_price,time_in_force,expires_tick,created_tick,sequence_no,reserved_cash_atoms,reserved_quantity,status,termination_reason,fill_order_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'OPEN',NULL,NULL,?)`).run(row.order_id,row.intent_id,row.market_id,row.account_id,row.actor_hash,row.listing_id,row.symbol,row.side,row.order_type,row.quantity,row.condition_price,row.time_in_force,row.expires_tick,row.created_tick,row.sequence_no,row.reserved_cash_atoms,row.reserved_quantity,row.created_at);
    this.append(row,meta,at,true);
  }
  finish(row:ScheduledRow,status:'FILLED'|'CANCELLED'|'EXPIRED',reason:NonNullable<ScheduledRow['termination_reason']>,fillOrderId:string|null,meta:ReservationMetadata,at:string):ScheduledRow {
    const state={...row,status,termination_reason:reason,fill_order_id:fillOrderId};
    const changed=this.db.prepare("UPDATE scheduled_orders SET status = ?,termination_reason = ?,fill_order_id = ? WHERE order_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ? AND status = 'OPEN'").run(status,reason,fillOrderId,row.order_id,row.market_id,row.account_id,row.actor_hash);
    if(changed.changes!==1) throw new LedgerIntegrityError();this.append(state,meta,at,false);return state;
  }
  private append(row:ScheduledRow,meta:ReservationMetadata,at:string,opening:boolean):void {
    const prior=this.db.prepare('SELECT state_hash FROM reservation_journal WHERE market_id = ? AND account_id = ? ORDER BY sequence_no DESC LIMIT 1').get(row.market_id,row.account_id) as {state_hash:string}|undefined;
    const previous=prior?.state_hash??'';const cash=(BigInt(row.reserved_cash_atoms)*(opening?1n:-1n)).toString();const shares=opening?row.reserved_quantity:opposite(row.reserved_quantity);
    this.db.prepare(`INSERT INTO reservation_journal(event_id,market_id,account_id,order_id,tick_no,market_version,sequence_no,state_json,cash_delta_atoms,system_cash_delta_atoms,quantity_delta,system_quantity_delta,previous_hash,state_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(),row.market_id,row.account_id,row.order_id,meta.tick_no,meta.market_version,meta.sequence_no,json(row),cash,(-BigInt(cash)).toString(),shares,opposite(shares),previous,hash(previous,row,meta,cash,shares,at),at);
  }
  view(row:ScheduledRow):ScheduledOrderView {
    return {orderId:row.order_id,symbol:row.symbol,side:row.side,orderType:row.order_type,quantity:row.quantity,conditionPrice:row.condition_price,timeInForce:row.time_in_force,expiresTick:row.expires_tick,status:row.status,reservedCash:moneyToString(moneyFromAtoms(row.status==='OPEN'?row.reserved_cash_atoms:'0')),reservedQuantity:row.status==='OPEN'?row.reserved_quantity:'0',sequenceNo:row.sequence_no,createdTick:row.created_tick,...(row.termination_reason?{terminationReason:row.termination_reason}:{})};
  }
}
