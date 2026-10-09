import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import test, {type TestContext} from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { BrokerRepository } from '../src/broker/repository.js';
import type { ServiceContext } from '../src/application/contracts.js';
import { FakeClock } from '../src/domain/clock.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { DM_NOTIFICATION_CONSENT_VERSION, NotificationAccessError, NotificationRepository } from '../src/notifications/repository.js';
import { notificationSchemaSql } from '../src/notifications/notification-schema.js';
import type { NotificationBoundary, NotificationOwner } from '../src/notifications/types.js';

const initial='2026-10-05T00:00:00.000Z';
const marketId='notification-market',user='222222222222222222',other='222222222222222223';
function fixture(t:TestContext) {
  const root=resolve(tmpdir()),directory=mkdtempSync(join(root,'papermarket-notifications-')),path=join(directory,'notifications.sqlite');
  const clock=new FakeClock(initial);let db=openDatabase(path);
  if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'notification_inbox'").get()) db.exec(notificationSchemaSql);
  let notifications=new NotificationRepository(db,clock);
  const foundation=new FoundationRepository(db,clock);const listings=createInitialListings();
  foundation.createMarket({marketId,guildId:'111111111111111111',listings});
  const account=foundation.openAccount({marketId,discordUserId:user,interactionId:'333333333333333333'});
  const otherAccount=foundation.openAccount({marketId,discordUserId:other,interactionId:'333333333333333334'});
  const owner:NotificationOwner={marketId,accountId:account.accountId,discordUserId:user};
  const otherOwner:NotificationOwner={marketId,accountId:otherAccount.accountId,discordUserId:other};
  let tick=0;
  const meta=()=>({tickNo:tick,marketVersion:tick,createdAt:clock.now()});
  const record=(eventId='event1')=>db.transaction(()=>notifications.record(marketId,owner.accountId,eventId,'SCHEDULED_FILLED','HGI','예약 주문 체결','현재 확정 시세로 전량 체결했습니다.',meta())).immediate();
  const boundary=(price='1000',extras:Partial<NotificationBoundary>={})=>{
    tick++;clock.advanceBy(300_000);
    const value:NotificationBoundary={marketId,...meta(),listings:listings.map(listing=>({listingId:listing.listingId,symbol:listing.symbol,name:listing.symbol,price:listing.symbol==='HGI'?price:'1000',active:true})),disclosures:[],...extras};
    db.transaction(()=>notifications.recordBoundary(value)).immediate();return value;
  };
  t.after(()=>{if(db.open) db.close();assert.equal(dirname(resolve(directory)),root);assert.ok(basename(directory).startsWith('papermarket-notifications-'));rmSync(directory,{recursive:true,force:true});});
  return {get db(){return db;},get notifications(){return notifications;},owner,otherOwner,clock,listings,record,boundary,meta,
    reopen(){db.close();db=openDatabase(path);notifications=new NotificationRepository(db,clock);}};
}
function count(f:ReturnType<typeof fixture>,table:'notification_inbox'|'notification_outbox'|'notification_preferences'|'price_alerts'|'watched_listings'|'notification_seen'):number {
  const sql={notification_inbox:'SELECT count(*) AS n FROM notification_inbox',notification_outbox:'SELECT count(*) AS n FROM notification_outbox',notification_preferences:'SELECT count(*) AS n FROM notification_preferences',price_alerts:'SELECT count(*) AS n FROM price_alerts',watched_listings:'SELECT count(*) AS n FROM watched_listings',notification_seen:'SELECT count(*) AS n FROM notification_seen'} as const;
  return (f.db.prepare(sql[table]).get() as {n:number}).n;
}

test('personal inbox persists committed facts without implicit DM or interaction tokens',t=>{
  const f=fixture(t);f.record();f.record();
  assert.equal(count(f,'notification_inbox'),1);assert.equal(count(f,'notification_outbox'),0);
  assert.deepEqual(f.notifications.getAlerts(f.owner),{dmEnabled:false,priceAlerts:[],watchlist:[]});
  f.reopen();const inbox=f.notifications.readInbox(f.owner);
  assert.equal(inbox.items[0]?.kind,'SCHEDULED_FILLED');assert.equal(inbox.items[0]?.marketVersion,0);
  assert.equal(JSON.stringify(inbox).includes(user),false);assert.equal(JSON.stringify(inbox).includes('token'),false);
  assert.deepEqual(f.notifications.poll(f.clock.now()),[]);
});

