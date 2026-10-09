import { EmbedBuilder } from 'discord.js';
import type { Backend } from '../application/contracts.js';
import type { NotificationDelivery } from './types.js';

export interface NotificationPublisherOptions {
  readonly now?:()=>string;
  readonly onFailure?:()=>void;
  readonly timeoutMs?:number;
  readonly onRetryAfter?:()=>void;
}

/** Discord REST normally applies Retry-After itself. Preserve it when an adapter returns a 429. */
export function notificationRetryAfterMs(error: unknown): number|undefined {
  if(!error || typeof error!=='object') return undefined;
  const record=error as Record<string,unknown>;
  const nested=record['rateLimitData'];
  const rate=nested&&typeof nested==='object'?(nested as Record<string,unknown>)['retryAfter']:undefined;
  const raw=record['rawError'];
  const seconds=raw&&typeof raw==='object'?(raw as Record<string,unknown>)['retry_after']:record['retry_after'];
  const value=typeof rate==='number'?rate:typeof seconds==='number'?seconds*1000:record['status']===429?record['retryAfter']:undefined;
  return typeof value==='number'&&Number.isFinite(value)&&value>0?Math.min(86_400_000,Math.max(1,Math.ceil(value))):undefined;
}

export function renderNotification(delivery: NotificationDelivery): {embeds:EmbedBuilder[];allowedMentions:{parse:[]}} {
  const item=delivery.notification;
  const escape=(text:string)=>text.replace(/[\\`*_{}[\]()<>|~]/g,'\\$&').replace(/@/g,'@\u200b');
  const embed=new EmbedBuilder().setColor(0x65758b).setTitle(escape(item.title).slice(0,100))
    .setDescription(escape(item.summary).slice(0,1200))
    .setFooter({text:`가상 시장 · 실거래 아님 · T${item.tickNo} · 버전 ${item.marketVersion} · 알림 ${item.notificationId}`})
    .setTimestamp(new Date(item.createdAt));
  return {embeds:[embed],allowedMentions:{parse:[]}};
}

/** Poll, deliver and acknowledge independently from ticks. Delivery can repeat after a lost acknowledgement. */
export class NotificationPublisher {
  readonly #backend:Backend;
  readonly #deliver:(delivery:NotificationDelivery)=>Promise<void>;
  readonly #now:()=>string;
  readonly #onFailure:()=>void;
  readonly #timeoutMs:number;
  readonly #onRetryAfter:(()=>void)|undefined;
  #running=false;
  #stopped=false;
  constructor(backend:Backend, deliver:(delivery:NotificationDelivery)=>Promise<void>, options:NotificationPublisherOptions={}) {
    this.#backend=backend;this.#deliver=deliver;this.#now=options.now??(()=>new Date().toISOString());
    this.#onFailure=options.onFailure??(()=>undefined);this.#timeoutMs=options.timeoutMs??10_000;
    this.#onRetryAfter=options.onRetryAfter;
    if(!Number.isSafeInteger(this.#timeoutMs)||this.#timeoutMs<1||this.#timeoutMs>20_000) throw new RangeError('Invalid notification delivery timeout');
  }
  stop():void {this.#stopped=true;}
  async flush():Promise<void> {
    if(this.#stopped||this.#running) return;
    this.#running=true;
    try {
      // Lease one job just before delivery so a slow recipient does not exhaust a whole batch's leases.
      const result=await this.#backend.execute({type:'notification-poll',now:this.#now(),limit:1});
      if(result.kind!=='NOTIFICATION_BATCH') {if(result.kind==='ERROR') this.#onFailure();return;}
      for(const delivery of result.deliveries) {
        if(this.#stopped) break;
        const permitted=await this.#backend.execute({type:'notification-check',now:this.#now(),jobId:delivery.jobId,leaseToken:delivery.leaseToken});
        if(permitted.kind!=='NOTIFICATION_AUTHORIZED'||!permitted.authorized) continue;
        let timer:ReturnType<typeof setTimeout>|undefined;
        let delivered=false,retryAfterMs:number|undefined;
        try {
          await Promise.race([this.#deliver(delivery),new Promise<never>((_,reject)=>{
            timer=setTimeout(()=>reject(new Error('Notification delivery timed out')),this.#timeoutMs);timer.unref();
          })]);
          delivered=true;
        } catch(error) {retryAfterMs=notificationRetryAfterMs(error);if(retryAfterMs!==undefined){try{this.#onRetryAfter?.();}catch{}}this.#onFailure();}
        finally {if(timer) clearTimeout(timer);}
        const ack=await this.#backend.execute({type:'notification-ack',now:this.#now(),jobId:delivery.jobId,leaseToken:delivery.leaseToken,delivered,...(retryAfterMs===undefined?{}:{retryAfterMs})});
        if(ack.kind==='ERROR') this.#onFailure();
      }
    } catch {this.#onFailure();}
    finally {this.#running=false;}
  }
}
