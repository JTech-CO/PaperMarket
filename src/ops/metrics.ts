import Database from 'better-sqlite3';

export const DURATION_METRICS=['queryMs','financialMs','tickMs','backgroundMs','workerServiceMs','queueAndTransportMs','deferMs','backupMs'] as const;
export const COUNTER_METRICS=['requests','errors','gateBusy','databaseBusy','integrityFailures','zeroCorporateReference','notificationFailures','discord429','backupFailures'] as const;
type DurationMetric=typeof DURATION_METRICS[number];
type CounterMetric=typeof COUNTER_METRICS[number];

/** Bounded local telemetry: fixed names and numbers only, never labels derived from user input or identifiers. */
export class OperationalMetrics {
  readonly #durations=new Map<DurationMetric,{count:number;values:number[]}>();
  readonly #counters=new Map<CounterMetric,number>();
  observe(name:DurationMetric,value:number):void {
    if(!DURATION_METRICS.includes(name)||!Number.isFinite(value)||value<0||value>86_400_000)return;
    const row=this.#durations.get(name)??{count:0,values:[]};row.count++;row.values.push(value);
    if(row.values.length>1024)row.values.shift();this.#durations.set(name,row);
  }
  increment(name:CounterMetric):void {
    if(COUNTER_METRICS.includes(name))this.#counters.set(name,(this.#counters.get(name)??0)+1);
  }
  snapshot():{counters:Partial<Record<CounterMetric,number>>;durations:Partial<Record<DurationMetric,{count:number;windowCount:number;p50:number;p95:number;max:number}>>} {
    const durations:Partial<Record<DurationMetric,{count:number;windowCount:number;p50:number;p95:number;max:number}>>={};
    for(const [name,row] of this.#durations){const values=row.values.toSorted((a,b)=>a-b);const at=(p:number)=>values[Math.max(0,Math.ceil(values.length*p)-1)]!;
      durations[name]={count:row.count,windowCount:values.length,p50:at(.5),p95:at(.95),max:values.at(-1)!};}
    return {counters:Object.fromEntries(this.#counters),durations};
  }
}

/** Local operator aggregate. Opens SQLite read-only; contains no account, guild, notification or host identifiers. */
export function readOperationalState(databasePath:string,now=new Date().toISOString()):{
  status:'OK'|'DEGRADED';markets:number;pausedMarkets:number;pendingNotifications:number;oldestNotificationLagMs:number;
  unpaidDividendRights:number;defaultEvents:number;replacementEvents:number;
} {
  const at=Date.parse(now);if(!Number.isFinite(at))throw new RangeError('Invalid operational clock');
  const db=new Database(databasePath,{readonly:true,fileMustExist:true,timeout:1000});
  try {
    const markets=db.prepare("SELECT count(*) total,sum(CASE WHEN state IN ('PAUSED','RECOVERING') THEN 1 ELSE 0 END) paused FROM markets WHERE state<>'ARCHIVED'").get() as {total:number;paused:number|null};
    const pending=db.prepare("SELECT count(*) total,min(i.created_at) oldest FROM notification_outbox o JOIN notification_inbox i ON i.notification_id=o.notification_id WHERE o.status IN ('PENDING','LEASED')").get() as {total:number;oldest:string|null};
    const rights=db.prepare("SELECT count(*) total FROM rights_journal r WHERE json_extract(r.state_json,'$.kind')='DIVIDEND' AND json_extract(r.state_json,'$.status') IN ('OPEN','ATTACHED') AND NOT EXISTS (SELECT 1 FROM rights_journal later WHERE later.market_id=r.market_id AND later.account_id=r.account_id AND later.right_id=r.right_id AND later.rowid>r.rowid)").get() as {total:number};
    const actions=db.prepare("SELECT sum(CASE WHEN json_extract(action_json,'$.kind')='LIQUIDATION_STARTED' THEN 1 ELSE 0 END) defaults,sum(CASE WHEN json_extract(action_json,'$.kind')='REPLACEMENT' THEN 1 ELSE 0 END) replacements FROM corporate_actions").get() as {defaults:number|null;replacements:number|null};
    const paused=markets.paused??0;
    return {status:paused?'DEGRADED':'OK',markets:markets.total,pausedMarkets:paused,pendingNotifications:pending.total,
      oldestNotificationLagMs:pending.oldest?Math.max(0,at-Date.parse(pending.oldest)):0,unpaidDividendRights:rights.total,
      defaultEvents:actions.defaults??0,replacementEvents:actions.replacements??0};
  } finally {db.close();}
}
export type OperationalState=ReturnType<typeof readOperationalState>;
