import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import Database from 'better-sqlite3';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { z } from 'zod';
import { isSupportedSqliteVersion } from '../storage/database.js';
import { migrations, migrationChecksum, verifyDatabaseSchema } from '../storage/migrations.js';
import { FoundationRepository } from '../storage/repository.js';
import { LedgerIntegrityError } from '../storage/replay.js';
import { EconomyRepository, canonicalEconomyJson, economySnapshotHash, type EconomySnapshot } from '../economy/repository.js';
import { validateEconomyState } from '../economy/engine.js';
import { validatePublicEconomy } from '../economy/public.js';
import { pricingStateSchema } from '../market/pricing.js';
import { RightsRepository } from '../rights/repository.js';
import { ScheduledRepository } from '../broker/scheduled.js';
import { ReportingBenchmarks } from '../reporting/benchmarks.js';
import { ReportingRepository } from '../reporting/repository.js';
import { parsePrice } from '../domain/numeric.js';

// Only fixed, application-owned SQL is used for whole-database fingerprints.
const fingerprintQueries = Object.freeze({
  schema_migrations: 'SELECT * FROM schema_migrations ORDER BY rowid',
  markets: 'SELECT * FROM markets ORDER BY rowid', issuers: 'SELECT * FROM issuers ORDER BY rowid',
  listings: 'SELECT * FROM listings ORDER BY rowid', accounts: 'SELECT * FROM accounts ORDER BY rowid',
  cash_journal: 'SELECT * FROM cash_journal ORDER BY rowid', position_journal: 'SELECT * FROM position_journal ORDER BY rowid',
  processed_commands: 'SELECT * FROM processed_commands ORDER BY rowid',
  account_subjects: 'SELECT * FROM account_subjects ORDER BY rowid', broker_metadata: 'SELECT * FROM broker_metadata ORDER BY rowid',
  market_settings: 'SELECT * FROM market_settings ORDER BY rowid', policy_acceptances: 'SELECT * FROM policy_acceptances ORDER BY rowid',
  order_intents: 'SELECT * FROM order_intents ORDER BY rowid', orders: 'SELECT * FROM orders ORDER BY rowid',
  fills: 'SELECT * FROM fills ORDER BY rowid', trade_commands: 'SELECT * FROM trade_commands ORDER BY rowid',
  trial_ticks: 'SELECT * FROM trial_ticks ORDER BY rowid', economy_markets: 'SELECT * FROM economy_markets ORDER BY rowid',
  economy_snapshots: 'SELECT * FROM economy_snapshots ORDER BY rowid', corporate_journal: 'SELECT * FROM corporate_journal ORDER BY rowid',
  economy_publications: 'SELECT * FROM economy_publications ORDER BY rowid', economy_prices: 'SELECT * FROM economy_prices ORDER BY rowid',
  economy_rate_intervals: 'SELECT * FROM economy_rate_intervals ORDER BY rowid', account_interest: 'SELECT * FROM account_interest ORDER BY rowid',
  interest_payouts: 'SELECT * FROM interest_payouts ORDER BY rowid', corporate_actions: 'SELECT * FROM corporate_actions ORDER BY rowid',
  rights_journal: 'SELECT * FROM rights_journal ORDER BY rowid', corporate_order_cancellations: 'SELECT * FROM corporate_order_cancellations ORDER BY rowid',
  conditional_intents: 'SELECT * FROM conditional_intents ORDER BY rowid', scheduled_orders: 'SELECT * FROM scheduled_orders ORDER BY rowid',
  reservation_journal: 'SELECT * FROM reservation_journal ORDER BY rowid', benchmark_series: 'SELECT * FROM benchmark_series ORDER BY rowid',
  benchmark_snapshots: 'SELECT * FROM benchmark_snapshots ORDER BY rowid', performance_samples: 'SELECT * FROM performance_samples ORDER BY rowid',
  export_access: 'SELECT * FROM export_access ORDER BY rowid', notification_preferences: 'SELECT * FROM notification_preferences ORDER BY rowid',
  watched_listings: 'SELECT * FROM watched_listings ORDER BY rowid', notification_seen: 'SELECT * FROM notification_seen ORDER BY rowid',
  price_alerts: 'SELECT * FROM price_alerts ORDER BY rowid', notification_inbox: 'SELECT * FROM notification_inbox ORDER BY rowid',
  notification_outbox: 'SELECT * FROM notification_outbox ORDER BY rowid',
});
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const recoveryFingerprintSchema = z.strictObject({
  schemaVersion: z.number().int().positive(), sqliteVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  stateHash: digest, tableHashes: z.record(z.string().regex(/^[a-z_]+$/), digest),
  rowCounts: z.record(z.string().regex(/^[a-z_]+$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)),
  markets: z.number().int().nonnegative(), accounts: z.number().int().nonnegative(), economicSnapshots: z.number().int().nonnegative(),
  benchmarkSeries: z.number().int().nonnegative(), benchmarkSnapshots: z.number().int().nonnegative(), performanceSamples: z.number().int().nonnegative(),
});
export type RecoveryFingerprint = z.infer<typeof recoveryFingerprintSchema>;
export interface RecoveryKeys { readonly identityKey: Buffer; readonly economySeed?: Buffer }

