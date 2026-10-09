import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { CalendarView, ChartView, DisclosureView, ExportView, HistoryEntry, MarketView, NewsView, PerformanceView, PortfolioView, PublicViewMeta, StockView } from '../application/contracts.js';
import { FinancialDecimal as D, MONEY_SCALE, addFractions, decimalFraction, fraction, moneyFromAtoms, moneyToString, multiplyFractions, parseFraction, parseMoney, parseRate, quantizeMoney, type Fraction } from '../domain/numeric.js';
import { dividendRightMark } from '../domain/corporate-rights.js';
import { capitalReturnFactor, linkCapitalFlows, type CapitalFlow } from '../domain/capital.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { canonicalEconomyJson, economySnapshotHash, projectEconomyView, type EconomySnapshot } from '../economy/repository.js';
import { publicEconomySchema, publicCorporateActionSchema, type PublicDisclosureRecord } from '../economy/public.js';
import type { CorporateDividend } from '../economy/types.js';
import { pricingStateSchema } from '../market/pricing.js';
import { RightsRepository } from '../rights/repository.js';
import { LedgerIntegrityError } from '../storage/replay.js';
import { ReportingBenchmarks } from './benchmarks.js';

export interface ReportingOwner { readonly marketId:string;readonly accountId:string;readonly discordUserId:string }
export interface CapitalPerformance { readonly initialCapital:string; readonly contributions:string; readonly netInvestmentPnl:string; readonly totalReturnPct:string }
interface SnapshotRow {tick_no:number;market_version:number;snapshot_json:string;snapshot_hash:string;committed_at:string}
interface PublicFrame {row:SnapshotRow;snapshot:EconomySnapshot}
interface Sample {market_id:string;account_id:string;tick_no:number;market_version:number;equity_atoms:string;sampled_at:string;source:'LIVE_TICK_END'|'HISTORICAL_TICK_END';previous_hash:string;sample_hash:string}
interface CashRow {event_id:string;entry_type:string;account_delta_atoms:string;tick_no:number;sequence_no:number;market_version:number;created_at:string;related_order_id:string|null}
interface CachedPublicSnapshot {readonly raw:string;readonly snapshot:EconomySnapshot;readonly bytes:number}
const PUBLIC_SNAPSHOT_CACHE_ENTRIES=64;
const PUBLIC_SNAPSHOT_CACHE_BYTES=16*1024*1024;
function freezeData<T>(value:T):T {
  if(value!==null&&typeof value==='object') {for(const child of Object.values(value))freezeData(child);Object.freeze(value);}
  return value;
}
const points=(atoms:string|bigint)=>moneyToString(moneyFromAtoms(atoms.toString()));
const value=(v:Fraction)=>points(quantizeMoney(v,'floor').money);
const digest=(v:unknown)=>createHash('sha256').update(canonicalEconomyJson(v)).digest('hex');
const meta=(m:MarketView):PublicViewMeta=>({tickNo:m.tickNo,marketVersion:m.marketVersion,updatedAt:m.updatedAt,nextBoundaryAt:m.nextBoundaryAt,state:m.state});
const signedPct=(v:InstanceType<typeof D>)=>parseRate(v.toString());
/** Escaping is applied to every CSV cell, including leading spaces/control characters. */
export function csvCell(input:unknown):string {
  let text=String(input??'');
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(text)) text=`'${text}`;
  return `"${text.replaceAll('"','""')}"`;
}
export function csvDocument(headers:readonly string[],rows:readonly (readonly unknown[])[]):string {
  return '\ufeff'+[headers,...rows].map(row=>row.map(csvCell).join(',')).join('\r\n')+'\r\n';
}

