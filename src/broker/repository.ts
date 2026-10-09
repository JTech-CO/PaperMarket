import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import type {
  AccountView, FillView, ListingView, MarketView, PortfolioView, QuoteView,
  ServiceContext, ServiceErrorCode, ServiceRequest, ServiceResponse,
} from '../application/contracts.js';
import { TICK_INTERVAL_MILLISECONDS } from '../domain/clock.js';
import { discordSnowflakeSchema, utcTimestampSchema } from '../domain/identifiers.js';
import {
  FinancialDecimal, MONEY_SCALE, NumericBoundaryError, addFractions, decimalFraction,
  fraction, fractionToCanonicalDecimal, moneyFromAtoms, moneyToString, multiplyFractions,
  parseMoney, parseOrderQuantity, parsePrice, parseRate, quantizeMoney, type Fraction, type Quantity,
} from '../domain/numeric.js';
import { STANDARD_RULESET } from '../domain/ruleset.js';
import { maxAffordableQuantity, settleBuy, settleSell, type TradeArithmetic } from '../domain/settlement.js';
import { createInitialListings, INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { validateOpeningAcknowledgements, OpeningAcknowledgementsError } from '../policy/index.js';
import {
  AccountNotFoundError, FoundationRepository, IdempotencyConflictError, MarketUnavailableError,
  type AccountRecord, type RepositoryClock,
} from '../storage/repository.js';
import { LedgerIntegrityError, type ReplayedAccount } from '../storage/replay.js';
import { EconomyRepository, projectEconomyView, type EconomySnapshot } from '../economy/repository.js';
import type { PublicDisclosureRecord } from '../economy/public.js';
import { RightsRepository } from '../rights/repository.js';
import { ScheduledRepository, type ScheduledRow, type ConditionalIntent } from './scheduled.js';
import { ContributionRepository, CONTRIBUTION_AMOUNT_ATOMS } from './contributions.js';
import { ReportingBenchmarks } from '../reporting/benchmarks.js';
import { ReportingRepository } from '../reporting/repository.js';
import { NotificationRepository, NotificationAccessError, NotificationInputError } from '../notifications/repository.js';
import type { SaveAlertsInput, PersonalNotificationFact } from '../notifications/types.js';
type UserRequest=Extract<ServiceRequest,{context:ServiceContext}>;

const contextSchema = z.strictObject({
  guildId: discordSnowflakeSchema, discordUserId: discordSnowflakeSchema,
  interactionId: discordSnowflakeSchema, receivedAt: utcTimestampSchema,
  guildPermissions: z.string().max(20).regex(/^(?:0|[1-9][0-9]*)$/).refine((v) => BigInt(v) < (1n << 64n)),
});
const context = { context: contextSchema };
const requestSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...context, type: z.literal('setup'), channelId: discordSnowflakeSchema }),
  z.strictObject({ ...context, type: z.literal('save-board'), channelId: discordSnowflakeSchema, messageId: discordSnowflakeSchema }),
  z.strictObject({ ...context, type: z.literal('open'), age14Plus: z.boolean(), agreeTerms: z.boolean() }),
  z.strictObject({ ...context, type: z.literal('funding'), enabled: z.boolean().optional() }),
  z.strictObject({ ...context, type: z.enum(['market', 'portfolio', 'status','orders']) }),
  z.strictObject({...context,type:z.literal('company'),symbol:z.string().max(12).regex(/^[A-Za-z][A-Za-z0-9]{0,11}$/),generation:z.number().int().min(1).max(1000000).optional()}),
  z.strictObject({...context,type:z.literal('news'),symbol:z.string().max(12).regex(/^[A-Za-z][A-Za-z0-9]{0,11}$/).optional(),beforeTick:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),cursor:z.string().regex(/^[a-f0-9]{64}$/).optional()}),
  z.strictObject({...context,type:z.enum(['calendar','performance'])}),
  z.strictObject({...context,type:z.literal('chart'),symbol:z.string().max(12).regex(/^[A-Za-z][A-Za-z0-9]{0,11}$/),generation:z.number().int().min(1).max(1000000).optional(),series:z.enum(['PRICE','TOTAL_RETURN']).optional(),scale:z.enum(['LINEAR','LOG']).optional(),limit:z.number().int().min(2).max(2000).optional()}),
  z.strictObject({...context,type:z.literal('export'),format:z.enum(['CSV','JSON']),beforeSequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),beforeEventId:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional(),limit:z.number().int().min(25).max(1000).optional()}),
  z.strictObject({...context,type:z.literal('alerts'),dmEnabled:z.boolean().optional(),symbol:z.string().max(12).regex(/^[A-Za-z][A-Za-z0-9]{0,11}$/).optional(),direction:z.enum(['ABOVE','BELOW']).optional(),threshold:z.string().min(1).max(96).optional(),removePriceAlertId:z.string().uuid().optional(),watch:z.boolean().optional(),beforeId:z.string().uuid().optional(),markRead:z.boolean().optional()}),
  z.strictObject({ ...context,type:z.literal('cancel-order'),orderId:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/) }),
  z.strictObject({ ...context, type: z.literal('history'), limit: z.number().int().min(1).max(25).optional(),beforeSequence:z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).optional(),beforeEventId:z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/).optional() }),
  z.strictObject({ ...context, type: z.literal('quote'), symbol: z.string().max(12).regex(/^[A-Za-z][A-Za-z0-9]{0,11}$/),
    side: z.enum(['BUY','SELL']), generation:z.number().int().min(1).max(1000000).optional(),quantity: z.string().min(1).max(64).optional(),
    budget: z.string().min(1).max(64).optional(), budgetPercent:z.union([z.literal(25),z.literal(50),z.literal(100)]).optional(), all: z.boolean().optional(),orderType:z.enum(['MARKET','LIMIT','STOP']).optional(),conditionPrice:z.string().min(1).max(128).optional(),timeInForce:z.enum(['TICK_COUNT','UNTIL_CANCELLED']).optional(),validForTicks:z.number().int().min(1).max(10000).optional() }),
  z.strictObject({ ...context, type: z.enum(['confirm','cancel']), token: z.string().length(43).regex(/^[A-Za-z0-9_-]+$/) }),
  z.strictObject({ ...context, type: z.literal('close'), confirmed: z.boolean() }),
  z.strictObject({ type: z.enum(['tick','recover']), now: utcTimestampSchema }),
  z.strictObject({type:z.literal('notification-poll'),now:utcTimestampSchema,limit:z.number().int().min(1).max(5).optional()}),
  z.strictObject({type:z.literal('notification-check'),now:utcTimestampSchema,jobId:z.string().uuid(),leaseToken:z.string().uuid()}),
  z.strictObject({type:z.literal('notification-ack'),now:utcTimestampSchema,jobId:z.string().uuid(),leaseToken:z.string().uuid(),delivered:z.boolean(),retryAfterMs:z.number().int().min(0).max(86400000).optional()}),
]);

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/);
const decimal = z.string().min(1).max(128).refine((value) => {
  try { return parseRate(value) === value; } catch { return false; }
});
const cash = z.string().min(1).max(64).refine((value) => {
  try { return moneyToString(parseMoney(value)) === value; } catch { return false; }
});
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const symbol = z.string().max(12).regex(/^[A-Z][A-Z0-9]{0,11}$/);
const accountViewSchema = z.strictObject({ accountId:id, status:z.enum(['ACTIVE','CLOSED']), accountVersion:counter.min(1),
  createdAt:utcTimestampSchema,cash });
const fillViewSchema = z.strictObject({ orderId:id,fillId:id,symbol,side:z.enum(['BUY','SELL']),quantity:decimal,price:decimal,
  gross:decimal,fee:decimal,total:cash,cashAfter:cash,realizedPnl:cash,createdAt:utcTimestampSchema,marketVersion:counter,tickNo:counter });
const quoteViewSchema = z.strictObject({ token:z.string().length(43).regex(/^[A-Za-z0-9_-]+$/),orderIntentId:id,
  symbol,side:z.enum(['BUY','SELL']),quantity:decimal,price:decimal,gross:decimal,fee:decimal,total:cash,cashAfter:cash,
  marketVersion:counter,expiresAt:utcTimestampSchema,orderType:z.enum(['MARKET','LIMIT','STOP']).optional(),conditionPrice:decimal.optional(),timeInForce:z.enum(['TICK_COUNT','UNTIL_CANCELLED']).optional(),expiresTick:counter.nullable().optional(),reservedCash:cash.optional(),reservedQuantity:decimal.optional() });
const scheduledViewSchema=z.strictObject({orderId:id,symbol,side:z.enum(['BUY','SELL']),orderType:z.enum(['LIMIT','STOP']),quantity:decimal,conditionPrice:decimal,timeInForce:z.enum(['TICK_COUNT','UNTIL_CANCELLED']),expiresTick:counter.nullable(),status:z.enum(['OPEN','FILLED','CANCELLED','EXPIRED']),reservedCash:cash,reservedQuantity:decimal,sequenceNo:counter.min(1),createdTick:counter,terminationReason:z.enum(['USER_CANCELLED','EXPIRED','CORPORATE_ACTION_CANCELLED','ACCOUNT_CLOSED','FILLED']).optional()});
const financialViewSchema=z.strictObject({symbol,name:z.string().min(1).max(100),reportKind:z.enum(['SYNTHETIC_INITIALIZATION','ACTUAL']),
  quarterNo:z.number().int().min(-1000000).max(Number.MAX_SAFE_INTEGER),closedTick:counter,publishedTick:counter,nextEarningsTick:counter,
  revenue:cash,operatingProfit:cash,interestExpense:cash,netProfit:cash,cash,debt:cash,operatingCashFlow:cash,capex:cash,
  annualRevenueForecast:cash,operatingMarginForecast:decimal,growthForecast:decimal,generation:counter.min(1).optional(),lifecycle:z.string().max(32).optional(),
  dividends:z.array(z.strictObject({id:z.string().max(128),dps:decimal,status:z.string().max(32),declaredTick:counter,exTick:counter,payTick:counter,recoveryRatio:decimal})).max(100000).optional()});
const economyViewSchema=z.strictObject({engineVersion:z.string().max(32),economyTick:counter,
  macro:z.strictObject({policyRate:decimal,cashAnnualRate:decimal,cashDailyRate:decimal,inflation:decimal,outputGap:decimal,
    industrialDemand:decimal,consumerDemand:decimal,metals:decimal,energy:decimal,fx:decimal,creditStress:decimal,riskAppetite:decimal,
    observedTick:counter,nextMeetingTick:counter,policyProbabilities:z.strictObject({decrease:decimal,unchanged:decimal,increase:decimal})}),
  companies:z.array(financialViewSchema).length(8),disclosures:z.array(z.strictObject({id:z.string().min(1).max(256),kind:z.enum(['MACRO','EARNINGS','CORPORATE_ACTION','EVENT']),
    publishedTick:counter,symbol:symbol.nullable(),title:z.string().max(100),summary:z.string().max(1000)})).max(8)});
const marketViewSchema = z.strictObject({ marketId:id,state:z.enum(['INITIALIZING','OPEN','UPDATING','PAUSED','RECOVERING','ARCHIVED']),
  tickNo:counter,marketVersion:counter,sequenceNo:counter,nextBoundaryAt:utcTimestampSchema,updatedAt:utcTimestampSchema,
  priceSource:z.enum(['TRIAL','ECONOMY']),channelId:discordSnowflakeSchema.nullable(),boardMessageId:discordSnowflakeSchema.nullable(),
  pm8:z.strictObject({kind:z.literal('PM8'),startTick:counter,tickNo:counter,equity:cash,cash,initialCapital:cash.optional(),contributions:cash.optional(),netInvestmentPnl:cash.optional(),contributionPolicy:z.string().max(256).optional(),totalReturnPct:decimal,fees:cash,cashInterest:cash,dividends:cash,liquidationReceipts:cash,receivables:cash,openingPolicy:z.literal('MARKET_ADOPTION'),index:decimal}).optional(),
  listings:z.array(z.strictObject({listingId:id,symbol,name:z.string().min(1).max(100),slotId:z.enum(['O1','O2','O3','G1','G2','T1','T2','D1']),
    category:z.enum(['ORDINARY','GROWTH','THEMATIC','DIVIDEND']),price:decimal,changePct:decimal.optional(),generation:counter.min(1).optional(),lifecycle:z.string().max(32).optional()})).max(8),economy:economyViewSchema.optional() });
