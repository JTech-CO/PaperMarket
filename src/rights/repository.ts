import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { RightsView } from '../application/contracts.js';
import type { CorporateAction, CorporateDividend } from '../economy/types.js';
import { MONEY_SCALE, addFractions, decimalFraction, fraction, fractionToCanonicalDecimal,
  moneyFromAtoms, moneyToString, multiplyFractions, negateFraction, parseFraction, quantizeMoney, serializeFraction, type Fraction } from '../domain/numeric.js';
import { FoundationRepository } from '../storage/repository.js';
import { LedgerIntegrityError } from '../storage/replay.js';
import { dividendRightMark } from '../domain/corporate-rights.js';

const id = z.string().min(1).max(256).regex(/^[A-Za-z0-9_.:-]+$/);
const frac = z.strictObject({ numerator:z.string().max(4096).regex(/^(?:0|[1-9]\d*)$/), denominator:z.string().max(4096).regex(/^[1-9]\d*$/) });
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const recordSchema = z.strictObject({ rightId:id,originId:id,marketId:id,accountId:id,issuerId:id,listingId:id,
  symbol:z.string().min(1).max(12).regex(/^[A-Z][A-Z0-9]*$/),kind:z.enum(['DIVIDEND','LIQUIDATION','ROUNDING']),
  status:z.enum(['ATTACHED','OPEN','IMPAIRED','SETTLED']),quantity:z.string().max(128),nominal:frac,mark:frac,
  paidAtoms:z.string().max(51).regex(/^(?:0|[1-9]\d*)$/),costAtoms:z.string().max(51).regex(/^(?:0|[1-9]\d*)$/),
  eligibleTick:counter,paymentTick:counter });
type Right = z.infer<typeof recordSchema>;
interface Event { market_id:string;account_id:string;right_id:string;action_id:string;event_id:string;tick_no:number;
  market_version:number;sequence_no:number;state_json:string;counter_json:string;previous_hash:string;state_hash:string;created_at:string }
export interface RightsTick { market_id:string;tick_no:number;market_version:number;sequence_no:number;engine_version:string;ruleset_version:string }
type CashChanged = (accountId:string,status:string,cashBefore:string,cashAfter:string)=>void;
const points = (atoms:string|bigint) => moneyToString(moneyFromAtoms(atoms.toString()));
const exact = (value:Fraction) => serializeFraction(value);
// Corporate action keys have a wider grammar than the immutable foundation ledger IDs.
const ledgerCause = (actionId:string) => `rights_${createHash('sha256').update(actionId).digest('hex').slice(0,48)}`;
function digest(row:Omit<Event,'state_hash'>):string { return createHash('sha256').update(JSON.stringify([
  row.market_id,row.account_id,row.right_id,row.action_id,row.event_id,row.tick_no,row.market_version,row.sequence_no,
  row.state_json,row.counter_json,row.previous_hash,row.created_at])).digest('hex'); }
function value(value:Fraction):string { return points(quantizeMoney(value,'floor').money); }
function counterState(right:Right):string { return JSON.stringify({nominal:exact(negateFraction(parseFraction(right.nominal))),mark:exact(negateFraction(parseFraction(right.mark))),
  paidAtoms:(-BigInt(right.paidAtoms)).toString(),costAtoms:(-BigInt(right.costAtoms)).toString(),quantity:fractionToCanonicalDecimal(negateFraction(decimalFraction(right.quantity)))}); }