test('explicit authenticated DM consent covers future events and withdrawal cancels leased delivery',t=>{
  const f=fixture(t);f.record('old');
  f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());
  const preference=f.db.prepare('SELECT consent_version,consented_at FROM notification_preferences WHERE market_id = ? AND account_id = ?').get(marketId,f.owner.accountId) as {consent_version:string;consented_at:string};
  assert.equal(preference.consent_version,DM_NOTIFICATION_CONSENT_VERSION);assert.equal(preference.consented_at,initial);
  f.record('new');const [delivery]=f.notifications.poll(f.clock.now());assert.ok(delivery);assert.equal(delivery.discordUserId,user);
  assert.equal(count(f,'notification_outbox'),1);assert.equal(f.notifications.authorizeDelivery(delivery.jobId,delivery.leaseToken,f.clock.now()),true);
  f.notifications.saveAlerts(f.owner,{dmEnabled:false},f.meta());
  assert.equal(f.notifications.authorizeDelivery(delivery.jobId,delivery.leaseToken,f.clock.now()),false);
  assert.equal(f.notifications.ack(delivery.jobId,delivery.leaseToken,{delivered:true},f.clock.now()),false);
  assert.equal(f.notifications.readInbox(f.owner).items.length,2);
  f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());assert.deepEqual(f.notifications.poll(f.clock.now()),[]);
});

test('notification ownership prevents cross-account reads, settings, deletion and cursor lookup',t=>{
  const f=fixture(t);f.record();
  const forged={...f.owner,discordUserId:other};
  for(const operation of [()=>f.notifications.readInbox(forged),()=>f.notifications.getAlerts(forged),()=>f.notifications.saveAlerts(forged,{dmEnabled:true},f.meta()),()=>f.notifications.closeOwner(forged)]) assert.throws(operation,NotificationAccessError);
  const id=f.notifications.readInbox(f.owner).items[0]!.notificationId;
  assert.throws(()=>f.notifications.readInbox(f.otherOwner,{beforeId:id}));
  assert.equal(f.notifications.readInbox(f.otherOwner).items.length,0);
  assert.throws(()=>f.notifications.readInbox({...f.owner,marketId:'other-market'}),NotificationAccessError);
});

test('price thresholds cross once, include equality, rearm only on opposite side and persist across restart',t=>{
  const f=fixture(t),hgi=f.listings.find(listing=>listing.symbol==='HGI')!;
  f.notifications.saveAlerts(f.owner,{addPriceAlert:{listingId:hgi.listingId,direction:'ABOVE',threshold:'1100'}},f.meta());
  f.boundary('1099');f.boundary('1100');assert.equal(f.notifications.readInbox(f.owner).items.length,1);
  f.boundary('1150');f.reopen();f.boundary('1120');assert.equal(f.notifications.readInbox(f.owner).items.length,1);
  f.boundary('1099');f.boundary('1100');assert.equal(f.notifications.readInbox(f.owner).items.length,2);
  const same=f.boundary('1200');f.db.transaction(()=>f.notifications.recordBoundary(same)).immediate();assert.equal(f.notifications.readInbox(f.owner).items.length,2);
});

test('an alert already beyond its threshold waits for a fresh directional crossing',t=>{
  const f=fixture(t),hgi=f.listings.find(listing=>listing.symbol==='HGI')!;
  f.notifications.saveAlerts(f.owner,{addPriceAlert:{listingId:hgi.listingId,direction:'BELOW',threshold:'1100'}},f.meta());
  assert.equal(f.notifications.getAlerts(f.owner).priceAlerts[0]!.armed,false);
  f.boundary('1050');assert.equal(f.notifications.readInbox(f.owner).items.length,0);
  f.boundary('1101');f.boundary('1100');assert.equal(f.notifications.readInbox(f.owner).items.length,1);
});

test('important public news respects immutable watch and holding interests while macro is general',t=>{
  const f=fixture(t),hgi=f.listings.find(listing=>listing.symbol==='HGI')!;
  f.notifications.saveAlerts(f.owner,{watchListingId:hgi.listingId},f.meta());
  f.boundary('1000',{disclosures:[{id:'public1',kind:'EARNINGS',publishedTick:1,listingId:hgi.listingId,symbol:'HGI',title:'공개 실적',summary:'확정 실적 요약'},{id:'macro1',kind:'MACRO',publishedTick:1,symbol:null,title:'금리 발표',summary:'확정 정책금리 발표'}]});
  assert.equal(f.notifications.readInbox(f.owner).items.length,2);assert.equal(f.notifications.readInbox(f.otherOwner).items.length,1);
  f.notifications.saveAlerts(f.owner,{unwatchListingId:hgi.listingId},f.meta());
  f.boundary('1000',{disclosures:[{id:'public2',kind:'EARNINGS',publishedTick:2,listingId:hgi.listingId,symbol:'HGI',title:'공개 실적',summary:'두 번째 요약'}]});
  assert.equal(f.notifications.readInbox(f.owner).items.length,2);
  assert.throws(()=>f.boundary('1000',{disclosures:[{id:'future',kind:'MACRO',publishedTick:100,symbol:null,title:'비공개',summary:'공개 전'}]}));
});