const responseSchema = z.discriminatedUnion('kind', [
  z.strictObject({kind:z.literal('SETUP'),market:marketViewSchema,
    previousBoard:z.strictObject({channelId:discordSnowflakeSchema,messageId:discordSnowflakeSchema}).optional()}),
  z.strictObject({kind:z.enum(['MARKET','STATUS']),market:marketViewSchema}),
  z.strictObject({kind:z.literal('ACCOUNT'),account:accountViewSchema}),
  z.strictObject({kind:z.literal('FUNDING'),funding:z.strictObject({enabled:z.boolean(),amount:cash,intervalTicks:z.literal(21),startTick:counter,nextContributionTick:counter.nullable(),contributions:cash})}),
  z.strictObject({kind:z.literal('QUOTE'),quote:quoteViewSchema}),
  z.strictObject({kind:z.literal('FILLED'),fill:fillViewSchema}),
  z.strictObject({kind:z.enum(['ORDER_OPENED','SCHEDULED_CANCELLED']),order:scheduledViewSchema}),
  z.strictObject({kind:z.literal('ORDERS'),orders:z.array(scheduledViewSchema).max(25)}),
  z.strictObject({kind:z.literal('CANCELLED'),orderIntentId:id}),
  z.strictObject({kind:z.literal('CLOSED'),accountId:id}),
  z.strictObject({kind:z.literal('HISTORY'),fills:z.array(fillViewSchema).max(25)}),
  z.strictObject({kind:z.literal('BOARD_SAVED')}),
  z.strictObject({kind:z.literal('PORTFOLIO'),portfolio:z.strictObject({account:accountViewSchema,marketVersion:counter,
    positions:z.array(z.strictObject({listingId:id,symbol,name:z.string().min(1).max(100),quantity:decimal,price:decimal,value:cash,cost:cash,unrealizedPnl:cash,availableQuantity:decimal.optional(),reservedQuantity:decimal.optional()})).max(8),
    equity:cash,totalReturnPct:decimal,initialCapital:cash.optional(),contributions:cash.optional(),netInvestmentPnl:cash.optional(),nextContributionTick:counter.nullable().optional(),accruedCashInterest:cash.optional(),cashInterestTotal:cash.optional(),dividendTotal:cash.optional(),liquidationTotal:cash.optional(),availableCash:cash.optional(),reservedCash:cash.optional(),
    rights:z.array(z.strictObject({rightId:z.string().max(256),kind:z.enum(['DIVIDEND','LIQUIDATION']),symbol,status:z.enum(['ATTACHED','OPEN','IMPAIRED','SETTLED']),quantity:decimal,
      nominal:cash,currentValue:cash,paid:cash,cost:cash,realizedPnl:cash,eligibleTick:counter,paymentTick:counter})).max(100000).optional()})}),
]);

interface MarketRow {
  market_id: string; guild_id: string; state: string; tick_no: number; market_version: number;
  sequence_no: number; engine_version: string; ruleset_version: string; created_at: string;
  next_boundary_at: string;
}
interface SettingsRow {
  market_id: string; market_channel_id: string; board_message_id: string | null;
  checkpoint_at: string; remaining_ms: number;
}
interface ListingRow {
  listing_id: string; symbol: string; price: string; status: string;
  slot_id: ListingView['slotId']; category: ListingView['category'];
}
interface IntentRow {
  intent_id: string; token: string; market_id: string; account_id: string; actor_hash: string;
  listing_id: string; side: 'BUY' | 'SELL'; quantity: string; price: string;
  account_version: number; market_version: number; tick_no: number; created_at: string;
  quoted_cash_after_atoms: string; expires_at: string; status: 'DRAFT' | 'FILLED' | 'CANCELLED' | 'EXPIRED' | 'REJECTED';
}
interface FillRow {
  market_id:string;account_id:string;actor_hash:string;
  fill_id: string; order_id: string; intent_id: string; symbol: string; side: 'BUY' | 'SELL';
  price: string; quantity: string; gross_numerator: string; gross_denominator: string;
  fee_numerator: string; fee_denominator: string; total_atoms: string; cash_after_atoms: string;
  cost_removed_atoms: string; realized_pnl_atoms: string; rounding_numerator: string;
  rounding_denominator: string; tick_no: number; market_version: number; created_at: string;
}
interface SubjectRow { account_id: string; closed_at: string | null }

class BrokerError extends Error {
  constructor(readonly code: ServiceErrorCode) { super(code); }
}
function reject(code: ServiceErrorCode): never { throw new BrokerError(code); }
function boundedCounter(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new LedgerIntegrityError();
  return value;
}
function moneyText(atoms: bigint | string): string { return moneyToString(moneyFromAtoms(atoms.toString())); }
function exactText(value: Fraction): string { return fractionToCanonicalDecimal(value); }
function decimalText(value: string): string { return new FinancialDecimal(value).toFixed(); }
function arithmetic(side: 'BUY' | 'SELL', price: string, quantity: string): TradeArithmetic {
  const parsedPrice = parsePrice(price);
  const parsedQuantity = parseOrderQuantity(decimalText(quantity));
  return side === 'BUY' ? settleBuy(parsedPrice, parsedQuantity, STANDARD_RULESET.tradeFeeRate)
    : settleSell(parsedPrice, parsedQuantity, STANDARD_RULESET.tradeFeeRate);
}

export interface BrokerOptions { readonly identityKey: Buffer; readonly economySeed?: Buffer;readonly onDiagnostic?:(code:'ZERO_CORPORATE_REFERENCE'|'ECONOMIC_TICK_FAILED')=>void }

/** Synchronous single-writer transaction boundary; Gateway supplies the authenticated context. */
export class BrokerRepository {
  readonly #db: Database.Database;
  readonly #clock: RepositoryClock;
  readonly #foundation: FoundationRepository;
  readonly #identityKey: Buffer;
  readonly #economy: EconomyRepository | undefined;
  readonly #scheduled: ScheduledRepository;
  readonly #contributions: ContributionRepository;
  readonly #benchmarks:ReportingBenchmarks;
  readonly #reporting:ReportingRepository;
  readonly #notifications:NotificationRepository;
  readonly #onDiagnostic:BrokerOptions['onDiagnostic'];

