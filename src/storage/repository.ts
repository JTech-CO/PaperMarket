import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import {
  accountIdSchema, accountVersionSchema, discordSnowflakeSchema, issuerCategorySchema,
  issuerIdSchema, listingIdSchema, marketIdSchema, marketStatusSchema, marketVersionSchema,
  sequenceNoSchema, slotIdSchema, tickNoSchema, utcTimestampSchema,
  type IssuerCategory, type SlotId,
} from '../domain/identifiers.js';
import { TICK_INTERVAL_MILLISECONDS } from '../domain/clock.js';
import { moneyFromAtoms } from '../domain/numeric.js';
import { INITIAL_ACCOUNT_GRANT_ATOMS, LedgerIntegrityError, replayJournal, type ReplayedAccount } from './replay.js';
import { FOUNDATION_ENGINE_VERSION, FOUNDATION_RULESET_VERSION } from './constants.js';

export { FOUNDATION_ENGINE_VERSION, FOUNDATION_RULESET_VERSION } from './constants.js';

export interface RepositoryClock { now(): string }

export interface InitialListing {
  readonly issuerId: string;
  readonly listingId: string;
  readonly slotId: SlotId;
  readonly category: IssuerCategory;
  readonly symbol: string;
  readonly price: string;
}

export interface CreateMarketInput {
  readonly marketId: string;
  readonly guildId: string;
  readonly createdAt?: string;
  readonly listings: readonly InitialListing[];
}

export interface MarketRecord {
  readonly marketId: string;
  readonly guildId: string;
  readonly state: string;
  readonly tickNo: number;
  readonly marketVersion: number;
  readonly sequenceNo: number;
  readonly engineVersion: string;
  readonly rulesetVersion: string;
  readonly createdAt: string;
  readonly nextBoundaryAt: string;
}

export interface AccountScope { readonly marketId: string; readonly discordUserId: string }
export interface OpenAccountInput extends AccountScope { readonly interactionId: string }
export interface AccountRecord extends AccountScope {
  readonly accountId: string;
  readonly status: 'ACTIVE' | 'CLOSED';
  readonly accountVersion: number;
  readonly createdAt: string;
  readonly cashAtoms: string;
}

const slotCategories: Readonly<Record<SlotId, IssuerCategory>> = Object.freeze({
  O1: 'ORDINARY', O2: 'ORDINARY', O3: 'ORDINARY', G1: 'GROWTH', G2: 'GROWTH',
  T1: 'THEMATIC', T2: 'THEMATIC', D1: 'DIVIDEND',
});
const listingSchema = z.strictObject({
  issuerId: issuerIdSchema,
  listingId: listingIdSchema,
  slotId: slotIdSchema,
  category: issuerCategorySchema,
  symbol: z.string().min(1).max(12).regex(/^[A-Z][A-Z0-9]{0,11}$/),
  price: z.literal('1000'),
});
const createMarketSchema = z.strictObject({
  marketId: marketIdSchema,
  guildId: discordSnowflakeSchema,
  createdAt: utcTimestampSchema.optional(),
  listings: z.array(listingSchema).length(8),
}).superRefine((input, context) => {
  for (const key of ['slotId', 'issuerId', 'listingId', 'symbol'] as const) {
    if (new Set(input.listings.map((listing) => listing[key])).size !== 8) {
      context.addIssue({ code: 'custom', message: `Initial ${key} must be unique.` });
    }
  }
  if (input.listings.some((listing) => slotCategories[listing.slotId] !== listing.category)) {
    context.addIssue({ code: 'custom', message: 'Initial slot and category must agree.' });
  }
});
const accountScopeSchema = z.strictObject({ marketId: marketIdSchema, discordUserId: discordSnowflakeSchema });
const openAccountSchema = accountScopeSchema.extend({ interactionId: discordSnowflakeSchema });
const accountRowSchema = z.object({
  account_id: accountIdSchema,
  market_id: marketIdSchema,
  discord_user_id: discordSnowflakeSchema,
  status: z.enum(['ACTIVE', 'CLOSED']),
  account_version: accountVersionSchema.refine((version) => version > 0),
  created_at: utcTimestampSchema,
});
const accountRecordSchema = z.strictObject({
  accountId: accountIdSchema,
  marketId: marketIdSchema,
  discordUserId: discordSnowflakeSchema,
  status: z.enum(['ACTIVE', 'CLOSED']),
  accountVersion: accountVersionSchema.refine((version) => version > 0),
  createdAt: utcTimestampSchema,
  cashAtoms: z.string().max(50).refine((value) => {
    try { return BigInt(moneyFromAtoms(value)) >= 0n; } catch { return false; }
  }),
});
const marketRowSchema = z.object({
  market_id: marketIdSchema,
  guild_id: discordSnowflakeSchema,
  state: marketStatusSchema,
  tick_no: tickNoSchema,
  market_version: marketVersionSchema,
  sequence_no: sequenceNoSchema,
  engine_version: z.literal(FOUNDATION_ENGINE_VERSION),
  ruleset_version: z.literal(FOUNDATION_RULESET_VERSION),
  created_at: utcTimestampSchema,
  next_boundary_at: utcTimestampSchema,
});
const processedCommandSchema = z.object({
  interaction_id: discordSnowflakeSchema,
  market_id: marketIdSchema,
  discord_user_id: discordSnowflakeSchema,
  account_id: accountIdSchema,
  command_type: z.literal('OPEN_ACCOUNT'),
  payload_hash: z.string().regex(/^[0-9a-f]{64}$/),
  result_json: z.string().min(1).max(4_096),
  sequence_no: sequenceNoSchema.refine((value) => value > 0),
  created_at: utcTimestampSchema,
});

