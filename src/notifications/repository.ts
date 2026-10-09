import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { accountIdSchema, discordSnowflakeSchema, listingIdSchema, marketIdSchema, marketVersionSchema, tickNoSchema, utcTimestampSchema } from '../domain/identifiers.js';
import { addFractions, decimalFraction, FinancialDecimal, fraction, parsePrice } from '../domain/numeric.js';
import type { AlertSettingsView, InboxItemView, InboxView, NotificationBoundary, NotificationDelivery, NotificationKind, NotificationMeta, NotificationOwner, SaveAlertsInput } from './types.js';

const ownerSchema = z.object({ marketId: marketIdSchema, accountId: accountIdSchema, discordUserId: discordSnowflakeSchema }).strict();
const metaSchema = z.object({ tickNo: tickNoSchema, marketVersion: marketVersionSchema, createdAt: utcTimestampSchema }).strict();
const uuid = z.string().uuid();
const symbol = z.string().min(1).max(12).regex(/^[A-Z0-9]+$/);
const kind = z.enum(['IMPORTANT_DISCLOSURE','DIVIDEND_RIGHT','DIVIDEND_PAID','SCHEDULED_FILLED','ORDER_CANCELLED','PRICE_THRESHOLD']);
const inboxRowSchema = z.object({
  inbox_no: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), notification_id: uuid,
  event_key: z.string().regex(/^[0-9a-f]{64}$/), market_id: marketIdSchema, account_id: accountIdSchema, kind,
  symbol: symbol.nullable(), title: z.string().min(1).max(100), summary: z.string().min(1).max(1200),
  tick_no: tickNoSchema, market_version: marketVersionSchema, created_at: utcTimestampSchema, read_at: utcTimestampSchema.nullable(),
}).strict();
const alertRowSchema = z.object({
  alert_id: uuid, market_id: marketIdSchema, account_id: accountIdSchema, listing_id: listingIdSchema, symbol,
  direction: z.enum(['ABOVE','BELOW']), threshold: z.string().transform(parsePrice),
  enabled: z.union([z.literal(0),z.literal(1)]), armed: z.union([z.literal(0),z.literal(1)]), last_price: z.string().transform(parsePrice),
  last_tick: tickNoSchema, disabled_reason: z.literal('LISTING_RETIRED').nullable(), created_at: utcTimestampSchema,
}).strict();
const settingsSchema = z.object({ dmEnabled: z.boolean().optional(),
  addPriceAlert: z.object({listingId: listingIdSchema, direction: z.enum(['ABOVE','BELOW']), threshold: z.string().transform(parsePrice)}).strict().optional(),
  removePriceAlertId: uuid.optional(),
  watchListingId: listingIdSchema.optional(), unwatchListingId: listingIdSchema.optional(),
}).strict().refine(value => Object.values(value).filter(v => v !== undefined).length === 1, 'One alert action is required');
const factSchema = z.object({ accountId: accountIdSchema, eventId: z.string().min(1).max(512), symbol: symbol.nullable(), title: z.string().min(1).max(100), summary: z.string().min(1).max(1200) }).strict();
const boundarySchema = z.object({
  marketId: marketIdSchema, tickNo: tickNoSchema, marketVersion: marketVersionSchema, createdAt: utcTimestampSchema,
  listings: z.array(z.object({listingId:listingIdSchema,symbol,name:z.string().min(1).max(100),price:z.string().min(1).max(96),active:z.boolean()}).strict()).max(10_000),
  disclosures: z.array(z.object({id:z.string().min(1).max(512),kind:z.enum(['MACRO','EARNINGS','CORPORATE_ACTION','EVENT']),publishedTick:tickNoSchema,listingId:listingIdSchema.nullable().optional(),symbol:symbol.nullable(),title:z.string().min(1).max(100),summary:z.string().min(1).max(1200),important:z.boolean().optional()}).strict()).max(10_000),
  rights: z.array(factSchema.extend({kind:z.enum(['DIVIDEND_RIGHT','DIVIDEND_PAID'])})).max(10_000).optional(),
  fills: z.array(factSchema).max(10_000).optional(), cancellations: z.array(factSchema).max(10_000).optional(),
}).strict();
const outboxRowSchema = z.object({job_id:uuid,notification_id:uuid,status:z.enum(['PENDING','LEASED','DELIVERED','FAILED','CANCELLED']),attempts:z.number().int().min(0).max(8),next_attempt_at:utcTimestampSchema,lease_token:uuid.nullable(),lease_expires_at:utcTimestampSchema.nullable(),delivered_at:utcTimestampSchema.nullable()}).strict();
const ATTEMPTS = 8;
export const NOTIFICATION_LEASE_MS = 30_000;
export const DM_NOTIFICATION_CONSENT_VERSION = 'dm-trial-v1';
export class NotificationAccessError extends Error { constructor() {super('Notification owner is unavailable');this.name='NotificationAccessError';} }
export class NotificationInputError extends Error { constructor() {super('Invalid notification setting');this.name='NotificationInputError';} }