  constructor(db: Database.Database, clock: RepositoryClock, options: BrokerOptions) {
    this.#onDiagnostic=options.onDiagnostic;
    if (!Buffer.isBuffer(options.identityKey) || options.identityKey.length < 32 || options.identityKey.length > 512) {
      throw new TypeError('A persistent server identity key of at least 32 bytes is required.');
    }
    this.#db = db; this.#clock = clock; this.#foundation = new FoundationRepository(db, clock);this.#scheduled=new ScheduledRepository(db);
    this.#contributions=new ContributionRepository(db);
    this.#benchmarks=new ReportingBenchmarks(db);this.#reporting=new ReportingRepository(db,this.#benchmarks);this.#notifications=new NotificationRepository(db,clock);
    this.#identityKey = Buffer.from(options.identityKey);
    if(options.economySeed===undefined&&(db.prepare('SELECT COUNT(*) AS count FROM economy_markets').get() as {count:number}).count>0) {
      throw new LedgerIntegrityError('Existing economy requires its persistent market seed.');
    }
    this.#economy = options.economySeed === undefined ? undefined : new EconomyRepository(db,options.economySeed);
    this.#db.transaction(() => {
      const keyCheck = this.#hash('PaperMarket identity key binding v1');
      const row = db.prepare('SELECT identity_key_check FROM broker_metadata WHERE singleton = 1').get() as
        { identity_key_check: string } | undefined;
      if (row && row.identity_key_check !== keyCheck) throw new LedgerIntegrityError('Persistent identity key has changed.');
      if (!row) db.prepare('INSERT INTO broker_metadata(singleton,identity_key_check) VALUES(1,?)').run(keyCheck);
      const accounts = db.prepare(`SELECT a.account_id,a.market_id,a.discord_user_id,m.guild_id FROM accounts a
        JOIN markets m ON m.market_id = a.market_id WHERE a.status = 'ACTIVE'`).all() as
        Array<{ account_id: string; market_id: string; discord_user_id: string; guild_id: string }>;
      for (const account of accounts) {
        this.#contributions.initialize(account.market_id,account.account_id,this.#market(account.market_id).tick_no);
        const hash = this.#subject(account.guild_id, account.discord_user_id);
        db.prepare('INSERT OR IGNORE INTO account_subjects(market_id,subject_hash,account_id,closed_at) VALUES(?,?,?,NULL)')
          .run(account.market_id, hash, account.account_id);
        const subject = this.#subjectRow(account.market_id, hash);
        if (!subject || subject.account_id !== account.account_id || subject.closed_at !== null) throw new LedgerIntegrityError();
        this.#checkReservations(account.market_id,this.#foundation.getAccount({marketId:account.market_id,discordUserId:account.discord_user_id})!);
        if(!this.#economy||this.#economy.has(account.market_id)) {
          this.#benchmarks.initializeAccount(account.market_id,account.account_id);
          this.#reporting.backfill({marketId:account.market_id,accountId:account.account_id,discordUserId:account.discord_user_id},this.#market(account.market_id).tick_no);
        }
      }
      const closed=db.prepare("SELECT market_id,account_id FROM accounts WHERE status = 'CLOSED'").all() as {market_id:string;account_id:string}[];
      for(const account of closed) this.#scheduled.replay(account.market_id,account.account_id);
      for(const m of db.prepare("SELECT m.market_id FROM markets m JOIN market_settings s ON s.market_id=m.market_id WHERE m.state<>'ARCHIVED'").all() as {market_id:string}[]) if(!this.#economy||this.#economy.has(m.market_id)) this.#benchmarks.initializeMarket(m.market_id,this.#elapsed(this.#market(m.market_id),this.#clock.now()));
    }).immediate();
  }

  dispatch(input: ServiceRequest): ServiceResponse {
    const parsed = requestSchema.safeParse(input);
    if (!parsed.success) return { kind: 'ERROR', code: 'INVALID_INPUT' };
    const request = parsed.data as ServiceRequest;
    try {
      if(request.type==='notification-poll') return {kind:'NOTIFICATION_BATCH',deliveries:this.#notifications.poll(request.now,request.limit??5)};
      if(request.type==='notification-check') return {kind:'NOTIFICATION_AUTHORIZED',authorized:this.#notifications.authorizeDelivery(request.jobId,request.leaseToken,request.now)};
      if(request.type==='notification-ack') return {kind:'NOTIFICATION_ACK',accepted:this.#notifications.ack(request.jobId,request.leaseToken,{delivered:request.delivered,...(request.retryAfterMs!==undefined?{retryAfterMs:request.retryAfterMs}:{})},request.now)};
      if (request.type === 'tick') {
        utcTimestampSchema.parse(request.now);
        const markets = this.#db.prepare(`SELECT market_id,market_version FROM markets WHERE state = 'OPEN' ORDER BY market_id`).all() as Array<{market_id:string;market_version:number}>;
        const changed:MarketView[]=[];
        for(const market of markets) {
          const current=this.#economy?this.advanceEconomyMarket(market.market_id,request.now):this.advanceTrialMarket(market.market_id,request.now);
          if(current.marketVersion!==market.market_version) changed.push(current);
        }
        return { kind: 'TICKED', markets: changed };
      }
      if (request.type === 'recover') {
        this.recoverTrialMarkets(request.now); return { kind: 'RECOVERED' };
      }
      const now = utcTimestampSchema.parse(this.#clock.now());
      if (request.context.receivedAt > now) reject('INVALID_INPUT');
      return this.#db.transaction(() => {
        const actorHash = this.#subject(request.context.guildId, request.context.discordUserId);
        // Queries project the current owner-scoped ledger; do not persist private response snapshots.
        // The board metadata write shares /setup's Interaction ID and is naturally idempotent.
        if (['save-board','market','status','portfolio','history','orders','company','news','calendar','chart','performance','export','alerts'].includes(request.type)) return this.#execute(request,actorHash,now);
        // Transport receipt times and refreshed permission masks are not user payloads.
        const { context: _context, ...payload } = request;
        const payloadHash = createHash('sha256').update(JSON.stringify(payload)).digest('hex');
        const prior = this.#db.prepare('SELECT * FROM trade_commands WHERE interaction_id = ?').get(request.context.interactionId) as
          { guild_id: string; actor_hash: string; payload_hash: string; response_json: string } | undefined;
        if (prior) {
          if (prior.guild_id !== request.context.guildId || prior.actor_hash !== actorHash || prior.payload_hash !== payloadHash) reject('IDEMPOTENCY_CONFLICT');
          if (request.type === 'setup') this.#admin(request.context);
          const result: unknown = JSON.parse(prior.response_json);
          return this.#validateCached(result, request, actorHash);
        }
        const result = this.#execute(request, actorHash, now);
        if (request.type !== 'close') {
          this.#db.prepare(`INSERT INTO trade_commands(interaction_id,guild_id,actor_hash,command_type,payload_hash,response_json,received_at,created_at)
            VALUES(?,?,?,?,?,?,?,?)`).run(request.context.interactionId, request.context.guildId, actorHash, request.type,
              payloadHash, JSON.stringify(result), request.context.receivedAt, now);
        }
        return result;
      }).immediate();
    } catch (error) {
      if (error instanceof BrokerError) return { kind: 'ERROR', code: error.code };
      if (error instanceof OpeningAcknowledgementsError) return { kind: 'ERROR', code: 'ACKNOWLEDGEMENTS_REQUIRED' };
      if (error instanceof NumericBoundaryError || error instanceof z.ZodError) return { kind: 'ERROR', code: 'INVALID_PRECISION' };
      if (error instanceof IdempotencyConflictError) return { kind: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
      if (error instanceof AccountNotFoundError) return { kind: 'ERROR', code: 'ACCOUNT_NOT_FOUND' };
      if(error instanceof NotificationAccessError) return {kind:'ERROR',code:'ACCOUNT_NOT_FOUND'};
      if(error instanceof NotificationInputError||error instanceof RangeError) return {kind:'ERROR',code:error instanceof RangeError&&error.message==='LISTING_NOT_TRADABLE'?'LISTING_NOT_TRADABLE':'INVALID_INPUT'};
      if (error instanceof MarketUnavailableError) return { kind: 'ERROR', code: 'MARKET_PAUSED' };
      if (error instanceof LedgerIntegrityError) {
        if ('context' in request) {
          const market=this.#db.prepare("SELECT market_id FROM markets WHERE guild_id = ? AND state <> 'ARCHIVED'").get(request.context.guildId) as {market_id:string}|undefined;
          if(market) this.#pause(market.market_id,this.#clock.now());
        }
        return { kind: 'ERROR', code: 'INTEGRITY_ERROR' };
      }
      if (typeof error === 'object' && error !== null && 'code' in error &&
        (error.code === 'SQLITE_BUSY' || error.code === 'SQLITE_LOCKED')) return { kind: 'ERROR', code: 'BUSY' };
      return { kind: 'ERROR', code: 'INTERNAL_ERROR' };
    }
  }

  #execute(request: UserRequest, actorHash: string, now: string): ServiceResponse {
    if (request.type === 'setup') return this.#setup(request.context, request.channelId, now);
    const market = this.#marketByGuild(request.context.guildId);
    this.#checkpoint(market, now);
    const snapshot=this.#economy?.load(market.market_id);
    if (request.type === 'save-board') {
      this.#admin(request.context);
      const settings = this.#settings(market.market_id);
      if (!settings || settings.market_channel_id !== request.channelId) reject('INVALID_INPUT');
      this.#db.prepare('UPDATE market_settings SET board_message_id = ? WHERE market_id = ? AND market_channel_id = ?')
        .run(request.messageId, market.market_id, request.channelId);
      return { kind: 'BOARD_SAVED' };
    }
    if (request.type === 'market' || request.type === 'status') return {
      kind: request.type === 'market' ? 'MARKET' : 'STATUS', market: this.#marketView(market,snapshot),
    };
    if(request.type==='company')return {kind:'STOCK',stock:this.#reporting.company(this.#marketView(market,snapshot),request.symbol.toUpperCase(),request.generation)};
    if(request.type==='news')return {kind:'NEWS',news:this.#reporting.news(this.#marketView(market,snapshot),request.beforeTick,request.symbol?.toUpperCase(),request.cursor)};
    if(request.type==='calendar')return {kind:'CALENDAR',calendar:this.#reporting.calendar(this.#marketView(market,snapshot))};
    if(request.type==='chart')return {kind:'CHART',chart:this.#reporting.chart(this.#marketView(market,snapshot),request.symbol.toUpperCase(),request.generation,request.series??'PRICE',request.scale??'LINEAR',request.limit??252)};
    if (request.type === 'close') return this.#close(request.context, market, actorHash, request.confirmed, now);
    const subject = this.#subjectRow(market.market_id, actorHash);
    if (subject?.closed_at) reject('ACCOUNT_CLOSED');
    if (request.type === 'open') {
      const acknowledgement = validateOpeningAcknowledgements({ age14Plus: request.age14Plus, agreeTerms: request.agreeTerms });
      this.#tradable(market, request.context.receivedAt, now);
      const account = this.#foundation.openAccount({ marketId: market.market_id,
        discordUserId: request.context.discordUserId, interactionId: request.context.interactionId });
      if(this.#economy) this.#economy.initializeAccount(market.market_id,account.accountId,market.tick_no,account.cashAtoms,this.#elapsed(market,now));
      this.#contributions.initialize(market.market_id,account.accountId,market.tick_no);
      this.#benchmarks.initializeAccount(market.market_id,account.accountId,this.#elapsed(market,now));
      this.#db.prepare('INSERT OR IGNORE INTO account_subjects(market_id,subject_hash,account_id,closed_at) VALUES(?,?,?,NULL)')
        .run(market.market_id, actorHash, account.accountId);
      if(this.#subjectRow(market.market_id,actorHash)?.account_id!==account.accountId) throw new LedgerIntegrityError();
      this.#db.prepare(`INSERT OR IGNORE INTO policy_acceptances(market_id,account_id,actor_hash,terms_version,privacy_version,age14_plus,agree_terms,accepted_at)
        VALUES(?,?,?,?,?,1,1,?)`).run(market.market_id, account.accountId, actorHash, acknowledgement.termsVersion, acknowledgement.privacyVersion, now);
      return { kind: 'ACCOUNT', account: this.#accountView(account) };
    }
    const account = this.#ownedAccount(market.market_id, request.context.discordUserId, actorHash);
    const owner={marketId:market.market_id,accountId:account.accountId,discordUserId:request.context.discordUserId};
    if(request.type==='funding') {
      if(request.enabled!==undefined)this.#contributions.set(owner,market.tick_no,request.enabled);
      return {kind:'FUNDING',funding:this.#contributions.view(owner,market.tick_no)};
    }
    if(request.type==='performance')return {kind:'PERFORMANCE',performance:this.#reporting.performance(owner,this.#marketView(market,snapshot),this.#portfolio(market,account),this.#elapsed(market,now))};
    if(request.type==='export')return {kind:'EXPORT',export:this.#reporting.export(owner,this.#marketView(market,snapshot),this.#portfolio(market,account),request.format,request.limit??500,request.beforeSequence,this.#elapsed(market,now),request.beforeEventId)};
    if(request.type==='alerts') {
      const actions=Number(request.dmEnabled!==undefined)+Number(request.removePriceAlertId!==undefined)+Number(request.watch!==undefined)+Number(request.direction!==undefined||request.threshold!==undefined);
      if(actions>1||request.symbol!==undefined&&request.watch===undefined&&request.direction===undefined||request.direction!==undefined&&request.threshold===undefined||request.threshold!==undefined&&request.direction===undefined||(request.watch!==undefined||request.direction!==undefined)&&request.symbol===undefined)reject('INVALID_INPUT');
      const listing=request.symbol?request.watch===false?this.#db.prepare('SELECT listing_id FROM watched_listings WHERE market_id=? AND account_id=? AND symbol=?').get(market.market_id,account.accountId,request.symbol.toUpperCase()) as {listing_id:string}|undefined:this.#listingBySymbol(market.market_id,request.symbol.toUpperCase()):undefined;
      if(request.symbol&&!listing)reject('INVALID_INPUT');
      const setting:SaveAlertsInput=request.dmEnabled!==undefined?{dmEnabled:request.dmEnabled}:request.removePriceAlertId?{removePriceAlertId:request.removePriceAlertId}:request.watch!==undefined?request.watch?{watchListingId:listing!.listing_id}:{unwatchListingId:listing!.listing_id}:request.direction?{addPriceAlert:{listingId:listing!.listing_id,direction:request.direction,threshold:request.threshold!}}:{};
      if(actions)this.#notifications.saveAlerts(owner,setting,{tickNo:market.tick_no,marketVersion:market.market_version,createdAt:now});
      const settings=this.#notifications.getAlerts(owner);return {kind:'ALERTS',alerts:{settings,dmEnabled:settings.dmEnabled,inbox:this.#notifications.readInbox(owner,{limit:4,...(request.beforeId?{beforeId:request.beforeId}:{}),markRead:request.markRead??false})}};
    }
    if (request.type === 'portfolio') return { kind: 'PORTFOLIO', portfolio: this.#portfolio(market, account) };
    if(request.type==='orders') return {kind:'ORDERS',orders:this.#scheduled.replay(market.market_id,account.accountId).sort((a,b)=>Number(b.status==='OPEN')-Number(a.status==='OPEN')||b.sequence_no-a.sequence_no).slice(0,25).map(row=>this.#scheduled.view(row))};
    if(request.type==='cancel-order') {
      const row=this.#scheduled.replay(market.market_id,account.accountId).find(item=>item.order_id===request.orderId&&item.actor_hash===actorHash);
      if(!row) reject('INTENT_NOT_FOUND');
      const current=row.status==='OPEN'?this.#terminateScheduled(row,'CANCELLED','USER_CANCELLED',now):row;
      return {kind:'SCHEDULED_CANCELLED',order:this.#scheduled.view(current)};
    }
    if (request.type === 'history') {
      const rows = this.#db.prepare(`SELECT f.* FROM fills f JOIN accounts a ON a.market_id = f.market_id AND a.account_id = f.account_id
        WHERE f.market_id = ? AND f.account_id = ? AND f.actor_hash = ? AND a.discord_user_id = ? AND a.status = 'ACTIVE'
        ORDER BY f.sequence_no DESC LIMIT ?`).all(market.market_id, account.accountId, actorHash,
          request.context.discordUserId, request.limit ?? 10) as FillRow[];
      return { kind: 'HISTORY', fills: rows.map((row) => this.#fillView(row)),...this.#reporting.history(owner,request.limit??10,request.beforeSequence,request.beforeEventId) };
    }
    if (request.type === 'quote') {
      this.#tradable(market, request.context.receivedAt, now);
      return { kind: 'QUOTE', quote: this.#quote(request, market, account, actorHash, now) };
    }
    if (request.type === 'confirm' || request.type === 'cancel') {
      const intent = this.#db.prepare(`SELECT i.* FROM order_intents i JOIN accounts a ON a.market_id = i.market_id AND a.account_id = i.account_id
        WHERE i.token = ? AND i.market_id = ? AND i.account_id = ? AND i.actor_hash = ? AND a.discord_user_id = ? AND a.status = 'ACTIVE'`)
        .get(request.token, market.market_id, account.accountId, actorHash, request.context.discordUserId) as IntentRow | undefined;
      if (!intent) reject('INTENT_NOT_FOUND');
      const scheduled=this.#scheduled.replay(market.market_id,account.accountId).find(row=>row.intent_id===intent.intent_id);
      if(scheduled) {
        if(request.type==='cancel') return {kind:'SCHEDULED_CANCELLED',order:this.#scheduled.view(scheduled.status==='OPEN'?this.#terminateScheduled(scheduled,'CANCELLED','USER_CANCELLED',now):scheduled)};
        return this.#scheduledResponse(scheduled);
      }
      if (intent.status === 'FILLED') {
        const fill = this.#db.prepare(`SELECT f.* FROM fills f JOIN accounts a ON a.market_id = f.market_id AND a.account_id = f.account_id
          WHERE f.intent_id = ? AND f.market_id = ? AND f.account_id = ? AND f.actor_hash = ? AND a.discord_user_id = ?`)
          .get(intent.intent_id, market.market_id, account.accountId, actorHash, request.context.discordUserId) as FillRow | undefined;
        if (!fill) throw new LedgerIntegrityError();
        return { kind: 'FILLED', fill: this.#fillView(fill) };
      }
      if (intent.status === 'CANCELLED') {
        if (request.type === 'cancel') return { kind: 'CANCELLED', orderIntentId: intent.intent_id };
        if(this.#db.prepare('SELECT 1 FROM corporate_order_cancellations WHERE market_id = ? AND account_id = ? AND intent_id = ?')
          .get(market.market_id,account.accountId,intent.intent_id)) reject('CORPORATE_ACTION_CANCELLED');
        reject('ORDER_CANCELLED');
      }
      if (intent.expires_at <= now || intent.status === 'EXPIRED') reject('ORDER_EXPIRED');
      if (intent.status !== 'DRAFT') reject('STALE_QUOTE');
      if (request.type === 'cancel') {
        this.#sequence(market);
        this.#db.prepare(`UPDATE order_intents SET status = 'CANCELLED' WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ? AND status = 'DRAFT'`)
          .run(intent.intent_id, market.market_id, account.accountId, actorHash);
        return { kind: 'CANCELLED', orderIntentId: intent.intent_id };
      }
      this.#tradable(market, request.context.receivedAt, now);
      if (intent.market_version !== market.market_version || intent.account_version !== account.accountVersion) reject('STALE_QUOTE');
      const terms=this.#scheduled.terms(intent.intent_id);
      if(terms) return this.#activateScheduled(market,account,intent,terms,actorHash,now);
      return { kind: 'FILLED', fill: this.#fill(market, account, intent, actorHash, now) };
    }
    reject('INVALID_INPUT');
  }

  #setup(context: ServiceContext, channelId: string, now: string): ServiceResponse {
    this.#admin(context);
    let previousBoard:{channelId:string;messageId:string}|undefined;
    let market = this.#db.prepare(`SELECT * FROM markets WHERE guild_id = ? AND state <> 'ARCHIVED'`).get(context.guildId) as MarketRow | undefined;
    if (!market) {
      const created = this.#foundation.createMarket({ marketId: randomUUID(), guildId: context.guildId, createdAt: now, listings: createInitialListings() });
      market = this.#market(created.marketId);
      this.#db.prepare(`INSERT INTO market_settings(market_id,market_channel_id,board_message_id,quote_provider,configured_at,checkpoint_at,remaining_ms)
        VALUES(?,?,NULL,'STATIC_TRIAL',?,?,?)`).run(market.market_id, channelId, now, now, TICK_INTERVAL_MILLISECONDS);
    } else {
      const previous = this.#settings(market.market_id);
      if (!previous) this.#db.prepare(`INSERT INTO market_settings(market_id,market_channel_id,board_message_id,quote_provider,configured_at,checkpoint_at,remaining_ms)
        VALUES(?,?,NULL,'STATIC_TRIAL',?,?,?)`).run(market.market_id, channelId, now, now,
          Math.max(0, Math.min(TICK_INTERVAL_MILLISECONDS, Date.parse(market.next_boundary_at) - Date.parse(now))));
      else if (previous.market_channel_id !== channelId) {
        if(previous.board_message_id) previousBoard={channelId:previous.market_channel_id,messageId:previous.board_message_id};
        this.#db.prepare(`UPDATE market_settings SET market_channel_id = ?, board_message_id = NULL, configured_at = ? WHERE market_id = ?`)
          .run(channelId, now, market.market_id);
      }
      this.#checkpoint(market, now);
    }
    if(this.#economy) this.#economy.initialize(market,now);
    this.#initializeReportingMarket(market,now);
    this.#benchmarks.initializeMarket(market.market_id,this.#elapsed(market,now));
    return { kind: 'SETUP', market: this.#marketView(market),...(previousBoard?{previousBoard}:{}) };
  }

  #quote(request: Extract<ServiceRequest,{type:'quote'}>, market: MarketRow, account: AccountRecord, actorHash: string, now: string): QuoteView {
    const listing = this.#listingBySymbol(market.market_id, request.symbol.toUpperCase());
    if(request.generation!==undefined&&this.#reporting.company(this.#marketView(market),listing.symbol).generation!==request.generation)reject('LISTING_NOT_TRADABLE');
    const replay = this.#foundation.replayAccount(accountScope(account));
    const choices = Number(request.quantity !== undefined) + Number(request.budget !== undefined) + Number(request.budgetPercent !== undefined) + Number(request.all === true);
    if (choices !== 1 || (request.side === 'BUY' && request.all === true) || (request.side === 'SELL' && (request.budget !== undefined || request.budgetPercent !== undefined))) reject('INVALID_INPUT');
    const orderType=request.orderType??'MARKET';let terms:ConditionalIntent|undefined;
    if(orderType==='MARKET') {if(request.conditionPrice!==undefined||request.timeInForce!==undefined||request.validForTicks!==undefined) reject('INVALID_INPUT');}
    else {
      if(request.quantity===undefined||request.budget!==undefined||request.budgetPercent!==undefined||request.all!==undefined||request.conditionPrice===undefined||orderType==='STOP'&&request.side!=='SELL'||request.timeInForce==='UNTIL_CANCELLED'&&request.validForTicks!==undefined) reject('INVALID_INPUT');
      terms={order_type:orderType,condition_price:parsePrice(request.conditionPrice),time_in_force:request.timeInForce??'TICK_COUNT',valid_for_ticks:request.timeInForce==='UNTIL_CANCELLED'?null:request.validForTicks??21};
      if(terms.valid_for_ticks!==null) boundedCounter(market.tick_no+terms.valid_for_ticks);
    }
    const reserved=this.#scheduled.reservations(market.market_id,account.accountId);
    let quantity: Quantity;
    if (request.quantity !== undefined) quantity = parseOrderQuantity(request.quantity);
    else if (request.budget !== undefined || request.budgetPercent !== undefined) {
      const budget = request.budgetPercent===undefined?parseMoney(request.budget!):moneyFromAtoms(((replay.cashAtoms-reserved.cash)*BigInt(request.budgetPercent)/100n).toString());
      if (budget <= 0n) reject('INVALID_INPUT');
      if (budget > replay.cashAtoms-reserved.cash) reject('INSUFFICIENT_CASH');
      quantity = maxAffordableQuantity(budget, parsePrice(listing.price), STANDARD_RULESET.tradeFeeRate);
    } else {
      const position = replay.positions.get(listing.listing_id);
      if (!position || position.quantity.numerator === 0n) reject('INSUFFICIENT_SHARES');
      const available=addFractions(position.quantity,fraction(-(reserved.shares.get(listing.listing_id)?.numerator??0n),reserved.shares.get(listing.listing_id)?.denominator??1n));
      if(available.numerator<=0n) reject('INSUFFICIENT_SHARES');
      quantity = parseOrderQuantity(decimalText(exactText(available)));
    }
    const amounts = arithmetic(request.side, terms?.condition_price??listing.price, quantity);
    this.#assets(market.market_id,request.side, replay, listing.listing_id, quantity, amounts.money);
    const intentId = randomUUID(); const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.parse(now) + STANDARD_RULESET.quoteTtlSeconds * 1000).toISOString();
    const cashAfter = replay.cashAtoms + (request.side === 'BUY' ? -amounts.money : amounts.money);
    this.#db.prepare(`INSERT INTO order_intents(intent_id,token,market_id,account_id,actor_hash,listing_id,side,quantity,price,quoted_cash_after_atoms,account_version,market_version,tick_no,created_at,expires_at,status)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'DRAFT')`).run(intentId, token, market.market_id, account.accountId, actorHash,
        listing.listing_id, request.side, quantity, listing.price, cashAfter.toString(), account.accountVersion, market.market_version, market.tick_no, now, expiresAt);
    if(terms) this.#db.prepare('INSERT INTO conditional_intents(intent_id,order_type,condition_price,time_in_force,valid_for_ticks) VALUES(?,?,?,?,?)').run(intentId,terms.order_type,terms.condition_price,terms.time_in_force,terms.valid_for_ticks);
    return { token, orderIntentId: intentId, symbol: listing.symbol, side: request.side, quantity,
      price: listing.price, gross: exactText(amounts.gross), fee: exactText(amounts.fee), total: moneyText(amounts.money),
      cashAfter: moneyText(cashAfter),
      marketVersion: market.market_version, expiresAt,...(terms?{orderType:terms.order_type,conditionPrice:terms.condition_price,timeInForce:terms.time_in_force,expiresTick:terms.valid_for_ticks===null?null:market.tick_no+terms.valid_for_ticks,reservedCash:request.side==='BUY'?moneyText(amounts.money):'0',reservedQuantity:request.side==='SELL'?quantity:'0'}:{}) };
  }

  #fill(market: MarketRow, account: AccountRecord, intent: IntentRow, actorHash: string, now: string,scheduledOrderId?:string): FillView {
    const listing = this.#db.prepare(`SELECT * FROM listings WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'`)
      .get(market.market_id, intent.listing_id) as ListingRow | undefined;
    if (!listing) reject('LISTING_NOT_TRADABLE');
    if (listing.price !== intent.price) reject('STALE_QUOTE');
    const replay = this.#foundation.replayAccount(accountScope(account));
    const amounts = arithmetic(intent.side, listing.price, intent.quantity);
    this.#assets(market.market_id,intent.side, replay, listing.listing_id, intent.quantity, amounts.money,scheduledOrderId);
    const quantity = decimalFraction(intent.quantity);
    let removedCost = 0n;
    if (intent.side === 'SELL') {
      const position = replay.positions.get(listing.listing_id)!;
      const soldCost = fraction(position.costAtoms * quantity.numerator * position.quantity.denominator,
        quantity.denominator * position.quantity.numerator);
      // Allocate a whole atom toward the remaining lot; final disposal removes every residual atom.
      removedCost = soldCost.numerator / soldCost.denominator;
    }
    const cashDelta = intent.side === 'BUY' ? -amounts.money : amounts.money;
    const cashAfter = replay.cashAtoms + cashDelta;
    if(this.#economy) this.#economy.accrueAccount(market.market_id,account.accountId,market.tick_no,replay.cashAtoms.toString(),cashAfter.toString(),this.#elapsed(market,now));
    const costDelta = intent.side === 'BUY' ? amounts.money : -removedCost;
    const positionDelta = intent.side === 'BUY' ? intent.quantity : exactText(fraction(-quantity.numerator, quantity.denominator));
    const systemDelta = exactText(fraction(-decimalFraction(positionDelta).numerator, decimalFraction(positionDelta).denominator));
    const sequence = this.#sequence(market); const orderId = randomUUID(); const fillId = randomUUID(); const eventId = randomUUID();
    this.#db.prepare(`INSERT INTO orders(order_id,intent_id,market_id,account_id,actor_hash,listing_id,side,order_type,status,sequence_no,created_at)
      VALUES(?,?,?,?,?,?,?,'MARKET','FILLED',?,?)`).run(orderId, intent.intent_id, market.market_id, account.accountId,
        actorHash, listing.listing_id, intent.side, sequence, now);
    this.#db.prepare(`INSERT INTO fills(fill_id,order_id,intent_id,market_id,account_id,actor_hash,listing_id,symbol,side,price,quantity,
      gross_numerator,gross_denominator,fee_numerator,fee_denominator,total_atoms,cash_after_atoms,cost_removed_atoms,realized_pnl_atoms,
      rounding_numerator,rounding_denominator,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(fillId, orderId, intent.intent_id, market.market_id,
        account.accountId, actorHash, listing.listing_id, listing.symbol, intent.side, listing.price, intent.quantity,
        amounts.gross.numerator.toString(), amounts.gross.denominator.toString(), amounts.fee.numerator.toString(), amounts.fee.denominator.toString(),
        amounts.money.toString(), cashAfter.toString(), removedCost.toString(), (intent.side === 'SELL' ? amounts.money - removedCost : 0n).toString(),
        amounts.roundingAdjustment.numerator.toString(), amounts.roundingAdjustment.denominator.toString(), market.tick_no,
        market.market_version, sequence, market.engine_version, market.ruleset_version, now);
    this.#db.prepare(`INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,
      currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id)
      VALUES(?,?,?,?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',?,?,?,?,?,?,?)`).run(randomUUID(), eventId, intent.intent_id,
        market.market_id, account.accountId, cashDelta.toString(), (-cashDelta).toString(), market.tick_no, market.market_version,
        sequence, market.engine_version, market.ruleset_version, now, orderId);
    this.#db.prepare(`INSERT INTO position_journal(journal_id,event_id,cause_id,market_id,account_id,listing_id,quantity_delta,system_quantity_delta,cost_delta_atoms,
      tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(randomUUID(), eventId, intent.intent_id, market.market_id, account.accountId,
        listing.listing_id, positionDelta, systemDelta, costDelta.toString(), market.tick_no, market.market_version, sequence,
        market.engine_version, market.ruleset_version, now, orderId);
    const changed = this.#db.prepare(`UPDATE accounts SET account_version = ? WHERE market_id = ? AND account_id = ? AND discord_user_id = ? AND status = 'ACTIVE' AND account_version = ?`)
      .run(boundedCounter(account.accountVersion + 1), market.market_id, account.accountId, account.discordUserId, account.accountVersion);
    if (changed.changes !== 1) throw new LedgerIntegrityError();
    this.#db.prepare(`UPDATE order_intents SET status = 'FILLED' WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ? AND status = 'DRAFT'`)
      .run(intent.intent_id, market.market_id, account.accountId, actorHash);
    const after = this.#foundation.replayAccount(accountScope(account));
    if (after.cashAtoms !== cashAfter) throw new LedgerIntegrityError();
    const fill = this.#db.prepare('SELECT * FROM fills WHERE fill_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?')
      .get(fillId, market.market_id, account.accountId, actorHash) as FillRow;
    return this.#fillView(fill);
  }

  #activateScheduled(market:MarketRow,account:AccountRecord,intent:IntentRow,terms:ConditionalIntent,actorHash:string,now:string):ServiceResponse {
    const replay=this.#foundation.replayAccount(accountScope(account));const amounts=arithmetic(intent.side,terms.condition_price,intent.quantity);
    this.#assets(market.market_id,intent.side,replay,intent.listing_id,intent.quantity,amounts.money);
    const listing=this.#listingBySymbol(market.market_id,this.#db.prepare('SELECT symbol FROM listings WHERE market_id = ? AND listing_id = ?').pluck().get(market.market_id,intent.listing_id) as string);
    const sequence=this.#sequence(market);
    const row:ScheduledRow={order_id:randomUUID(),intent_id:intent.intent_id,market_id:market.market_id,account_id:account.accountId,actor_hash:actorHash,listing_id:intent.listing_id,symbol:listing.symbol,side:intent.side,order_type:terms.order_type,quantity:intent.quantity,condition_price:terms.condition_price,time_in_force:terms.time_in_force,expires_tick:terms.valid_for_ticks===null?null:boundedCounter(market.tick_no+terms.valid_for_ticks),created_tick:market.tick_no,sequence_no:sequence,reserved_cash_atoms:intent.side==='BUY'?amounts.money.toString():'0',reserved_quantity:intent.side==='SELL'?intent.quantity:'0',status:'OPEN',termination_reason:null,fill_order_id:null,created_at:utcTimestampSchema.parse(now)};
    // The preview nonce is consumed; scheduled_orders records the live order lifecycle.
    this.#db.prepare("UPDATE order_intents SET status = 'FILLED' WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ? AND status = 'DRAFT'").run(intent.intent_id,market.market_id,account.accountId,actorHash);
    this.#scheduled.open(row,{...market,sequence_no:sequence},now);
    this.#bumpAccount(account);
    if(this.#scheduled.triggered(row,listing.price)) return this.#executeScheduled(row,now);
    return {kind:'ORDER_OPENED',order:this.#scheduled.view(row)};
  }
  #scheduledResponse(row:ScheduledRow):ServiceResponse {
    if(row.status==='FILLED') {
      const fill=this.#db.prepare('SELECT * FROM fills WHERE order_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?').get(row.fill_order_id,row.market_id,row.account_id,row.actor_hash) as FillRow|undefined;
      if(!fill) throw new LedgerIntegrityError();return {kind:'FILLED',fill:this.#fillView(fill)};
    }
    return {kind:row.status==='OPEN'?'ORDER_OPENED':'SCHEDULED_CANCELLED',order:this.#scheduled.view(row)};
  }
  #bumpAccount(account:AccountRecord):void {
    const changed=this.#db.prepare("UPDATE accounts SET account_version = ? WHERE market_id = ? AND account_id = ? AND discord_user_id = ? AND status = 'ACTIVE' AND account_version = ?").run(boundedCounter(account.accountVersion+1),account.marketId,account.accountId,account.discordUserId,account.accountVersion);
    if(changed.changes!==1) throw new LedgerIntegrityError();
  }
  #internalAccount(row:ScheduledRow):AccountRecord {
    const user=this.#db.prepare("SELECT discord_user_id FROM accounts WHERE market_id = ? AND account_id = ? AND status = 'ACTIVE'").get(row.market_id,row.account_id) as {discord_user_id:string}|undefined;
    if(!user) throw new LedgerIntegrityError();
    const account=this.#foundation.getAccount({marketId:row.market_id,discordUserId:user.discord_user_id});
    if(!account||this.#subjectRow(row.market_id,row.actor_hash)?.account_id!==row.account_id) throw new LedgerIntegrityError();return account;
  }
  #terminateScheduled(row:ScheduledRow,status:'CANCELLED'|'EXPIRED',reason:'USER_CANCELLED'|'EXPIRED'|'CORPORATE_ACTION_CANCELLED'|'ACCOUNT_CLOSED',now:string):ScheduledRow {
    this.#scheduled.replay(row.market_id,row.account_id);const account=this.#internalAccount(row);const market=this.#market(row.market_id);const sequence=this.#sequence(market);
    const result=this.#scheduled.finish(row,status,reason,null,{...market,sequence_no:sequence},now);this.#bumpAccount(account);
    this.#notifications.record(row.market_id,row.account_id,`${row.order_id}:${reason}`,'ORDER_CANCELLED',row.symbol,'조건주문 종료',`${row.symbol} 주문이 ${reason==='EXPIRED'?'유효기간 만료':reason==='CORPORATE_ACTION_CANCELLED'?'기업행동에 따른 취소':'취소'}로 종료됐습니다. 예약 자산을 해제했습니다.`,{tickNo:market.tick_no,marketVersion:market.market_version,createdAt:now});
    return result;
  }
  #executeScheduled(row:ScheduledRow,now:string):ServiceResponse {
    this.#scheduled.replay(row.market_id,row.account_id);const account=this.#internalAccount(row);const market=this.#market(row.market_id);
    const listing=this.#db.prepare("SELECT * FROM listings WHERE market_id = ? AND listing_id = ? AND status = 'ACTIVE'").get(row.market_id,row.listing_id) as ListingRow|undefined;
    if(!listing) throw new LedgerIntegrityError();
    const intent=this.#db.prepare('SELECT * FROM order_intents WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?').get(row.intent_id,row.market_id,row.account_id,row.actor_hash) as IntentRow;
    const fill=this.#fill(market,account,{...intent,price:listing.price},row.actor_hash,now,row.order_id);
    const after=this.#market(row.market_id);const sequence=this.#sequence(after);
    const finished=this.#scheduled.finish(row,'FILLED','FILLED',fill.orderId,{...after,sequence_no:sequence},now);
    this.#notifications.record(row.market_id,row.account_id,fill.fillId,'SCHEDULED_FILLED',fill.symbol,'조건주문 체결',`${fill.symbol} ${fill.quantity}주가 ${fill.price}포인트에 체결됐습니다. /history에서 비용과 결과를 확인할 수 있습니다.`,{tickNo:after.tick_no,marketVersion:after.market_version,createdAt:now});
    this.#checkReservations(row.market_id,this.#internalAccount(row));return this.#scheduledResponse(finished);
  }
  #expireScheduled(marketId:string,nextTick:number,now:string):void {
    const rows=this.#db.prepare("SELECT * FROM scheduled_orders WHERE market_id = ? AND status = 'OPEN' AND expires_tick <= ? ORDER BY account_id,sequence_no").all(marketId,nextTick) as ScheduledRow[];
    for(const row of rows) this.#terminateScheduled(row,'EXPIRED','EXPIRED',now);
  }
  #evaluateScheduled(marketId:string,now:string):void {
    const rows=this.#db.prepare("SELECT * FROM scheduled_orders WHERE market_id = ? AND status = 'OPEN' ORDER BY account_id,sequence_no").all(marketId) as ScheduledRow[];
    for(const row of rows) {
      const listing=this.#db.prepare("SELECT price,status FROM listings WHERE market_id = ? AND listing_id = ?").get(marketId,row.listing_id) as {price:string;status:string}|undefined;
      if(!listing||listing.status!=='ACTIVE') this.#terminateScheduled(row,'CANCELLED','CORPORATE_ACTION_CANCELLED',now);
      else if(this.#scheduled.triggered(row,listing.price)) this.#executeScheduled(row,now);
    }
  }
  #cancelScheduledCorporate(marketId:string,now:string):void {
    const tick=this.#market(marketId).tick_no;
    // Rights cancellation markers cover dividend ex-dates as well as retiring listings.
    const rows=this.#db.prepare(`SELECT s.* FROM scheduled_orders s WHERE s.market_id = ? AND s.status = 'OPEN' AND
      (EXISTS(SELECT 1 FROM corporate_order_cancellations c WHERE c.market_id=s.market_id AND c.account_id=s.account_id AND c.intent_id=s.intent_id)
       OR EXISTS(SELECT 1 FROM corporate_actions d WHERE d.market_id=s.market_id AND d.tick_no=?
         AND json_extract(d.action_json,'$.listingId')=s.listing_id AND json_extract(d.action_json,'$.kind') IN ('DIVIDEND_EX','LIQUIDATION_STARTED'))) ORDER BY s.account_id,s.sequence_no`).all(marketId,tick) as ScheduledRow[];
    for(const row of rows) this.#terminateScheduled(row,'CANCELLED','CORPORATE_ACTION_CANCELLED',now);
  }
  #close(context: ServiceContext, market: MarketRow, actorHash: string, confirmed: boolean, now: string): ServiceResponse {
    if (!confirmed) reject('INVALID_INPUT');
    const subject = this.#subjectRow(market.market_id, actorHash);
    if (subject?.closed_at) return { kind: 'CLOSED', accountId: subject.account_id };
    let account = this.#ownedAccount(market.market_id, context.discordUserId, actorHash);
    for(const row of this.#scheduled.replay(market.market_id,account.accountId)) if(row.status==='OPEN') this.#terminateScheduled(row,'CANCELLED','ACCOUNT_CLOSED',now);
    account=this.#ownedAccount(market.market_id,context.discordUserId,actorHash);market=this.#market(market.market_id);
    this.#notifications.closeOwner({marketId:market.market_id,accountId:account.accountId,discordUserId:context.discordUserId});
    this.#db.prepare('DELETE FROM export_access WHERE market_id=? AND account_id=?').run(market.market_id,account.accountId);
    if(this.#economy) this.#economy.accrueAccount(market.market_id,account.accountId,market.tick_no,account.cashAtoms,'0',this.#elapsed(market,now));
    this.#sequence(market);
    this.#db.prepare(`UPDATE accounts SET status = 'CLOSED',account_version = ? WHERE market_id = ? AND account_id = ? AND discord_user_id = ? AND status = 'ACTIVE'`)
      .run(boundedCounter(account.accountVersion + 1), market.market_id, account.accountId, context.discordUserId);
    this.#db.prepare('UPDATE account_subjects SET closed_at = ? WHERE market_id = ? AND account_id = ? AND subject_hash = ?')
      .run(now, market.market_id, account.accountId, actorHash);
    this.#db.prepare('DELETE FROM processed_commands WHERE market_id = ? AND account_id = ? AND discord_user_id = ?')
      .run(market.market_id, account.accountId, context.discordUserId);
    this.#db.prepare('DELETE FROM policy_acceptances WHERE market_id = ? AND account_id = ? AND actor_hash = ?')
      .run(market.market_id, account.accountId, actorHash);
    this.#db.prepare('DELETE FROM trade_commands WHERE guild_id = ? AND actor_hash = ?').run(context.guildId, actorHash);
    this.#db.prepare(`DELETE FROM order_intents WHERE market_id = ? AND account_id = ? AND actor_hash = ? AND status <> 'FILLED'
      AND NOT EXISTS(SELECT 1 FROM corporate_order_cancellations c WHERE c.market_id=order_intents.market_id AND c.account_id=order_intents.account_id AND c.intent_id=order_intents.intent_id)`)
      .run(market.market_id, account.accountId, actorHash);
    const retained = this.#db.prepare(`SELECT intent_id FROM order_intents WHERE market_id = ? AND account_id = ? AND actor_hash = ?`)
      .all(market.market_id, account.accountId, actorHash) as Array<{intent_id:string}>;
    for (const intent of retained) this.#db.prepare('UPDATE order_intents SET token = ? WHERE intent_id = ? AND market_id = ? AND account_id = ? AND actor_hash = ?')
      .run(randomBytes(32).toString('base64url'), intent.intent_id, market.market_id, account.accountId, actorHash);
    // A random numeric tombstone satisfies the foundation's snowflake storage shape; it is never a Discord identity.
    let tombstone: string;
    do { tombstone = (100_000_000_000_000_000n + BigInt(`0x${randomBytes(7).toString('hex')}`)).toString(); }
    while (this.#db.prepare('SELECT 1 FROM accounts WHERE market_id = ? AND discord_user_id = ?').get(market.market_id, tombstone));
    this.#db.prepare(`UPDATE accounts SET discord_user_id = ? WHERE market_id = ? AND account_id = ? AND discord_user_id = ? AND status = 'CLOSED'`)
      .run(tombstone, market.market_id, account.accountId, context.discordUserId);
    return { kind: 'CLOSED', accountId: account.accountId };
  }

  #portfolio(market: MarketRow, account: AccountRecord,now=this.#clock.now()): PortfolioView {
    const replay = this.#foundation.replayAccount(accountScope(account));
    const reserved=this.#scheduled.reservations(market.market_id,account.accountId);
    this.#economy?.validatePrincipal(market.market_id,account.accountId,market.tick_no,replay.cashAtoms.toString());
    const positions: PortfolioView['positions'][number][] = [];
    let equity = fraction(replay.cashAtoms, MONEY_SCALE);
    for (const [listingId, position] of replay.positions) {
      if (position.quantity.numerator === 0n) continue;
      const listing = this.#db.prepare('SELECT * FROM listings WHERE market_id = ? AND listing_id = ?').get(market.market_id, listingId) as ListingRow | undefined;
      if (!listing || listing.status !== 'ACTIVE') throw new LedgerIntegrityError();
      const value = multiplyFractions(position.quantity, decimalFraction(parsePrice(listing.price)));
      equity = addFractions(equity, value);
      const valuedAtoms = quantizeMoney(value, 'floor').money;
      positions.push({ listingId, symbol: listing.symbol, name: this.#name(market.market_id,listingId),
        quantity: exactText(position.quantity), price: listing.price, value: moneyText(valuedAtoms),
        cost: moneyText(position.costAtoms), unrealizedPnl: moneyText(valuedAtoms - position.costAtoms),reservedQuantity:exactText(reserved.shares.get(listingId)??fraction(0n)),availableQuantity:exactText(addFractions(position.quantity,fraction(-(reserved.shares.get(listingId)?.numerator??0n),reserved.shares.get(listingId)?.denominator??1n))) });
    }
    const rights=this.#economy?new RightsRepository(this.#db).view(market.market_id,account.accountId):undefined;
    if(rights) equity=addFractions(equity,rights.asset);
    if(this.#economy) equity=addFractions(equity,this.#economy.unpaidInterest(market.market_id,account.accountId,market.tick_no,this.#elapsed(market,now)));
    const equityMoney = quantizeMoney(equity, 'floor').money;
    const owner={marketId:market.market_id,accountId:account.accountId,discordUserId:account.discordUserId};
    const capital=this.#reporting.capitalPerformance(owner,moneyText(equityMoney),market.tick_no);
    const funding=this.#contributions.view(owner,market.tick_no);
    const interest=this.#economy?.interestView(market.market_id,account.accountId,market.tick_no,this.#elapsed(market,now));
    return { account: this.#accountView(account), marketVersion: market.market_version, positions,
      equity: moneyText(equityMoney), ...capital,nextContributionTick:funding.nextContributionTick,availableCash:moneyText(replay.cashAtoms-reserved.cash),reservedCash:moneyText(reserved.cash),...interest,...(rights?{rights:rights.rights,dividendTotal:rights.dividendTotal,liquidationTotal:rights.liquidationTotal}:{}) };
  }

  #assets(marketId:string,side: 'BUY' | 'SELL', replay: ReplayedAccount, listingId: string, quantity: string, total: bigint,exclude?:string): void {
    const reserved=this.#scheduled.reservations(marketId,replay.accountId,exclude);
    if (side === 'BUY') { if (total > replay.cashAtoms-reserved.cash) reject('INSUFFICIENT_CASH'); return; }
    const owned = replay.positions.get(listingId)?.quantity ?? fraction(0n);const reservation=reserved.shares.get(listingId)??fraction(0n);
    const held=addFractions(owned,fraction(-reservation.numerator,reservation.denominator));
    const wanted = decimalFraction(quantity);
    if (wanted.numerator * held.denominator > held.numerator * wanted.denominator) reject('INSUFFICIENT_SHARES');
  }
  #ownedAccount(marketId: string, userId: string, actorHash: string): AccountRecord {
    const subject = this.#subjectRow(marketId, actorHash);
    if (subject?.closed_at) reject('ACCOUNT_CLOSED');
    const account = this.#foundation.getAccount({ marketId, discordUserId: userId });
    if (!account) reject('ACCOUNT_NOT_FOUND');
    if (account.status !== 'ACTIVE') reject('ACCOUNT_CLOSED');
    if (!subject || subject.account_id !== account.accountId) throw new LedgerIntegrityError();
    if(this.#economy) new RightsRepository(this.#db).replay(marketId,account.accountId);
    this.#checkReservations(marketId,account);
    return account;
  }
  #checkReservations(marketId:string,account:AccountRecord):void {
    const replay=this.#foundation.replayAccount(accountScope(account));const reserved=this.#scheduled.reservations(marketId,account.accountId);
    if(reserved.cash>replay.cashAtoms) throw new LedgerIntegrityError();
    for(const [listingId,q] of reserved.shares) {const owned=replay.positions.get(listingId)?.quantity??fraction(0n);if(q.numerator*owned.denominator>owned.numerator*q.denominator) throw new LedgerIntegrityError();}
  }
  #admin(context: ServiceContext): void {
    const permissions = BigInt(context.guildPermissions);
    if ((permissions & 32n) === 0n && (permissions & 8n) === 0n) reject('PERMISSION_DENIED');
  }
  #tradable(market: MarketRow, receivedAt: string, now: string): void {
    if (market.state === 'UPDATING') reject('MARKET_UPDATING');
    if (market.state !== 'OPEN') reject('MARKET_PAUSED');
    if (receivedAt >= market.next_boundary_at || now >= market.next_boundary_at) reject('MARKET_UPDATING');
  }
  #marketByGuild(guildId: string): MarketRow {
    const row = this.#db.prepare(`SELECT * FROM markets WHERE guild_id = ? AND state <> 'ARCHIVED'`).get(guildId) as MarketRow | undefined;
    if (!row) reject('MARKET_NOT_FOUND');
    return row;
  }
  #market(marketId: string): MarketRow {
    const row = this.#db.prepare('SELECT * FROM markets WHERE market_id = ?').get(marketId) as MarketRow | undefined;
    if (!row) reject('MARKET_NOT_FOUND');
    return row;
  }
  #settings(marketId: string): SettingsRow | undefined {
    return this.#db.prepare('SELECT * FROM market_settings WHERE market_id = ?').get(marketId) as SettingsRow | undefined;
  }
  #subjectRow(marketId: string, hash: string): SubjectRow | undefined {
    return this.#db.prepare('SELECT account_id,closed_at FROM account_subjects WHERE market_id = ? AND subject_hash = ?')
      .get(marketId, hash) as SubjectRow | undefined;
  }
  #listingBySymbol(marketId: string, symbol: string): ListingRow {
    const listing = this.#db.prepare(`SELECT * FROM listings WHERE market_id = ? AND symbol = ? AND status = 'ACTIVE'`)
      .get(marketId, symbol) as ListingRow | undefined;
    if (!listing) reject('LISTING_NOT_TRADABLE');
    return listing;
  }
  #sequence(market: MarketRow): number {
    const next = boundedCounter(market.sequence_no + 1);
    const changed = this.#db.prepare('UPDATE markets SET sequence_no = ? WHERE market_id = ? AND sequence_no = ?')
      .run(next, market.market_id, market.sequence_no);
    if (changed.changes !== 1) throw new LedgerIntegrityError();
    return next;
  }
  #accountView(account: AccountRecord): AccountView {
    return { accountId: account.accountId, status: account.status, accountVersion: account.accountVersion,
      createdAt: account.createdAt, cash: moneyText(account.cashAtoms) };
  }
  #name(marketId:string,listingId: string): string {
    const original=INITIAL_COMPANIES.find((company) => company.listingId === listingId);if(original) return original.name;
    const listing=this.#db.prepare('SELECT symbol,slot_id FROM listings WHERE market_id = ? AND listing_id = ?').get(marketId,listingId) as {symbol:string;slot_id:string}|undefined;
    const template=INITIAL_COMPANIES.find(company=>company.slotId===listing?.slot_id);
    return template?`${template.name} ${listing?.symbol.replace(/^[A-Z]+/,'')}세대`:'가상 기업';
  }
  #marketView(market: MarketRow,validatedSnapshot?:EconomySnapshot): MarketView {
    const settings = this.#settings(market.market_id);
    const listings = this.#db.prepare(`SELECT * FROM listings WHERE market_id = ? AND status = 'ACTIVE' ORDER BY slot_id`)
      .all(market.market_id) as ListingRow[];
    const lastTick = this.#db.prepare('SELECT committed_at FROM trial_ticks WHERE market_id = ? ORDER BY tick_no DESC LIMIT 1')
      .get(market.market_id) as {committed_at:string} | undefined;
    const snapshot=this.#economy?.has(market.market_id)?validatedSnapshot??this.#economy.load(market.market_id):undefined;
    const publications=snapshot?this.#db.prepare('SELECT publication_json FROM economy_publications WHERE market_id=? ORDER BY tick_no DESC,publication_id DESC LIMIT 8').all(market.market_id) as {publication_json:string}[]:[];
    const economy=snapshot?projectEconomyView(snapshot,this.#economy!.rates(snapshot),publications.map(row=>JSON.parse(row.publication_json) as PublicDisclosureRecord)):undefined;
    const changes:ReadonlyMap<string,string>|undefined=snapshot?new Map(snapshot.pricing.companies.map(company=>[company.listingId,parseRate(new FinancialDecimal(company.lastReturn).mul('100').toString())])):undefined;
    return { marketId: market.market_id, state: market.state, tickNo: market.tick_no, marketVersion: market.market_version,
      sequenceNo: market.sequence_no, nextBoundaryAt: market.next_boundary_at, updatedAt: economy?this.#economy!.updatedAt(market.market_id):lastTick?.committed_at ?? market.created_at,
      priceSource: economy?'ECONOMY':'TRIAL', channelId: settings?.market_channel_id ?? null, boardMessageId: settings?.board_message_id ?? null,
      ...(this.#db.prepare("SELECT 1 FROM benchmark_series WHERE market_id=? AND kind='PM8'").get(market.market_id)?{pm8:this.#benchmarks.pm8(market.market_id)}:{}),
      listings: listings.map((listing) => ({ listingId: listing.listing_id, symbol: listing.symbol, name: this.#name(market.market_id,listing.listing_id),
        slotId: listing.slot_id, category: listing.category, price: parsePrice(listing.price),...(changes?{changePct:changes.get(listing.listing_id)!}:{}),
        ...(economy?{generation:economy.companies.find(company=>company.symbol===listing.symbol)?.generation??1,lifecycle:economy.companies.find(company=>company.symbol===listing.symbol)?.lifecycle??'OPERATING'}:{}) })),...(economy?{economy}:{}) };
  }
  #fillView(row: FillRow): FillView {
    const scheduled=this.#db.prepare('SELECT order_id FROM scheduled_orders WHERE market_id = ? AND account_id = ? AND actor_hash = ? AND intent_id = ? AND fill_order_id = ?').get(row.market_id,row.account_id,row.actor_hash,row.intent_id,row.order_id) as {order_id:string}|undefined;
    return { orderId: scheduled?.order_id??row.order_id, fillId: row.fill_id, symbol: row.symbol, side: row.side,
      quantity: row.quantity, price: row.price, gross: exactText(fraction(BigInt(row.gross_numerator), BigInt(row.gross_denominator))),
      fee: exactText(fraction(BigInt(row.fee_numerator), BigInt(row.fee_denominator))), total: moneyText(row.total_atoms),
      cashAfter: moneyText(row.cash_after_atoms), realizedPnl: moneyText(row.realized_pnl_atoms), createdAt: row.created_at,
      marketVersion: row.market_version, tickNo: row.tick_no };
  }
  #hash(value: string): string { return createHmac('sha256', this.#identityKey).update(value).digest('hex'); }
  #subject(guildId: string, userId: string): string { return this.#hash(JSON.stringify(['PaperMarket subject v1', guildId, userId])); }
  #checkpoint(market: MarketRow, now: string): void {
    if(market.state!=='OPEN') return;
    const remaining = Math.max(0, Math.min(TICK_INTERVAL_MILLISECONDS, Date.parse(market.next_boundary_at) - Date.parse(now)));
    this.#db.prepare('UPDATE market_settings SET checkpoint_at = ?,remaining_ms = ? WHERE market_id = ?')
      .run(now, remaining, market.market_id);
  }
  #elapsed(market:MarketRow,now:string):number {
    if(market.state!=='OPEN'&&market.state!=='UPDATING') {
      const settings=this.#settings(market.market_id);
      if(!settings) throw new LedgerIntegrityError('Paused market has no active clock checkpoint.');
      return TICK_INTERVAL_MILLISECONDS-settings.remaining_ms;
    }
    return TICK_INTERVAL_MILLISECONDS-Math.max(0,Math.min(TICK_INTERVAL_MILLISECONDS,Date.parse(market.next_boundary_at)-Date.parse(now)));
  }
  #pause(marketId:string,inputNow:string):void {
    const now=utcTimestampSchema.parse(inputNow);
    this.#db.transaction(()=>{
      const market=this.#market(marketId);
      this.#checkpoint(market,now);
      this.#db.prepare("UPDATE markets SET state = 'PAUSED' WHERE market_id = ? AND state <> 'ARCHIVED'").run(marketId);
    }).immediate();
  }
  #validateCached(value: unknown, request: UserRequest, actorHash: string): ServiceResponse {
    const parsed = responseSchema.safeParse(value);
    if (!parsed.success) throw new LedgerIntegrityError('Malformed cached command response.');
    const response = parsed.data;
    const expectedKinds:Readonly<Record<string,readonly string[]>>={setup:['SETUP'],open:['ACCOUNT'],market:['MARKET'],status:['STATUS'],
      portfolio:['PORTFOLIO'],history:['HISTORY'],quote:['QUOTE'],funding:['FUNDING'],confirm:['FILLED','ORDER_OPENED','SCHEDULED_CANCELLED'],cancel:['CANCELLED','FILLED','SCHEDULED_CANCELLED'],close:['CLOSED'],'cancel-order':['SCHEDULED_CANCELLED'],'save-board':['BOARD_SAVED']};
    if(!expectedKinds[request.type]?.includes(response.kind)) throw new LedgerIntegrityError('Cached response belongs to another command type.');
    if(response.kind==='FUNDING') {
      const market=this.#marketByGuild(request.context.guildId);const account=this.#ownedAccount(market.market_id,request.context.discordUserId,actorHash);
      return {kind:'FUNDING',funding:this.#contributions.view({marketId:market.market_id,accountId:account.accountId,discordUserId:request.context.discordUserId},market.tick_no)};
    }
    if (response.kind === 'QUOTE') {
      const market = this.#marketByGuild(request.context.guildId);
      const account = this.#ownedAccount(market.market_id, request.context.discordUserId, actorHash);
      const intent = this.#db.prepare(`SELECT i.* FROM order_intents i JOIN accounts a ON a.market_id=i.market_id AND a.account_id=i.account_id
        WHERE i.intent_id = ? AND i.market_id = ? AND i.account_id = ? AND i.actor_hash = ? AND a.discord_user_id = ?`)
        .get(response.quote.orderIntentId,market.market_id,account.accountId,actorHash,request.context.discordUserId) as IntentRow | undefined;
      if (!intent) throw new LedgerIntegrityError();
      const terms=this.#scheduled.terms(intent.intent_id);const amounts=arithmetic(intent.side,terms?.condition_price??intent.price,intent.quantity);
      const listing = this.#db.prepare('SELECT symbol FROM listings WHERE market_id = ? AND listing_id = ?')
        .get(market.market_id,intent.listing_id) as {symbol:string}|undefined;
      const expected:QuoteView={token:intent.token,orderIntentId:intent.intent_id,symbol:listing?.symbol??'',side:intent.side,
        quantity:intent.quantity,price:intent.price,gross:exactText(amounts.gross),fee:exactText(amounts.fee),total:moneyText(amounts.money),
        cashAfter:moneyText(intent.quoted_cash_after_atoms),marketVersion:intent.market_version,expiresAt:intent.expires_at,...(terms?{orderType:terms.order_type,conditionPrice:terms.condition_price,timeInForce:terms.time_in_force,expiresTick:terms.valid_for_ticks===null?null:intent.tick_no+terms.valid_for_ticks,reservedCash:intent.side==='BUY'?moneyText(amounts.money):'0',reservedQuantity:intent.side==='SELL'?intent.quantity:'0'}:{})};
      if (JSON.stringify(response.quote)!==JSON.stringify(expected)) throw new LedgerIntegrityError('Cached quote differs from its stored intent.');
    } else if (response.kind==='FILLED') {
      const market=this.#marketByGuild(request.context.guildId);
      const account=this.#ownedAccount(market.market_id,request.context.discordUserId,actorHash);
      const fill=this.#db.prepare(`SELECT f.* FROM fills f JOIN accounts a ON a.market_id=f.market_id AND a.account_id=f.account_id
        WHERE f.fill_id = ? AND f.market_id = ? AND f.account_id = ? AND f.actor_hash = ? AND a.discord_user_id = ?`)
        .get(response.fill.fillId,market.market_id,account.accountId,actorHash,request.context.discordUserId) as FillRow|undefined;
      if(!fill||JSON.stringify(response.fill)!==JSON.stringify(this.#fillView(fill))) throw new LedgerIntegrityError('Cached fill differs from its committed record.');
    } else if(response.kind==='ORDER_OPENED'||response.kind==='SCHEDULED_CANCELLED') {
      const market=this.#marketByGuild(request.context.guildId);const account=this.#ownedAccount(market.market_id,request.context.discordUserId,actorHash);
      const row=this.#scheduled.replay(market.market_id,account.accountId).find(item=>item.order_id===response.order.orderId&&item.actor_hash===actorHash);
      if(!row) throw new LedgerIntegrityError();
      const historic={...row,status:response.order.status,termination_reason:response.order.terminationReason??null,fill_order_id:null};
      if(response.kind==='ORDER_OPENED'&&response.order.status!=='OPEN'||response.kind==='SCHEDULED_CANCELLED'&&response.order.status==='OPEN'||JSON.stringify(this.#scheduled.view(historic))!==JSON.stringify(response.order)) throw new LedgerIntegrityError();
      return request.type==='confirm'?this.#scheduledResponse(row):{kind:'SCHEDULED_CANCELLED',order:this.#scheduled.view(row)};
    } else if (response.kind==='ACCOUNT') {
      if(request.type!=='open') throw new LedgerIntegrityError();
      const market=this.#marketByGuild(request.context.guildId);
      const account=this.#foundation.openAccount({marketId:market.market_id,discordUserId:request.context.discordUserId,interactionId:request.context.interactionId});
      if(JSON.stringify(response.account)!==JSON.stringify(this.#accountView(account))) throw new LedgerIntegrityError('Cached account differs from its committed record.');
    }
    if(response.kind==='SETUP') {
      if (request.type !== 'setup') throw new LedgerIntegrityError();
      const current = this.#marketByGuild(request.context.guildId);
      if (current.market_id !== response.market.marketId) throw new LedgerIntegrityError();
      const view = this.#marketView(current);
      if (view.channelId !== request.channelId) reject('IDEMPOTENCY_CONFLICT');
      return {kind:'SETUP',market:view,...(response.previousBoard?{previousBoard:response.previousBoard}:{})};
    }
    return response as ServiceResponse;
  }

  /** Internal deterministic trial provider. Polling before the boundary never changes prices or versions. */
  #payContributions(marketId:string,now:string):void {
    for(const owner of this.#contributions.due(marketId,this.#market(marketId).tick_no)) {
      const market=this.#market(marketId);
      const account=this.#foundation.getAccount({marketId,discordUserId:owner.discordUserId});
      if(!account||account.status!=='ACTIVE'||account.accountId!==owner.accountId)throw new LedgerIntegrityError();
      const beforeEquity=parseMoney(this.#portfolio(market,account,now).equity);
      const afterCash=moneyFromAtoms((BigInt(account.cashAtoms)+CONTRIBUTION_AMOUNT_ATOMS).toString());
      const sequence=this.#sequence(market);const eventId=randomUUID();
      this.#db.prepare("INSERT INTO cash_journal(journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id) VALUES(?,?,?,?,?,'CONTRIBUTION',?,?,'EXTERNAL_CAPITAL','PAPERMARKET_POINT',?,?,?,?,?,?,NULL)")
        .run(randomUUID(),eventId,eventId,marketId,account.accountId,CONTRIBUTION_AMOUNT_ATOMS.toString(),(-CONTRIBUTION_AMOUNT_ATOMS).toString(),market.tick_no,market.market_version,sequence,market.engine_version,market.ruleset_version,now);
      this.#db.prepare('INSERT INTO contribution_valuations(market_id,account_id,event_id,tick_no,sequence_no,before_equity_atoms,amount_atoms) VALUES(?,?,?,?,?,?,?)')
        .run(marketId,account.accountId,eventId,market.tick_no,sequence,beforeEquity.toString(),CONTRIBUTION_AMOUNT_ATOMS.toString());
      const changed=this.#db.prepare("UPDATE accounts SET account_version=account_version+1 WHERE market_id=? AND account_id=? AND discord_user_id=? AND status='ACTIVE' AND account_version<9007199254740991")
        .run(marketId,account.accountId,owner.discordUserId);
      if(changed.changes!==1)throw new LedgerIntegrityError('Account version exceeds the supported range.');
      this.#economy?.accrueAccount(marketId,account.accountId,market.tick_no,account.cashAtoms,afterCash.toString(),0);
    }
  }
  #recordTickEnd(market:MarketRow,now:string):void {
    const view=this.#marketView(market);
    for(const row of this.#db.prepare("SELECT discord_user_id FROM accounts WHERE market_id=? AND status='ACTIVE'").all(market.market_id) as {discord_user_id:string}[]) {
      const account=this.#foundation.getAccount({marketId:market.market_id,discordUserId:row.discord_user_id})!;
      this.#reporting.recordTickEnd({marketId:market.market_id,accountId:account.accountId,discordUserId:row.discord_user_id},view,this.#portfolio(market,account,now),now);
    }
  }
  #initializeReportingMarket(market:MarketRow,now:string):void {
    this.#benchmarks.initializeMarket(market.market_id,this.#elapsed(market,now));
    for(const row of this.#db.prepare("SELECT account_id,discord_user_id FROM accounts WHERE market_id=? AND status='ACTIVE'").all(market.market_id) as {account_id:string;discord_user_id:string}[]) {
      this.#benchmarks.initializeAccount(market.market_id,row.account_id);
      this.#reporting.backfill({marketId:market.market_id,accountId:row.account_id,discordUserId:row.discord_user_id},market.tick_no);
    }
  }
  #recordBoundary(marketId:string,now:string):void {
    const market=this.#market(marketId);const view=this.#marketView(market);
    const rights:Array<PersonalNotificationFact&{kind:'DIVIDEND_RIGHT'|'DIVIDEND_PAID'}>=[];
    const events=this.#db.prepare('SELECT account_id,event_id,state_json FROM rights_journal WHERE market_id=? AND tick_no=? ORDER BY sequence_no,rowid').all(marketId,market.tick_no) as {account_id:string;event_id:string;state_json:string}[];
    const offset=market.tick_no-(view.economy?.economyTick??market.tick_no);
    const seen=new Set<string>();
    for(const row of events) {
      const state=JSON.parse(row.state_json) as {rightId:string;kind:string;status:string;symbol:string;eligibleTick:number;paidAtoms:string};
      if(state.kind!=='DIVIDEND')continue;
      const paid=state.status==='SETTLED';if(!paid&&state.eligibleTick+offset!==market.tick_no||state.status==='ATTACHED')continue;
      const key=`${row.account_id}:${state.rightId}:${paid?'paid':'right'}`;if(seen.has(key))continue;seen.add(key);
      rights.push({accountId:row.account_id,eventId:key,kind:paid?'DIVIDEND_PAID':'DIVIDEND_RIGHT',symbol:state.symbol,title:paid?'배당 지급 완료':'배당 권리 확정',summary:paid?`${state.symbol} 지급 ${moneyText(state.paidAtoms)}포인트. 권리 평가액에서 현금으로 이동했으며 수익을 중복 계산하지 않습니다.`:`${state.symbol}의 배당 권리가 확정됐습니다. 이후 주식을 매도해도 이 권리는 유지됩니다.`});
    }
    const fills:PersonalNotificationFact[]=(this.#db.prepare("SELECT f.account_id,f.fill_id,f.symbol,f.quantity,f.price FROM fills f JOIN scheduled_orders s ON s.market_id=f.market_id AND s.account_id=f.account_id AND s.fill_order_id=f.order_id WHERE f.market_id=? AND f.tick_no=?").all(marketId,market.tick_no) as {account_id:string;fill_id:string;symbol:string;quantity:string;price:string}[]).map(f=>({accountId:f.account_id,eventId:f.fill_id,symbol:f.symbol,title:'조건주문 체결',summary:`${f.symbol} ${f.quantity}주가 ${f.price}포인트에 체결됐습니다. /history에서 비용과 결과를 확인할 수 있습니다.`}));
    const listings=(this.#db.prepare('SELECT listing_id,symbol,price,status FROM listings WHERE market_id=?').all(marketId) as {listing_id:string;symbol:string;price:string;status:string}[]).map(l=>({listingId:l.listing_id,symbol:l.symbol,name:this.#name(marketId,l.listing_id),price:l.price,active:l.status==='ACTIVE'}));
    this.#notifications.recordBoundary({marketId,tickNo:market.tick_no,marketVersion:market.market_version,createdAt:now,listings,disclosures:this.#reporting.disclosures(view,undefined,undefined,10000).filter(d=>d.publishedTick===market.tick_no),rights,fills});
  }
  advanceTrialMarket(marketId: string, inputNow: string = this.#clock.now()): MarketView {
    const now = utcTimestampSchema.parse(inputNow);
    return this.#db.transaction(() => {
      let market = this.#market(marketId);
      if (!this.#settings(marketId)) reject('MARKET_NOT_FOUND');
      if (market.state !== 'OPEN' || now < market.next_boundary_at) {
        this.#checkpoint(market, now); return this.#marketView(market);
      }
      const tick = boundedCounter(market.tick_no + 1); const version = boundedCounter(market.market_version + 1);
      this.#recordTickEnd(market,now);
      this.#expireScheduled(marketId,tick,now);market=this.#market(marketId);
      const sequence = this.#sequence(market);
      this.#db.prepare(`INSERT INTO trial_ticks(market_id,tick_no,market_version,sequence_no,boundary_at,committed_at) VALUES(?,?,?,?,?,?)`)
        .run(marketId, tick, version, sequence, market.next_boundary_at, now);
      this.#db.prepare(`UPDATE markets SET tick_no = ?,market_version = ?,next_boundary_at = ? WHERE market_id = ? AND market_version = ?`)
        .run(tick, version, new Date(Date.parse(now) + TICK_INTERVAL_MILLISECONDS).toISOString(), marketId, market.market_version);
      const current = this.#market(marketId); this.#checkpoint(current, now);this.#evaluateScheduled(marketId,now);
      this.#payContributions(marketId,now);
      this.#benchmarks.advanceBoundary(marketId);this.#recordBoundary(marketId,now);
      return this.#marketView(this.#market(marketId));
    }).immediate();
  }

  /** One atomic economic, disclosure, valuation and investor-interest commit. Failure leaves prior values and pauses. */
  advanceEconomyMarket(marketId:string,inputNow:string=this.#clock.now()):MarketView {
    const now=utcTimestampSchema.parse(inputNow);
    if(!this.#economy) throw new LedgerIntegrityError('Economic provider is unavailable.');
    try {
      return this.#db.transaction(()=>{
        let market=this.#market(marketId);
        if(!this.#settings(marketId)) reject('MARKET_NOT_FOUND');
        this.#economy!.initialize(market,now);
        if(market.state!=='OPEN'||now<market.next_boundary_at) {this.#checkpoint(market,now);return this.#marketView(market);}
        const tick=boundedCounter(market.tick_no+1);const version=boundedCounter(market.market_version+1);
        this.#recordTickEnd(market,now);
        this.#expireScheduled(marketId,tick,now);market=this.#market(marketId);const sequence=this.#sequence(market);
        this.#db.prepare("UPDATE markets SET state = 'UPDATING' WHERE market_id = ? AND state = 'OPEN'").run(marketId);
        this.#economy!.settleInterest(market,tick,version,sequence,now);
        this.#economy!.advance(market,tick,version,now);
        const changed=this.#db.prepare("UPDATE markets SET state = 'OPEN',tick_no = ?,market_version = ?,next_boundary_at = ? WHERE market_id = ? AND market_version = ?")
          .run(tick,version,new Date(Date.parse(now)+TICK_INTERVAL_MILLISECONDS).toISOString(),marketId,market.market_version);
        if(changed.changes!==1) throw new LedgerIntegrityError('Market version changed during economic commit.');
        const current=this.#market(marketId);this.#checkpoint(current,now);
        this.#cancelScheduledCorporate(marketId,now);
        this.#economy!.settleRights(this.#market(marketId),now);
        this.#evaluateScheduled(marketId,now);
        this.#payContributions(marketId,now);
        this.#benchmarks.advanceBoundary(marketId);this.#recordBoundary(marketId,now);
        return this.#marketView(this.#market(marketId));
      }).immediate();
    } catch(error) {
      try{this.#onDiagnostic?.(error instanceof LedgerIntegrityError&&error.message==='ZERO_CORPORATE_REFERENCE'?'ZERO_CORPORATE_REFERENCE':'ECONOMIC_TICK_FAILED');}catch{/* Diagnostic delivery cannot affect rollback or pausing. */}
      this.#pause(marketId,now);
      throw new LedgerIntegrityError('Economic tick failed and market was paused.');
    }
  }

  /** Rebase the saved active interval at startup, excluding time while the process was offline. */
  recoverTrialMarkets(inputNow: string = this.#clock.now()): void {
    const now = utcTimestampSchema.parse(inputNow);
    this.#db.transaction(() => {
      const markets = this.#db.prepare(`SELECT m.* FROM markets m JOIN market_settings s ON s.market_id = m.market_id WHERE m.state = 'OPEN'`).all() as MarketRow[];
      for (const market of markets) {
        const settings = this.#settings(market.market_id)!;
        if (settings.checkpoint_at > now) throw new LedgerIntegrityError('Recovery clock precedes its checkpoint.');
        this.#db.prepare('UPDATE markets SET next_boundary_at = ? WHERE market_id = ?')
          .run(new Date(Date.parse(now) + settings.remaining_ms).toISOString(), market.market_id);
        this.#db.prepare('UPDATE market_settings SET checkpoint_at = ? WHERE market_id = ?').run(now, market.market_id);
        if(this.#economy) this.#economy.initialize(market,now);
        this.#initializeReportingMarket(this.#market(market.market_id),now);
      }
    }).immediate();
  }
}

function accountScope(account: AccountRecord) { return { marketId: account.marketId, discordUserId: account.discordUserId }; }
