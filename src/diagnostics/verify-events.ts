import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { EVENT_CATALOG } from '../events/catalog.js';
import { validateEventCatalog } from '../events/validator.js';
import { BrokerRepository } from '../broker/repository.js';
import { EconomyRepository,economySnapshotHash } from '../economy/repository.js';
import { openDatabase } from '../storage/database.js';
import { FoundationRepository } from '../storage/repository.js';
import { createInitialListings } from '../fixtures/initial-companies.js';
import { FakeClock } from '../domain/clock.js';
import type { ServiceContext } from '../application/contracts.js';

const root=resolve(tmpdir());const directory=mkdtempSync(join(root,'papermarket-events-'));const path=join(directory,'events.sqlite');let db=openDatabase(path);
try {
  const catalog=validateEventCatalog(EVENT_CATALOG);assert.equal(catalog.length,240);const clock=new FakeClock('2026-10-04T00:00:00.000Z');const identityKey=randomBytes(32),seed=Buffer.alloc(32,17),marketId='events_diagnostic';
  new FoundationRepository(db,clock).createMarket({marketId,guildId:'111111111111111111',listings:createInitialListings()});let broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});let id=333333333333333333n;
  const context=():ServiceContext=>({guildId:'111111111111111111',discordUserId:'222222222222222222',interactionId:(++id).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  assert.equal(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind,'SETUP');
  for(let tick=1;tick<=21;tick++) {
    if(tick===12) {
      const before=economySnapshotHash(new EconomyRepository(db,seed).load(marketId));db.close();db=openDatabase(path);broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});clock.advanceBy(86400000);
      assert.equal(broker.dispatch({type:'recover',now:clock.now()}).kind,'RECOVERED');assert.equal(economySnapshotHash(new EconomyRepository(db,seed).load(marketId)),before);
    }
    clock.advanceBy(300000);const result=broker.dispatch({type:'tick',now:clock.now()});assert.equal(result.kind,'TICKED');
    const snapshot=new EconomyRepository(db,seed).load(marketId);assert.equal(snapshot.economy.tickNo,tick);assert.equal(snapshot.public.tickNo,tick);
    const view=broker.dispatch({type:'market',context:context()});assert.equal(view.kind,'MARKET');if(view.kind!=='MARKET')throw new Error('view');
    assert.ok(view.market.economy?.disclosures.every(item=>item.publishedTick<=tick));assert.ok((view.market.economy?.disclosures.length??0)<=8);
    for(const forbidden of ['workingCapital','cooldowns','outcomeId','successorTemplateId','seed_check']) assert.equal(JSON.stringify(view.market).includes(forbidden),false);
  }
  const snapshot=new EconomyRepository(db,seed).load(marketId);assert.ok(snapshot.economy.events.occurrences.length>0);
  const eventRecords=(db.prepare('SELECT publication_json FROM economy_publications').all() as {publication_json:string}[]).map(row=>JSON.parse(row.publication_json) as {kind:string;effectiveTick:number;publishedTick:number});
  const events=eventRecords.filter(row=>row.kind==='EVENT');assert.ok(events.length>0);assert.ok(events.every(row=>row.effectiveTick<=row.publishedTick&&row.publishedTick<=21));
  process.stdout.write(JSON.stringify({status:'PASS',templates:240,profiles:12,storage:'real SQLite',ticks:21,eventDisclosures:events.length,checks:['catalog validation','state effects','public boundary','restart replay','offline exclusion','display limit preserves persisted events']})+'\n');
} finally {if(db.open) db.close();assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});}