/** Investor claims are appended independently of the company's economic number of shares. */
export class RightsRepository {
  constructor(readonly db:Database.Database) {}
  replay(marketId:string,accountId:string):ReadonlyMap<string,Right> {
    const owner=this.db.prepare('SELECT account_id FROM accounts WHERE market_id = ? AND account_id = ?').get(marketId,accountId);
    if(!owner) throw new LedgerIntegrityError('Claim account scope differs.');
    const market=this.db.prepare('SELECT tick_no,market_version,sequence_no FROM markets WHERE market_id = ?').get(marketId) as RightsTick;
    const rows=this.db.prepare('SELECT * FROM rights_journal WHERE market_id = ? AND account_id = ? ORDER BY sequence_no,rowid').all(marketId,accountId) as Event[];
    const states=new Map<string,Right>();const hashes=new Map<string,string>();
    for(const row of rows) {
      if(row.market_id!==marketId||row.account_id!==accountId||row.tick_no>market.tick_no||row.market_version>market.market_version||row.sequence_no>market.sequence_no)
        throw new LedgerIntegrityError('Claim metadata differs.');
      const {state_hash,...unsigned}=row;
      if(row.previous_hash!==(hashes.get(row.right_id)??'')||state_hash!==digest(unsigned)) throw new LedgerIntegrityError('Claim journal chain differs.');
      let right:Right;
      try {right=recordSchema.parse(JSON.parse(row.state_json));} catch {throw new LedgerIntegrityError('Invalid claim journal.');}
      if(JSON.stringify(right)!==row.state_json||right.marketId!==marketId||right.accountId!==accountId||right.rightId!==row.right_id)
        throw new LedgerIntegrityError('Claim identity differs.');
      if(row.counter_json!==counterState(right)) throw new LedgerIntegrityError('Claim system counterpart differs.');
      const prior=states.get(right.rightId);
      if(prior&&(prior.originId!==right.originId||prior.issuerId!==right.issuerId||prior.listingId!==right.listingId||prior.quantity!==right.quantity||prior.costAtoms!==right.costAtoms||prior.kind!==right.kind))
        throw new LedgerIntegrityError('Claim ownership changed.');
      for(const field of [right.nominal,right.mark]) parseFraction(field);
      const quantity=decimalFraction(right.quantity);if(quantity.numerator<0n) throw new LedgerIntegrityError();
      if(right.kind==='ROUNDING'&&parseFraction(right.mark).numerator*MONEY_SCALE>=parseFraction(right.mark).denominator) throw new LedgerIntegrityError('Invalid claim rounding balance.');
      states.set(right.rightId,right);hashes.set(right.rightId,state_hash);
    }
    const recorded=[...states.values()].reduce((sum,right)=>sum+BigInt(right.paidAtoms),0n);
    const paid=this.db.prepare("SELECT account_delta_atoms FROM cash_journal WHERE market_id = ? AND account_id = ? AND entry_type IN ('DIVIDEND','LIQUIDATION')").all(marketId,accountId) as {account_delta_atoms:string}[];
    if(recorded!==paid.reduce((sum,row)=>sum+moneyFromAtoms(row.account_delta_atoms),0n)) throw new LedgerIntegrityError('Claim payments differ from the cash journal.');
    return states;
  }
  #append(rightInput:Right,actionId:string,market:RightsTick,now:string):void {
    const right=recordSchema.parse(rightInput);
    const previous=this.db.prepare('SELECT state_hash FROM rights_journal WHERE market_id = ? AND account_id = ? AND right_id = ? ORDER BY sequence_no DESC,rowid DESC LIMIT 1')
      .get(market.market_id,right.accountId,right.rightId) as {state_hash:string}|undefined;
    const row:Omit<Event,'state_hash'>={market_id:market.market_id,account_id:right.accountId,right_id:right.rightId,action_id:actionId,event_id:randomUUID(),
      tick_no:market.tick_no,market_version:market.market_version,sequence_no:market.sequence_no,state_json:JSON.stringify(right),counter_json:counterState(right),previous_hash:previous?.state_hash??'',created_at:now};
    this.db.prepare('INSERT INTO rights_journal(market_id,account_id,right_id,action_id,event_id,tick_no,market_version,sequence_no,state_json,counter_json,previous_hash,state_hash,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(row.market_id,row.account_id,row.right_id,row.action_id,row.event_id,row.tick_no,row.market_version,row.sequence_no,row.state_json,row.counter_json,row.previous_hash,digest(row),now);
  }
  #cash(right:Right,amount:Fraction,actionId:string,market:RightsTick,now:string,status:string,changed:CashChanged):void {
    if(right.status==='SETTLED') return;
    const states=this.replay(market.market_id,right.accountId);
    const roundingId=`rounding_${right.kind.toLowerCase()}`;
    const priorCarry=states.get(roundingId);
    const total=addFractions(amount,priorCarry?parseFraction(priorCarry.mark):fraction(0n));
    const payout=quantizeMoney(total,'floor');
    const carry=addFractions(total,negateFraction(fraction(payout.money,MONEY_SCALE)));
    const owner=this.db.prepare('SELECT discord_user_id FROM accounts WHERE market_id = ? AND account_id = ?').get(market.market_id,right.accountId) as {discord_user_id:string};
    const cashBefore=new FoundationRepository(this.db).replayAccount({marketId:market.market_id,discordUserId:owner.discord_user_id}).cashAtoms;
    if(payout.money>0n) {
      this.db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES(?,?,?,?,?,?,?,?,?,'PAPERMARKET_POINT',?,?,?,?,?,?,NULL)")
        .run(randomUUID(),randomUUID(),ledgerCause(actionId),market.market_id,right.accountId,right.kind,payout.money.toString(),(-payout.money).toString(),right.kind,
          market.tick_no,market.market_version,market.sequence_no,market.engine_version,market.ruleset_version,now);
      changed(right.accountId,status,cashBefore.toString(),(cashBefore+payout.money).toString());
      const bumped=this.db.prepare('UPDATE accounts SET account_version=account_version+1 WHERE market_id = ? AND account_id = ? AND account_version < 9007199254740991').run(market.market_id,right.accountId);
      if(bumped.changes!==1) throw new LedgerIntegrityError('Claim account version exceeded.');
    }
    this.#append({...right,status:'SETTLED',mark:exact(fraction(0n)),paidAtoms:payout.money.toString()},actionId,market,now);
    const rounding:Right=priorCarry??{...right,rightId:roundingId,originId:roundingId,kind:'ROUNDING',status:'OPEN',quantity:'0',costAtoms:'0',paidAtoms:'0',nominal:exact(fraction(0n))};
    this.#append({...rounding,mark:exact(carry)},`${actionId}_carry`,market,now);
  }
  apply(actions:readonly CorporateAction[],market:RightsTick,now:string,changed:CashChanged,annualRate='0',knownDividends:readonly CorporateDividend[]=[]):void {
    const latestDividends=[...new Map(knownDividends.map(dividend=>[dividend.id,dividend])).values()];
    const owners=this.db.prepare('SELECT account_id,discord_user_id,status FROM accounts WHERE market_id = ? ORDER BY account_id').all(market.market_id) as {account_id:string;discord_user_id:string;status:string}[];
    const foundation=new FoundationRepository(this.db);
    for(const action of actions) {
      if(action.kind==='DIVIDEND_EX'||action.kind==='LIQUIDATION_STARTED') {
        const intents=this.db.prepare("SELECT intent_id,account_id FROM order_intents WHERE market_id = ? AND listing_id = ? AND status = 'DRAFT'")
          .all(market.market_id,action.listingId) as {intent_id:string;account_id:string}[];
        for(const intent of intents) this.db.prepare('INSERT OR IGNORE INTO corporate_order_cancellations(market_id,account_id,intent_id,action_id,reason) VALUES(?,?,?,?,?)')
          .run(market.market_id,intent.account_id,intent.intent_id,action.id,'CORPORATE_ACTION_CANCELLED');
        this.db.prepare("UPDATE order_intents SET status='CANCELLED' WHERE market_id = ? AND listing_id = ? AND status='DRAFT'").run(market.market_id,action.listingId);
      }
      for(const owner of owners) {
        if(this.db.prepare('SELECT 1 FROM rights_journal WHERE market_id = ? AND account_id = ? AND action_id = ?').get(market.market_id,owner.account_id,action.id)) continue;
        let states=this.replay(market.market_id,owner.account_id);
        const matching=[...states.values()].filter(right=>right.listingId===action.listingId&&right.kind!=='ROUNDING'&&right.status!=='SETTLED');
        if(action.kind==='DIVIDEND_EX') {
          const attached=states.get(action.dividend.id);
          if(attached?.status==='ATTACHED') this.#append({...attached,status:action.dividend.recoveryRatio==='1'?'OPEN':'IMPAIRED'},action.id,market,now);
        }
        const origin=action.kind==='DIVIDEND_EX'?action.dividend.id:action.kind==='LIQUIDATION_STARTED'?action.liquidationId:null;
        if(origin&&!states.has(origin)) {
          let position=foundation.replayAccount({marketId:market.market_id,discordUserId:owner.discord_user_id}).positions.get(action.listingId);
          if((!position||position.quantity.numerator===0n)&&action.kind==='DIVIDEND_EX') {
            const liquidated=matching.find(right=>right.kind==='LIQUIDATION');
            if(liquidated) position={quantity:decimalFraction(liquidated.quantity),costAtoms:BigInt(liquidated.costAtoms)};
          }
          if(position&&position.quantity.numerator>0n) {
            const isDividend=action.kind==='DIVIDEND_EX';
            const nominal=isDividend?multiplyFractions(position.quantity,fraction(BigInt(action.dividend.totalNominalAtoms),MONEY_SCALE*BigInt(action.dividend.issuedShares))):fraction(0n);
            const perShare=isDividend?dividendRightMark(action.dividend.dps,action.dividend.recoveryRatio,annualRate,Math.max(0,action.dividend.payTick-action.effectiveTick)):action.kind==='LIQUIDATION_STARTED'?action.estimatedRecoveryPerShare:'0';
            const right:Right={rightId:origin,originId:origin,marketId:market.market_id,accountId:owner.account_id,issuerId:action.issuerId,listingId:action.listingId,symbol:action.symbol,
              kind:isDividend?'DIVIDEND':'LIQUIDATION',status:'OPEN',quantity:fractionToCanonicalDecimal(position.quantity),nominal:exact(nominal),mark:exact(multiplyFractions(position.quantity,decimalFraction(perShare))),
              costAtoms:isDividend?'0':position.costAtoms.toString(),paidAtoms:'0',eligibleTick:action.effectiveTick,
              paymentTick:isDividend?action.dividend.payTick:action.kind==='LIQUIDATION_STARTED'?action.settlementTick:action.effectiveTick};
            if(!isDividend) {
              const quantity=fractionToCanonicalDecimal(negateFraction(position.quantity));
              this.db.prepare('INSERT INTO position_journal(journal_id,event_id,cause_id,market_id,account_id,listing_id,quantity_delta,system_quantity_delta,cost_delta_atoms,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
                .run(randomUUID(),randomUUID(),ledgerCause(action.id),market.market_id,owner.account_id,action.listingId,quantity,fractionToCanonicalDecimal(position.quantity),(-position.costAtoms).toString(),market.tick_no,market.market_version,market.sequence_no,market.engine_version,market.ruleset_version,now);
            }
            this.#append(right,action.id,market,now);
            if(action.kind==='LIQUIDATION_STARTED') for(const dividend of latestDividends.filter(dividend=>dividend.listingId===action.listingId&&dividend.exTick>action.effectiveTick&&dividend.remainingPayableAtoms!=='0')) {
              if(states.has(dividend.id)) continue;
              const mark=dividendRightMark(dividend.dps,action.dividendRecoveryRatio,annualRate,Math.max(0,dividend.payTick-action.effectiveTick));
              this.#append({...right,rightId:dividend.id,originId:dividend.id,kind:'DIVIDEND',status:'ATTACHED',costAtoms:'0',eligibleTick:dividend.exTick,paymentTick:dividend.payTick,
                nominal:exact(multiplyFractions(position.quantity,fraction(BigInt(dividend.totalNominalAtoms),MONEY_SCALE*BigInt(dividend.issuedShares)))),mark:exact(multiplyFractions(position.quantity,decimalFraction(mark)))},`${action.id}_${dividend.id}`,market,now);
            }
            const bumped=this.db.prepare('UPDATE accounts SET account_version=account_version+1 WHERE market_id = ? AND account_id = ? AND account_version < 9007199254740991').run(market.market_id,owner.account_id);
            if(bumped.changes!==1) throw new LedgerIntegrityError('Claim account version exceeded.');
          }
        }
        if(action.kind==='DIVIDEND_IMPAIRED') for(const right of matching.filter(right=>right.originId===action.dividend.id))
          this.#append({...right,status:right.status==='ATTACHED'?'ATTACHED':'IMPAIRED',mark:exact(multiplyFractions(parseFraction(right.nominal),decimalFraction(action.dividend.recoveryRatio)))},action.id,market,now);
        if(action.kind==='DIVIDEND_PAYMENT') for(const right of matching.filter(right=>right.originId===action.dividend.id))
          this.#cash(right,multiplyFractions(parseFraction(right.nominal),fraction(BigInt(action.dividend.paidAtoms),BigInt(action.dividend.totalNominalAtoms))),action.id,market,now,owner.status,changed);
        if(action.kind==='LIQUIDATION_STARTED') for(const right of matching.filter(right=>right.kind==='DIVIDEND'))
          this.#append({...right,status:'IMPAIRED',mark:exact(multiplyFractions(parseFraction(right.nominal),decimalFraction(action.dividendRecoveryRatio)))},action.id,market,now);
        if(action.kind==='LIQUIDATION_SETTLED') {
          for(const right of matching.filter(right=>right.originId===action.liquidationId))
            this.#cash(right,multiplyFractions(decimalFraction(right.quantity),fraction(BigInt(action.commonPaidAtoms),MONEY_SCALE*BigInt(action.eligibleShares))),action.id,market,now,owner.status,changed);
          states=this.replay(market.market_id,owner.account_id);
          for(const recovery of action.dividendRecoveries) for(const right of [...states.values()].filter(right=>right.originId===recovery.dividendId&&right.kind==='DIVIDEND'&&right.status!=='SETTLED')) {
            const dividend=latestDividends.find(dividend=>dividend.id===recovery.dividendId);
            if(!dividend) throw new LedgerIntegrityError('Liquidation dividend basis missing.');
            this.#cash(right,multiplyFractions(parseFraction(right.nominal),fraction(BigInt(recovery.paidAtoms),BigInt(dividend.totalNominalAtoms))),`${action.id}_${recovery.dividendId}`,market,now,owner.status,changed);
          }
        }
      }
    }
  }
  revalue(market:RightsTick,now:string,economicTick:number,annualRate:string,dividends:readonly CorporateDividend[]):void {
    const latest=new Map(dividends.map(dividend=>[dividend.id,dividend]));
    const owners=this.db.prepare('SELECT account_id FROM accounts WHERE market_id = ?').all(market.market_id) as {account_id:string}[];
    for(const owner of owners) for(const right of this.replay(market.market_id,owner.account_id).values()) {
      if(right.kind!=='DIVIDEND'||right.status==='SETTLED') continue;
      const dividend=latest.get(right.originId);if(!dividend) continue;
      const perShare=dividendRightMark(dividend.dps,dividend.recoveryRatio,annualRate,Math.max(0,dividend.payTick-economicTick));
      const mark=exact(multiplyFractions(decimalFraction(right.quantity),decimalFraction(perShare)));
      if(JSON.stringify(mark)!==JSON.stringify(right.mark)) this.#append({...right,mark},`rights_valuation_${market.tick_no}`,market,now);
    }
  }
  view(marketId:string,accountId:string):{rights:RightsView[];asset:Fraction;dividendTotal:string;liquidationTotal:string} {
    const records=[...this.replay(marketId,accountId).values()];
    const asset=records.reduce((sum,right)=>addFractions(sum,parseFraction(right.mark)),fraction(0n));
    const rights=records.filter(right=>right.kind!=='ROUNDING').map((right):RightsView=>({rightId:right.rightId,kind:right.kind as RightsView['kind'],symbol:right.symbol,status:right.status,quantity:right.quantity,
      nominal:value(parseFraction(right.nominal)),currentValue:value(parseFraction(right.mark)),paid:points(right.paidAtoms),cost:points(right.costAtoms),realizedPnl:right.kind==='LIQUIDATION'&&right.status==='SETTLED'?points(BigInt(right.paidAtoms)-BigInt(right.costAtoms)):'0',eligibleTick:right.eligibleTick,paymentTick:right.paymentTick}));
    const total=(kind:string)=>points(records.filter(right=>right.kind===kind).reduce((sum,right)=>sum+BigInt(right.paidAtoms),0n));
    return {rights,asset,dividendTotal:total('DIVIDEND'),liquidationTotal:total('LIQUIDATION')};
  }
}
