import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import type { Backend, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { FakeClock } from '../src/domain/clock.js';
import { NotificationPublisher, notificationRetryAfterMs, renderNotification } from '../src/notifications/publisher.js';
import type { NotificationDelivery } from '../src/notifications/types.js';

function delivery():NotificationDelivery {
  return {jobId:randomUUID(),leaseToken:randomUUID(),discordUserId:'222222222222222222',guildId:'111111111111111111',attempts:1,
    notification:{notificationId:randomUUID(),kind:'SCHEDULED_FILLED',symbol:'HGI',title:'예약 주문 체결',summary:'HGI 현재 확정 시세로 체결했습니다.',read:false,tickNo:10,marketVersion:11,createdAt:'2026-10-05T00:00:00.000Z'}};
}
function backend(job:NotificationDelivery) {
  const requests:ServiceRequest[]=[];let authorized=true,queued=true,ackFailure=false;
  const service:Backend={async execute(request):Promise<ServiceResponse> {
    requests.push(request);
    switch(request.type) {
      case 'notification-poll':return {kind:'NOTIFICATION_BATCH',deliveries:queued?[job]:[]};
      case 'notification-check':return {kind:'NOTIFICATION_AUTHORIZED',authorized};
      case 'notification-ack':if(ackFailure) return {kind:'ERROR',code:'INTERNAL_ERROR'};queued=!request.delivered;return {kind:'NOTIFICATION_ACK',accepted:true};
      case 'tick':return {kind:'TICKED',markets:[]};
      default:return {kind:'ERROR',code:'INVALID_INPUT'};
    }
  }};
  return {service,requests,withdraw(){authorized=false;},failAck(){ackFailure=true;}};
}

test('personal delivery polls stored facts and never invokes a financial request or original interaction',async()=>{
  const job=delivery(),b=backend(job),sent:NotificationDelivery[]=[];
  const publisher=new NotificationPublisher(b.service,async item=>{sent.push(item);});
  await publisher.flush();await publisher.flush();assert.equal(sent.length,1);
  assert.deepEqual(b.requests.map(request=>request.type),['notification-poll','notification-check','notification-ack','notification-poll']);
  assert.equal(JSON.stringify(b.requests).includes('interaction'),false);
});

test('withdrawal after polling is rechecked immediately before external delivery',async()=>{
  const b=backend(delivery());let sent=0;b.withdraw();
  const publisher=new NotificationPublisher(b.service,async()=>{sent++;});await publisher.flush();
  assert.equal(sent,0);assert.equal(b.requests.some(request=>request.type==='notification-ack'),false);
});

test('slow DM delivery neither blocks tick execution nor creates concurrent sends',async()=>{
  const b=backend(delivery());let release!:()=>void,sent=0;
  const waiting=new Promise<void>(resolve=>{release=resolve;});
  const publisher=new NotificationPublisher(b.service,async()=>{sent++;await waiting;});
  const sending=publisher.flush();await new Promise<void>(resolve=>setImmediate(resolve));
  const tick=await b.service.execute({type:'tick',now:'2026-10-05T00:05:00.000Z'});assert.equal(tick.kind,'TICKED');
  await publisher.flush();assert.equal(sent,1);release();await sending;
});

test('429 Retry-After is persisted in the acknowledgement and only the outbox retries',async()=>{
  const clock=new FakeClock('2026-10-05T00:00:00.000Z'),b=backend(delivery());let errors=0;
  const publisher=new NotificationPublisher(b.service,async()=>{throw {status:429,rawError:{retry_after:2.5}};},{now:()=>clock.now(),onFailure:()=>{errors++;}});
  await publisher.flush();const ack=b.requests.find(request=>request.type==='notification-ack');assert.ok(ack&&ack.type==='notification-ack');assert.equal(ack.delivered,false);assert.equal(ack.retryAfterMs,2500);assert.equal(errors,1);
  assert.equal(b.requests.some(request=>request.type==='tick'||request.type==='confirm'),false);
  assert.equal(notificationRetryAfterMs({rateLimitData:{retryAfter:99}}),99);assert.equal(notificationRetryAfterMs({status:429,retryAfter:Infinity}),undefined);
  assert.equal(notificationRetryAfterMs({status:429,retryAfter:999_999_999}),86_400_000);
});

test('lost acknowledgement permits a duplicate with the same visible event identity',async()=>{
  const b=backend(delivery()),ids:string[]=[];b.failAck();
  const first=new NotificationPublisher(b.service,async item=>{ids.push(item.notification.notificationId);});await first.flush();
  const restored=new NotificationPublisher(b.service,async item=>{ids.push(item.notification.notificationId);});await restored.flush();
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);
});

test('stopping or bounded delivery timeout leaves a retryable stored job',async()=>{
  const b=backend(delivery());const stopped=new NotificationPublisher(b.service,async()=>{});stopped.stop();await stopped.flush();assert.equal(b.requests.length,0);
  const bounded=new NotificationPublisher(b.service,async()=>new Promise<void>(()=>{}),{timeoutMs:5});
  const keepAlive=setTimeout(()=>{},50);await bounded.flush();clearTimeout(keepAlive);
  const ack=b.requests.find(request=>request.type==='notification-ack');assert.ok(ack&&ack.type==='notification-ack');assert.equal(ack.delivered,false);
  assert.throws(()=>new NotificationPublisher(b.service,async()=>{},{timeoutMs:30_000}));
});

test('DM renderer is neutral, mention-safe, bounded and carries committed version and event identity',()=>{
  const job=delivery();const unsafe={...job,notification:{...job.notification,title:'@everyone **제목**',summary:'<@222222222222222222> [내용](javascript:x)'}};
  const rendered=renderNotification(unsafe),json=rendered.embeds[0]!.toJSON();
  assert.deepEqual(rendered.allowedMentions,{parse:[]});assert.equal(json.description?.includes('@\u200b'),true);
  assert.equal(json.description?.includes('[내용]'),false);assert.ok(json.footer?.text.includes(`T10 · 버전 11 · 알림 ${job.notification.notificationId}`));
  assert.equal(JSON.stringify(rendered).includes('discordUserId'),false);
});