function view(row: z.infer<typeof inboxRowSchema>): InboxItemView {
  return {notificationId:row.notification_id,kind:row.kind,symbol:row.symbol,title:row.title,summary:row.summary,
    tickNo:row.tick_no,marketVersion:row.market_version,createdAt:row.created_at,read:row.read_at !== null};
}

/** Personal projections contain committed public facts only and never produce financial entries. */
export class NotificationRepository {
  readonly #db: Database.Database;
  readonly #clock: {now():string};
  constructor(db: Database.Database, clock: {now():string} = {now:()=>new Date().toISOString()}) {this.#db=db;this.#clock=clock;}

  #owner(input: NotificationOwner): z.infer<typeof ownerSchema> {
    const owner=ownerSchema.parse(input);
    if(!this.#db.prepare("SELECT 1 FROM accounts WHERE market_id = ? AND account_id = ? AND discord_user_id = ? AND status = 'ACTIVE'").get(owner.marketId,owner.accountId,owner.discordUserId)) throw new NotificationAccessError();
    return owner;
  }

  getAlerts(input: NotificationOwner): AlertSettingsView {
    const owner=this.#owner(input);
    const preference=this.#db.prepare('SELECT dm_enabled FROM notification_preferences WHERE market_id = ? AND account_id = ?').get(owner.marketId,owner.accountId) as {dm_enabled:number}|undefined;
    if(preference && preference.dm_enabled!==0 && preference.dm_enabled!==1) throw new NotificationInputError();
    const alerts=this.#db.prepare('SELECT * FROM price_alerts WHERE market_id = ? AND account_id = ? ORDER BY created_at,alert_id').all(owner.marketId,owner.accountId).map(row=>alertRowSchema.parse(row));
    const watched=this.#db.prepare(`SELECT w.listing_id,w.symbol,w.enabled,l.status FROM watched_listings w JOIN listings l ON l.market_id = w.market_id AND l.listing_id = w.listing_id WHERE w.market_id = ? AND w.account_id = ? ORDER BY w.created_at,w.listing_id`).all(owner.marketId,owner.accountId) as {listing_id:string;symbol:string;enabled:number;status:string}[];
    return {dmEnabled:preference?.dm_enabled===1,watchlist:watched.map(row=>({listingId:listingIdSchema.parse(row.listing_id),symbol:symbol.parse(row.symbol),enabled:row.enabled===1&&row.status==='ACTIVE'})),priceAlerts:alerts.map(row=>({alertId:row.alert_id,listingId:row.listing_id,symbol:row.symbol,direction:row.direction,threshold:row.threshold,enabled:row.enabled===1,armed:row.armed===1,disabledReason:row.disabled_reason}))};
  }

  saveAlerts(input: NotificationOwner, change: SaveAlertsInput, inputMeta: NotificationMeta): AlertSettingsView {
    const owner=this.#owner(input), setting=settingsSchema.parse(change), meta=metaSchema.parse(inputMeta);
    return this.#db.transaction(()=>{
      this.#owner(owner);
      if(setting.dmEnabled!==undefined) {
        this.#db.prepare(`INSERT INTO notification_preferences(market_id,account_id,dm_enabled,consented_at,consent_version,updated_at) VALUES(?,?,?,?,?,?)
          ON CONFLICT(market_id,account_id) DO UPDATE SET dm_enabled = excluded.dm_enabled,consented_at = excluded.consented_at,consent_version = excluded.consent_version,updated_at = excluded.updated_at`)
          .run(owner.marketId,owner.accountId,setting.dmEnabled?1:0,setting.dmEnabled?meta.createdAt:null,DM_NOTIFICATION_CONSENT_VERSION,meta.createdAt);
        if(!setting.dmEnabled) this.#db.prepare(`UPDATE notification_outbox SET status = 'CANCELLED',lease_token = NULL,lease_expires_at = NULL
          WHERE status IN ('PENDING','LEASED') AND notification_id IN (SELECT notification_id FROM notification_inbox WHERE market_id = ? AND account_id = ?)`)
          .run(owner.marketId,owner.accountId);
      }
      if(setting.watchListingId) {
        const listing=this.#db.prepare("SELECT symbol FROM listings WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'").get(owner.marketId,setting.watchListingId) as {symbol:string}|undefined;
        if(!listing) throw new NotificationInputError();
        const exists=this.#db.prepare('SELECT 1 FROM watched_listings WHERE market_id = ? AND account_id = ? AND listing_id = ?').get(owner.marketId,owner.accountId,setting.watchListingId);
        const count=this.#db.prepare('SELECT count(*) AS n FROM watched_listings WHERE market_id = ? AND account_id = ?').get(owner.marketId,owner.accountId) as {n:number};
        if(!exists&&count.n>=20) throw new NotificationInputError();
        this.#db.prepare('INSERT INTO watched_listings(market_id,account_id,listing_id,symbol,enabled,created_at) VALUES(?,?,?,?,1,?) ON CONFLICT(market_id,account_id,listing_id) DO NOTHING').run(owner.marketId,owner.accountId,setting.watchListingId,listing.symbol,meta.createdAt);
      }
      if(setting.unwatchListingId) this.#db.prepare('DELETE FROM watched_listings WHERE market_id = ? AND account_id = ? AND listing_id = ?').run(owner.marketId,owner.accountId,setting.unwatchListingId);
      if(setting.addPriceAlert) {
        const term=setting.addPriceAlert;
        const listing=this.#db.prepare("SELECT symbol,price FROM listings WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'").get(owner.marketId,term.listingId) as {symbol:string;price:string}|undefined;
        if(!listing) throw new NotificationInputError();
        const current=parsePrice(listing.price);
        const exists=this.#db.prepare('SELECT 1 FROM price_alerts WHERE market_id = ? AND account_id = ? AND listing_id = ? AND direction = ? AND threshold = ?')
          .get(owner.marketId,owner.accountId,term.listingId,term.direction,term.threshold);
        const count=this.#db.prepare('SELECT count(*) AS n FROM price_alerts WHERE market_id = ? AND account_id = ?').get(owner.marketId,owner.accountId) as {n:number};
        if(!exists && count.n>=20) throw new NotificationInputError();
        const armed=term.direction==='ABOVE'?new FinancialDecimal(current).lt(term.threshold):new FinancialDecimal(current).gt(term.threshold);
        this.#db.prepare(`INSERT INTO price_alerts(alert_id,market_id,account_id,listing_id,symbol,direction,threshold,enabled,armed,last_price,last_tick,disabled_reason,created_at)
          VALUES(?,?,?,?,?,?,?,1,?,?,?,NULL,?) ON CONFLICT(market_id,account_id,listing_id,direction,threshold) DO NOTHING`).run(randomUUID(),owner.marketId,owner.accountId,term.listingId,listing.symbol,term.direction,term.threshold,armed?1:0,current,meta.tickNo,meta.createdAt);
      }
      if(setting.removePriceAlertId) {
        const removed=this.#db.prepare('DELETE FROM price_alerts WHERE alert_id = ? AND market_id = ? AND account_id = ?').run(setting.removePriceAlertId,owner.marketId,owner.accountId);
        if(removed.changes!==1) throw new NotificationInputError();
      }
      return this.getAlerts(owner);
    }).immediate();
  }

  readInbox(input: NotificationOwner, options: {readonly limit?:number;readonly beforeId?:string;readonly markRead?:boolean} = {}): InboxView {
    const owner=this.#owner(input);
    const parsed=z.object({limit:z.number().int().min(1).max(25).default(10),beforeId:uuid.optional(),markRead:z.boolean().default(false)}).strict().parse(options);
    return this.#db.transaction(()=>{
      const before=parsed.beforeId?this.#db.prepare('SELECT inbox_no FROM notification_inbox WHERE notification_id = ? AND market_id = ? AND account_id = ?').get(parsed.beforeId,owner.marketId,owner.accountId) as {inbox_no:number}|undefined:undefined;
      if(parsed.beforeId && !before) throw new NotificationInputError();
      const rows=this.#db.prepare(`SELECT * FROM notification_inbox WHERE market_id = ? AND account_id = ? AND inbox_no < ? ORDER BY inbox_no DESC LIMIT ?`)
        .all(owner.marketId,owner.accountId,before?.inbox_no??Number.MAX_SAFE_INTEGER,parsed.limit+1).map(row=>inboxRowSchema.parse(row));
      const page=rows.slice(0,parsed.limit);
      if(parsed.markRead) {
        const now=utcTimestampSchema.parse(this.#clock.now());
        for(const row of page) this.#db.prepare('UPDATE notification_inbox SET read_at = COALESCE(read_at,?) WHERE notification_id = ? AND market_id = ? AND account_id = ?').run(now,row.notification_id,owner.marketId,owner.accountId);
      }
      const unread=this.#db.prepare('SELECT count(*) AS n FROM notification_inbox WHERE market_id = ? AND account_id = ? AND read_at IS NULL').get(owner.marketId,owner.accountId) as {n:number};
      return {items:page.map(row=>({...view(row),read:parsed.markRead||row.read_at!==null})),unreadCount:unread.n,nextBeforeId:rows.length>parsed.limit?page.at(-1)!.notification_id:null};
    }).immediate();
  }

  /** Call inside the same financial transaction, before commit. Repeat event IDs are harmless. */
  record(marketId: string, accountId: string, eventId: string, notificationKind: NotificationKind, symbolValue: string|null, title: string, summary: string, inputMeta: NotificationMeta): void {
    if(!this.#db.inTransaction) throw new Error('Notification records require a committing transaction');
    const fact=factSchema.parse({accountId,eventId,symbol:symbolValue,title,summary}); const meta=metaSchema.parse(inputMeta);
    marketId=marketIdSchema.parse(marketId);notificationKind=kind.parse(notificationKind);
    if(!this.#db.prepare("SELECT 1 FROM accounts WHERE market_id = ? AND account_id = ? AND status = 'ACTIVE'").get(marketId,fact.accountId)) return;
    const key=createHash('sha256').update(JSON.stringify([marketId,fact.accountId,notificationKind,fact.eventId])).digest('hex');
    const seen=this.#db.prepare('INSERT OR IGNORE INTO notification_seen(market_id,account_id,event_key) VALUES(?,?,?)').run(marketId,fact.accountId,key);
    if(seen.changes!==1) return;
    const notificationId=randomUUID();
    const inserted=this.#db.prepare(`INSERT INTO notification_inbox(notification_id,event_key,market_id,account_id,kind,symbol,title,summary,tick_no,market_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(notificationId,key,marketId,fact.accountId,notificationKind,fact.symbol,fact.title,fact.summary,meta.tickNo,meta.marketVersion,meta.createdAt);
    if(inserted.changes!==1) return;
    const opted=this.#db.prepare('SELECT 1 FROM notification_preferences WHERE market_id = ? AND account_id = ? AND dm_enabled = 1 AND consented_at IS NOT NULL').get(marketId,fact.accountId);
    if(opted) this.#db.prepare("INSERT INTO notification_outbox(job_id,notification_id,status,attempts,next_attempt_at) VALUES(?,?,'PENDING',0,?)").run(randomUUID(),notificationId,meta.createdAt);
    this.#db.prepare(`DELETE FROM notification_inbox WHERE market_id = ? AND account_id = ? AND inbox_no NOT IN
      (SELECT inbox_no FROM notification_inbox WHERE market_id = ? AND account_id = ? ORDER BY inbox_no DESC LIMIT 1000)`)
      .run(marketId,fact.accountId,marketId,fact.accountId);
  }

  recordBoundary(input: NotificationBoundary): void {
    if(!this.#db.inTransaction) throw new Error('Notification boundaries require a committing transaction');
    const boundary=boundarySchema.parse(input),meta={tickNo:boundary.tickNo,marketVersion:boundary.marketVersion,createdAt:boundary.createdAt};
    const accounts=this.#db.prepare("SELECT account_id FROM accounts WHERE market_id = ? AND status = 'ACTIVE'").all(boundary.marketId) as {account_id:string}[];
    const relevant=new Map<string,Set<string>>();
    for(const account of accounts) {
      const interested=new Set((this.#db.prepare('SELECT listing_id FROM watched_listings WHERE market_id = ? AND account_id = ? AND enabled = 1').all(boundary.marketId,account.account_id) as {listing_id:string}[]).map(row=>row.listing_id));
      const holdings=new Map<string,ReturnType<typeof fraction>>();
      for(const row of this.#db.prepare('SELECT listing_id,quantity_delta FROM position_journal WHERE market_id = ? AND account_id = ? ORDER BY sequence_no,journal_id').all(boundary.marketId,account.account_id) as {listing_id:string;quantity_delta:string}[]) holdings.set(row.listing_id,addFractions(holdings.get(row.listing_id)??fraction(0n),decimalFraction(row.quantity_delta)));
      for(const [listingId,quantity] of holdings) if(quantity.numerator>0n) interested.add(listingId);
      const rights=new Map<string,{listingId:string;status:string;kind:string;quantity:string}>();
      for(const row of this.#db.prepare('SELECT right_id,state_json FROM rights_journal WHERE market_id = ? AND account_id = ? ORDER BY sequence_no,rowid').all(boundary.marketId,account.account_id) as {right_id:string;state_json:string}[]) {
        const claim=z.object({listingId:listingIdSchema,status:z.enum(['ATTACHED','OPEN','IMPAIRED','SETTLED']),kind:z.enum(['DIVIDEND','LIQUIDATION','ROUNDING']),quantity:z.string().max(128)}).parse(JSON.parse(row.state_json));
        rights.set(row.right_id,claim);
      }
      for(const claim of rights.values()) if(claim.kind!=='ROUNDING'&&claim.status!=='SETTLED'&&decimalFraction(claim.quantity).numerator>0n) interested.add(claim.listingId);
      relevant.set(account.account_id,interested);
    }
    for(const disclosure of boundary.disclosures) {
      if(disclosure.publishedTick>boundary.tickNo) throw new NotificationInputError();
      if(disclosure.important===false) continue;
      const matching=boundary.listings.filter(listing=>listing.symbol===disclosure.symbol);
      const listingId=disclosure.listingId??(matching.length===1?matching[0]!.listingId:null);
      for(const account of accounts) {
        if(disclosure.kind!=='MACRO' && disclosure.symbol!==null && (listingId===null || !relevant.get(account.account_id)?.has(listingId))) continue;
        this.record(boundary.marketId,account.account_id,disclosure.id,'IMPORTANT_DISCLOSURE',disclosure.symbol,disclosure.title,disclosure.summary,meta);
      }
    }
    for(const right of boundary.rights??[]) this.record(boundary.marketId,right.accountId,right.eventId,right.kind,right.symbol,right.title,right.summary,meta);
    for(const fill of boundary.fills??[]) this.record(boundary.marketId,fill.accountId,fill.eventId,'SCHEDULED_FILLED',fill.symbol,fill.title,fill.summary,meta);
    for(const cancellation of boundary.cancellations??[]) this.record(boundary.marketId,cancellation.accountId,cancellation.eventId,'ORDER_CANCELLED',cancellation.symbol,cancellation.title,cancellation.summary,meta);
    this.#db.prepare(`UPDATE watched_listings SET enabled = 0 WHERE market_id = ? AND enabled = 1 AND NOT EXISTS
      (SELECT 1 FROM listings l WHERE l.market_id = watched_listings.market_id AND l.listing_id = watched_listings.listing_id AND l.status = 'ACTIVE')`).run(boundary.marketId);
    const prices=new Map(boundary.listings.map(listing=>[listing.listingId,listing]));
    const alerts=this.#db.prepare(`SELECT p.* FROM price_alerts p JOIN accounts a ON a.market_id = p.market_id AND a.account_id = p.account_id
      WHERE p.market_id = ? AND p.enabled = 1 AND a.status = 'ACTIVE'`).all(boundary.marketId).map(row=>alertRowSchema.parse(row));
    for(const alert of alerts) {
      const listing=prices.get(alert.listing_id);
      const active=this.#db.prepare("SELECT 1 FROM listings WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'").get(boundary.marketId,alert.listing_id);
      if(!active || (listing && !listing.active)) {
        this.#db.prepare("UPDATE price_alerts SET enabled = 0,armed = 0,disabled_reason = 'LISTING_RETIRED',last_tick = ? WHERE alert_id = ? AND market_id = ? AND account_id = ?")
          .run(boundary.tickNo,alert.alert_id,boundary.marketId,alert.account_id);continue;
      }
      if(!listing || boundary.tickNo<=alert.last_tick) continue;
      const price=parsePrice(listing.price),onSide=alert.direction==='ABOVE'?new FinancialDecimal(price).gte(alert.threshold):new FinancialDecimal(price).lte(alert.threshold);
      if(onSide && alert.armed===1) this.record(boundary.marketId,alert.account_id,`${alert.alert_id}:${boundary.tickNo}`,'PRICE_THRESHOLD',alert.symbol,'가격 임계값 통과',`${alert.symbol} 시세 ${price}포인트 · ${alert.direction==='ABOVE'?'이상':'이하'} ${alert.threshold}포인트 조건을 통과했습니다. 다음 알림은 반대편으로 이동한 뒤 다시 통과할 때 발송됩니다.`,meta);
      this.#db.prepare('UPDATE price_alerts SET armed = ?,last_price = ?,last_tick = ? WHERE alert_id = ? AND market_id = ? AND account_id = ?')
        .run(onSide?0:1,price,boundary.tickNo,alert.alert_id,boundary.marketId,alert.account_id);
    }
  }

  poll(inputNow: string, inputLimit = 5): readonly NotificationDelivery[] {
    const now=utcTimestampSchema.parse(inputNow),limit=z.number().int().min(1).max(5).parse(inputLimit);
    return this.#db.transaction(()=>{
      this.#db.prepare(`UPDATE notification_outbox SET status = 'FAILED',lease_token = NULL,lease_expires_at = NULL WHERE attempts >= ? AND
        (status = 'PENDING' OR (status = 'LEASED' AND lease_expires_at <= ?))`).run(ATTEMPTS,now);
      this.#db.prepare(`UPDATE notification_outbox SET status = 'CANCELLED',lease_token = NULL,lease_expires_at = NULL WHERE status IN ('PENDING','LEASED') AND NOT EXISTS
        (SELECT 1 FROM notification_inbox i JOIN accounts a ON a.market_id = i.market_id AND a.account_id = i.account_id
         JOIN notification_preferences p ON p.market_id = i.market_id AND p.account_id = i.account_id
         WHERE i.notification_id = notification_outbox.notification_id AND a.status = 'ACTIVE' AND p.dm_enabled = 1 AND p.consented_at IS NOT NULL)`).run();
      const due=this.#db.prepare(`SELECT o.* FROM notification_outbox o WHERE attempts < ? AND
        ((status = 'PENDING' AND next_attempt_at <= ?) OR (status = 'LEASED' AND lease_expires_at <= ?))
        ORDER BY next_attempt_at,job_id LIMIT ?`).all(ATTEMPTS,now,now,limit).map(row=>outboxRowSchema.parse(row));
      const deliveries:NotificationDelivery[]=[];
      for(const row of due) {
        const leaseToken=randomUUID(),expires=utcTimestampSchema.parse(new Date(Date.parse(now)+NOTIFICATION_LEASE_MS).toISOString());
        this.#db.prepare("UPDATE notification_outbox SET status = 'LEASED',attempts = attempts + 1,lease_token = ?,lease_expires_at = ? WHERE job_id = ?")
          .run(leaseToken,expires,row.job_id);
        const joined=this.#db.prepare(`SELECT i.*,a.discord_user_id,m.guild_id FROM notification_inbox i
          JOIN accounts a ON a.market_id = i.market_id AND a.account_id = i.account_id JOIN markets m ON m.market_id = i.market_id WHERE i.notification_id = ? AND a.status = 'ACTIVE'`).get(row.notification_id) as Record<string,unknown>;
        const {discord_user_id,guild_id,...inbox}=joined;
        deliveries.push({jobId:row.job_id,leaseToken,discordUserId:discordSnowflakeSchema.parse(discord_user_id),guildId:discordSnowflakeSchema.parse(guild_id),notification:view(inboxRowSchema.parse(inbox)),attempts:row.attempts+1});
      }
      return deliveries;
    }).immediate();
  }

  authorizeDelivery(jobId: string, leaseToken: string, inputNow: string): boolean {
    uuid.parse(jobId);uuid.parse(leaseToken);const now=utcTimestampSchema.parse(inputNow);
    return Boolean(this.#db.prepare(`SELECT 1 FROM notification_outbox o JOIN notification_inbox i ON i.notification_id = o.notification_id
      JOIN accounts a ON a.market_id = i.market_id AND a.account_id = i.account_id JOIN notification_preferences p ON p.market_id = i.market_id AND p.account_id = i.account_id
      WHERE o.job_id = ? AND o.lease_token = ? AND o.status = 'LEASED' AND o.lease_expires_at > ? AND a.status = 'ACTIVE' AND p.dm_enabled = 1 AND p.consented_at IS NOT NULL`).get(jobId,leaseToken,now));
  }

  ack(jobId: string, leaseToken: string, outcome: {readonly delivered:boolean;readonly retryAfterMs?:number}, inputNow: string): boolean {
    uuid.parse(jobId);uuid.parse(leaseToken);const now=utcTimestampSchema.parse(inputNow);
    const result=z.object({delivered:z.boolean(),retryAfterMs:z.number().int().min(1).max(86_400_000).optional()}).strict().parse(outcome);
    return this.#db.transaction(()=>{
      if(!this.authorizeDelivery(jobId,leaseToken,now)) return false;
      const row=outboxRowSchema.parse(this.#db.prepare('SELECT * FROM notification_outbox WHERE job_id = ? AND lease_token = ?').get(jobId,leaseToken));
      const wait=result.retryAfterMs??Math.min(3_600_000,1_000*2**(row.attempts-1));
      const next=utcTimestampSchema.parse(new Date(Date.parse(now)+wait).toISOString());
      const state=result.delivered?'DELIVERED':row.attempts>=ATTEMPTS?'FAILED':'PENDING';
      this.#db.prepare('UPDATE notification_outbox SET status = ?,lease_token = NULL,lease_expires_at = NULL,next_attempt_at = ?,delivered_at = ? WHERE job_id = ? AND lease_token = ?')
        .run(state,next,result.delivered?now:null,jobId,leaseToken);
      return true;
    }).immediate();
  }

  /** Remove every personal notification projection before the account is pseudonymized. */
  closeOwner(input: NotificationOwner): void {
    const owner=this.#owner(input);
    this.#db.transaction(()=>{
      this.#db.prepare('DELETE FROM notification_inbox WHERE market_id = ? AND account_id = ?').run(owner.marketId,owner.accountId);
      this.#db.prepare('DELETE FROM notification_preferences WHERE market_id = ? AND account_id = ?').run(owner.marketId,owner.accountId);
      this.#db.prepare('DELETE FROM price_alerts WHERE market_id = ? AND account_id = ?').run(owner.marketId,owner.accountId);
      this.#db.prepare('DELETE FROM watched_listings WHERE market_id = ? AND account_id = ?').run(owner.marketId,owner.accountId);
      this.#db.prepare('DELETE FROM notification_seen WHERE market_id = ? AND account_id = ?').run(owner.marketId,owner.accountId);
    }).immediate();
  }
}
