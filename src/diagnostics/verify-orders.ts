import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname,join,resolve } from 'node:path';
import { BrokerRepository } from '../broker/repository.js';
import { ScheduledRepository } from '../broker/scheduled.js';
import { openDatabase } from '../storage/database.js';
import { FakeClock } from '../domain/clock.js';
import type { ServiceContext,ServiceRequest } from '../application/contracts.js';

const root=resolve(tmpdir());const directory=mkdtempSync(join(root,'papermarket-orders-'));let db=openDatabase(join(directory,'orders.sqlite'));
try {
  const clock=new FakeClock('2026-10-04T00:00:00.000Z');const identityKey=randomBytes(32);let broker=new BrokerRepository(db,clock,{identityKey});let id=333333333333333333n;
  const context=():ServiceContext=>({guildId:'111111111111111111',discordUserId:'222222222222222222',interactionId:(++id).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'});assert.equal(setup.kind,'SETUP');if(setup.kind!=='SETUP') throw new Error('setup');const marketId=setup.market.marketId;
  const account=broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true});assert.equal(account.kind,'ACCOUNT');if(account.kind!=='ACCOUNT') throw new Error('account');
  function submit(input:Partial<Extract<ServiceRequest,{type:'quote'}>>) {
    const quote=broker.dispatch({type:'quote',context:context(),symbol:'HGI',side:'BUY',quantity:'1',...input});assert.equal(quote.kind,'QUOTE');if(quote.kind!=='QUOTE') throw new Error('quote');
    return broker.dispatch({type:'confirm',context:context(),token:quote.quote.token});
  }
  assert.equal(submit({quantity:'3'}).kind,'FILLED');assert.equal(submit({side:'SELL',orderType:'STOP',conditionPrice:'900',quantity:'2'}).kind,'ORDER_OPENED');assert.equal(submit({orderType:'LIMIT',conditionPrice:'900'}).kind,'ORDER_OPENED');
  db.close();db=openDatabase(join(directory,'orders.sqlite'));broker=new BrokerRepository(db,clock,{identityKey});clock.advanceBy(86400000);assert.equal(broker.dispatch({type:'recover',now:clock.now()}).kind,'RECOVERED');
  assert.equal(new ScheduledRepository(db).replay(marketId,account.account.accountId).filter(row=>row.status==='OPEN').length,2);
  db.prepare("UPDATE listings SET price = '800' WHERE market_id = ? AND symbol = 'HGI'").run(marketId);clock.advanceBy(300000);assert.equal(broker.dispatch({type:'tick',now:clock.now()}).kind,'TICKED');
  const fills=db.prepare('SELECT side,price FROM fills ORDER BY sequence_no').all() as {side:string;price:string}[];assert.deepEqual(fills.map(row=>[row.side,row.price]),[['BUY','1000'],['SELL','800'],['BUY','800']]);
  const reservations=new ScheduledRepository(db).reservations(marketId,account.account.accountId);assert.equal(reservations.cash,0n);assert.equal([...reservations.shares.values()].some(q=>q.numerator!==0n),false);
  assert.equal(submit({orderType:'LIMIT',conditionPrice:'700',validForTicks:1}).kind,'ORDER_OPENED');clock.advanceBy(300000);assert.equal(broker.dispatch({type:'tick',now:clock.now()}).kind,'TICKED');assert.equal(new ScheduledRepository(db).replay(marketId,account.account.accountId).at(-1)?.status,'EXPIRED');
  process.stdout.write(JSON.stringify({status:'PASS',storage:'real SQLite',checks:['reservation replay','offline recovery','acceptance sequence','limit improvement','stop gap at actual price','expiry before evaluation','paired reservation release']})+'\n');
} finally {
  if(db.open) db.close();assert.equal(dirname(resolve(directory)),root);rmSync(directory,{recursive:true,force:true});
}