/** Opens a completed snapshot without migration, adoption, recovery, or financial writes. */
export function openReadonlyDatabase(path: string): Database.Database {
  const db = new Database(path, { readonly: true, fileMustExist: true, timeout: 2_000 });
  try { db.pragma('query_only=ON'); db.pragma('foreign_keys=ON'); return db; }
  catch (error) { db.close(); throw error; }
}

/** Public result contains aggregate counters and opaque hashes only. */
export function verifyRecoveryDatabase(db: Database.Database, keys: RecoveryKeys): RecoveryFingerprint {
  if (!db.readonly || db.pragma('query_only', { simple: true }) !== 1) throw new LedgerIntegrityError('Recovery verification requires a read-only snapshot.');
  if (keys.identityKey.length < 32 || keys.identityKey.length > 512) throw new LedgerIntegrityError('Recovery identity key is invalid.');
  return db.transaction(() => {
    const sqliteVersion = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
    if (!isSupportedSqliteVersion(sqliteVersion)) throw new LedgerIntegrityError('Unsupported recovery SQLite version.');
    const integrity = db.pragma('integrity_check') as { integrity_check: string }[];
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new LedgerIntegrityError('Recovery database integrity failed.');
    const applied = db.prepare('SELECT version,name,checksum FROM schema_migrations ORDER BY version').all() as { version: number; name: string; checksum: string }[];
    const schemaVersion = db.pragma('user_version', { simple: true }) as number;
    if (applied.length !== migrations.length || schemaVersion !== migrations.at(-1)?.version || applied.some((row, index) => {
      const expected = migrations[index]; return !expected || row.version !== expected.version || row.name !== expected.name || row.checksum !== migrationChecksum(expected);
    })) throw new LedgerIntegrityError('Recovery migration history differs.');
    verifyDatabaseSchema(db);
    const binding = db.prepare('SELECT identity_key_check FROM broker_metadata WHERE singleton=1').get() as { identity_key_check: string } | undefined;
    const check = createHmac('sha256', keys.identityKey).update('PaperMarket identity key binding v1').digest();
    if (!binding || !/^[a-f0-9]{64}$/.test(binding.identity_key_check) || !timingSafeEqual(Buffer.from(binding.identity_key_check, 'hex'), check)) throw new LedgerIntegrityError('Recovery identity key binding differs.');
    const markets = db.prepare('SELECT market_id FROM markets ORDER BY market_id').all() as { market_id: string }[];
    const owners = db.prepare('SELECT a.*,s.subject_hash,s.closed_at FROM accounts a LEFT JOIN account_subjects s ON s.market_id=a.market_id AND s.account_id=a.account_id ORDER BY a.market_id,a.account_id').all() as { market_id: string; account_id: string; discord_user_id: string; status: string; subject_hash: string | null; closed_at: string | null }[];
    const economics = db.prepare('SELECT market_id,epoch_tick,current_tick FROM economy_markets ORDER BY market_id').all() as { market_id: string; epoch_tick: number; current_tick: number }[];
    if (economics.length && !keys.economySeed) throw new LedgerIntegrityError('Recovery economic seed is required.');
    const economy = keys.economySeed ? new EconomyRepository(db, keys.economySeed) : undefined;
    const foundation = new FoundationRepository(db), rights = new RightsRepository(db), scheduled = new ScheduledRepository(db);
    for (const owner of owners) {
      if (!owner.subject_hash || (owner.status === 'ACTIVE' ? owner.closed_at !== null : owner.closed_at === null)) throw new LedgerIntegrityError('Recovery owner state differs.');
      if (owner.status === 'ACTIVE') {
        const guild = (db.prepare('SELECT guild_id FROM markets WHERE market_id=?').get(owner.market_id) as { guild_id: string }).guild_id;
        const subject = createHmac('sha256', keys.identityKey).update(JSON.stringify(['PaperMarket subject v1', guild, owner.discord_user_id])).digest('hex');
        if (subject !== owner.subject_hash) throw new LedgerIntegrityError('Recovery active subject differs.');
      }
      const replayed = foundation.replayAccount({ marketId: owner.market_id, discordUserId: owner.discord_user_id });
      rights.replay(owner.market_id, owner.account_id);
      const reserved = scheduled.reservations(owner.market_id, owner.account_id);
      if (reserved.cash > replayed.cashAtoms) throw new LedgerIntegrityError('Recovery reserved cash exceeds balance.');
      for (const [listing, quantity] of reserved.shares) {
        const holding = replayed.positions.get(listing)?.quantity;
        if (quantity.numerator > 0n && (!holding || quantity.numerator * holding.denominator > holding.numerator * quantity.denominator)) throw new LedgerIntegrityError('Recovery reserved shares exceed holdings.');
      }
      if (economy?.has(owner.market_id)) {
        const market = db.prepare('SELECT tick_no FROM markets WHERE market_id=?').get(owner.market_id) as { tick_no: number };
        economy.validatePrincipal(owner.market_id, owner.account_id, market.tick_no, owner.status === 'ACTIVE' ? replayed.cashAtoms.toString() : '0');
        const elapsed = db.prepare('SELECT elapsed_ms FROM account_interest WHERE market_id=? AND account_id=?').get(owner.market_id, owner.account_id) as { elapsed_ms: number };
        economy.interestView(owner.market_id, owner.account_id, market.tick_no, elapsed.elapsed_ms);
      }
    }
    let economicSnapshots = 0;
    for (const market of economics) {
      const frames = db.prepare('SELECT * FROM economy_snapshots WHERE market_id=? ORDER BY tick_no').all(market.market_id) as { tick_no: number; engine_tick: number; market_version: number; engine_version: string; snapshot_json: string; snapshot_hash: string }[];
      if (frames.length !== market.current_tick - market.epoch_tick + 1) throw new LedgerIntegrityError('Recovery economic history has a gap.');
      for (const [index, row] of frames.entries()) {
        const raw = JSON.parse(row.snapshot_json) as EconomySnapshot;
        if (row.tick_no !== market.epoch_tick + index || row.engine_tick !== index || row.engine_version !== raw.engineVersion || !['0.2.0','0.3.0','0.4.0'].includes(row.engine_version) || canonicalEconomyJson(raw) !== row.snapshot_json || economySnapshotHash(raw) !== row.snapshot_hash) throw new LedgerIntegrityError('Recovery economic snapshot hash differs.');
        const snapshot: EconomySnapshot = { ...raw, economy: validateEconomyState(raw.economy), public: validatePublicEconomy(raw.public), pricing: pricingStateSchema.parse(raw.pricing) };
        if (snapshot.economy.marketId !== market.market_id || snapshot.public.marketId !== market.market_id || snapshot.economy.tickNo !== index || snapshot.public.tickNo !== index || snapshot.pricing.tickNo !== index || snapshot.public.companies.length !== 8 || snapshot.pricing.companies.length !== 8) throw new LedgerIntegrityError('Recovery economic identity differs.');
        for (const company of snapshot.public.companies) {
          const privateCompany = snapshot.economy.companies.find(value => value.issuerId === company.issuerId && value.listingId === company.listingId);
          if (!privateCompany || privateCompany.slotId !== company.slotId || privateCompany.category !== company.category || privateCompany.symbol !== company.baseSymbol || privateCompany.generation !== company.generation || !snapshot.pricing.companies.some(value => value.listingId === company.listingId && value.issuerId === company.issuerId)) throw new LedgerIntegrityError('Recovery company generations differ.');
        }
        const rates = db.prepare('SELECT daily_cash_rate,rate_json FROM economy_rate_intervals WHERE market_id=? AND tick_no=?').get(market.market_id, row.tick_no) as { daily_cash_rate: string; rate_json: string } | undefined;
        const expected = economy!.rates(snapshot);
        if (!rates || rates.daily_cash_rate !== expected.cashDailyRate || rates.rate_json !== canonicalEconomyJson(expected)) throw new LedgerIntegrityError('Recovery historical rates differ.');
        const prices = db.prepare('SELECT listing_id,price FROM economy_prices WHERE market_id=? AND tick_no=? ORDER BY listing_id').all(market.market_id, row.tick_no) as { listing_id: string; price: string }[];
        if (index !== 0 && prices.length !== 8 || prices.some(price => snapshot.pricing.companies.find(company => company.listingId === price.listing_id)?.price !== parsePrice(price.price))) throw new LedgerIntegrityError('Recovery historical prices differ.');
      }
      economicSnapshots += frames.length;
    }
    const benchmarks = new ReportingBenchmarks(db), baselineAudit = benchmarks.auditAll();
    const performance = new ReportingRepository(db, benchmarks).auditAll();
    const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[];
    const tableHashes: Record<string, string> = {}, rowCounts: Record<string, number> = {};
    for (const table of tables) {
      const query = fingerprintQueries[table.name as keyof typeof fingerprintQueries];
      if (!query) throw new LedgerIntegrityError('Recovery fingerprint table is not allowlisted.');
      const hash = createHash('sha256'); let count = 0;
      for (const row of db.prepare(query).iterate()) { hash.update(canonicalEconomyJson(row)); hash.update('\n'); count++; }
      tableHashes[table.name] = hash.digest('hex'); rowCounts[table.name] = count;
    }
    const stateHash = economySnapshotHash({ schemaVersion, tableHashes, rowCounts });
    return recoveryFingerprintSchema.parse({ schemaVersion, sqliteVersion, stateHash, tableHashes, rowCounts,
      markets: markets.length, accounts: owners.length, economicSnapshots, benchmarkSeries: baselineAudit.series,
      benchmarkSnapshots: baselineAudit.snapshots, performanceSamples: performance.samples });
  })();
}

