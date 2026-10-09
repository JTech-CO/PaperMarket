import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  AccountNotFoundError, FoundationRepository, IdempotencyConflictError,
  INITIAL_ACCOUNT_GRANT_ATOMS, LedgerIntegrityError, MigrationIntegrityError,
  isSupportedSqliteVersion, migrateDatabase, openDatabase, replayJournal,
  type CashJournalRow, type InitialListing, type PositionJournalRow,
} from '../src/storage/index.js';
import { FakeClock } from '../src/domain/clock.js';
import { migrations } from '../src/storage/migrations.js';

const guildId = '111111111111111111';
const discordUserId = '222222222222222222';
const otherUserId = '222222222222222223';
const interactionId = '333333333333333333';
const now = '2026-10-03T11:00:00.000Z';
const marketId = 'synthetic-market';
const scope = { marketId, discordUserId };
const listings: readonly InitialListing[] = [
  { issuerId: 'issuer-hgi', listingId: 'listing-hgi', slotId: 'O1', category: 'ORDINARY', symbol: 'HGI', price: '1000' },
  { issuerId: 'issuer-dnl', listingId: 'listing-dnl', slotId: 'O2', category: 'ORDINARY', symbol: 'DNL', price: '1000' },
  { issuerId: 'issuer-tlr', listingId: 'listing-tlr', slotId: 'O3', category: 'ORDINARY', symbol: 'TLR', price: '1000' },
  { issuerId: 'issuer-nxc', listingId: 'listing-nxc', slotId: 'G1', category: 'GROWTH', symbol: 'NXC', price: '1000' },
  { issuerId: 'issuer-vtr', listingId: 'listing-vtr', slotId: 'G2', category: 'GROWTH', symbol: 'VTR', price: '1000' },
  { issuerId: 'issuer-aur', listingId: 'listing-aur', slotId: 'T1', category: 'THEMATIC', symbol: 'AUR', price: '1000' },
  { issuerId: 'issuer-lmb', listingId: 'listing-lmb', slotId: 'T2', category: 'THEMATIC', symbol: 'LMB', price: '1000' },
  { issuerId: 'issuer-rvi', listingId: 'listing-rvi', slotId: 'D1', category: 'DIVIDEND', symbol: 'RVI', price: '1000' },
];

