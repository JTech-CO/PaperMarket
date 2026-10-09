import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test,{type TestContext} from 'node:test';
import { BrokerRepository } from '../src/broker/repository.js';
import { ScheduledRepository } from '../src/broker/scheduled.js';
import { FakeClock } from '../src/domain/clock.js';
import { parseMoney } from '../src/domain/numeric.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';
import { createInitialListings } from '../src/fixtures/initial-companies.js';
import type { ServiceContext,ServiceRequest,QuoteView,ScheduledOrderView } from '../src/application/contracts.js';
const user='222222222222222222',other='222222222222222223';
function fixture(t:TestContext,economic=false) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock('2026-10-04T00:00:00.000Z');const identityKey=randomBytes(32),economySeed=Buffer.alloc(32,17);
  if(economic) new FoundationRepository(db,clock).createMarket({marketId:'conditional-orders-economic',guildId:'111111111111111111',listings:createInitialListings()});
  let broker=new BrokerRepository(db,clock,{identityKey,...(economic?{economySeed}:{})});let sequence=333333333333333333n;
  const context=(owner=user,guild='111111111111111111'):ServiceContext=>({guildId:guild,discordUserId:owner,interactionId:(++sequence).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'});assert.equal(setup.kind,'SETUP');if(setup.kind!=='SETUP') throw new Error(JSON.stringify(setup));const marketId=setup.market.marketId;
  const open=(owner=user)=>{const r=broker.dispatch({type:'open',context:context(owner),age14Plus:true,agreeTerms:true});assert.equal(r.kind,'ACCOUNT');if(r.kind!=='ACCOUNT') throw new Error();return r.account.accountId;};
  const accountId=open();
  const preview=(input:Partial<Extract<ServiceRequest,{type:'quote'}>>={},owner=user):QuoteView=>{const r=broker.dispatch({type:'quote',context:context(owner),symbol:'HGI',side:'BUY',...(input.all||input.budget?{}:{quantity:'1'}),...input});assert.equal(r.kind,'QUOTE',JSON.stringify(r));if(r.kind!=='QUOTE') throw new Error();return r.quote;};
  const confirm=(q:QuoteView,owner=user)=>broker.dispatch({type:'confirm',context:context(owner),token:q.token});
  const pending=(input:Partial<Extract<ServiceRequest,{type:'quote'}>>={},owner=user):ScheduledOrderView=>{const r=confirm(preview({orderType:'LIMIT',conditionPrice:'900',...input},owner),owner);assert.equal(r.kind,'ORDER_OPENED',JSON.stringify(r));if(r.kind!=='ORDER_OPENED') throw new Error();return r.order;};
  const portfolio=(owner=user)=>{const r=broker.dispatch({type:'portfolio',context:context(owner)});assert.equal(r.kind,'PORTFOLIO',JSON.stringify(r));if(r.kind!=='PORTFOLIO') throw new Error();return r.portfolio;};
  const price=(value:string)=>db.prepare("UPDATE listings SET price = ? WHERE market_id = ? AND symbol = 'HGI'").run(value,marketId);
  const tick=()=>{clock.advanceBy(300000);const r=broker.dispatch({type:'tick',now:clock.now()});assert.equal(r.kind,'TICKED',JSON.stringify(r));return r;};
  const orders=()=>{const r=broker.dispatch({type:'orders',context:context()});assert.equal(r.kind,'ORDERS');if(r.kind!=='ORDERS') throw new Error();return r.orders;};
  return {db,clock,context,marketId,accountId,open,preview,confirm,pending,portfolio,price,tick,orders,get broker(){return broker;},restart(){broker=new BrokerRepository(db,clock,{identityKey,...(economic?{economySeed}:{})});}};
}
test('preview is unreserved; confirmation reserves worst-case cash and an immediately satisfied condition fills at current price',t=>{
  const f=fixture(t);const q=f.preview({orderType:'LIMIT',conditionPrice:'1100'});assert.equal(q.reservedCash,'1101.1');assert.equal(q.price,'1000');assert.equal(f.portfolio().reservedCash,'0');
  const r=f.confirm(q);assert.equal(r.kind,'FILLED');if(r.kind==='FILLED') {assert.equal(r.fill.price,'1000');assert.equal(r.fill.orderId,f.orders()[0]?.orderId);}assert.equal(f.portfolio().account.cash,'8999');assert.equal(f.portfolio().reservedCash,'0');assert.equal(f.orders()[0]?.status,'FILLED');
});
test('a resting limit reserves cash without changing equity and releases better-price surplus',t=>{
  const f=fixture(t);f.pending({quantity:'2'});const p=f.portfolio();assert.equal(p.account.cash,'10000');assert.equal(p.reservedCash,'1801.8');assert.equal(p.availableCash,'8198.2');assert.equal(p.equity,'10000');
  f.price('800');f.tick();const after=f.portfolio();assert.equal(after.account.cash,'8398.4');assert.equal(after.reservedCash,'0');assert.equal(after.positions[0]?.quantity,'2');assert.equal(f.orders()[0]?.status,'FILLED');
  const fill=f.db.prepare('SELECT price,total_atoms FROM fills').get() as {price:string;total_atoms:string};assert.equal(fill.price,'800');assert.equal(fill.total_atoms,parseMoney('1601.6').toString());f.restart();
});
test('reserved cash cannot be spent twice and reservations are excluded from budget buys',t=>{
  const f=fixture(t);f.pending({quantity:'10'});
  for(const input of [{quantity:'1'},{budget:'1000'}]) assert.deepEqual(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',...input}),{kind:'ERROR',code:'INSUFFICIENT_CASH'});
  assert.deepEqual(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',quantity:'2',orderType:'LIMIT',conditionPrice:'900'}),{kind:'ERROR',code:'INSUFFICIENT_CASH'});
});
test('stop sell reserves shares, prevents duplicate disposal, and a gap executes at 800 rather than the 900 trigger',t=>{
  const f=fixture(t);assert.equal(f.confirm(f.preview({quantity:'3'})).kind,'FILLED');f.pending({side:'SELL',orderType:'STOP',conditionPrice:'900',quantity:'2'});
  assert.equal(f.portfolio().positions[0]?.reservedQuantity,'2');assert.equal(f.portfolio().positions[0]?.availableQuantity,'1');
  assert.deepEqual(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'SELL',quantity:'2'}),{kind:'ERROR',code:'INSUFFICIENT_SHARES'});
  f.price('800');f.tick();const latest=f.db.prepare('SELECT price,quantity FROM fills ORDER BY sequence_no DESC LIMIT 1').get() as {price:string;quantity:string};assert.deepEqual(latest,{price:'800',quantity:'2'});assert.equal(f.portfolio().positions[0]?.quantity,'1');
});
test('sell-all uses only available shares and pending stock remains part of total ownership',t=>{
  const f=fixture(t);f.confirm(f.preview({quantity:'3'}));f.pending({side:'SELL',conditionPrice:'1200',quantity:'2'});
  const q=f.preview({side:'SELL',all:true});assert.equal(q.quantity,'1');f.confirm(q);assert.equal(f.portfolio().positions[0]?.quantity,'2');assert.equal(f.portfolio().positions[0]?.availableQuantity,'0');
});
test('expiry at the exact tick happens before a favorable new price; until-cancelled survives subsequent ticks',t=>{
  const f=fixture(t);const first=f.pending({validForTicks:1});const later=f.pending({conditionPrice:'700',timeInForce:'UNTIL_CANCELLED'});f.price('800');f.tick();
  assert.equal(f.orders().find(o=>o.orderId===first.orderId)?.status,'EXPIRED');assert.equal(f.orders().find(o=>o.orderId===later.orderId)?.status,'OPEN');assert.equal(f.db.prepare('SELECT count(*) FROM fills').pluck().get(),0);assert.equal(f.portfolio().reservedCash,'700.7');
});
test('owned cancellation is idempotent, releases exactly once, and does not reveal another owner or guild order',t=>{
  const f=fixture(t);f.open(other);const order=f.pending();
  assert.deepEqual(f.broker.dispatch({type:'cancel-order',context:f.context(other),orderId:order.orderId}),{kind:'ERROR',code:'INTENT_NOT_FOUND'});
  assert.deepEqual(f.broker.dispatch({type:'cancel-order',context:f.context(user,'111111111111111112'),orderId:order.orderId}),{kind:'ERROR',code:'MARKET_NOT_FOUND'});
  const context=f.context();const request={type:'cancel-order' as const,context,orderId:order.orderId};assert.equal(f.broker.dispatch(request).kind,'SCHEDULED_CANCELLED');assert.equal(f.broker.dispatch(request).kind,'SCHEDULED_CANCELLED');
  assert.equal(f.broker.dispatch({...request,context:f.context()}).kind,'SCHEDULED_CANCELLED');assert.equal(f.portfolio().reservedCash,'0');assert.equal(f.db.prepare('SELECT count(*) FROM reservation_journal').pluck().get(),2);f.restart();
});
test('confirmation nonce retries return current order state without duplicating reservation or fills',t=>{
  const f=fixture(t);const q=f.preview({orderType:'LIMIT',conditionPrice:'900'});const context=f.context();const request={type:'confirm' as const,context,token:q.token};assert.equal(f.broker.dispatch(request).kind,'ORDER_OPENED');assert.equal(f.broker.dispatch(request).kind,'ORDER_OPENED');assert.equal(f.confirm(q).kind,'ORDER_OPENED');
  f.price('800');f.tick();assert.equal(f.broker.dispatch(request).kind,'FILLED');assert.equal(f.confirm(q).kind,'FILLED');assert.equal(f.db.prepare('SELECT count(*) FROM fills').pluck().get(),1);assert.equal(f.db.prepare('SELECT count(*) FROM reservation_journal').pluck().get(),2);
});
test('stale previews never reserve and duration/input bounds are validated on the server',t=>{
  const f=fixture(t);const q=f.preview({orderType:'LIMIT',conditionPrice:'900'});f.pending();assert.deepEqual(f.confirm(q),{kind:'ERROR',code:'STALE_QUOTE'});
  for(const input of [{orderType:'STOP',conditionPrice:'900'},{orderType:'MARKET',conditionPrice:'900'},{orderType:'LIMIT',conditionPrice:'900',validForTicks:0},{orderType:'LIMIT',conditionPrice:'900',validForTicks:10001},{orderType:'LIMIT',conditionPrice:'900',timeInForce:'UNTIL_CANCELLED',validForTicks:2},{orderType:'LIMIT',conditionPrice:'0'},{orderType:'LIMIT',conditionPrice:'900',all:false}]) {
    const result=f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',quantity:'1',...input} as ServiceRequest);assert.equal(result.kind,'ERROR',JSON.stringify(input));
  }
});
test('same-account acceptance sequence determines boundary fills while other account reservations are independent',t=>{
  const f=fixture(t);f.open(other);f.pending({quantity:'2'});f.pending({quantity:'1'});f.pending({quantity:'3'},other);f.price('800');f.tick();
  const fills=f.db.prepare('SELECT account_id,quantity FROM fills ORDER BY sequence_no').all() as {account_id:string;quantity:string}[];
  assert.deepEqual(fills.filter(x=>x.account_id===f.accountId).map(x=>x.quantity),['2','1']);assert.equal(f.portfolio(other).positions[0]?.quantity,'3');
});
test('all live orders execute even when the display lists only the most recent 25',t=>{
  const f=fixture(t);for(let i=0;i<28;i++) f.pending({quantity:'0.000001'});assert.equal(f.orders().length,25);f.price('800');f.tick();assert.equal(f.db.prepare('SELECT count(*) FROM fills').pluck().get(),28);assert.equal(f.portfolio().reservedCash,'0');
});
test('restart and recovery exclude offline time from order tick expiry',t=>{
  const f=fixture(t);f.pending({validForTicks:2});f.clock.advanceBy(1000);f.portfolio();f.restart();f.clock.advanceBy(86400000);assert.equal(f.broker.dispatch({type:'recover',now:f.clock.now()}).kind,'RECOVERED');assert.equal(f.orders()[0]?.status,'OPEN');f.tick();assert.equal(f.orders()[0]?.status,'OPEN');f.tick();assert.equal(f.orders()[0]?.status,'EXPIRED');
});
test('account closure cancels live reservations and preserves financial records behind a tombstone',t=>{
  const f=fixture(t);f.pending();const close=f.broker.dispatch({type:'close',context:f.context(),confirmed:true});assert.equal(close.kind,'CLOSED');
  assert.equal(f.db.prepare('SELECT status FROM scheduled_orders').pluck().get(),'CANCELLED');assert.equal(f.db.prepare('SELECT termination_reason FROM scheduled_orders').pluck().get(),'ACCOUNT_CLOSED');
  assert.equal(JSON.stringify(f.db.prepare('SELECT * FROM reservation_journal').all()).includes(user),false);assert.equal(f.db.prepare('SELECT count(*) FROM trade_commands WHERE actor_hash IN (SELECT actor_hash FROM scheduled_orders)').pluck().get(),0);f.restart();assert.deepEqual(f.broker.dispatch({type:'orders',context:f.context()}),{kind:'ERROR',code:'ACCOUNT_CLOSED'});
});
test('closure preserves a corporate cancellation reference while destroying its original nonce and Discord identity',t=>{
  const f=fixture(t);const q=f.preview();f.db.prepare("UPDATE order_intents SET status='CANCELLED' WHERE intent_id=?").run(q.orderIntentId);
  f.db.prepare("INSERT INTO corporate_order_cancellations(market_id,account_id,intent_id,action_id,reason) VALUES(?,?,?,?,'CORPORATE_ACTION_CANCELLED')").run(f.marketId,f.accountId,q.orderIntentId,'test_ex');
  assert.equal(f.broker.dispatch({type:'close',context:f.context(),confirmed:true}).kind,'CLOSED');assert.equal(f.db.prepare('SELECT count(*) FROM corporate_order_cancellations').pluck().get(),1);assert.notEqual(f.db.prepare('SELECT token FROM order_intents WHERE intent_id=?').pluck().get(q.orderIntentId),q.token);assert.notEqual(f.db.prepare('SELECT discord_user_id FROM accounts').pluck().get(),user);f.restart();
});
test('immutable reservation terms and journal counterpart checks detect tampering before any further trade',t=>{
  const f=fixture(t);f.pending();assert.throws(()=>f.db.prepare("UPDATE scheduled_orders SET quantity='2'").run(),/immutable/);assert.throws(()=>f.db.prepare("DELETE FROM reservation_journal").run(),/append-only/);
  f.db.exec('DROP TRIGGER reservation_journal_no_update');f.db.prepare("UPDATE reservation_journal SET system_cash_delta_atoms='0'").run();assert.throws(()=>new ScheduledRepository(f.db).replay(f.marketId,f.accountId));assert.deepEqual(f.broker.dispatch({type:'portfolio',context:f.context()}),{kind:'ERROR',code:'INTEGRITY_ERROR'});
});
test('a failed reservation release rolls back the complete boundary, its fill and cash journals',t=>{
  const f=fixture(t);f.pending();f.price('800');f.db.exec("CREATE TRIGGER test_reservation_abort BEFORE INSERT ON reservation_journal BEGIN SELECT RAISE(ABORT,'test failure'); END");f.clock.advanceBy(300000);
  assert.equal(f.broker.dispatch({type:'tick',now:f.clock.now()}).kind,'ERROR');assert.equal(f.db.prepare('SELECT tick_no FROM markets').pluck().get(),0);assert.equal(f.db.prepare('SELECT count(*) FROM fills').pluck().get(),0);assert.equal(f.db.prepare('SELECT status FROM scheduled_orders').pluck().get(),'OPEN');assert.equal(f.portfolio().account.cash,'10000');
});
test('reserved cash still earns the full tick interest in the economic market',t=>{
  const f=fixture(t,true);const q=f.preview({orderType:'LIMIT',conditionPrice:'1',quantity:'1000'});assert.equal(f.confirm(q).kind,'ORDER_OPENED');f.tick();const p=f.portfolio();assert.equal(p.reservedCash,'1001');assert.ok(parseMoney(p.account.cash)>parseMoney('10000'));assert.ok(parseMoney(p.cashInterestTotal??'0')>0n);f.restart();
});
test('an economic failure rolls expiry, interest and reservation release back together and pauses the market',t=>{
  const f=fixture(t,true);f.pending({conditionPrice:'1',validForTicks:1});f.db.exec("CREATE TRIGGER test_snapshot_abort BEFORE INSERT ON economy_snapshots BEGIN SELECT RAISE(ABORT,'test failure'); END");f.clock.advanceBy(300000);
  assert.deepEqual(f.broker.dispatch({type:'tick',now:f.clock.now()}),{kind:'ERROR',code:'INTEGRITY_ERROR'});assert.equal(f.db.prepare('SELECT state FROM markets').pluck().get(),'PAUSED');assert.equal(f.db.prepare('SELECT tick_no FROM markets').pluck().get(),0);assert.equal(f.orders()[0]?.status,'OPEN');assert.equal(f.portfolio().reservedCash,'1.001');assert.equal(f.db.prepare('SELECT count(*) FROM reservation_journal').pluck().get(),1);assert.equal(f.db.prepare("SELECT count(*) FROM cash_journal WHERE entry_type='INTEREST'").pluck().get(),0);
});
test('real dividend ex-date releases all live conditions, preserves reserved-share ownership and gives expiry precedence',t=>{
  const f=fixture(t,true);assert.equal(f.confirm(f.preview({symbol:'DNL',quantity:'2'})).kind,'FILLED');for(let tick=1;tick<=64;tick++) f.tick();
  const expiring=f.pending({symbol:'DNL',side:'SELL',conditionPrice:'100000',validForTicks:3});
  const stop=f.pending({symbol:'DNL',side:'SELL',orderType:'STOP',conditionPrice:'1',timeInForce:'UNTIL_CANCELLED'});
  const buy=f.pending({symbol:'DNL',conditionPrice:'1',timeInForce:'UNTIL_CANCELLED'});assert.equal(f.portfolio().positions.find(p=>p.symbol==='DNL')?.reservedQuantity,'2');
  f.tick();f.tick();f.tick();const orders=f.orders();assert.equal(orders.find(o=>o.orderId===expiring.orderId)?.terminationReason,'EXPIRED');
  for(const order of [stop,buy]) assert.equal(orders.find(o=>o.orderId===order.orderId)?.terminationReason,'CORPORATE_ACTION_CANCELLED');
  const p=f.portfolio();assert.equal(p.reservedCash,'0');assert.equal(p.positions.find(p=>p.symbol==='DNL')?.reservedQuantity,'0');assert.equal(p.positions.find(p=>p.symbol==='DNL')?.quantity,'2');assert.equal(p.rights?.find(right=>right.kind==='DIVIDEND'&&right.symbol==='DNL')?.quantity,'2');
  f.restart();assert.equal(f.orders().filter(o=>o.status==='OPEN').length,0);
});