test('a real executed holding receives company news without requiring a watch or DM consent',t=>{
  const f=fixture(t),broker=new BrokerRepository(f.db,f.clock,{identityKey:randomBytes(32)});let interaction=333333333333334000n;
  const context=():ServiceContext=>({guildId:'111111111111111111',discordUserId:user,interactionId:(++interaction).toString(),receivedAt:f.clock.now(),guildPermissions:'32'});
  assert.equal(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind,'SETUP');
  assert.equal(broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true}).kind,'ACCOUNT');
  const quote=broker.dispatch({type:'quote',context:context(),symbol:'HGI',side:'BUY',quantity:'1'});assert.equal(quote.kind,'QUOTE');if(quote.kind!=='QUOTE')throw new Error('quote unavailable');
  assert.equal(broker.dispatch({type:'confirm',context:context(),token:quote.quote.token}).kind,'FILLED');
  f.boundary('1000',{disclosures:[{id:'owned-news',kind:'EARNINGS',publishedTick:1,listingId:f.listings.find(listing=>listing.symbol==='HGI')!.listingId,symbol:'HGI',title:'확정 실적',summary:'보유종목의 공개 실적입니다.'}]});
  assert.equal(f.notifications.readInbox(f.owner).items.some(item=>item.kind==='IMPORTANT_DISCLOSURE'),true);assert.equal(f.notifications.readInbox(f.otherOwner).items.length,0);
  assert.equal(f.notifications.getAlerts(f.owner).watchlist.length,0);assert.equal(count(f,'notification_outbox'),0);
});

test('retired listing alerts and watches disable without transferring to a replacement',t=>{
  const f=fixture(t),hgi=f.listings.find(listing=>listing.symbol==='HGI')!;
  f.notifications.saveAlerts(f.owner,{watchListingId:hgi.listingId},f.meta());
  f.notifications.saveAlerts(f.owner,{addPriceAlert:{listingId:hgi.listingId,direction:'ABOVE',threshold:'1100'}},f.meta());
  f.db.prepare("UPDATE listings SET status = 'EXTINGUISHED',price = '0' WHERE market_id = ? AND listing_id = ?").run(marketId,hgi.listingId);
  f.boundary('0',{listings:[]});const settings=f.notifications.getAlerts(f.owner);
  assert.equal(settings.watchlist[0]?.enabled,false);assert.equal(settings.priceAlerts[0]?.enabled,false);assert.equal(settings.priceAlerts[0]?.disabledReason,'LISTING_RETIRED');
  assert.throws(()=>f.notifications.saveAlerts(f.owner,{addPriceAlert:{listingId:hgi.listingId,direction:'ABOVE',threshold:'1'}},f.meta()));
  assert.equal(f.notifications.readInbox(f.owner).items.length,0);
});

test('lease recovery, stale acknowledgements and retries never change financial journals',t=>{
  const f=fixture(t);f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());f.record();
  const journalBefore=f.db.prepare('SELECT * FROM cash_journal ORDER BY journal_id').all();
  const [first]=f.notifications.poll(f.clock.now());assert.ok(first);assert.deepEqual(f.notifications.poll(f.clock.now()),[]);
  f.clock.advanceBy(30_000);f.reopen();const [retry]=f.notifications.poll(f.clock.now());assert.ok(retry);assert.equal(retry.jobId,first.jobId);assert.notEqual(retry.leaseToken,first.leaseToken);assert.equal(retry.attempts,2);
  assert.equal(f.notifications.ack(first.jobId,first.leaseToken,{delivered:true},f.clock.now()),false);
  assert.equal(f.notifications.ack(retry.jobId,retry.leaseToken,{delivered:false,retryAfterMs:60_000},f.clock.now()),true);
  f.clock.advanceBy(59_999);assert.deepEqual(f.notifications.poll(f.clock.now()),[]);f.clock.advanceBy(1);const [last]=f.notifications.poll(f.clock.now());assert.ok(last);
  assert.equal(f.notifications.ack(last.jobId,last.leaseToken,{delivered:true},f.clock.now()),true);assert.deepEqual(f.notifications.poll(f.clock.now()),[]);
  assert.deepEqual(f.db.prepare('SELECT * FROM cash_journal ORDER BY journal_id').all(),journalBefore);
});