function fixture(context: TestContext) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'papermarket-storage-'));
  const path = join(directory, 'foundation.sqlite');
  let db = openDatabase(path);
  const clock = new FakeClock(now);
  let repository = new FoundationRepository(db, clock);
  context.after(() => {
    if (db.open) db.close();
    // Verify the exact, resolved test target before any recursive cleanup.
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('papermarket-storage-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return {
    get db() { return db; },
    get repository() { return repository; },
    clock,
    path,
    createMarket() { return repository.createMarket({ marketId, guildId, listings }); },
    reopen() {
      db.close();
      db = openDatabase(path);
      repository = new FoundationRepository(db, clock);
    },
  };
}

function count(db: Database.Database, query: string): number {
  return (db.prepare(query).get() as { count: number }).count;
}

test('SQLite version, WAL, foreign keys, FULL sync and migration rerun are verified', (context) => {
  const { db } = fixture(context);
  assert.ok(isSupportedSqliteVersion('3.51.3'));
  assert.ok(isSupportedSqliteVersion('3.53.4'));
  assert.ok(!isSupportedSqliteVersion('3.51.2'));
  assert.ok(!isSupportedSqliteVersion('3.50.9'));
  assert.throws(() => isSupportedSqliteVersion('3.53'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  assert.equal(db.pragma('busy_timeout', { simple: true }), 2_000);
  assert.equal(db.pragma('user_version', { simple: true }), migrations.at(-1)?.version);
  migrateDatabase(db);
  assert.equal(count(db, 'SELECT COUNT(*) AS count FROM schema_migrations'), migrations.length);
  assert.throws(() => db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('0'.repeat(64)), /append-only/);
});

test('eight slots, category allocation and 1000-point initial prices are atomic', (context) => {
  const f = fixture(context);
  const market = f.createMarket();
  assert.equal(market.createdAt, now);
  assert.equal(market.nextBoundaryAt, '2026-10-03T11:05:00.000Z');
  assert.equal(market.marketVersion, 0);
  assert.equal(market.tickNo, 0);
  assert.deepEqual(f.db.prepare('SELECT category,COUNT(*) AS count FROM listings GROUP BY category ORDER BY category').all(), [
    { category: 'DIVIDEND', count: 1 }, { category: 'GROWTH', count: 2 },
    { category: 'ORDINARY', count: 3 }, { category: 'THEMATIC', count: 2 },
  ]);
  assert.equal(count(f.db, "SELECT COUNT(*) AS count FROM listings WHERE price = '1000' AND status = 'ACTIVE'"), 8);
  assert.throws(() => f.repository.createMarket({ marketId: 'duplicate-guild', guildId, listings }), /UNIQUE/);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM markets'), 1);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM issuers'), 8);
});

test('server input validation rejects malformed, oversized, duplicate and mismatched initialization', (context) => {
  const f = fixture(context);
  assert.throws(() => f.repository.createMarket({ marketId, guildId, listings: listings.slice(0, 7) }));
  assert.throws(() => f.repository.createMarket({ marketId, guildId, listings: [...listings.slice(0, 7), listings[0]!] }));
  assert.throws(() => f.repository.createMarket({ marketId, guildId, listings: listings.map((listing, index) => index === 0 ? { ...listing, category: 'GROWTH' } : listing) }));
  assert.throws(() => f.repository.createMarket({ marketId, guildId, listings: listings.map((listing) => ({ ...listing, price: '1e1000' })) }));
  assert.throws(() => f.repository.createMarket({ marketId: "';DROP TABLE markets;--", guildId, listings }));
  assert.throws(() => f.repository.createMarket({ marketId, guildId: '18446744073709551616', listings }));
  assert.throws(() => f.repository.createMarket({ marketId: 'x'.repeat(65), guildId, listings }));
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM markets'), 0);
});

test('initial 10000-point grant happens once per market and owner, including new interaction IDs', (context) => {
  const f = fixture(context);
  f.createMarket();
  const first = f.repository.openAccount({ ...scope, interactionId });
  assert.equal(first.cashAtoms, '10000000000000000');
  assert.ok(BigInt(first.cashAtoms) > BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual(f.repository.openAccount({ ...scope, interactionId }), first);
  f.clock.advanceBy(60_000);
  assert.deepEqual(f.repository.openAccount({ ...scope, interactionId: '333333333333333334' }), first);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM accounts'), 1);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 1);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM processed_commands'), 2);
  assert.equal(f.repository.replayAccount(scope).cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS);
  assert.equal(f.repository.replayAccount(scope).positions.size, 0);
});

test('restart replays the exact grant and durable duplicate result without a second payment', (context) => {
  const f = fixture(context);
  f.createMarket();
  const first = f.repository.openAccount({ ...scope, interactionId });
  f.reopen();
  assert.deepEqual(f.repository.openAccount({ ...scope, interactionId }), first);
  assert.deepEqual(f.repository.getAccount(scope), first);
  assert.equal(f.repository.replayAccount(scope).cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 1);
});

test('account, initial ledger, market sequence and processed command roll back as one unit', (context) => {
  const f = fixture(context);
  f.createMarket();
  f.db.exec("CREATE TRIGGER synthetic_failure BEFORE INSERT ON cash_journal BEGIN SELECT RAISE(ABORT, 'synthetic interruption'); END;");
  assert.throws(() => f.repository.openAccount({ ...scope, interactionId }), /synthetic interruption/);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM accounts'), 0);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 0);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM processed_commands'), 0);
  assert.equal((f.db.prepare('SELECT sequence_no FROM markets WHERE market_id = ?').get(marketId) as { sequence_no: number }).sequence_no, 0);
  f.db.exec('DROP TRIGGER synthetic_failure');
  assert.equal(f.repository.openAccount({ ...scope, interactionId }).cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS.toString());
});

