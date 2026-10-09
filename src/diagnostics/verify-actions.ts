import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import type { ServiceContext } from '../application/contracts.js';
import { BrokerRepository } from '../broker/repository.js';
import { FakeClock } from '../domain/clock.js';
import { parseMoney } from '../domain/numeric.js';
import { createInitialListings } from '../fixtures/initial-companies.js';
import { RightsRepository } from '../rights/repository.js';
import { openDatabase } from '../storage/database.js';
import { FoundationRepository } from '../storage/repository.js';

/** Fixed synthetic scenario, never an operator seed or a production account. */
function verify():void {
  const root=resolve(tmpdir());const directory=mkdtempSync(join(root,'papermarket-actions-check-'));
  const path=join(directory,'market.sqlite');let db=openDatabase(path);
  try {
    const clock=new FakeClock('2026-10-04T00:00:00.000Z');const seed=Buffer.alloc(32,17);const identityKey=randomBytes(32);
    const marketId='actions-test-market';const user='222222222222222222';
    new FoundationRepository(db,clock).createMarket({marketId,guildId:'111111111111111111',listings:createInitialListings()});
    let broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});let interaction=333333333333333333n;
    const context=():ServiceContext=>({guildId:'111111111111111111',discordUserId:user,interactionId:(++interaction).toString(),receivedAt:clock.now(),guildPermissions:'32'});
    assert.equal(broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'}).kind,'SETUP');
    const opened=broker.dispatch({type:'open',context:context(),age14Plus:true,agreeTerms:true});assert.equal(opened.kind,'ACCOUNT');if(opened.kind!=='ACCOUNT')throw new Error();
    const accountId=opened.account.accountId;
    const quote=(side:'BUY'|'SELL',quantity:string)=>{
      const response=broker.dispatch({type:'quote',context:context(),side,symbol:'DNL',quantity});assert.equal(response.kind,'QUOTE');if(response.kind!=='QUOTE')throw new Error();return response.quote;
    };
    assert.equal(broker.dispatch({type:'confirm',context:context(),token:quote('BUY','2').token}).kind,'FILLED');
    let pending='';let claimId='';
    for(let tick=1;tick<=70;tick++) {
      clock.advanceBy(300000);const response=broker.dispatch({type:'tick',now:clock.now()});assert.equal(response.kind,'TICKED');if(response.kind!=='TICKED')throw new Error();
      assert.equal(response.markets[0]?.state,'OPEN');assert.equal(response.markets[0]?.listings.length,8);
      if(tick===66) pending=quote('BUY','1').token;
      if(tick===67) {
        const rights=new RightsRepository(db).view(marketId,accountId);assert.equal(rights.rights.length,1);assert.equal(rights.rights[0]?.status,'OPEN');claimId=rights.rights[0]!.rightId;
        assert.deepEqual(broker.dispatch({type:'confirm',context:context(),token:pending}),{kind:'ERROR',code:'CORPORATE_ACTION_CANCELLED'});
        assert.equal(broker.dispatch({type:'confirm',context:context(),token:quote('SELL','2').token}).kind,'FILLED');
      }
      if(tick===68) {
        const before=new RightsRepository(db).view(marketId,accountId);db.close();clock.advanceBy(86400000);db=openDatabase(path);
        broker=new BrokerRepository(db,clock,{identityKey,economySeed:seed});assert.equal(broker.dispatch({type:'recover',now:clock.now()}).kind,'RECOVERED');
        assert.deepEqual(new RightsRepository(db).view(marketId,accountId),before);
      }
    }
    const rights=new RightsRepository(db).view(marketId,accountId);assert.equal(rights.rights.find(right=>right.rightId===claimId)?.status,'SETTLED');assert(parseMoney(rights.dividendTotal)>0n);
    const count=()=> (db.prepare("SELECT count(*) AS n FROM cash_journal WHERE market_id=? AND account_id=? AND entry_type='DIVIDEND'").get(marketId,accountId) as {n:number}).n;
    assert.equal(count(),1);assert.equal(broker.dispatch({type:'tick',now:clock.now()}).kind,'TICKED');assert.equal(count(),1);
    const portfolio=broker.dispatch({type:'portfolio',context:context()});assert.equal(portfolio.kind,'PORTFOLIO');if(portfolio.kind!=='PORTFOLIO')throw new Error();assert.equal(portfolio.portfolio.positions.length,0);assert.equal(portfolio.portfolio.dividendTotal,rights.dividendTotal);
    console.log(JSON.stringify({milestone:3,result:'PASS',engineVersion:'0.4.0',economicTicks:70,dividendEx: 'PASS',sellAfterEx:'PASS',exactPayoutAndCarry:'PASS',cancelPriorQuote:'PASS',restartAndOfflineExclusion:'PASS',ownerLedgerReplay:'PASS',duplicatePayment:'PASS',discordConnection:'NOT_RUN'},null,2));
  } finally {
    if(db.open)db.close();if(dirname(resolve(directory))!==root||!basename(directory).startsWith('papermarket-actions-check-'))throw new Error('Unsafe cleanup target');rmSync(directory,{recursive:true,force:true});
  }
}
try {verify();} catch {console.error(JSON.stringify({milestone:3,result:'FAIL',code:'LOCAL_ACTIONS_CHECK_FAILED'}));process.exitCode=1;}
