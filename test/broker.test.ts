import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test, { type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import type { ServiceContext, ServiceRequest, ServiceResponse, QuoteView, FillView } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/index.js';
import { FakeClock } from '../src/domain/clock.js';
import { decimalFraction, parseMoney } from '../src/domain/numeric.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { migrationChecksum, migrations } from '../src/storage/migrations.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { TERMS_VERSION, PRIVACY_VERSION } from '../src/policy/index.js';

const guildId = '111111111111111111';
const userId = '222222222222222222';
const otherUserId = '222222222222222223';
const otherGuildId = '111111111111111112';
const channelId = '444444444444444444';
const initial = '2026-10-03T11:00:00.000Z';

function fixture(t: TestContext) {
  const temporaryRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(temporaryRoot, 'papermarket-broker-'));
  const path = join(directory, 'broker.sqlite');
  const clock = new FakeClock(initial);
  const identityKey = randomBytes(32);
  let db = openDatabase(path);
  let broker = new BrokerRepository(db, clock, { identityKey });
  let interaction = 333_333_333_333_333_333n;
  function context(user = userId, guild = guildId, permissions = '32'): ServiceContext {
    return { guildId: guild, discordUserId: user, interactionId: (++interaction).toString(),
      receivedAt: clock.now(), guildPermissions: permissions };
  }
  const setup = (guild = guildId) => {
    const response = broker.dispatch({ type: 'setup', context: context(userId, guild), channelId });
    assert.equal(response.kind, 'SETUP');
    if (response.kind !== 'SETUP') throw new Error('setup failed');
    return response.market;
  };
  const open = (user = userId, guild = guildId) => {
    const response = broker.dispatch({ type: 'open', context: context(user, guild), age14Plus: true, agreeTerms: true });
    assert.equal(response.kind, 'ACCOUNT');
    if (response.kind !== 'ACCOUNT') throw new Error('open failed');
    return response.account;
  };
  const quote = (side: 'BUY'|'SELL', input: {quantity?:string;budget?:string;all?:boolean} = {quantity:'1'}, user = userId, guild = guildId): QuoteView => {
    const response = broker.dispatch({ type: 'quote', context: context(user, guild), symbol: 'hgi', side, ...input });
    assert.equal(response.kind, 'QUOTE', JSON.stringify(response));
    if (response.kind !== 'QUOTE') throw new Error('quote failed');
    return response.quote;
  };
  const confirm = (quote: QuoteView, user = userId, guild = guildId): FillView => {
    const response = broker.dispatch({ type: 'confirm', context: context(user, guild), token: quote.token });
    assert.equal(response.kind, 'FILLED', JSON.stringify(response));
    if (response.kind !== 'FILLED') throw new Error('fill failed');
    return response.fill;
  };
  t.after(() => {
    if (db.open) db.close();
    assert.equal(dirname(resolve(directory)), temporaryRoot);
    assert.ok(basename(directory).startsWith('papermarket-broker-'));
    rmSync(directory, { recursive: true, force: true });
  });
  return { get db() { return db; }, get broker() { return broker; }, clock, identityKey, path,
    context, setup, open, quote, confirm,
    reopen() { db.close(); db = openDatabase(path); broker = new BrokerRepository(db, clock, { identityKey }); },
  };
}
function error(response: ServiceResponse, code: string): void { assert.deepEqual(response, {kind:'ERROR',code}); }
function counts(f: ReturnType<typeof fixture>) {
  return { orders: (f.db.prepare('SELECT count(*) AS n FROM orders').get() as {n:number}).n,
    fills: (f.db.prepare('SELECT count(*) AS n FROM fills').get() as {n:number}).n,
    cash: (f.db.prepare('SELECT count(*) AS n FROM cash_journal').get() as {n:number}).n,
    positions: (f.db.prepare('SELECT count(*) AS n FROM position_journal').get() as {n:number}).n };
}

test('migration 2 preserves the foundation SQL checksum and upgrades file databases', (t) => {
  const f = fixture(t);
  const history = f.db.prepare('SELECT version,checksum FROM schema_migrations ORDER BY version').all() as Array<{version:number;checksum:string}>;
  assert.deepEqual(history.map((row) => row.version), migrations.map(migration=>migration.version));
  assert.equal(history[0]?.checksum, migrationChecksum(migrations[0]!));
  assert.equal(f.db.pragma('user_version',{simple:true}),migrations.at(-1)?.version);
  f.reopen(); assert.equal(f.db.pragma('user_version',{simple:true}),migrations.at(-1)?.version);
});