export class IdempotencyConflictError extends Error {
  constructor() {
    super('Interaction identifier is already bound to another command.');
    this.name = 'IdempotencyConflictError';
  }
}

export class AccountNotFoundError extends Error {
  constructor() {
    super('No account is available in this owner scope.');
    this.name = 'AccountNotFoundError';
  }
}

export class MarketUnavailableError extends Error {
  constructor() {
    super('Market is unavailable for account creation.');
    this.name = 'MarketUnavailableError';
  }
}

/** Trusted server boundary: owner IDs must come from authenticated Discord interactions. */
export class FoundationRepository {
  readonly #db: Database.Database;
  readonly #clock: RepositoryClock;

  constructor(db: Database.Database, clock: RepositoryClock = { now: () => new Date().toISOString() }) {
    this.#db = db;
    this.#clock = clock;
  }

  createMarket(input: CreateMarketInput): MarketRecord {
    const parsed = createMarketSchema.parse(input);
    const createdAt = parsed.createdAt ?? utcTimestampSchema.parse(this.#clock.now());
    const nextBoundaryAt = utcTimestampSchema.parse(new Date(Date.parse(createdAt) + TICK_INTERVAL_MILLISECONDS).toISOString());
    return this.#db.transaction(() => {
      this.#db.prepare(`INSERT INTO markets (
        market_id,guild_id,state,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,next_boundary_at
      ) VALUES(?,?,'OPEN',0,0,0,?,?,?,?)`).run(
        parsed.marketId, parsed.guildId, FOUNDATION_ENGINE_VERSION, FOUNDATION_RULESET_VERSION, createdAt, nextBoundaryAt,
      );
      const insertIssuer = this.#db.prepare('INSERT INTO issuers(market_id,issuer_id,category) VALUES(?,?,?)');
      const insertListing = this.#db.prepare(`INSERT INTO listings (
        market_id,listing_id,issuer_id,slot_id,category,symbol,price,status,created_at
      ) VALUES(?,?,?,?,?,?,?,'ACTIVE',?)`);
      for (const listing of parsed.listings) {
        insertIssuer.run(parsed.marketId, listing.issuerId, listing.category);
        insertListing.run(parsed.marketId, listing.listingId, listing.issuerId, listing.slotId, listing.category,
          listing.symbol, listing.price, createdAt);
      }
      const row = marketRowSchema.parse(this.#db.prepare('SELECT * FROM markets WHERE market_id = ?').get(parsed.marketId));
      return Object.freeze({
        marketId: row.market_id, guildId: row.guild_id, state: row.state, tickNo: row.tick_no,
        marketVersion: row.market_version, sequenceNo: row.sequence_no, engineVersion: row.engine_version,
        rulesetVersion: row.ruleset_version, createdAt: row.created_at, nextBoundaryAt: row.next_boundary_at,
      });
    }).immediate();
  }

  openAccount(input: OpenAccountInput): AccountRecord {
    const parsed = openAccountSchema.parse(input);
    const payloadHash = createHash('sha256').update(JSON.stringify([
      'OPEN_ACCOUNT', parsed.marketId, parsed.discordUserId,
    ])).digest('hex');

    return this.#db.transaction(() => {
      const priorRaw = this.#db.prepare('SELECT * FROM processed_commands WHERE interaction_id = ?').get(parsed.interactionId);
      if (priorRaw) {
        const prior = processedCommandSchema.parse(priorRaw);
        if (prior.market_id !== parsed.marketId || prior.discord_user_id !== parsed.discordUserId || prior.payload_hash !== payloadHash) {
          throw new IdempotencyConflictError();
        }
        const result = accountRecordSchema.parse(JSON.parse(prior.result_json));
        const account = this.#accountRow(parsed);
        if (result.accountId !== prior.account_id || result.marketId !== parsed.marketId || result.discordUserId !== parsed.discordUserId ||
            !account || account.account_id !== result.accountId) {
          throw new LedgerIntegrityError();
        }
        this.#replay(parsed, account);
        const historical = this.#replay(parsed, account, prior.sequence_no);
        if (result.cashAtoms !== historical.cashAtoms.toString() || result.createdAt !== account.created_at ||
            result.createdAt > prior.created_at || result.accountVersion > account.account_version ||
            (result.accountVersion === account.account_version && result.status !== account.status)) {
          throw new LedgerIntegrityError('Cached command response differs from its committed journal.');
        }
        return Object.freeze(result);
      }

      const marketRaw = this.#db.prepare('SELECT * FROM markets WHERE market_id = ?').get(parsed.marketId);
      if (!marketRaw) throw new MarketUnavailableError();
      const market = marketRowSchema.parse(marketRaw);
      if (market.state !== 'OPEN') throw new MarketUnavailableError();
      const sequenceNo = sequenceNoSchema.parse(market.sequence_no + 1);
      const createdAt = utcTimestampSchema.parse(this.#clock.now());
      const advanced = this.#db.prepare('UPDATE markets SET sequence_no = ? WHERE market_id = ? AND sequence_no = ?')
        .run(sequenceNo, parsed.marketId, market.sequence_no);
      if (advanced.changes !== 1) throw new LedgerIntegrityError('Market command sequence could not advance.');

      let account = this.#accountRow(parsed);
      if (!account) {
        const accountId = randomUUID();
        this.#db.prepare(`INSERT INTO accounts(account_id,market_id,discord_user_id,status,account_version,created_at)
          VALUES(?,?,?,'ACTIVE',1,?)`).run(accountId, parsed.marketId, parsed.discordUserId, createdAt);
        const eventId = randomUUID();
        this.#db.prepare(`INSERT INTO cash_journal (
          journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,
          currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id
        ) VALUES(?,?,?,?,?,'INITIAL_GRANT',?,?,'INITIAL_CAPITAL','PAPERMARKET_POINT',?,?,?,?,?,?,NULL)`).run(
          randomUUID(), eventId, eventId, parsed.marketId, accountId,
          INITIAL_ACCOUNT_GRANT_ATOMS.toString(), (-INITIAL_ACCOUNT_GRANT_ATOMS).toString(),
          market.tick_no, market.market_version, sequenceNo, market.engine_version, market.ruleset_version, createdAt,
        );
        account = this.#accountRow(parsed);
      }
      if (!account) throw new LedgerIntegrityError();
      if (account.status !== 'ACTIVE') throw new MarketUnavailableError();
      const result = this.#accountRecord(account, this.#replay(parsed, account));
      this.#db.prepare(`INSERT INTO processed_commands(
        interaction_id,market_id,discord_user_id,account_id,command_type,payload_hash,result_json,sequence_no,created_at
      ) VALUES(?,?,?,?,'OPEN_ACCOUNT',?,?,?,?)`).run(
        parsed.interactionId, parsed.marketId, parsed.discordUserId, account.account_id,
        payloadHash, JSON.stringify(result), sequenceNo, createdAt,
      );
      return result;
    }).immediate();
  }

  getAccount(input: AccountScope): AccountRecord | null {
    const scope = accountScopeSchema.parse(input);
    return this.#snapshot(() => {
      const row = this.#accountRow(scope);
      return row ? this.#accountRecord(row, this.#replay(scope, row)) : null;
    });
  }

  replayAccount(input: AccountScope): ReplayedAccount {
    const scope = accountScopeSchema.parse(input);
    return this.#snapshot(() => {
      const row = this.#accountRow(scope);
      if (!row) throw new AccountNotFoundError();
      return this.#replay(scope, row);
    });
  }

  #accountRow(scope: AccountScope) {
    const row = this.#db.prepare('SELECT * FROM accounts WHERE market_id = ? AND discord_user_id = ?')
      .get(scope.marketId, scope.discordUserId);
    return row ? accountRowSchema.parse(row) : null;
  }

  #replay(scope: AccountScope, account: z.output<typeof accountRowSchema>, asOfSequence?: number): ReplayedAccount {
    const accountId = account.account_id;
    const market = marketRowSchema.parse(this.#db.prepare('SELECT * FROM markets WHERE market_id = ?').get(scope.marketId));
    const sequenceLimit = asOfSequence === undefined ? null : sequenceNoSchema.parse(asOfSequence);
    if (sequenceLimit !== null && sequenceLimit > market.sequence_no) throw new LedgerIntegrityError();
    // The join repeats the owner condition even after the scoped account lookup.
    const cashRows = this.#db.prepare(`SELECT j.* FROM cash_journal j
      JOIN accounts a ON a.market_id = j.market_id AND a.account_id = j.account_id
      WHERE j.market_id = ? AND j.account_id = ? AND a.discord_user_id = ?
        AND (? IS NULL OR j.sequence_no <= ?)
      ORDER BY j.sequence_no,j.journal_id`).all(scope.marketId, accountId, scope.discordUserId, sequenceLimit, sequenceLimit);
    const positionRows = this.#db.prepare(`SELECT j.* FROM position_journal j
      JOIN accounts a ON a.market_id = j.market_id AND a.account_id = j.account_id
      WHERE j.market_id = ? AND j.account_id = ? AND a.discord_user_id = ?
        AND (? IS NULL OR j.sequence_no <= ?)
      ORDER BY j.sequence_no,j.journal_id`).all(scope.marketId, accountId, scope.discordUserId, sequenceLimit, sequenceLimit);
    const contributions=cashRows.filter(row=>(row as {entry_type:string}).entry_type==='CONTRIBUTION') as {event_id:string;tick_no:number;sequence_no:number;account_delta_atoms:string}[];
    // Foundation migration fixtures also replay genuine pre-v7 databases. Their
    // cash CHECK cannot contain contributions; current schemas require checkpoints.
    const schemaVersion=this.#db.pragma('user_version',{simple:true});
    const valuations=schemaVersion!==undefined&&Number(schemaVersion)>=7?this.#db.prepare(`SELECT v.event_id,v.tick_no,v.sequence_no,v.amount_atoms,v.before_equity_atoms FROM contribution_valuations v
      JOIN accounts a ON a.market_id=v.market_id AND a.account_id=v.account_id
      WHERE v.market_id=? AND v.account_id=? AND a.discord_user_id=? AND (? IS NULL OR v.sequence_no<=?)`)
      .all(scope.marketId,accountId,scope.discordUserId,sequenceLimit,sequenceLimit) as {event_id:string;tick_no:number;sequence_no:number;amount_atoms:string;before_equity_atoms:string}[]:[];
    const byEvent=new Map(valuations.map(row=>[row.event_id,row]));
    if(valuations.length!==contributions.length||byEvent.size!==contributions.length)throw new LedgerIntegrityError('External contribution checkpoints differ.');
    for(const row of contributions) {
      const value=byEvent.get(row.event_id);
      if(!value||value.tick_no!==row.tick_no||value.sequence_no!==row.sequence_no||value.amount_atoms!==row.account_delta_atoms||moneyFromAtoms(value.before_equity_atoms)<0n)throw new LedgerIntegrityError('External contribution checkpoint differs from its journal.');
    }
    return replayJournal({
      accountId, marketId: scope.marketId, cashRows, positionRows, accountCreatedAt: account.created_at,
      maximumMetadata: { tickNo: market.tick_no, marketVersion: market.market_version, sequenceNo: sequenceLimit ?? market.sequence_no },
    });
  }

  #accountRecord(row: z.output<typeof accountRowSchema>, replayed: ReplayedAccount): AccountRecord {
    return Object.freeze({
      accountId: row.account_id, marketId: row.market_id, discordUserId: row.discord_user_id,
      status: row.status, accountVersion: row.account_version, createdAt: row.created_at,
      cashAtoms: replayed.cashAtoms.toString(),
    });
  }

  #snapshot<T>(read: () => T): T {
    return this.#db.inTransaction ? read() : this.#db.transaction(read).deferred();
  }
}
