import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { FakeClock } from '../domain/clock.js';
import { moneyFromAtoms, moneyToString } from '../domain/numeric.js';
import { STANDARD_RULESET } from '../domain/ruleset.js';
import { INITIAL_COMPANIES, createInitialListings, validateInitialCompanies } from '../fixtures/index.js';
import { FoundationRepository, openDatabase } from '../storage/index.js';

const temporaryRoot = resolve(tmpdir());
const directory = mkdtempSync(join(temporaryRoot, 'papermarket-foundation-'));
const path = join(directory, 'foundation.sqlite');
let database: ReturnType<typeof openDatabase> | undefined;

try {
  validateInitialCompanies(INITIAL_COMPANIES);
  const clock = new FakeClock('2026-10-03T00:00:00.000Z');
  database = openDatabase(path);
  const sqlite = database.prepare('SELECT sqlite_version() AS version').get() as { version: string };
  const repository = new FoundationRepository(database, clock);
  const market = repository.createMarket({
    marketId: 'foundation-check', guildId: '100000000000000001', listings: createInitialListings(),
  });
  const scope = { marketId: market.marketId, discordUserId: '100000000000000002' };
  const request = { ...scope, interactionId: '100000000000000003' };
  const opened = repository.openAccount(request);
  assert.equal(BigInt(opened.cashAtoms), STANDARD_RULESET.initialCash);
  assert.deepEqual(repository.openAccount(request), opened);
  clock.advanceBy(60_000);
  assert.deepEqual(repository.openAccount({ ...scope, interactionId: '100000000000000004' }), opened);
  const grantCount = database.prepare("SELECT count(*) AS count FROM cash_journal WHERE entry_type = 'INITIAL_GRANT'")
    .get() as { count: number };
  assert.equal(grantCount.count, 1);
  const current = database.prepare('SELECT tick_no, market_version FROM markets WHERE market_id = ?')
    .get(market.marketId) as { tick_no: number; market_version: number };
  assert.equal(current.tick_no, market.tickNo);
  assert.equal(current.market_version, market.marketVersion);
  database.close();
  database = openDatabase(path);
  const restored = new FoundationRepository(database, clock);
  assert.deepEqual(restored.getAccount(scope), opened);
  assert.equal(restored.replayAccount(scope).cashAtoms, STANDARD_RULESET.initialCash);
  console.log(JSON.stringify({
    milestone: 0, result: 'PASS', companies: INITIAL_COMPANIES.length,
    sqliteVersion: sqlite.version, initialCash: moneyToString(moneyFromAtoms(opened.cashAtoms)),
    grants: grantCount.count, reopenAndReplay: 'PASS',
  }, null, 2));
} finally {
  if (database?.open) database.close();
  // Verify the exact absolute cleanup target belongs to this invocation's temp root.
  if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('papermarket-foundation-')) {
    throw new Error('Invalid temporary cleanup target');
  }
  rmSync(directory, { recursive: true, force: true });
}