test('a genuine version 1 file upgrades without resetting its existing account or command history', (t) => {
  const f=fixture(t); const legacyPath=join(dirname(f.path),'legacy.sqlite');
  const legacy=new Database(legacyPath); legacy.pragma('foreign_keys = ON');
  const first=migrations[0]!; legacy.exec(first.sql);
  legacy.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY CHECK(version > 0),
      name TEXT NOT NULL,
      checksum TEXT NOT NULL CHECK(length(checksum) = 64),
      applied_at TEXT NOT NULL
    ) STRICT;`);
  legacy.prepare('INSERT INTO schema_migrations(version,name,checksum,applied_at) VALUES(?,?,?,?)').run(first.version,first.name,migrationChecksum(first),initial);
  const foundation=new FoundationRepository(legacy,f.clock);
  foundation.createMarket({marketId:'legacy-market',guildId,listings:createInitialListings()});
  const original=foundation.openAccount({marketId:'legacy-market',discordUserId:userId,interactionId:'333333333333333310'});
  legacy.close();
  const upgraded=openDatabase(legacyPath);
  try {
    const broker=new BrokerRepository(upgraded,f.clock,{identityKey:f.identityKey});
    assert.equal(upgraded.pragma('user_version',{simple:true}),migrations.at(-1)?.version);
    const restored=broker.dispatch({type:'open',context:f.context(),age14Plus:true,agreeTerms:true});
    assert.equal(restored.kind,'ACCOUNT'); if(restored.kind==='ACCOUNT') assert.equal(restored.account.accountId,original.accountId);
    assert.equal((upgraded.prepare("SELECT count(*) AS n FROM cash_journal WHERE entry_type='INITIAL_GRANT'").get() as {n:number}).n,1);
    assert.equal(new FoundationRepository(upgraded,f.clock).openAccount({marketId:'legacy-market',discordUserId:userId,interactionId:'333333333333333310'}).accountId,original.accountId);
  } finally { upgraded.close(); }
});

test('solo setup is idempotent, admin scoped and leaves 8 static trial listings', (t) => {
  const f = fixture(t);
  error(f.broker.dispatch({ type:'setup',context:f.context(userId,guildId,'0'),channelId }), 'PERMISSION_DENIED');
  const market = f.setup(); const again = f.setup();
  assert.equal(again.marketId, market.marketId);
  assert.equal(again.marketVersion,0); assert.equal(again.tickNo,0);
  assert.equal(again.priceSource,'TRIAL'); assert.equal(again.listings.length,8);
  assert.ok(again.listings.every((listing)=>listing.price==='1000'));
  const other = f.setup(otherGuildId); assert.notEqual(other.marketId,market.marketId);
});

test('board persistence requires admin and the configured market channel', (t) => {
  const f=fixture(t); f.setup();
  error(f.broker.dispatch({type:'save-board',context:f.context(userId,guildId,'0'),channelId,messageId:'555555555555555555'}),'PERMISSION_DENIED');
  error(f.broker.dispatch({type:'save-board',context:f.context(),channelId:'444444444444444445',messageId:'555555555555555555'}),'INVALID_INPUT');
  assert.deepEqual(f.broker.dispatch({type:'save-board',context:f.context(),channelId,messageId:'555555555555555555'}),{kind:'BOARD_SAVED'});
  f.reopen();
  const market=f.broker.dispatch({type:'market',context:f.context()});
  assert.equal(market.kind,'MARKET'); if(market.kind==='MARKET') assert.equal(market.market.boardMessageId,'555555555555555555');
});

test('setup and its saved board can share one authenticated Discord Interaction', (t) => {
  const f=fixture(t); const context=f.context();
  assert.equal(f.broker.dispatch({type:'setup',context,channelId}).kind,'SETUP');
  assert.deepEqual(f.broker.dispatch({type:'save-board',context,channelId,messageId:'555555555555555555'}),{kind:'BOARD_SAVED'});
  assert.deepEqual(f.broker.dispatch({type:'save-board',context,channelId,messageId:'555555555555555555'}),{kind:'BOARD_SAVED'});
});

test('moving the configured channel returns the previous fixed board for an explicit move notice', (t) => {
  const f=fixture(t); const market=f.setup();
  f.broker.dispatch({type:'save-board',context:f.context(),channelId,messageId:'555555555555555555'});
  const moved=f.broker.dispatch({type:'setup',context:f.context(),channelId:'444444444444444445'});
  assert.equal(moved.kind,'SETUP');
  if(moved.kind==='SETUP') {
    assert.equal(moved.market.marketId,market.marketId); assert.equal(moved.market.marketVersion,market.marketVersion);
    assert.equal(moved.market.channelId,'444444444444444445'); assert.equal(moved.market.boardMessageId,null);
    assert.deepEqual('previousBoard' in moved?moved.previousBoard:undefined,{channelId,messageId:'555555555555555555'});
  }
});

test('opening requires two explicit acknowledgements and grants capital once', (t) => {
  const f=fixture(t); f.setup();
  error(f.broker.dispatch({type:'open',context:f.context(),age14Plus:false,agreeTerms:true}),'ACKNOWLEDGEMENTS_REQUIRED');
  error(f.broker.dispatch({type:'open',context:f.context(),age14Plus:true,agreeTerms:false}),'ACKNOWLEDGEMENTS_REQUIRED');
  assert.deepEqual(counts(f),{orders:0,fills:0,cash:0,positions:0});
  const account=f.open(); assert.equal(account.cash,'10000');
  f.clock.advanceBy(1000); const again=f.open(); assert.equal(again.accountId,account.accountId);
  f.reopen(); assert.equal(f.open().accountId,account.accountId);
  assert.equal(counts(f).cash,1);
  const acceptance=f.db.prepare('SELECT * FROM policy_acceptances').get() as {terms_version:string;privacy_version:string;age14_plus:number;agree_terms:number};
  assert.equal(acceptance.terms_version,TERMS_VERSION); assert.equal(acceptance.privacy_version,PRIVACY_VERSION);
  assert.equal(acceptance.age14_plus,1); assert.equal(acceptance.agree_terms,1);
});

test('quote does not reserve funds, and a confirmed buy commits balanced journals and fee inclusive cost', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); const quote=f.quote('BUY');
  assert.equal(quote.symbol,'HGI'); assert.equal(quote.gross,'1000'); assert.equal(quote.fee,'1');
  assert.equal(quote.total,'1001'); assert.equal(quote.cashAfter,'8999');
  assert.equal(Buffer.from(quote.token,'base64url').length,32); assert.equal(quote.token.length,43);
  assert.deepEqual(counts(f),{orders:0,fills:0,cash:1,positions:0});
  const fill=f.confirm(quote); assert.equal(fill.cashAfter,'8999');
  assert.deepEqual(counts(f),{orders:1,fills:1,cash:2,positions:1});
  const cash=f.db.prepare("SELECT * FROM cash_journal WHERE entry_type='TRADE'").get() as {account_delta_atoms:string;system_delta_atoms:string;related_order_id:string;engine_version:string;ruleset_version:string};
  assert.equal(BigInt(cash.account_delta_atoms)+BigInt(cash.system_delta_atoms),0n);
  assert.equal(cash.related_order_id,fill.orderId); assert.equal(cash.engine_version,'0.0.0'); assert.equal(cash.ruleset_version,'1.0.0');
  const replay=new FoundationRepository(f.db,f.clock).replayAccount({marketId:market.marketId,discordUserId:userId});
  assert.equal(replay.cashAtoms,parseMoney('8999'));
  assert.equal(replay.positions.get(market.listings.find((listing)=>listing.symbol==='HGI')!.listingId)!.costAtoms,parseMoney('1001'));
});

test('entire cash budget includes fees and leaves a nonnegative exact residual', (t) => {
  const f=fixture(t); f.setup(); f.open(); const quote=f.quote('BUY',{budget:'10000'});
  assert.equal(quote.quantity,'9.990009'); assert.equal(quote.total,'9999.999009'); assert.equal(quote.cashAfter,'0.000991');
  const fill=f.confirm(quote); assert.equal(fill.cashAfter,'0.000991');
  error(f.broker.dispatch({type:'quote',context:f.context(),side:'BUY',symbol:'HGI',quantity:'0.000001'}),'INSUFFICIENT_CASH');
});

test('sell removes average cost, realizes fee losses and conserves every remaining cost atom', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); f.confirm(f.quote('BUY',{quantity:'3'}));
  const first=f.confirm(f.quote('SELL',{quantity:'1'})); assert.equal(first.realizedPnl,'-2');
  const second=f.confirm(f.quote('SELL',{quantity:'1'})); assert.equal(second.realizedPnl,'-2');
  const final=f.confirm(f.quote('SELL',{all:true})); assert.equal(final.quantity,'1'); assert.equal(final.realizedPnl,'-2');
  assert.equal(final.cashAfter,'9994');
  const replay=new FoundationRepository(f.db,f.clock).replayAccount({marketId:market.marketId,discordUserId:userId});
  const position=replay.positions.get(market.listings.find((listing)=>listing.symbol==='HGI')!.listingId)!;
  assert.equal(position.quantity.numerator,0n); assert.equal(position.costAtoms,0n);
  const costs=f.db.prepare("SELECT cost_removed_atoms FROM fills WHERE side='SELL'").all() as Array<{cost_removed_atoms:string}>;
  assert.equal(costs.reduce((sum,row)=>sum+BigInt(row.cost_removed_atoms),0n),parseMoney('3003'));
});

test('partial sale with indivisible average cost leaves remainder for the final full sale', (t) => {
  const f=fixture(t); const market=f.setup(); f.open();
  // A representable subpoint static test price exercises atom rounding without implementing a price engine.
  f.db.prepare("UPDATE listings SET price = ? WHERE market_id = ? AND symbol = 'HGI'").run('0.000001000000001',market.marketId);
  const buy=f.confirm(f.quote('BUY',{quantity:'3'}));
  f.confirm(f.quote('SELL',{quantity:'1'})); f.confirm(f.quote('SELL',{quantity:'1'})); f.confirm(f.quote('SELL',{all:true}));
  const costs=f.db.prepare("SELECT cost_removed_atoms FROM fills WHERE side='SELL'").all() as Array<{cost_removed_atoms:string}>;
  assert.equal(costs.reduce((sum,row)=>sum+BigInt(row.cost_removed_atoms),0n),parseMoney(buy.total));
  const replay=new FoundationRepository(f.db,f.clock).replayAccount({marketId:market.marketId,discordUserId:userId});
  assert.equal([...replay.positions.values()][0]?.costAtoms,0n);
  const roundings=f.db.prepare('SELECT rounding_numerator,rounding_denominator FROM fills').all() as Array<{rounding_numerator:string;rounding_denominator:string}>;
  assert.ok(roundings.some((row)=>row.rounding_numerator!=='0'));
});

test('duplicates under new Interaction IDs and after reopen return the same fill once', (t) => {
  const f=fixture(t); f.setup(); f.open(); const quote=f.quote('BUY'); const first=f.confirm(quote);
  const duplicate=f.confirm(quote); assert.deepEqual(duplicate,first);
  f.reopen(); assert.deepEqual(f.confirm(quote),first);
  f.clock.advanceBy(40_000); assert.deepEqual(f.confirm(quote),first);
  assert.deepEqual(counts(f),{orders:1,fills:1,cash:2,positions:1});
});

test('same interaction payload is idempotent, another owner or changed payload is rejected', (t) => {
  const f=fixture(t); f.setup(); f.open(); const ctx=f.context();
  const request:ServiceRequest={type:'quote',context:ctx,side:'BUY',symbol:'HGI',quantity:'1'};
  const first=f.broker.dispatch(request); assert.deepEqual(f.broker.dispatch(request),first);
  error(f.broker.dispatch({...request,quantity:'2'}),'IDEMPOTENCY_CONFLICT');
  error(f.broker.dispatch({...request,context:{...ctx,discordUserId:otherUserId}}),'IDEMPOTENCY_CONFLICT');
  assert.equal((f.db.prepare('SELECT count(*) AS n FROM order_intents').get() as {n:number}).n,1);
});

test('cross owner and cross guild forged tokens never execute or disclose a fill', (t) => {
  const f=fixture(t); f.setup(); f.open(); f.open(otherUserId); f.setup(otherGuildId); f.open(userId,otherGuildId);
  const quote=f.quote('BUY');
  error(f.broker.dispatch({type:'confirm',context:f.context(otherUserId),token:quote.token}),'INTENT_NOT_FOUND');
  error(f.broker.dispatch({type:'cancel',context:f.context(userId,otherGuildId),token:quote.token}),'INTENT_NOT_FOUND');
  f.confirm(quote);
  error(f.broker.dispatch({type:'confirm',context:f.context(otherUserId),token:quote.token}),'INTENT_NOT_FOUND');
  assert.equal(counts(f).fills,1);
});

test('concurrent stale cash previews serialize to one effect and cannot overspend', async (t) => {
  const f=fixture(t); f.setup(); f.open(); const one=f.quote('BUY',{budget:'10000'}); const two=f.quote('BUY',{budget:'10000'});
  const responses=await Promise.all([one,two].map((quote)=>Promise.resolve().then(()=>f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}))));
  assert.equal(responses.filter((response)=>response.kind==='FILLED').length,1);
  assert.equal(responses.filter((response)=>response.kind==='ERROR'&&response.code==='STALE_QUOTE').length,1);
  assert.equal(counts(f).fills,1);
});

test('concurrent sell previews cannot sell the same shares twice', async (t) => {
  const f=fixture(t); f.setup(); f.open(); f.confirm(f.quote('BUY'));
  const one=f.quote('SELL',{all:true}); const two=f.quote('SELL',{all:true});
  const responses=await Promise.all([one,two].map((quote)=>Promise.resolve().then(()=>f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}))));
  assert.equal(responses.filter((response)=>response.kind==='FILLED').length,1);
  assert.equal(counts(f).fills,2);
});

test('expiry includes the exact 30 second boundary and cancelled intents cannot execute', (t) => {
  const f=fixture(t); f.setup(); f.open(); const quote=f.quote('BUY');
  f.clock.advanceBy(30_000);
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'ORDER_EXPIRED');
  const second=f.quote('BUY');
  const cancelled=f.broker.dispatch({type:'cancel',context:f.context(),token:second.token});
  assert.equal(cancelled.kind,'CANCELLED'); assert.deepEqual(f.broker.dispatch({type:'cancel',context:f.context(),token:second.token}),cancelled);
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:second.token}),'ORDER_CANCELLED');
  assert.equal(counts(f).fills,0);
});

test('price/version drift never silently executes at another price', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); const quote=f.quote('BUY');
  f.db.prepare("UPDATE listings SET price = ? WHERE market_id = ? AND symbol = 'HGI'").run('1100',market.marketId);
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'STALE_QUOTE');
  assert.equal(counts(f).fills,0); const replacement=f.quote('BUY'); assert.equal(replacement.price,'1100');
});

test('exact tick boundary waits for new committed version and stale intents stay invalid', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); f.clock.advanceBy(290_000); const quote=f.quote('BUY');
  f.clock.advanceBy(10_000);
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'MARKET_UPDATING');
  const committed=f.broker.advanceTrialMarket(market.marketId);
  assert.equal(committed.tickNo,1); assert.equal(committed.marketVersion,1); assert.ok(committed.listings.every((listing)=>listing.price==='1000'));
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'STALE_QUOTE');
  const current=f.quote('BUY'); assert.equal(current.marketVersion,1); f.confirm(current);
  assert.equal(f.broker.advanceTrialMarket(market.marketId).tickNo,1);
});

test('trial recovery restores active time and does not accrue offline ticks', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); f.clock.advanceBy(100_000);
  f.broker.advanceTrialMarket(market.marketId); f.reopen(); f.clock.advanceBy(86_400_000);
  f.broker.recoverTrialMarkets();
  let current=f.broker.advanceTrialMarket(market.marketId); assert.equal(current.tickNo,0);
  assert.equal(Date.parse(current.nextBoundaryAt)-Date.parse(f.clock.now()),200_000);
  f.clock.advanceBy(200_000); current=f.broker.advanceTrialMarket(market.marketId); assert.equal(current.tickNo,1);
});

test('trial scheduler returns only committed version changes for board edits', (t) => {
  const f=fixture(t); f.setup();
  assert.deepEqual(f.broker.dispatch({type:'tick',now:f.clock.now()}),{kind:'TICKED',markets:[]});
  f.clock.advanceBy(300_000); const changed=f.broker.dispatch({type:'tick',now:f.clock.now()});
  assert.equal(changed.kind,'TICKED'); if(changed.kind==='TICKED') assert.equal(changed.markets.length,1);
  assert.deepEqual(f.broker.dispatch({type:'tick',now:f.clock.now()}),{kind:'TICKED',markets:[]});
});

test('immutable intent terms and closed subject bindings cannot be rewritten', (t) => {
  const f=fixture(t); f.setup(); const account=f.open(); const quote=f.quote('BUY');
  assert.throws(()=>f.db.prepare('UPDATE order_intents SET quantity = ? WHERE token = ?').run('2',quote.token),/immutable/);
  assert.throws(()=>f.db.prepare('UPDATE account_subjects SET account_id = ? WHERE account_id = ?').run('different',account.accountId),/permanent/);
  f.broker.dispatch({type:'close',context:f.context(),confirmed:true});
  assert.throws(()=>f.db.prepare('UPDATE account_subjects SET closed_at = NULL WHERE account_id = ?').run(account.accountId),/permanent/);
  assert.throws(()=>f.db.prepare('DELETE FROM account_subjects WHERE account_id = ?').run(account.accountId),/permanent/);
});

test('malformed and financially changed cached responses fail closed and pause their market', (t) => {
  for(const mode of ['malformed','amount'] as const) {
    const f=fixture(t); f.setup(); f.open(); const quote=f.quote('BUY'); const context=f.context();
    const request:ServiceRequest={type:'confirm',context,token:quote.token};
    const response=f.broker.dispatch(request); assert.equal(response.kind,'FILLED');
    if(response.kind!=='FILLED') throw new Error('fill failed');
    f.db.exec('DROP TRIGGER trade_commands_no_update');
    const poisoned=mode==='malformed'?{kind:'FILLED',fill:{}}:{...response,fill:{...response.fill,cashAfter:'10000'}};
    f.db.prepare('UPDATE trade_commands SET response_json = ? WHERE interaction_id = ?').run(JSON.stringify(poisoned),context.interactionId);
    error(f.broker.dispatch(request),'INTEGRITY_ERROR');
    const market=f.broker.dispatch({type:'market',context:f.context()});
    if(market.kind==='MARKET') assert.equal(market.market.state,'PAUSED'); else assert.fail('missing market');
    assert.equal(counts(f).fills,1);
  }
});

test('cached quote cost cannot drift away from its stored intent', (t) => {
  const f=fixture(t); f.setup(); f.open(); const context=f.context();
  const request:ServiceRequest={type:'quote',context,side:'BUY',symbol:'HGI',quantity:'1'};
  const response=f.broker.dispatch(request); assert.equal(response.kind,'QUOTE');
  if(response.kind!=='QUOTE') throw new Error('quote failed');
  f.db.exec('DROP TRIGGER trade_commands_no_update');
  f.db.prepare('UPDATE trade_commands SET response_json = ? WHERE interaction_id = ?')
    .run(JSON.stringify({...response,quote:{...response.quote,total:'0'}}),context.interactionId);
  error(f.broker.dispatch(request),'INTEGRITY_ERROR'); assert.equal(counts(f).fills,0);
});

test('market paused prevents openings/trades while owner portfolio/history remain readable', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); const quote=f.quote('BUY');
  f.db.prepare("UPDATE markets SET state='PAUSED' WHERE market_id = ?").run(market.marketId);
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'MARKET_PAUSED');
  error(f.broker.dispatch({type:'open',context:f.context(otherUserId),age14Plus:true,agreeTerms:true}),'MARKET_PAUSED');
  assert.equal(f.broker.dispatch({type:'portfolio',context:f.context()}).kind,'PORTFOLIO');
  assert.equal(f.broker.dispatch({type:'history',context:f.context()}).kind,'HISTORY');
});

test('overcash, oversell, mixed input, substep and unbounded input reject without journals', (t) => {
  const f=fixture(t); f.setup(); f.open();
  const cases:Array<[Partial<Extract<ServiceRequest,{type:'quote'}>>,string]>=[
    [{side:'BUY',quantity:'10'},'INSUFFICIENT_CASH'],[{side:'SELL',quantity:'1'},'INSUFFICIENT_SHARES'],
    [{side:'BUY',quantity:'1',budget:'1000'},'INVALID_INPUT'],[{side:'BUY',all:true},'INVALID_INPUT'],
    [{side:'SELL',budget:'1'},'INVALID_INPUT'],[{side:'BUY',quantity:'0.0000001'},'INVALID_PRECISION'],
    [{side:'BUY',quantity:'0'},'INVALID_PRECISION'],[{side:'BUY',budget:'0'},'INVALID_INPUT'],
    [{side:'BUY',quantity:'1'.repeat(65)},'INVALID_INPUT'],[{side:'BUY',symbol:'HGI;DROP'},'INVALID_INPUT'],
  ];
  for(const [input,code]of cases) error(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',...input}),code);
  assert.deepEqual(counts(f),{orders:0,fills:0,cash:1,positions:0});
});

test('subatom trade refuses free positions and preserves tiny positive prices', (t) => {
  const f=fixture(t); const market=f.setup(); f.open();
  f.db.prepare("UPDATE listings SET price = ? WHERE market_id = ? AND symbol = 'HGI'").run('1e-30',market.marketId);
  error(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',quantity:'1'}),'INVALID_PRECISION');
  const current=f.broker.dispatch({type:'market',context:f.context()});
  if(current.kind==='MARKET') assert.equal(current.market.listings.find((listing)=>listing.symbol==='HGI')?.price,'1e-30');
  assert.equal(counts(f).fills,0);
});

test('late insert failure rolls back order, fill, both journals, status and account version', (t) => {
  const f=fixture(t); const market=f.setup(); const account=f.open(); const quote=f.quote('BUY');
  f.db.exec("CREATE TRIGGER broker_test_fail BEFORE INSERT ON position_journal BEGIN SELECT RAISE(ABORT,'test failure'); END;");
  error(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.token}),'INTERNAL_ERROR');
  assert.deepEqual(counts(f),{orders:0,fills:0,cash:1,positions:0});
  const accountNow=new FoundationRepository(f.db,f.clock).getAccount({marketId:market.marketId,discordUserId:userId});
  assert.equal(accountNow?.accountVersion,account.accountVersion); assert.equal(accountNow?.cashAtoms,parseMoney('10000').toString());
  assert.equal((f.db.prepare('SELECT status FROM order_intents WHERE token = ?').get(quote.token) as {status:string}).status,'DRAFT');
  f.db.exec('DROP TRIGGER broker_test_fail'); f.confirm(quote);
});

test('portfolio and history reconstruct fees, positions and realized loss after reopening', (t) => {
  const f=fixture(t); f.setup(); f.open(); const buy=f.confirm(f.quote('BUY')); f.reopen();
  const portfolio=f.broker.dispatch({type:'portfolio',context:f.context()}); assert.equal(portfolio.kind,'PORTFOLIO');
  if(portfolio.kind==='PORTFOLIO') {
    assert.equal(portfolio.portfolio.equity,'9999'); assert.equal(portfolio.portfolio.totalReturnPct,'-0.01');
    assert.equal(portfolio.portfolio.positions[0]?.cost,'1001'); assert.equal(portfolio.portfolio.positions[0]?.unrealizedPnl,'-1');
  }
  const history=f.broker.dispatch({type:'history',context:f.context()});
  if(history.kind==='HISTORY') assert.deepEqual(history.fills,[buy]); else assert.fail('missing history');
  f.open(otherUserId); const another=f.broker.dispatch({type:'history',context:f.context(otherUserId)});
  if(another.kind==='HISTORY') assert.deepEqual(another.fills,[]); else assert.fail('missing history');
});

test('duplicate queries read the current owned ledger without retaining private response caches', (t) => {
  const f = fixture(t); f.setup(); f.open();
  const request: ServiceRequest = { type: 'portfolio', context: f.context() };
  const before = f.broker.dispatch(request); assert.equal(before.kind, 'PORTFOLIO');
  if (before.kind === 'PORTFOLIO') assert.equal(before.portfolio.account.cash, '10000');
  f.confirm(f.quote('BUY'));
  const after = f.broker.dispatch(request); assert.equal(after.kind, 'PORTFOLIO');
  if (after.kind === 'PORTFOLIO') {
    assert.equal(after.portfolio.account.cash, '8999');
    assert.equal(after.portfolio.positions.length, 1);
  }
  f.broker.dispatch({ type: 'history', context: f.context() });
  const count = f.db.prepare("SELECT count(*) AS n FROM trade_commands WHERE command_type IN ('market','status','portfolio','history')").get() as { n: number };
  assert.equal(count.n, 0);
});

test('close pseudonymizes identifiers, scrubs acceptance/cache/token data and prevents regrant across restart', (t) => {
  const f=fixture(t); const market=f.setup(); const account=f.open(); const buyQuote=f.quote('BUY'); f.confirm(buyQuote);
  const draft=f.quote('BUY');
  error(f.broker.dispatch({type:'close',context:f.context(),confirmed:false}),'INVALID_INPUT');
  const closed=f.broker.dispatch({type:'close',context:f.context(),confirmed:true});
  assert.deepEqual(closed,{kind:'CLOSED',accountId:account.accountId});
  const stored=f.db.prepare('SELECT discord_user_id,status FROM accounts WHERE account_id = ?').get(account.accountId) as {discord_user_id:string;status:string};
  assert.notEqual(stored.discord_user_id,userId); assert.equal(stored.status,'CLOSED');
  for(const name of ['processed_commands','policy_acceptances','trade_commands'] as const) {
    const query={processed_commands:'SELECT count(*) AS n FROM processed_commands',policy_acceptances:'SELECT count(*) AS n FROM policy_acceptances',trade_commands:'SELECT count(*) AS n FROM trade_commands'}[name];
    assert.equal((f.db.prepare(query).get() as {n:number}).n,0);
  }
  assert.equal(f.db.prepare('SELECT 1 FROM order_intents WHERE token = ?').get(draft.token),undefined);
  assert.equal(f.db.prepare('SELECT 1 FROM order_intents WHERE token = ?').get(buyQuote.token),undefined);
  assert.deepEqual(counts(f),{orders:1,fills:1,cash:2,positions:1});
  f.reopen();
  error(f.broker.dispatch({type:'open',context:f.context(),age14Plus:true,agreeTerms:true}),'ACCOUNT_CLOSED');
  error(f.broker.dispatch({type:'portfolio',context:f.context()}),'ACCOUNT_CLOSED');
  assert.deepEqual(f.broker.dispatch({type:'close',context:f.context(),confirmed:true}),closed);
  assert.equal(counts(f).cash,2);
  assert.throws(()=>f.db.prepare("UPDATE accounts SET status='ACTIVE' WHERE account_id = ?").run(account.accountId),/cannot reopen/);
  const retained=new FoundationRepository(f.db,f.clock).replayAccount({marketId:market.marketId,discordUserId:stored.discord_user_id});
  assert.equal(retained.cashAtoms,parseMoney('8999'));
});

test('identity key rotation cannot bypass closed-account antireset records', (t) => {
  const f=fixture(t); f.setup(); f.open(); f.broker.dispatch({type:'close',context:f.context(),confirmed:true});
  assert.throws(()=>new BrokerRepository(f.db,f.clock,{identityKey:randomBytes(32)}),/identity key has changed/);
});

test('system counter accounts do not constrain large independent solo executions or alter prices', (t) => {
  const f=fixture(t); const market=f.setup(); f.open(); f.open(otherUserId);
  f.confirm(f.quote('BUY',{budget:'10000'})); f.confirm(f.quote('BUY',{budget:'10000'},otherUserId),otherUserId);
  const after=f.broker.dispatch({type:'market',context:f.context()});
  if(after.kind==='MARKET') {
    assert.equal(after.market.marketVersion,market.marketVersion); assert.equal(after.market.tickNo,market.tickNo);
    assert.deepEqual(after.market.listings,market.listings);
  } else assert.fail('missing market');
  const quantities=f.db.prepare('SELECT quantity FROM fills').all() as Array<{quantity:string}>;
  assert.equal(quantities.length,2); assert.equal(decimalFraction(quantities[0]!.quantity).numerator>0n,true);
});