test('retry exhaustion leaves readable inbox and stops external attempts',t=>{
  const f=fixture(t);f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());f.record();
  for(let attempt=1;attempt<=8;attempt++) {
    const [delivery]=f.notifications.poll(f.clock.now());assert.ok(delivery);assert.equal(delivery.attempts,attempt);
    assert.equal(f.notifications.ack(delivery.jobId,delivery.leaseToken,{delivered:false,retryAfterMs:1},f.clock.now()),true);f.clock.advanceBy(1);
  }
  assert.deepEqual(f.notifications.poll(f.clock.now()),[]);assert.equal(f.notifications.readInbox(f.owner).items.length,1);
});

test('one delayed recipient does not starve other due outbox jobs',t=>{
  const f=fixture(t);f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());f.notifications.saveAlerts(f.otherOwner,{dmEnabled:true},f.meta());
  f.record('first');f.db.transaction(()=>f.notifications.record(marketId,f.otherOwner.accountId,'other-event','SCHEDULED_FILLED','HGI','체결','요약',f.meta())).immediate();
  const [first]=f.notifications.poll(f.clock.now(),1);assert.ok(first);f.notifications.ack(first.jobId,first.leaseToken,{delivered:false,retryAfterMs:60_000},f.clock.now());
  const [otherDelivery]=f.notifications.poll(f.clock.now(),1);assert.ok(otherDelivery);assert.notEqual(otherDelivery.discordUserId,first.discordUserId);
  assert.equal(f.notifications.ack(otherDelivery.jobId,otherDelivery.leaseToken,{delivered:true},f.clock.now()),true);
  assert.deepEqual(f.notifications.poll(f.clock.now()),[]);
});

test('notification creation and outbox both roll back with an interrupted financial commit',t=>{
  const f=fixture(t);f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());
  assert.throws(()=>f.notifications.record(marketId,f.owner.accountId,'outside','SCHEDULED_FILLED','HGI','체결','요약',f.meta()));
  assert.throws(()=>f.db.transaction(()=>{f.notifications.record(marketId,f.owner.accountId,'rollback','SCHEDULED_FILLED','HGI','체결','요약',f.meta());throw new Error('simulated commit failure');}).immediate());
  assert.equal(count(f,'notification_seen'),0);assert.equal(count(f,'notification_inbox'),0);assert.equal(count(f,'notification_outbox'),0);
  f.record('rollback');assert.equal(count(f,'notification_inbox'),1);
});

test('inbox pagination stays owner scoped and capped while old event IDs stay deduplicated after retention',t=>{
  const f=fixture(t);
  f.db.transaction(()=>{for(let index=0;index<1005;index++) f.notifications.record(marketId,f.owner.accountId,`event${index}`,'SCHEDULED_FILLED','HGI','체결','요약',f.meta());}).immediate();
  assert.equal(count(f,'notification_inbox'),1000);assert.equal(count(f,'notification_seen'),1005);
  f.record('event0');assert.equal(count(f,'notification_inbox'),1000);
  const first=f.notifications.readInbox(f.owner,{limit:25,markRead:true});assert.equal(first.items.length,25);assert.equal(first.unreadCount,975);assert.ok(first.nextBeforeId);
  const next=f.notifications.readInbox(f.owner,{limit:25,beforeId:first.nextBeforeId});assert.equal(next.items.length,25);assert.equal(next.items.some(row=>first.items.some(prior=>prior.notificationId===row.notificationId)),false);
  assert.throws(()=>f.notifications.readInbox(f.owner,{limit:26}));assert.throws(()=>f.notifications.saveAlerts(f.owner,{dmEnabled:true,removePriceAlertId:randomUUID()},f.meta()));
});

test('account closure removes inbox, dedup history, watches, price conditions, consent and leased jobs',t=>{
  const f=fixture(t),hgi=f.listings.find(listing=>listing.symbol==='HGI')!;
  f.notifications.saveAlerts(f.owner,{dmEnabled:true},f.meta());f.notifications.saveAlerts(f.owner,{watchListingId:hgi.listingId},f.meta());
  f.notifications.saveAlerts(f.owner,{addPriceAlert:{listingId:hgi.listingId,direction:'ABOVE',threshold:'1100'}},f.meta());f.record();const [delivery]=f.notifications.poll(f.clock.now());assert.ok(delivery);
  f.notifications.closeOwner(f.owner);
  for(const table of ['notification_inbox','notification_outbox','notification_seen','notification_preferences','price_alerts','watched_listings'] as const) assert.equal(count(f,table),0);
  assert.equal(f.notifications.authorizeDelivery(delivery.jobId,delivery.leaseToken,f.clock.now()),false);
  assert.equal(f.db.prepare('SELECT * FROM accounts WHERE account_id = ?').get(f.owner.accountId)!==undefined,true);
});