test('reused interactions deny mismatched payload or owner and account queries remain scoped', (context) => {
  const f = fixture(context);
  f.createMarket();
  const first = f.repository.openAccount({ ...scope, interactionId });
  assert.throws(() => f.repository.openAccount({ marketId, discordUserId: otherUserId, interactionId }), IdempotencyConflictError);
  assert.throws(() => f.repository.openAccount({ marketId: 'other-market', discordUserId, interactionId }), IdempotencyConflictError);
  assert.equal(f.repository.getAccount({ marketId, discordUserId: otherUserId }), null);
  assert.throws(() => f.repository.replayAccount({ marketId, discordUserId: otherUserId }), AccountNotFoundError);
  assert.equal(f.repository.getAccount({ marketId: 'other-market', discordUserId }), null);
  assert.equal(f.repository.getAccount(scope)?.accountId, first.accountId);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM accounts'), 1);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM processed_commands'), 1);
});

test('immutable journals, ownership and persistent account keys cannot be edited or deleted', (context) => {
  const f = fixture(context);
  f.createMarket();
  const account = f.repository.openAccount({ ...scope, interactionId });
  assert.throws(() => f.db.prepare('UPDATE cash_journal SET account_delta_atoms = ? WHERE account_id = ?').run('1', account.accountId), /append-only/);
  assert.throws(() => f.db.prepare('DELETE FROM cash_journal WHERE account_id = ?').run(account.accountId), /append-only/);
  assert.throws(() => f.db.prepare('DELETE FROM processed_commands WHERE interaction_id = ?').run(interactionId), /append-only/);
  assert.throws(() => f.db.prepare('UPDATE accounts SET discord_user_id = ? WHERE account_id = ?').run(otherUserId, account.accountId), /immutable/);
  assert.throws(() => f.db.prepare('DELETE FROM accounts WHERE account_id = ?').run(account.accountId), /cannot be reset/);
  assert.equal(f.repository.replayAccount(scope).cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS);
});

test('foreign key and text-only balancing constraints reject orphaned and unbalanced journal rows', (context) => {
  const f = fixture(context);
  f.createMarket();
  f.repository.openAccount({ ...scope, interactionId });
  const raw = f.db.prepare('SELECT * FROM cash_journal').get() as CashJournalRow;
  const insert = f.db.prepare(`INSERT INTO cash_journal(
    journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,
    currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id
  ) VALUES(?,?,?,?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',0,0,2,'0.0.0','1.0.0',?,NULL)`);
  assert.throws(() => insert.run('unbalanced-journal', 'unbalanced-event', 'synthetic-cause', marketId, raw.account_id, '1', '-2', now), /CHECK/);
  assert.throws(() => insert.run('orphan-journal', 'orphan-event', 'synthetic-cause', marketId, 'absent-account', '1', '-1', now), /FOREIGN KEY/);
  assert.throws(() => insert.run('padded-journal', 'padded-event', 'synthetic-cause', marketId, raw.account_id, '01', '-01', now), /CHECK/);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 1);
});

test('history checksum and removed append-only triggers are detected on database reopen', (context) => {
  const f = fixture(context);
  f.db.exec('DROP TRIGGER schema_migrations_no_update');
  f.db.prepare('UPDATE schema_migrations SET checksum = ? WHERE version = 1').run('0'.repeat(64));
  f.db.close();
  assert.throws(() => openDatabase(f.path), MigrationIntegrityError);

  const other = fixture(context);
  other.db.exec('DROP TRIGGER cash_journal_no_update');
  other.db.close();
  assert.throws(() => openDatabase(other.path), MigrationIntegrityError);
});

test('failed schema migration rolls back all tables and migration metadata', (context) => {
  const f = fixture(context);
  const broken = new Database(':memory:');
  context.after(() => broken.close());
  broken.exec('CREATE TABLE accounts (placeholder TEXT) STRICT');
  assert.throws(() => migrateDatabase(broken), /already exists/);
  assert.equal(count(broken, "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name IN ('markets','schema_migrations','issuers','listings')"), 0);
  assert.equal(broken.pragma('user_version', { simple: true }), 0);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM schema_migrations'), migrations.length);
});