/** Projections whitelist public facts and owner-scoped financial fields. Never exposes sealed economics. */
export class ReportingRepository {
  readonly #publicSnapshots=new Map<string,CachedPublicSnapshot>();
  #publicSnapshotBytes=0;
  constructor(readonly db:Database.Database,readonly benchmarks:ReportingBenchmarks) {}
  /** Operator-only backup audit; retained pseudonymous samples remain verifiable after account closure. */
  auditAll():{owners:number;samples:number} {
    const owners=this.db.prepare('SELECT DISTINCT market_id,account_id FROM performance_samples ORDER BY market_id,account_id').all() as {market_id:string;account_id:string}[];
    let samples=0;
    for(const owner of owners)samples+=this.#validatedSamples(owner.market_id,owner.account_id).length;
    return {owners:owners.length,samples};
  }
  #owner(owner:ReportingOwner):void {
    if(!this.db.prepare("SELECT 1 FROM accounts WHERE market_id=? AND account_id=? AND discord_user_id=? AND status='ACTIVE'").get(owner.marketId,owner.accountId,owner.discordUserId)) throw new LedgerIntegrityError('Reporting owner unavailable.');
  }
  #snapshot(row:SnapshotRow):EconomySnapshot {
    const cached=this.#publicSnapshots.get(row.snapshot_hash);
    // A claimed digest alone cannot authorize reuse: raw bytes must match the validated input exactly.
    if(cached?.raw===row.snapshot_json) {this.#publicSnapshots.delete(row.snapshot_hash);this.#publicSnapshots.set(row.snapshot_hash,cached);return cached.snapshot;}
    const raw=JSON.parse(row.snapshot_json) as EconomySnapshot;
    if(economySnapshotHash(raw)!==row.snapshot_hash) throw new LedgerIntegrityError('Historical public snapshot hash differs.');
    // Read only these branches; legacy defaults follow original hash validation.
    const snapshot=freezeData({engineVersion:raw.engineVersion,public:publicEconomySchema.parse(raw.public) as unknown as EconomySnapshot['public'],pricing:pricingStateSchema.parse(raw.pricing) as unknown as EconomySnapshot['pricing'],economy:undefined as unknown as EconomySnapshot['economy']});
    const bytes=Buffer.byteLength(row.snapshot_json,'utf8');
    if(bytes<=PUBLIC_SNAPSHOT_CACHE_BYTES) {
      if(cached){this.#publicSnapshots.delete(row.snapshot_hash);this.#publicSnapshotBytes-=cached.bytes;}
      while(this.#publicSnapshots.size>=PUBLIC_SNAPSHOT_CACHE_ENTRIES||this.#publicSnapshotBytes+bytes>PUBLIC_SNAPSHOT_CACHE_BYTES) {
        const oldest=this.#publicSnapshots.keys().next().value;if(oldest===undefined)break;
        this.#publicSnapshotBytes-=this.#publicSnapshots.get(oldest)!.bytes;this.#publicSnapshots.delete(oldest);
      }
      this.#publicSnapshots.set(row.snapshot_hash,{raw:row.snapshot_json,snapshot,bytes});this.#publicSnapshotBytes+=bytes;
    }
    return snapshot;
  }
  #snapshots(marketId:string):Array<{row:SnapshotRow;snapshot:EconomySnapshot}> {
    return (this.db.prepare('SELECT tick_no,market_version,snapshot_json,snapshot_hash,committed_at FROM economy_snapshots WHERE market_id=? ORDER BY tick_no').all(marketId) as SnapshotRow[]).map(row=>({row,snapshot:this.#snapshot(row)}));
  }
  disclosures(market:MarketView,beforeTick=Number.MAX_SAFE_INTEGER,symbol?:string,limit=9):Array<DisclosureView & {listingId:string|null}> {
    const latest=this.db.prepare('SELECT tick_no,market_version,snapshot_json,snapshot_hash,committed_at FROM economy_snapshots WHERE market_id=? ORDER BY tick_no DESC LIMIT 1').get(market.marketId) as SnapshotRow|undefined;
    if(!latest) return [];
    const snapshot=this.#snapshot(latest);
    const rows=this.db.prepare('SELECT publication_json FROM economy_publications WHERE market_id=? AND tick_no<? ORDER BY tick_no DESC,publication_id DESC').all(market.marketId,beforeTick) as {publication_json:string}[];
    const result:Array<DisclosureView & {listingId:string|null}>=[];
    for(const row of rows) {
      const record=JSON.parse(row.publication_json) as PublicDisclosureRecord;
      if(record.publishedTick>snapshot.public.tickNo||!['MACRO','EARNINGS','CORPORATE_ACTION','EVENT'].includes(record.kind)) throw new LedgerIntegrityError('Undisclosed publication encountered.');
      const view=projectEconomyView(snapshot,{policyRate:'0',cashAnnualRate:'0',cashDailyRate:'0'},[record]).disclosures[0]!;
      // Older issuer IDs are looked up from durable listing identity, never the current slot.
      const listing=record.issuerId?this.db.prepare('SELECT listing_id,symbol FROM listings WHERE market_id=? AND issuer_id=?').get(market.marketId,record.issuerId) as {listing_id:string;symbol:string}|undefined:undefined;
      const projected={...view,publishedTick:(this.db.prepare('SELECT epoch_tick FROM economy_markets WHERE market_id=?').get(market.marketId) as {epoch_tick:number}).epoch_tick+view.publishedTick,symbol:listing?.symbol??view.symbol,listingId:listing?.listing_id??null};
      if(symbol&&projected.symbol!==symbol) continue;
      result.push(projected);if(result.length>=limit) break;
    }
    return result;
  }
  news(market:MarketView,beforeTick?:number,symbol?:string,cursor?:string):NewsView {
    const all=this.disclosures(market,beforeTick,symbol,100000);
    const start=cursor?all.findIndex(d=>createHash('sha256').update(d.id).digest('hex')===cursor)+1:0;
    if(cursor&&start===0)throw new RangeError('INVALID_CURSOR');
    const items=all.slice(start,start+5);const shown=items.slice(0,4);
    return {...meta(market),items:shown.map(({listingId:_listing,...item})=>item),more:items.length>4,nextBeforeTick:items.length>4?shown.at(-1)!.publishedTick:null,nextCursor:items.length>4?createHash('sha256').update(shown.at(-1)!.id).digest('hex'):null};
  }
  company(market:MarketView,symbol:string,generation?:number):StockView {
    const listing=this.db.prepare('SELECT listing_id,symbol,slot_id,category,price,status FROM listings WHERE market_id=? AND symbol=?').get(market.marketId,symbol) as {listing_id:string;symbol:string;slot_id:string;category:string;price:string;status:string}|undefined;
    if(!listing) throw new RangeError('LISTING_NOT_TRADABLE');
    let frame:PublicFrame|undefined;
    // Generations retain their own last disclosed financial report after replacement.
    const latest=this.db.prepare('SELECT tick_no,market_version,snapshot_json,snapshot_hash,committed_at FROM economy_snapshots WHERE market_id=? ORDER BY tick_no DESC LIMIT 1').get(market.marketId) as SnapshotRow|undefined;
    if(latest) {
      const snapshot=this.#snapshot(latest);
      frame={row:latest,snapshot};
      if(!snapshot.public.companies.some(c=>c.listingId===listing.listing_id)) frame=this.#snapshots(market.marketId).findLast(f=>f.snapshot.public.companies.some(c=>c.listingId===listing.listing_id));
    }
    const company=frame?.snapshot.public.companies.find(c=>c.listingId===listing.listing_id);
    const gen=company?.generation??1;
    if(generation!==undefined&&gen!==generation) throw new RangeError('LISTING_NOT_TRADABLE');
    const template=INITIAL_COMPANIES.find(c=>c.slotId===listing.slot_id)!;
    const priced=frame?.snapshot.pricing.companies.find(c=>c.listingId===listing.listing_id);
    const contribution=this.db.prepare('SELECT contribution_json FROM economy_prices WHERE market_id=? AND listing_id=? ORDER BY tick_no DESC LIMIT 1').get(market.marketId,listing.listing_id) as {contribution_json:string}|undefined;
    const details=contribution?JSON.parse(contribution.contribution_json) as {referencePrice:string;referenceAdjustment?:string}:undefined;
    const previous=this.db.prepare('SELECT price FROM economy_prices WHERE market_id=? AND listing_id=? ORDER BY tick_no DESC LIMIT 1 OFFSET 1').get(market.marketId,listing.listing_id) as {price:string}|undefined;
    const lifecycle=listing.status==='ACTIVE'?company?.lifecycle??'OPERATING':listing.status;
    return {...meta(market),listing:{listingId:listing.listing_id,symbol,name:company?.name??template.name,slotId:template.slotId,category:template.category,price:listing.price,generation:gen,lifecycle,changePct:priced?signedPct(new D(priced.lastReturn).mul(100)):'0'},
      currentPrice:listing.price,referencePrice:details?.referencePrice??listing.price,previousRawPrice:previous?.price??null,exAdjustment:new D(details?.referenceAdjustment??'0').lt(0),
      financial:frame?projectEconomyView(frame.snapshot,{policyRate:'0',cashAnnualRate:'0',cashDailyRate:'0'},[]).companies.find(c=>c.symbol===symbol)??null:null,
      latestDisclosures:this.disclosures(market,undefined,symbol,3).map(({listingId:_listing,...item})=>item),lifecycle,generation:gen,businessSummary:`${template.name}의 ${template.category==='ORDINARY'?'안정적 사업과 현금흐름':template.category==='GROWTH'?'성장 투자와 자금조달':template.category==='THEMATIC'?'사업 성과와 시장 기대':'현금흐름과 배당'}을 관찰하는 가상 기업입니다.`};
  }
  calendar(market:MarketView):CalendarView {
    const result:CalendarView['items'][number][]=[];
    const economy=market.economy;if(!economy) return {...meta(market),items:result};
    const offset=market.tickNo-economy.economyTick;
    result.push({kind:'POLICY',title:'모의 정책금리 회의',symbol:null,announcedTick:offset+economy.macro.observedTick,eventTick:offset+economy.macro.nextMeetingTick,generation:null});
    for(const company of economy.companies) {
      result.push({kind:'EARNINGS',title:'실적 발표 예정',symbol:company.symbol,announcedTick:offset+company.publishedTick,eventTick:offset+company.nextEarningsTick,generation:company.generation??1});
      for(const d of company.dividends??[]) for(const [kind,tick,title] of [['DIVIDEND_EX',d.exTick,'배당락·권리 확정'],['DIVIDEND_PAYMENT',d.payTick,'배당 지급 예정']] as const) if(offset+tick>=market.tickNo&&d.status!=='SETTLED') result.push({kind,title,symbol:company.symbol,announcedTick:offset+d.declaredTick,eventTick:offset+tick,generation:company.generation??1});
    }
    return {...meta(market),items:result.sort((a,b)=>a.eventTick-b.eventTick||a.title.localeCompare(b.title)).slice(0,25)};
  }
  chart(market:MarketView,symbol:string,generation:number|undefined,series:'PRICE'|'TOTAL_RETURN',scale:'LINEAR'|'LOG',limit:number):ChartView {
    const stock=this.company(market,symbol,generation);const listingId=stock.listing.listingId;
    const frames=this.#snapshots(market.marketId);const points:ChartView['points'][number][]=[];const annotations:ChartView['annotations'][number][]=[];
    // This is the value of one original share held throughout its own generation:
    // distributed cash is retained without interest or reinvestment, and claims
    // remain assets after the stock is removed from the active listing slot.
    let received=fraction(0n);let liquidation=fraction(0n);let started=false;let retired=false;let settled=false;
    const knownDividends=new Map<string,CorporateDividend>();const rights=new Set<string>();const paidDividends=new Map<string,bigint>();
    const distributeDividend=(dividend:CorporateDividend,paidAtoms:string):void=>{
      const paid=BigInt(paidAtoms);const prior=paidDividends.get(dividend.id)??0n;
      if(paid<prior)throw new LedgerIntegrityError('Chart dividend payment regressed.');
      received=addFractions(received,fraction(paid-prior,MONEY_SCALE*BigInt(dividend.issuedShares)));
      paidDividends.set(dividend.id,paid);rights.delete(dividend.id);
    };
    const actionsByTick=new Map<number,ReturnType<typeof publicCorporateActionSchema.parse>[]>();
    for(const row of this.db.prepare('SELECT tick_no,action_json FROM corporate_actions WHERE market_id=? AND tick_no<=? ORDER BY tick_no,rowid').all(market.marketId,market.tickNo) as {tick_no:number;action_json:string}[]) {
      const action=publicCorporateActionSchema.parse(JSON.parse(row.action_json));
      if(action.listingId!==listingId)continue;
      const actions=actionsByTick.get(row.tick_no)??[];actions.push(action);actionsByTick.set(row.tick_no,actions);
    }
    // STATIC_TRIAL is a recorded fixed-1000 regime. Include only its initial
    // listing observation and committed ticks, never a fabricated current point.
    if(stock.generation===1&&(frames[0]?.row.tick_no??1)>0) {
      const created=this.db.prepare('SELECT created_at FROM listings WHERE market_id=? AND listing_id=?').get(market.marketId,listingId) as {created_at:string}|undefined;
      if(!created)throw new LedgerIntegrityError('Chart listing history missing.');
      points.push({tickNo:0,at:created.created_at,value:'1000'});started=true;
      const firstEconomicTick=frames[0]?.row.tick_no??Number.MAX_SAFE_INTEGER;
      for(const row of this.db.prepare('SELECT tick_no,committed_at FROM trial_ticks WHERE market_id=? AND tick_no<=? AND tick_no<? ORDER BY tick_no').all(market.marketId,market.tickNo,firstEconomicTick) as {tick_no:number;committed_at:string}[]) points.push({tickNo:row.tick_no,at:row.committed_at,value:'1000'});
    }
    const economicOffset=frames[0]?frames[0].row.tick_no-frames[0].snapshot.public.tickNo:0;
    for(const {row,snapshot} of frames) {
      if(row.tick_no>market.tickNo||row.market_version>market.marketVersion||snapshot.public.marketId!==market.marketId
        ||snapshot.public.tickNo!==snapshot.pricing.tickNo||row.tick_no-snapshot.public.tickNo!==economicOffset)throw new LedgerIntegrityError('Chart public history identity differs.');
      const publicCompany=snapshot.public.companies.find(c=>c.listingId===listingId);
      const price=snapshot.pricing.companies.find(c=>c.listingId===listingId)?.price;
      const actions=actionsByTick.get(row.tick_no)??[];
      for(const action of actions)if(action.effectiveTick!==snapshot.public.tickNo||!snapshot.public.corporateActions.some(a=>a.id===action.id&&canonicalEconomyJson(a)===canonicalEconomyJson(action)))throw new LedgerIntegrityError('Chart action differs from committed public history.');
      if(settled)continue;
      if(price!==undefined)started=true;
      // A retired company's dividends no longer appear in active companies, but
      // their disclosed nominal basis survives in the durable action history.
      for(const action of actions)if('dividend' in action)knownDividends.set(action.dividend.id,action.dividend);
      for(const dividend of publicCompany?.dividends??[])knownDividends.set(dividend.id,dividend);
      for(const a of actions) {
        if(a.kind==='DIVIDEND_EX') {rights.add(a.dividend.id);annotations.push({tickNo:row.tick_no,label:'EX'});}
        if(a.kind==='DIVIDEND_PAYMENT')distributeDividend(a.dividend,a.dividend.paidAtoms);
        if(a.kind==='LIQUIDATION_STARTED') {
          retired=true;liquidation=decimalFraction(a.estimatedRecoveryPerShare);annotations.push({tickNo:row.tick_no,label:'청산'});
          for(const [id,dividend] of knownDividends)if(dividend.remainingPayableAtoms!=='0') {
            knownDividends.set(id,{...dividend,recoveryRatio:a.dividendRecoveryRatio});rights.add(id);
          }
        }
        if(a.kind==='LIQUIDATION_SETTLED') {
          received=addFractions(received,fraction(BigInt(a.commonPaidAtoms),MONEY_SCALE*BigInt(a.eligibleShares)));liquidation=fraction(0n);
          for(const recovery of a.dividendRecoveries) {
            const dividend=knownDividends.get(recovery.dividendId);
            if(!dividend)throw new LedgerIntegrityError('Chart liquidation dividend basis missing.');
            distributeDividend(dividend,recovery.paidAtoms);
          }
          if(rights.size)throw new LedgerIntegrityError('Chart liquidation left unsettled dividend claims.');
          settled=true;annotations.push({tickNo:row.tick_no,label:'종료'});
        }
      }
      for(const dividend of publicCompany?.dividends??[]) {
        if(dividend.exTick<=snapshot.public.tickNo&&dividend.remainingPayableAtoms!=='0'&&!settled)rights.add(dividend.id);
        else if(dividend.status==='PAID'||dividend.status==='SETTLED')rights.delete(dividend.id);
      }
      if(!started)continue;
      const raw=retired?'0':price;
      if(raw===undefined)throw new LedgerIntegrityError('Chart committed price is missing.');
      if(series==='PRICE') {
        // The recorded retirement action terminates the old raw-stock line at
        // zero. Subsequent claim valuation belongs only to the total-value line.
        if(!retired||actions.some(a=>a.kind==='LIQUIDATION_STARTED'))points.push({tickNo:row.tick_no,at:row.committed_at,value:raw});
      }else {
        const annualRate=parseRate(D.max(0,new D(snapshot.public.observedMacro.policyRate).minus('0.005')).toString());
        let marks=liquidation;
        for(const id of rights) {
          const dividend=knownDividends.get(id);
          if(!dividend)throw new LedgerIntegrityError('Chart dividend basis missing.');
          marks=addFractions(marks,decimalFraction(dividendRightMark(dividend.dps,dividend.recoveryRatio,annualRate,Math.max(0,dividend.payTick-snapshot.public.tickNo))));
        }
        points.push({tickNo:row.tick_no,at:row.committed_at,value:value(addFractions(addFractions(decimalFraction(raw),received),marks))});
      }
    }
    if(!points.length)throw new LedgerIntegrityError('Recorded chart history is missing.');
    const actual=points.slice(-limit);
    return {...meta(market),listingId,symbol,name:stock.listing.name,generation:stock.generation,lifecycle:stock.lifecycle,series,scale,points:actual,annotations:annotations.filter(a=>a.tickNo>=(actual[0]?.tickNo??0)&&a.tickNo<=(actual.at(-1)?.tickNo??0))};
  }
  #samples(owner:ReportingOwner):Sample[] {
    this.#owner(owner);return this.#validatedSamples(owner.marketId,owner.accountId);
  }
  #validatedSamples(marketId:string,accountId:string):Sample[] {
    const rows=this.db.prepare('SELECT * FROM performance_samples WHERE market_id=? AND account_id=? ORDER BY tick_no').all(marketId,accountId) as Sample[];
    let prior='';let priorTick=-1;
    for(const row of rows) {const {sample_hash,...unsigned}=row;if(row.previous_hash!==prior||row.tick_no<=priorTick||digest(unsigned)!==sample_hash||parseMoney(points(row.equity_atoms))<0n) throw new LedgerIntegrityError('Performance series hash differs.');prior=sample_hash;priorTick=row.tick_no;}
    return rows;
  }
  #append(owner:ReportingOwner,tick:number,version:number,equity:bigint,at:string,source:Sample['source']):void {
    const rows=this.#samples(owner);if(rows.some(s=>s.tick_no===tick))return;
    const unsigned={market_id:owner.marketId,account_id:owner.accountId,tick_no:tick,market_version:version,equity_atoms:equity.toString(),sampled_at:at,source,previous_hash:rows.at(-1)?.sample_hash??''};
    this.db.prepare('INSERT INTO performance_samples(market_id,account_id,tick_no,market_version,equity_atoms,sampled_at,source,previous_hash,sample_hash) VALUES(?,?,?,?,?,?,?,?,?)').run(...Object.values(unsigned),digest(unsigned));
  }
  recordTickEnd(owner:ReportingOwner,market:MarketView,portfolio:PortfolioView,now:string):void {this.#append(owner,market.tickNo,market.marketVersion,parseMoney(portfolio.equity),now,'LIVE_TICK_END');}
  #capital(owner:ReportingOwner):{initialCapital:string;contributions:string;flows:CapitalFlow[]} {
    this.#owner(owner);
    const cash=this.db.prepare("SELECT c.event_id,c.entry_type,c.account_delta_atoms,c.tick_no,c.sequence_no,c.market_version,c.created_at,c.related_order_id FROM cash_journal c JOIN accounts a ON a.market_id=c.market_id AND a.account_id=c.account_id WHERE c.market_id=? AND c.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE' AND c.entry_type IN ('INITIAL_GRANT','CONTRIBUTION') ORDER BY c.tick_no,c.sequence_no,c.journal_id")
      .all(owner.marketId,owner.accountId,owner.discordUserId) as CashRow[];
    const grants=cash.filter(row=>row.entry_type==='INITIAL_GRANT');
    if(grants.length!==1||BigInt(grants[0]!.account_delta_atoms)<=0n)throw new LedgerIntegrityError('Original account capital differs.');
    const funding=cash.filter(row=>row.entry_type==='CONTRIBUTION');
    const valuations=this.db.prepare("SELECT v.event_id,v.tick_no,v.sequence_no,v.before_equity_atoms,v.amount_atoms FROM contribution_valuations v JOIN accounts a ON a.market_id=v.market_id AND a.account_id=v.account_id WHERE v.market_id=? AND v.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE' ORDER BY v.tick_no,v.sequence_no,v.event_id")
      .all(owner.marketId,owner.accountId,owner.discordUserId) as {event_id:string;tick_no:number;sequence_no:number;before_equity_atoms:string;amount_atoms:string}[];
    const byEvent=new Map(funding.map(row=>[row.event_id,row]));
    if(valuations.length!==funding.length||byEvent.size!==funding.length)throw new LedgerIntegrityError('External capital checkpoints differ.');
    let total=0n;
    const flows=valuations.map((row):CapitalFlow=>{
      const journal=byEvent.get(row.event_id);
      if(!journal||journal.tick_no!==row.tick_no||journal.sequence_no!==row.sequence_no||journal.account_delta_atoms!==row.amount_atoms
          ||moneyFromAtoms(row.amount_atoms)<=0n||moneyFromAtoms(row.before_equity_atoms)<0n)
        throw new LedgerIntegrityError('External capital checkpoint does not match its journal.');
      total+=BigInt(row.amount_atoms);
      return {eventId:row.event_id,tickNo:row.tick_no,sequenceNo:row.sequence_no,beforeEquity:points(row.before_equity_atoms),amount:points(row.amount_atoms)};
    });
    return {initialCapital:points(grants[0]!.account_delta_atoms),contributions:points(total),flows};
  }
  /** Shared owner-scoped portfolio projection; does not call portfolio or benchmark reporting. */
  capitalPerformance(owner:ReportingOwner,equity:string,currentTick:number):CapitalPerformance {
    const capital=this.#capital(owner);
    if(capital.flows.some(flow=>flow.tickNo>currentTick))throw new LedgerIntegrityError('Future external capital is forbidden.');
    const factor=capitalReturnFactor(capital.initialCapital,equity,linkCapitalFlows(capital.initialCapital,capital.flows),currentTick);
    return {initialCapital:capital.initialCapital,contributions:capital.contributions,
      netInvestmentPnl:points(parseMoney(equity)-parseMoney(capital.initialCapital)-parseMoney(capital.contributions)),
      totalReturnPct:signedPct(new D(factor).minus(1).mul(100))};
  }
  /** Completed intervals can be reconstructed from immutable cash/position/rights and paid interval accruals. */
  backfill(owner:ReportingOwner,currentTick:number):void {
    this.#owner(owner);const grant=this.db.prepare("SELECT tick_no FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='INITIAL_GRANT'").get(owner.marketId,owner.accountId) as {tick_no:number}|undefined;
    if(!grant)throw new LedgerIntegrityError();
    const existing=new Set(this.#samples(owner).map(r=>r.tick_no));
    let complete=true;
    for(let tick=grant.tick_no;tick<currentTick;tick++)if(!existing.has(tick)){complete=false;break;}
    if(complete)return;
    const frames=this.#snapshots(owner.marketId);const byTick=new Map(frames.map(f=>[f.row.tick_no,f]));
    for(let tick=grant.tick_no;tick<currentTick;tick++) {
      if(existing.has(tick))continue;
      const frame=byTick.get(tick);const trial=this.db.prepare('SELECT market_version,committed_at FROM trial_ticks WHERE market_id=? AND tick_no=?').get(owner.marketId,tick) as {market_version:number;committed_at:string}|undefined;
      if(!frame&&!trial&&tick!==0)continue;
      const cash=this.#cash(owner).filter(r=>r.tick_no<=tick).reduce((sum,r)=>sum+BigInt(r.account_delta_atoms),0n);
      let equity=fraction(cash,MONEY_SCALE);const quantities=new Map<string,Fraction>();
      const positions=this.db.prepare('SELECT listing_id,quantity_delta FROM position_journal WHERE market_id=? AND account_id=? AND tick_no<=? ORDER BY sequence_no,journal_id').all(owner.marketId,owner.accountId,tick) as {listing_id:string;quantity_delta:string}[];
      for(const row of positions)quantities.set(row.listing_id,addFractions(quantities.get(row.listing_id)??fraction(0n),decimalFraction(row.quantity_delta)));
      for(const [listingId,q] of quantities) {if(q.numerator===0n)continue;const price=frame?.snapshot.pricing.companies.find(c=>c.listingId===listingId)?.price??(!frame?'1000':undefined);if(price===undefined)throw new LedgerIntegrityError('Historical held price missing.');equity=addFractions(equity,multiplyFractions(q,decimalFraction(price)));}
      const rights=this.db.prepare('SELECT right_id,state_json FROM rights_journal WHERE market_id=? AND account_id=? AND tick_no<=? ORDER BY sequence_no,rowid').all(owner.marketId,owner.accountId,tick) as {right_id:string;state_json:string}[];
      const marks=new Map<string,Fraction>();for(const r of rights)marks.set(r.right_id,parseFraction((JSON.parse(r.state_json) as {mark:{numerator:string;denominator:string}}).mark));
      for(const mark of marks.values())equity=addFractions(equity,mark);
      const ending=this.db.prepare('SELECT accrued_numerator,accrued_denominator FROM interest_payouts WHERE market_id=? AND account_id=? AND tick_no=?').get(owner.marketId,owner.accountId,tick) as {accrued_numerator:string;accrued_denominator:string}|undefined;
      const previous=this.db.prepare('SELECT carry_numerator,carry_denominator FROM interest_payouts WHERE market_id=? AND account_id=? AND tick_no<? ORDER BY tick_no DESC LIMIT 1').get(owner.marketId,owner.accountId,tick) as {carry_numerator:string;carry_denominator:string}|undefined;
      if(ending)equity=addFractions(equity,fraction(BigInt(ending.accrued_numerator),BigInt(ending.accrued_denominator)));
      if(previous)equity=addFractions(equity,fraction(BigInt(previous.carry_numerator),BigInt(previous.carry_denominator)));
      this.#append(owner,tick,frame?.row.market_version??trial?.market_version??0,quantizeMoney(equity,'floor').money,frame?.row.committed_at??trial?.committed_at??'1970-01-01T00:00:00.000Z','HISTORICAL_TICK_END');
    }
  }
  performance(owner:ReportingOwner,market:MarketView,portfolio:PortfolioView,elapsedMs?:number):PerformanceView {
    this.#owner(owner);const samples=this.#samples(owner);const cash=this.#cash(owner);const grant=cash.find(r=>r.entry_type==='INITIAL_GRANT')!;
    const capital=this.#capital(owner);const linked=linkCapitalFlows(capital.initialCapital,capital.flows);
    const fills=this.db.prepare('SELECT realized_pnl_atoms,fee_numerator,fee_denominator FROM fills WHERE market_id=? AND account_id=?').all(owner.marketId,owner.accountId) as {realized_pnl_atoms:string;fee_numerator:string;fee_denominator:string}[];
    const realized=fills.reduce((sum,f)=>sum+BigInt(f.realized_pnl_atoms),0n);
    const fees=value(fills.reduce((sum,f)=>addFractions(sum,fraction(BigInt(f.fee_numerator),BigInt(f.fee_denominator))),fraction(0n)));
    const unrealized=portfolio.positions.reduce((sum,p)=>sum+parseMoney(p.unrealizedPnl),0n);
    const states=[...new RightsRepository(this.db).replay(owner.marketId,owner.accountId).values()];
    const dividend=states.filter(r=>r.kind==='DIVIDEND').reduce((sum,r)=>addFractions(addFractions(sum,fraction(BigInt(r.paidAtoms),MONEY_SCALE)),parseFraction(r.mark)),fraction(0n));
    const liquidation=states.filter(r=>r.kind==='LIQUIDATION').reduce((sum,r)=>addFractions(addFractions(sum,fraction(BigInt(r.paidAtoms)-BigInt(r.costAtoms),MONEY_SCALE)),parseFraction(r.mark)),fraction(0n));
    const other=states.filter(r=>r.kind==='ROUNDING').reduce((sum,r)=>addFractions(addFractions(sum,fraction(BigInt(r.paidAtoms),MONEY_SCALE)),parseFraction(r.mark)),fraction(0n));
    const interest=new D(portfolio.cashInterestTotal??'0').plus(portfolio.accruedCashInterest??'0');const corrections=cash.filter(r=>r.entry_type==='REVERSAL'||r.entry_type==='ROUNDING').reduce((sum,r)=>sum+BigInt(r.account_delta_atoms),0n);
    const components=realized+unrealized+parseMoney(value(dividend))+parseMoney(value(liquidation))+parseMoney(value(other))+parseMoney(interest.toString())+corrections;
    const delta=parseMoney(portfolio.equity)-parseMoney(capital.initialCapital)-parseMoney(capital.contributions);
    // Independent line floors differ from total-equity floor by at most one atom per term.
    const rounding=delta-components;
    if(rounding< -32n||rounding>32n)throw new LedgerIntegrityError('Performance contributions do not reconcile.');
    const currentFactor=new D(capitalReturnFactor(capital.initialCapital,portfolio.equity,linked,market.tickNo));
    const observations=[
      ...samples.map(s=>({tick:s.tick_no,phase:1,factor:new D(capitalReturnFactor(capital.initialCapital,points(s.equity_atoms),linked,s.tick_no))})),
      ...linked.map(flow=>({tick:flow.tickNo,phase:0,factor:new D(flow.factor)})),
      {tick:market.tickNo,phase:2,factor:currentFactor},
    ].sort((a,b)=>a.tick-b.tick||a.phase-b.phase);
    const values=[new D(1),...observations.map(observation=>observation.factor)];let peak=new D(0);let mdd=new D(0);
    for(const v of values){peak=D.max(peak,v);if(peak.gt(0))mdd=D.max(mdd,peak.minus(v).div(peak).mul(100));}
    const previous=samples.at(-1);const expected=market.tickNo-grant.tick_no;
    const previousFactor=previous?new D(capitalReturnFactor(capital.initialCapital,points(previous.equity_atoms),linked,previous.tick_no)):null;
    return {...meta(market),equity:portfolio.equity,initialCapital:capital.initialCapital,contributions:capital.contributions,netInvestmentPnl:points(delta),nextContributionTick:portfolio.nextContributionTick??null,totalReturnPct:signedPct(currentFactor.minus(1).mul(100)),previousTickChangePct:previousFactor?.gt(0)?signedPct(currentFactor.div(previousFactor).minus(1).mul(100)):null,maxDrawdownPct:signedPct(mdd),
      realizedPnl:points(realized),unrealizedPnl:points(unrealized),fees,cashInterest:interest.toString(),dividends:value(dividend),liquidation:value(liquidation),otherRightsPnl:value(other),rounding:points(rounding+corrections),reconciled:true,cashWeightPct:new D(portfolio.equity).gt(0)?signedPct(new D(portfolio.account.cash).div(portfolio.equity).mul(100)):'0',
      startedTick:grant.tick_no,currentTick:market.tickNo,missingHistory:samples.length!==expected,sampleCount:values.length,drawdownDefinition:'외부 납입 직전 평가액으로 연결한 시간가중 수익률의 개설 시점·납입 경계·완료된 틱 말·현재 지수. 틱 내부 최저가는 포함하지 않습니다.',baselines:this.benchmarks.owned(owner.marketId,owner.accountId,elapsedMs),pm8:this.benchmarks.pm8(owner.marketId,elapsedMs)};
  }
  #cash(owner:ReportingOwner):CashRow[] {this.#owner(owner);return this.db.prepare("SELECT c.event_id,c.entry_type,c.account_delta_atoms,c.tick_no,c.sequence_no,c.market_version,c.created_at,c.related_order_id FROM cash_journal c JOIN accounts a ON a.market_id=c.market_id AND a.account_id=c.account_id WHERE c.market_id=? AND c.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE' ORDER BY c.sequence_no,c.journal_id").all(owner.marketId,owner.accountId,owner.discordUserId) as CashRow[];}
  history(owner:ReportingOwner,limit:number,beforeSequence=Number.MAX_SAFE_INTEGER,beforeEventId?:string):{entries:HistoryEntry[];nextBeforeSequence:number|null;nextBeforeEventId:string|null} {
    const ordered=this.#cash(owner).reverse();
    const cursor=beforeEventId===undefined?-1:ordered.findIndex(r=>r.event_id===beforeEventId&&r.sequence_no===beforeSequence);
    if(beforeEventId!==undefined&&cursor<0)throw new RangeError('INVALID_CURSOR');
    const all=beforeEventId===undefined?ordered.filter(r=>r.sequence_no<beforeSequence):ordered.slice(cursor+1);
    const shown=all.slice(0,limit);
    const entries=shown.map((r):HistoryEntry=>{const fill=r.related_order_id?this.db.prepare('SELECT symbol,side,quantity FROM fills WHERE market_id=? AND account_id=? AND order_id=?').get(owner.marketId,owner.accountId,r.related_order_id) as {symbol:string;side:string;quantity:string}|undefined:undefined;
      const kind:HistoryEntry['kind']=r.entry_type==='TRADE'?'FILL':r.entry_type==='REVERSAL'||r.entry_type==='ROUNDING'?'CORRECTION':r.entry_type as HistoryEntry['kind'];
      const title=fill?`${fill.symbol} ${fill.side==='BUY'?'매수':'매도'} ${fill.quantity}주`:({DIVIDEND:'배당 지급',INTEREST:'현금 이자',LIQUIDATION:'청산 회수',CORRECTION:'원장 조정',INITIAL_GRANT:'최초자금',CONTRIBUTION:'정기 투자금 납입'} as Record<string,string>)[kind]??'원장 기록';
      return {eventId:r.event_id,kind,tickNo:r.tick_no,sequenceNo:r.sequence_no,marketVersion:r.market_version,createdAt:r.created_at,symbol:fill?.symbol??null,title,amount:points(r.account_delta_atoms)};});
    const last=all.length>shown.length?shown.at(-1):undefined;
    return {entries,nextBeforeSequence:last?.sequence_no??null,nextBeforeEventId:last?.event_id??null};
  }
  export(owner:ReportingOwner,market:MarketView,portfolio:PortfolioView,format:'CSV'|'JSON',limit:number,beforeSequence?:number,elapsedMs?:number,beforeEventId?:string):ExportView {
    this.#owner(owner);const page=this.history(owner,limit,beforeSequence,beforeEventId);const performance=this.performance(owner,market,portfolio,elapsedMs);
    const eventIds=JSON.stringify(page.entries.map(entry=>entry.eventId));
    const fills=(this.db.prepare('SELECT fill_id,order_id,symbol,side,quantity,price,gross_numerator,gross_denominator,fee_numerator,fee_denominator,total_atoms,realized_pnl_atoms,cash_after_atoms,tick_no,sequence_no,market_version,created_at FROM fills WHERE market_id=? AND account_id=? AND order_id IN (SELECT related_order_id FROM cash_journal WHERE market_id=? AND account_id=? AND event_id IN (SELECT value FROM json_each(?))) ORDER BY sequence_no DESC').all(owner.marketId,owner.accountId,owner.marketId,owner.accountId,eventIds) as Array<{fill_id:string;order_id:string;symbol:string;side:string;quantity:string;price:string;gross_numerator:string;gross_denominator:string;fee_numerator:string;fee_denominator:string;total_atoms:string;realized_pnl_atoms:string;cash_after_atoms:string;tick_no:number;sequence_no:number;market_version:number;created_at:string}>).map(f=>({fillId:f.fill_id,orderId:f.order_id,symbol:f.symbol,side:f.side,quantity:f.quantity,price:f.price,gross:parseRate(new D(f.gross_numerator).div(f.gross_denominator).toString()),fee:parseRate(new D(f.fee_numerator).div(f.fee_denominator).toString()),total:points(f.total_atoms),realizedPnl:points(f.realized_pnl_atoms),cashAfter:points(f.cash_after_atoms),tickNo:f.tick_no,sequenceNo:f.sequence_no,marketVersion:f.market_version,createdAt:f.created_at}));
    const preferences=this.db.prepare('SELECT dm_enabled,consented_at,consent_version,updated_at FROM notification_preferences WHERE market_id=? AND account_id=?').get(owner.marketId,owner.accountId)??null;
    const priceAlerts=this.db.prepare('SELECT alert_id,listing_id,symbol,direction,threshold,enabled,armed,disabled_reason,created_at FROM price_alerts WHERE market_id=? AND account_id=?').all(owner.marketId,owner.accountId);
    const watchlist=this.db.prepare('SELECT listing_id,symbol,enabled,created_at FROM watched_listings WHERE market_id=? AND account_id=?').all(owner.marketId,owner.accountId);
    const acceptance=this.db.prepare('SELECT terms_version,privacy_version,age14_plus,agree_terms,accepted_at FROM policy_acceptances WHERE market_id=? AND account_id=?').get(owner.marketId,owner.accountId)??null;
    const notifications=this.db.prepare('SELECT notification_id,kind,symbol,title,summary,tick_no,market_version,created_at,read_at FROM notification_inbox WHERE market_id=? AND account_id=? ORDER BY inbox_no DESC LIMIT 1000').all(owner.marketId,owner.accountId) as Array<Record<string,unknown>>;
    const exportAccess=this.db.prepare('SELECT format,market_version,record_count,accessed_at FROM export_access WHERE market_id=? AND account_id=? ORDER BY accessed_at DESC,access_id DESC LIMIT 1000').all(owner.marketId,owner.accountId);
    const plan=this.db.prepare("SELECT p.enabled,p.start_tick,p.interval_ticks,p.amount_atoms FROM account_contribution_plans p JOIN accounts a ON a.market_id=p.market_id AND a.account_id=p.account_id WHERE p.market_id=? AND p.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE'")
      .get(owner.marketId,owner.accountId,owner.discordUserId) as {enabled:number;start_tick:number;interval_ticks:number;amount_atoms:string}|undefined;
    const funding=plan?{enabled:plan.enabled===1,startTick:plan.start_tick,intervalTicks:plan.interval_ticks,amount:points(plan.amount_atoms),nextContributionTick:performance.nextContributionTick}:null;
    const payload={schema:'PaperMarket owner export v1',generatedAt:market.updatedAt,marketVersion:market.marketVersion,account:portfolio.account,portfolio,performance,funding,history:page.entries,fills,alerts:{preferences,priceAlerts,watchlist},notifications,policyAcceptance:acceptance,exportAccess,nextBeforeSequence:page.nextBeforeSequence,nextBeforeEventId:page.nextBeforeEventId};
    const files=format==='JSON'?[{name:'papermarket.json',mimeType:'application/json',content:JSON.stringify(payload,null,2)}]:[
      {name:'account.csv',mimeType:'text/csv',content:csvDocument(['account_id','created_at','tick','market_version','cash','equity','initial_capital','contributions','net_investment_pnl','total_return_pct','next_contribution_tick','funding_enabled','funding_start_tick','funding_interval_ticks','funding_amount'],[[owner.accountId,portfolio.account.createdAt,market.tickNo,market.marketVersion,portfolio.account.cash,portfolio.equity,performance.initialCapital,performance.contributions,performance.netInvestmentPnl,performance.totalReturnPct,performance.nextContributionTick,funding?.enabled,funding?.startTick,funding?.intervalTicks,funding?.amount]])},
      {name:'history.csv',mimeType:'text/csv',content:csvDocument(['event_id','kind','tick','sequence','market_version','created_at','symbol','description','cash_delta'],page.entries.map(e=>[e.eventId,e.kind,e.tickNo,e.sequenceNo,e.marketVersion,e.createdAt,e.symbol,e.title,e.amount]))},
      {name:'positions.csv',mimeType:'text/csv',content:csvDocument(['listing_id','symbol','quantity','price','value','cost','unrealized_pnl'],portfolio.positions.map(p=>[p.listingId,p.symbol,p.quantity,p.price,p.value,p.cost,p.unrealizedPnl]))},
      {name:'rights.csv',mimeType:'text/csv',content:csvDocument(['right_id','kind','symbol','status','nominal','mark','paid','cost'],(portfolio.rights??[]).map(r=>[r.rightId,r.kind,r.symbol,r.status,r.nominal,r.currentValue,r.paid,r.cost]))},
      {name:'performance.csv',mimeType:'text/csv',content:csvDocument(['metric','value'],Object.entries(performance).filter(([,v])=>['string','number','boolean'].includes(typeof v)).map(([k,v])=>[k,v]))},
      {name:'fills.csv',mimeType:'text/csv',content:csvDocument(['fill_id','order_id','symbol','side','quantity','price','gross','fee','total','realized_pnl','cash_after','tick','sequence','version','created_at'],fills.map(f=>Object.values(f)))},
      {name:'settings.csv',mimeType:'text/csv',content:csvDocument(['section','record'],[['preferences',JSON.stringify(preferences)],['price_alerts',JSON.stringify(priceAlerts)],['watchlist',JSON.stringify(watchlist)],['policy_acceptance',JSON.stringify(acceptance)]])},
      {name:'notifications.csv',mimeType:'text/csv',content:csvDocument(['notification_id','kind','symbol','title','summary','tick','version','created_at','read_at'],notifications.map(n=>Object.values(n)))}];
    if(files.reduce((n,f)=>n+Buffer.byteLength(f.content),0)>2_000_000)throw new RangeError('EXPORT_TOO_LARGE');
    this.db.prepare('INSERT INTO export_access(access_id,market_id,account_id,format,market_version,record_count,accessed_at) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),owner.marketId,owner.accountId,format,market.marketVersion,page.entries.length,new Date().toISOString());
    this.db.prepare('DELETE FROM export_access WHERE market_id=? AND account_id=? AND access_id NOT IN (SELECT access_id FROM export_access WHERE market_id=? AND account_id=? ORDER BY accessed_at DESC,access_id DESC LIMIT 1000)').run(owner.marketId,owner.accountId,owner.marketId,owner.accountId);
    return {files,recordCount:page.entries.length,nextBeforeSequence:page.nextBeforeSequence,nextBeforeEventId:page.nextBeforeEventId,truncated:page.nextBeforeSequence!==null};
  }
}
