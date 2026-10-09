import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { FundingView } from '../application/contracts.js';
import { moneyFromAtoms, moneyToString } from '../domain/numeric.js';
import { LedgerIntegrityError } from '../storage/replay.js';

export const CONTRIBUTION_INTERVAL_TICKS = 21;
export const CONTRIBUTION_AMOUNT_ATOMS = 1_000_000_000_000_000n;
const planSchema = z.strictObject({market_id:z.string(),account_id:z.string(),start_tick:z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),interval_ticks:z.literal(21),amount_atoms:z.literal('1000000000000000'),enabled:z.union([z.literal(0),z.literal(1)])});
export interface ContributionOwner {readonly marketId:string;readonly accountId:string;readonly discordUserId:string}

/** Only the writer creates deposits; clients can select whether future deposits continue. */
export class ContributionRepository {
  constructor(private readonly db:Database.Database) {}

  initialize(marketId:string,accountId:string,tick:number):void {
    this.db.prepare('INSERT OR IGNORE INTO account_contribution_plans(market_id,account_id,start_tick,interval_ticks,amount_atoms,enabled) VALUES(?,?,?,21,?,1)')
      .run(marketId,accountId,tick,CONTRIBUTION_AMOUNT_ATOMS.toString());
  }
  private plan(owner:ContributionOwner,tick:number) {
    const raw=this.db.prepare("SELECT p.* FROM account_contribution_plans p JOIN accounts a ON a.market_id=p.market_id AND a.account_id=p.account_id WHERE p.market_id=? AND p.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE'")
      .get(owner.marketId,owner.accountId,owner.discordUserId);
    const parsed=planSchema.safeParse(raw);
    if(!parsed.success||parsed.data.start_tick>tick)throw new LedgerIntegrityError('Contribution plan missing or invalid.');
    return parsed.data;
  }
  set(owner:ContributionOwner,tick:number,enabled:boolean):void {
    const plan=this.plan(owner,tick);
    if(Boolean(plan.enabled)===enabled)return;
    const changed=this.db.prepare("UPDATE account_contribution_plans SET enabled=?,start_tick=? WHERE market_id=? AND account_id=? AND EXISTS(SELECT 1 FROM accounts a WHERE a.market_id=account_contribution_plans.market_id AND a.account_id=account_contribution_plans.account_id AND a.discord_user_id=? AND a.status='ACTIVE')")
      .run(enabled?1:0,tick,owner.marketId,owner.accountId,owner.discordUserId);
    if(changed.changes!==1)throw new LedgerIntegrityError();
  }
  view(owner:ContributionOwner,tick:number):FundingView {
    const plan=this.plan(owner,tick);
    const rows=this.db.prepare("SELECT c.account_delta_atoms FROM cash_journal c JOIN accounts a ON a.market_id=c.market_id AND a.account_id=c.account_id WHERE c.market_id=? AND c.account_id=? AND a.discord_user_id=? AND a.status='ACTIVE' AND c.entry_type='CONTRIBUTION'")
      .all(owner.marketId,owner.accountId,owner.discordUserId) as {account_delta_atoms:string}[];
    const contributions=rows.reduce((sum,row)=>sum+BigInt(moneyFromAtoms(row.account_delta_atoms)),0n);
    const candidate=plan.start_tick+(Math.floor((tick-plan.start_tick)/plan.interval_ticks)+1)*plan.interval_ticks;
    return {enabled:Boolean(plan.enabled),amount:moneyToString(moneyFromAtoms(plan.amount_atoms)),intervalTicks:plan.interval_ticks,startTick:plan.start_tick,
      nextContributionTick:plan.enabled&&Number.isSafeInteger(candidate)?candidate:null,contributions:moneyToString(moneyFromAtoms(contributions.toString()))};
  }
  due(marketId:string,tick:number):ContributionOwner[] {
    const rows=this.db.prepare("SELECT p.*,a.discord_user_id FROM account_contribution_plans p JOIN accounts a ON a.market_id=p.market_id AND a.account_id=p.account_id WHERE p.market_id=? AND a.status='ACTIVE' AND p.enabled=1 ORDER BY p.account_id").all(marketId) as Array<z.infer<typeof planSchema>&{discord_user_id:string}>;
    return rows.filter(row=>{
      const {discord_user_id:_identity,...raw}=row;const plan=planSchema.parse(raw);
      if(plan.start_tick>tick)throw new LedgerIntegrityError();
      return tick>plan.start_tick&&(tick-plan.start_tick)%plan.interval_ticks===0;
    }).map(row=>({marketId,accountId:row.account_id,discordUserId:row.discord_user_id}));
  }
}