test('pure journal replay preserves tiny rights exactly and detects altered balances and owner scopes', (context) => {
  const f = fixture(context);
  f.createMarket();
  const account = f.repository.openAccount({ ...scope, interactionId });
  const cash = f.db.prepare('SELECT * FROM cash_journal').get() as CashJournalRow;
  const metadata = {
    journal_id: 'position-journal', event_id: 'position-event', cause_id: 'synthetic-cause',
    market_id: marketId, account_id: account.accountId,
    tick_no: 0, market_version: 0, sequence_no: 2,
    engine_version: '0.0.0' as const, ruleset_version: '1.0.0' as const, created_at: now, related_order_id: null,
  };
  const position: PositionJournalRow = {
    ...metadata, listing_id: 'listing-hgi', quantity_delta: '1e-20', system_quantity_delta: '-1e-20', cost_delta_atoms: '1',
  };
  const replay = replayJournal({ accountId: account.accountId, marketId, cashRows: [cash], positionRows: [position] });
  assert.deepEqual(replay.positions.get('listing-hgi'), { quantity: { numerator: 1n, denominator: 10n ** 20n }, costAtoms: 1n });
  assert.equal(replay.cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [{ ...cash, system_delta_atoms: '-1' }], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [{ ...cash, account_delta_atoms: '01' }], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: 'another-account', marketId, cashRows: [cash], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [cash, cash], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [cash], positionRows: [{ ...position, system_quantity_delta: '-2e-20' }] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [cash], positionRows: [{ ...position, quantity_delta: '1.0', system_quantity_delta: '-1.0' }] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [{ ...cash, engine_version: 'future-version' }], positionRows: [] }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [cash], positionRows: [], accountCreatedAt: '2026-10-03T11:01:00.000Z' }), LedgerIntegrityError);
  assert.throws(() => replayJournal({ accountId: account.accountId, marketId, cashRows: [cash], positionRows: [position], maximumMetadata: { tickNo: 0, marketVersion: 0, sequenceNo: 1 } }), LedgerIntegrityError);
});

test('cached command results still verify the current journal before returning', (context) => {
  const f = fixture(context);
  f.createMarket();
  f.repository.openAccount({ ...scope, interactionId });
  f.db.exec('DROP TRIGGER cash_journal_no_update');
  f.db.prepare('UPDATE cash_journal SET engine_version = ?').run('unsupported-version');
  assert.throws(() => f.repository.openAccount({ ...scope, interactionId }), LedgerIntegrityError);
  assert.throws(() => f.repository.getAccount(scope), LedgerIntegrityError);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM processed_commands'), 1);
});

test('cached cash corruption is rejected against the original command journal', (context) => {
  const f = fixture(context);
  f.createMarket();
  const opened = f.repository.openAccount({ ...scope, interactionId });
  f.db.exec('DROP TRIGGER processed_commands_no_update');
  f.db.prepare('UPDATE processed_commands SET result_json = ? WHERE interaction_id = ?')
    .run(JSON.stringify({ ...opened, cashAtoms: '1' }), interactionId);
  assert.throws(() => f.repository.openAccount({ ...scope, interactionId }), LedgerIntegrityError);
  assert.equal(f.repository.getAccount(scope)?.cashAtoms, INITIAL_ACCOUNT_GRANT_ATOMS.toString());
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 1);
});

test('a valid cached response preserves its historical cash after subsequent ledger activity', (context) => {
  const f = fixture(context);
  f.createMarket();
  const opened = f.repository.openAccount({ ...scope, interactionId });
  // A trusted synthetic future coordinator posting, not a public mutation API.
  f.db.transaction(() => {
    f.db.prepare('UPDATE markets SET sequence_no = 2 WHERE market_id = ?').run(marketId);
    f.db.prepare('UPDATE accounts SET account_version = 2 WHERE account_id = ?').run(opened.accountId);
    f.db.prepare(`INSERT INTO cash_journal (
      journal_id,event_id,cause_id,market_id,account_id,entry_type,account_delta_atoms,system_delta_atoms,system_account,
      currency,tick_no,market_version,sequence_no,engine_version,ruleset_version,created_at,related_order_id
    ) VALUES(?,?,?,?,?,'TRADE',?,?,'BROKER','PAPERMARKET_POINT',0,0,2,'0.0.0','1.0.0',?,NULL)`)
      .run('synthetic-later-journal', 'synthetic-later-event', 'synthetic-later-cause', marketId, opened.accountId,
        '-1000000000000000', '1000000000000000', now);
  })();
  assert.equal(f.repository.getAccount(scope)?.cashAtoms, '9000000000000000');
  assert.deepEqual(f.repository.openAccount({ ...scope, interactionId }), opened);
  assert.equal(count(f.db, 'SELECT COUNT(*) AS count FROM cash_journal'), 2);
});
