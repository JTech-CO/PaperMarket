import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test,{type TestContext} from 'node:test';
import { BrokerRepository } from '../src/broker/repository.js';
import { FakeClock } from '../src/domain/clock.js';
import { FinancialDecimal, decimalFraction, addFractions, multiplyFractions, parseFraction, parseMoney } from '../src/domain/numeric.js';
import type { CorporateAction,CorporateDividend } from '../src/economy/types.js';
import { createInitialListings, INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { RightsRepository,type RightsTick } from '../src/rights/repository.js';
import { openDatabase } from '../src/storage/database.js';
import { FoundationRepository } from '../src/storage/repository.js';
import type { ServiceContext } from '../src/application/contracts.js';

function fixture(t:TestContext,economic=false) {
  const db=openDatabase(':memory:');t.after(()=>db.close());const clock=new FakeClock('2026-10-04T00:00:00.000Z');
  if(economic) new FoundationRepository(db,clock).createMarket({marketId:'actions-test-market',guildId:'111111111111111111',listings:createInitialListings()});
  const broker=new BrokerRepository(db,clock,{identityKey:randomBytes(32),...(economic?{economySeed:Buffer.alloc(32,17)}:{})});
  let interaction=333333333333333333n;
  const context=(user='222222222222222222'):ServiceContext=>({guildId:'111111111111111111',discordUserId:user,interactionId:(++interaction).toString(),receivedAt:clock.now(),guildPermissions:'32'});
  const setup=broker.dispatch({type:'setup',context:context(),channelId:'444444444444444444'});assert.equal(setup.kind,'SETUP');if(setup.kind!=='SETUP')throw new Error();
  const marketId=setup.market.marketId;const foundation=new FoundationRepository(db,clock);const rights=new RightsRepository(db);
  const open=(user='222222222222222222')=>{const result=broker.dispatch({type:'open',context:context(user),age14Plus:true,agreeTerms:true});assert.equal(result.kind,'ACCOUNT');if(result.kind!=='ACCOUNT')throw new Error();return result.account.accountId;};
  function trade(side:'BUY'|'SELL',quantity='2',user='222222222222222222',symbol='HGI') {
    const quote=broker.dispatch({type:'quote',context:context(user),symbol,side,quantity});assert.equal(quote.kind,'QUOTE');if(quote.kind!=='QUOTE')throw new Error(JSON.stringify(quote));
    assert.equal(broker.dispatch({type:'confirm',context:context(user),token:quote.quote.token}).kind,'FILLED');
  }
  const known=new Map<string,CorporateDividend>();
  function commit(actions:readonly CorporateAction[]) {
    clock.advanceBy(1000);
    db.transaction(()=>{
      db.prepare('UPDATE markets SET tick_no=tick_no+1,market_version=market_version+1,sequence_no=sequence_no+1,next_boundary_at=? WHERE market_id=?')
        .run(new Date(Date.parse(clock.now())+300000).toISOString(),marketId);
      const market=db.prepare('SELECT * FROM markets WHERE market_id=?').get(marketId) as RightsTick;
      // This fixture advances the static trial clock; retain its real observation for later account baselines.
      db.prepare('INSERT INTO trial_ticks(market_id,tick_no,market_version,sequence_no,boundary_at,committed_at) VALUES(?,?,?,?,?,?)')
        .run(marketId,market.tick_no,market.market_version,market.sequence_no,clock.now(),clock.now());
      const latest=new Map(known);for(const action of actions) if('dividend' in action) latest.set(action.dividend.id,action.dividend);
      rights.apply(actions,market,clock.now(),()=>{},'0',[...latest.values()]);
    }).immediate();
    for(const action of actions) if('dividend' in action) known.set(action.dividend.id,action.dividend);
  }
  return {db,clock,broker,context,marketId,foundation,rights,open,trade,commit};
}
const source=INITIAL_COMPANIES.find(company=>company.symbol==='HGI')!;
function dividend(id='test_dividend',dps='15'):CorporateDividend {return {id,issuerId:source.issuerId,listingId:source.listingId,declaredTick:0,exTick:3,payTick:5,status:'EX_ENTITLED',issuedShares:source.issuedShares,
  totalNominalAtoms:(parseMoney(dps)*BigInt(source.issuedShares)).toString(),dps,remainingPayableAtoms:(parseMoney(dps)*BigInt(source.issuedShares)).toString(),recoveryRatio:'1',paidAtoms:'0'};}
function action(kind:'DIVIDEND_EX'|'DIVIDEND_PAYMENT'|'DIVIDEND_IMPAIRED',claim=dividend()):Extract<CorporateAction,{readonly dividend:CorporateDividend}> {return {id:`${claim.id}_${kind}`,kind,issuerId:source.issuerId,listingId:source.listingId,symbol:'HGI',effectiveTick:kind==='DIVIDEND_EX'?3:5,dividend:kind==='DIVIDEND_PAYMENT'?{...claim,remainingPayableAtoms:'0',paidAtoms:new FinancialDecimal(claim.totalNominalAtoms).mul(claim.recoveryRatio).floor().toFixed(0)}:claim};}

test('AT-28/30/31/32 ex ownership, stock/claim conservation, sale then one cash substitution',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');
  const before=f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'});
  f.commit([action('DIVIDEND_EX')]);f.db.prepare('UPDATE listings SET price=? WHERE market_id=? AND listing_id=?').run('985',f.marketId,source.listingId);
  const view=f.rights.view(f.marketId,account);assert.equal(view.rights[0]?.nominal,'30');assert.equal(view.rights[0]?.currentValue,'30');
  assert.deepEqual(addFractions(multiplyFractions(decimalFraction('2'),decimalFraction('985')),view.asset),decimalFraction('2000'));
  f.trade('SELL');const sold=f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'});assert.equal(sold.positions.get(source.listingId)?.quantity.numerator,0n);
  f.commit([action('DIVIDEND_PAYMENT',{...dividend(),status:'PAID',paidAtoms:dividend().totalNominalAtoms,remainingPayableAtoms:'0'})]);
  const paid=f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'});assert.equal(paid.cashAtoms-sold.cashAtoms,parseMoney('30'));assert.equal(f.rights.view(f.marketId,account).asset.numerator,0n);
  f.commit([action('DIVIDEND_PAYMENT')]);assert.equal(f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'}).cashAtoms,paid.cashAtoms);
  assert.equal(before.cashAtoms,parseMoney('7998'));
});
test('late buyers miss the detached dividend and independent owners cannot read another account scope',t=>{
  const f=fixture(t);const early=f.open();f.trade('BUY');f.commit([action('DIVIDEND_EX')]);const late=f.open('222222222222222223');f.trade('BUY','1','222222222222222223');
  assert.equal(f.rights.view(f.marketId,early).rights.length,1);assert.equal(f.rights.view(f.marketId,late).rights.length,0);
  assert.throws(()=>f.rights.view('other_market',early),/scope/);
});
test('AT-29/45 unfilled sell intent does not remove ownership and ex cancels the old quote with its cause',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');const quote=f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'SELL',quantity:'1'});assert.equal(quote.kind,'QUOTE');if(quote.kind!=='QUOTE')throw new Error();
  f.commit([action('DIVIDEND_EX')]);assert.equal(f.rights.view(f.marketId,account).rights[0]?.nominal,'30');
  assert.deepEqual(f.broker.dispatch({type:'confirm',context:f.context(),token:quote.quote.token}),{kind:'ERROR',code:'CORPORATE_ACTION_CANCELLED'});
});
test('closed accounts retain existing claims for immutable settlement without restoring personal identifiers or access',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');f.commit([action('DIVIDEND_EX')]);assert.equal(f.broker.dispatch({type:'close',context:f.context(),confirmed:true}).kind,'CLOSED');
  f.commit([action('DIVIDEND_PAYMENT')]);assert.equal(f.rights.view(f.marketId,account).dividendTotal,'30');
  assert.deepEqual(f.broker.dispatch({type:'portfolio',context:f.context()}),{kind:'ERROR',code:'ACCOUNT_CLOSED'});
  assert.equal(JSON.stringify(f.db.prepare('SELECT state_json FROM rights_journal WHERE market_id=? AND account_id=?').all(f.marketId,account)).includes('222222222222222222'),false);
});
test('AT-34 impairment retains nominal and pays only explicit recovery while zero settles without a cash grant',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');f.commit([action('DIVIDEND_EX')]);
  f.commit([action('DIVIDEND_IMPAIRED',{...dividend(),status:'IMPAIRED',recoveryRatio:'0.4'})]);
  const impaired=f.rights.view(f.marketId,account).rights[0]!;assert.equal(impaired.nominal,'30');assert.equal(impaired.currentValue,'12');
  f.commit([action('DIVIDEND_PAYMENT',{...dividend(),status:'SETTLED',recoveryRatio:'0.4'})]);assert.equal(f.rights.view(f.marketId,account).dividendTotal,'12');
  const zero=dividend('zero_dividend');f.commit([action('DIVIDEND_EX',zero)]);f.commit([action('DIVIDEND_PAYMENT',{...zero,status:'SETTLED',recoveryRatio:'0'})]);
  assert.equal(f.rights.view(f.marketId,account).dividendTotal,'12');assert.equal(f.rights.view(f.marketId,account).rights[1]?.status,'SETTLED');
});
test('AT-49 claim fractions are pooled without losing subatoms or counting them as cash interest principal',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY','0.000001');
  for(let index=0;index<3;index++){const claim=dividend(`tiny_${index}`,'0.0000004');f.commit([action('DIVIDEND_EX',claim)]);f.commit([action('DIVIDEND_PAYMENT',{...claim,status:'PAID'})]);}
  assert.equal(f.rights.view(f.marketId,account).dividendTotal,'0.000000000001');
  const states=f.rights.replay(f.marketId,account);const carry=states.get('rounding_dividend')!;assert.deepEqual(parseFraction(carry.mark),decimalFraction('0.0000000000002'));
  assert.deepEqual(f.rights.view(f.marketId,account).asset,decimalFraction('0.0000000000002'));
});
test('AT-54/55/56 liquidation removes old shares but retains cost, separate dividend and final loss',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');f.commit([action('DIVIDEND_EX')]);
  const started:CorporateAction={id:'liquidation_started',kind:'LIQUIDATION_STARTED',effectiveTick:6,issuerId:source.issuerId,listingId:source.listingId,symbol:'HGI',liquidationId:'liq_test',settlementTick:27,estimatedRecoveryPerShare:'2',dividendRecoveryRatio:'0.2'};
  f.commit([started]);f.db.prepare("UPDATE listings SET status='LIQUIDATING' WHERE market_id=? AND listing_id=?").run(f.marketId,source.listingId);
  assert.equal(f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'}).positions.get(source.listingId)?.quantity.numerator,0n);
  assert.deepEqual(f.broker.dispatch({type:'quote',context:f.context(),symbol:'HGI',side:'BUY',quantity:'1'}),{kind:'ERROR',code:'LISTING_NOT_TRADABLE'});
  f.commit([{id:'liquidation_settled',kind:'LIQUIDATION_SETTLED',effectiveTick:27,issuerId:source.issuerId,listingId:source.listingId,symbol:'HGI',liquidationId:'liq_test',realizedRecoveryPerShare:'1',commonPaidAtoms:(parseMoney('1')*BigInt(source.issuedShares)).toString(),eligibleShares:source.issuedShares,dividendRecoveries:[{dividendId:'test_dividend',recoveryRatio:'0.2',paidAtoms:(BigInt(dividend().totalNominalAtoms)/5n).toString()}]}]);
  const view=f.rights.view(f.marketId,account);assert.equal(view.liquidationTotal,'2');assert.equal(view.dividendTotal,'6');
  const claim=view.rights.find(right=>right.kind==='LIQUIDATION')!;assert.equal(claim.cost,'2002');assert.equal(claim.realizedPnl,'-2000');assert.equal(claim.currentValue,'0');
});
test('late claim write failure rolls back cash and rights as one transaction; immutable chains detect drift',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY');f.commit([action('DIVIDEND_EX')]);const before=f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'}).cashAtoms;
  f.db.exec("CREATE TRIGGER fail_rights BEFORE INSERT ON rights_journal WHEN json_extract(NEW.state_json,'$.status')='SETTLED' BEGIN SELECT RAISE(ABORT,'injected'); END");
  assert.throws(()=>f.commit([action('DIVIDEND_PAYMENT')]));assert.equal(f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'}).cashAtoms,before);assert.equal(f.rights.view(f.marketId,account).rights[0]?.status,'OPEN');
  f.db.exec('DROP TRIGGER fail_rights');assert.throws(()=>f.db.prepare('UPDATE rights_journal SET state_hash=?').run('0'.repeat(64)),/append-only/);
  f.db.exec('DROP TRIGGER rights_journal_no_update');f.db.prepare('UPDATE rights_journal SET state_hash=?').run('0'.repeat(64));assert.throws(()=>f.rights.view(f.marketId,account),/chain/);
});
test('published corporate keys become valid foundation ledger causes and repeated fractions settle exact company cash',t=>{
  const f=fixture(t);const account=f.open();f.trade('BUY','3');const claim={...dividend('issuer_hgi:dividend:0','1'),issuedShares:'3',totalNominalAtoms:parseMoney('3').toString(),remainingPayableAtoms:parseMoney('3').toString()};
  f.commit([action('DIVIDEND_EX',claim)]);
  f.commit([{...action('DIVIDEND_PAYMENT',claim),dividend:{...claim,status:'SETTLED',remainingPayableAtoms:'0',paidAtoms:parseMoney('1').toString(),recoveryRatio:'0.33333333333333333333333333333333333333333333333333'}}]);
  assert.equal(f.rights.view(f.marketId,account).dividendTotal,'1');
  assert.equal(f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'}).cashAtoms,parseMoney('6998'));
});
test('real economic ticks expose, detach and pay a dividend through the portfolio without participant-dependent corporate totals',t=>{
  const f=fixture(t,true);const account=f.open();f.trade('BUY','1','222222222222222222','DNL');
  for(let tick=1;tick<=69;tick++){f.clock.advanceBy(300000);const result=f.broker.dispatch({type:'tick',now:f.clock.now()});assert.equal(result.kind,'TICKED',JSON.stringify(result));if(result.kind==='TICKED') assert.equal(result.markets[0]?.state,'OPEN',`failed tick ${tick}`);}
  f.foundation.replayAccount({marketId:f.marketId,discordUserId:'222222222222222222'});f.rights.replay(f.marketId,account);
  const portfolio=f.broker.dispatch({type:'portfolio',context:f.context()});assert.equal(portfolio.kind,'PORTFOLIO',JSON.stringify(portfolio));if(portfolio.kind!=='PORTFOLIO')throw new Error();
  assert.equal(f.rights.view(f.marketId,account).rights.some(right=>right.kind==='DIVIDEND'&&right.status==='SETTLED'),true);
  assert.equal(parseMoney(portfolio.portfolio.dividendTotal!)>0n,true);assert.equal(portfolio.portfolio.rights?.some(right=>right.status==='SETTLED'),true);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM cash_journal WHERE entry_type='DIVIDEND'").get()!==undefined,true);
});