/** Standalone diagnostic uses only synthetic data in an isolated task-local directory. */
async function syntheticRecoveryDiagnostic(): Promise<void> {
  const [{ randomBytes }, { mkdtemp, rm }, { join, dirname, basename }, { openDatabase }, { BrokerRepository }, { FakeClock }, { BackupManager }] = await Promise.all([
    import('node:crypto'), import('node:fs/promises'), import('node:path'), import('../storage/database.js'),
    import('../broker/repository.js'), import('../domain/clock.js'), import('../ops/backup.js'),
  ]);
  const parent = resolve(process.cwd()), directory = await mkdtemp(join(parent,'.papermarket-recovery-diagnostic-'));
  const path = join(directory,'synthetic.sqlite'), identityKey = randomBytes(32), economySeed = randomBytes(32), backupKey = randomBytes(32);
  const source = openDatabase(path), clock = new FakeClock('2026-10-09T00:00:00.000Z');
  const manager = new BackupManager({ databasePath: path, backupDirectory: join(directory,'backups'), identityKey, economySeed, backupKey, now:()=>clock.now() });
  try {
    const broker = new BrokerRepository(source,clock,{identityKey,economySeed}); let interaction = 333333333333333333n;
    const context = () => ({ guildId:'111111111111111111', discordUserId:'222222222222222222', interactionId:(++interaction).toString(), receivedAt:clock.now(), guildPermissions:'32' });
    if (broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind !== 'SETUP' || broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true}).kind !== 'ACCOUNT') throw new LedgerIntegrityError();
    const quote = broker.dispatch({type:'quote',context:context(),symbol:'HGI',side:'BUY',quantity:'1'});
    if (quote.kind !== 'QUOTE' || broker.dispatch({type:'confirm',context:context(),token:quote.quote.token}).kind !== 'FILLED') throw new LedgerIntegrityError();
    clock.advanceBy(300_000); if (broker.dispatch({type:'tick',now:clock.now()}).kind !== 'TICKED') throw new LedgerIntegrityError();
    const manifest = await manager.create(), target = join(directory,'restored.sqlite'); await manager.restoreToNewFile(manifest.backupId,target);
    const restored = openReadonlyDatabase(target); let result: RecoveryFingerprint;
    try { result = verifyRecoveryDatabase(restored,{identityKey,economySeed}); } finally { restored.close(); }
    if (canonicalEconomyJson(result) !== canonicalEconomyJson(manifest.fingerprint)) throw new LedgerIntegrityError();
    process.stdout.write(`${JSON.stringify({code:'RECOVERY_CHECK_PASSED',schemaVersion:result.schemaVersion,markets:result.markets,accounts:result.accounts,economicSnapshots:result.economicSnapshots,benchmarkSnapshots:result.benchmarkSnapshots,performanceSamples:result.performanceSamples,stateHash:result.stateHash})}\n`);
  } finally {
    await manager.stop(); source.close(); identityKey.fill(0); economySeed.fill(0); backupKey.fill(0);
    if (dirname(resolve(directory)) !== parent || !basename(directory).startsWith('.papermarket-recovery-diagnostic-')) throw new LedgerIntegrityError('Unsafe diagnostic cleanup.');
    await rm(directory,{recursive:true,force:true});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syntheticRecoveryDiagnostic().catch(() => { process.stderr.write('RECOVERY_CHECK_FAILED\n'); process.exitCode=1; });
}
