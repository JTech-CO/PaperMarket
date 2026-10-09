import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { DeterministicRandom } from '../src/domain/random.js';
import { FinancialDecimal, parseMoney } from '../src/domain/numeric.js';
import { INITIAL_COMPANIES } from '../src/fixtures/initial-companies.js';
import { advanceEconomy, createEconomyState, validateEconomyState } from '../src/economy/engine.js';
import { ASSET_ACCOUNTS, checkCorporateBalance } from '../src/economy/corporate.js';
import { observeMacro, policyExpectation } from '../src/economy/macro.js';
import type { CompanyTrueState, CorporateAccount, CorporateJournalEntry, EconomyRandom, EconomyState } from '../src/economy/types.js';

const midpoint: EconomyRandom = { uniform: () => '0.5' };
function company(state: EconomyState, symbol: string): CompanyTrueState { return state.companies.find((item) => item.symbol === symbol)!; }
function advanceTo(input: EconomyState, tick: number, random: EconomyRandom = midpoint): EconomyState {
  let state = input;
  for (let next = state.tickNo + 1; next <= tick; next++) state = advanceEconomy(state, next, random).state;
  return state;
}
function entryBalanced(entry: CorporateJournalEntry): void {
  assert.equal(entry.lines.filter((line) => line.side === 'DR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n), entry.lines.filter((line) => line.side === 'CR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n));
}
test('economic initialization reconciles all eight fixtures and four explicitly synthetic quarters', () => {
  const state = createEconomyState('test_economy');
  assert.equal(state.companies.length, 8);
  for (const item of state.companies) {
    const fixture = INITIAL_COMPANIES.find((initial) => initial.symbol === item.symbol)!;
    assert.equal(item.balances.cash, parseMoney(fixture.cash).toString());
    assert.equal(item.balances.debt, parseMoney(fixture.interestBearingDebt).toString());
    assert.equal(item.debtContracts.length, 16);
    assert.deepEqual([...new Set(item.debtContracts.map((debt) => debt.maturityTick))], [63, 126, 189, 252, 315, 378, 441, 504]);
    assert.equal(item.sealedQuarters.length, 4);
    assert(item.sealedQuarters.every((report) => report.kind === 'SYNTHETIC_INITIALIZATION'));
    checkCorporateBalance(item);
  }
  assert.equal(JSON.parse(JSON.stringify(state)).companies[0].balances.cash, state.companies[0]!.balances.cash);
  assert.throws(() => createEconomyState('bad ID'));
  assert.throws(() => createEconomyState('test_economy', 1));
});
test('sales recognize receivables before cash; research is an expense and journals balance exactly', () => {
  const initial = createEconomyState('operations');
  const next = advanceEconomy(initial, 1, midpoint);
  const lmb = company(next.state, 'LMB');
  assert(BigInt(lmb.currentQuarter.researchAtoms) > 0n);
  assert.equal(lmb.balances.cash, company(initial, 'LMB').balances.cash);
  assert(BigInt(lmb.balances.receivables) > BigInt(company(initial, 'LMB').balances.receivables));
  assert(BigInt(lmb.balances.retained_earnings) < 0n);
  const research = next.corporateEntries.filter((entry) => entry.issuerId === lmb.issuerId && entry.kind === 'RESEARCH_EXPENSE');
  assert.equal(research.length, 1);
  assert.deepEqual(research[0]!.lines.map((line) => line.account), ['retained_earnings', 'trade_payables']);
  for (const entry of next.corporateEntries) entryBalanced(entry);
});
test('a linked contract has matched revenue/cost and a later matched cash settlement exactly once', () => {
  const initial = createEconomyState('contracts');
  const t1 = advanceEconomy(initial, 1, midpoint);
  const related = t1.corporateEntries.filter((entry) => entry.contractId === 'baseline_TLR_HGI_RAW_MATERIALS');
  assert.equal(related.length, 2);
  const revenue = related.find((entry) => entry.kind === 'CONTRACT_REVENUE')!;
  const cost = related.find((entry) => entry.kind === 'CONTRACT_EXPENSE')!;
  assert.equal(revenue.causeId, cost.causeId);
  assert.equal(revenue.lines[0]!.amountAtoms, cost.lines[0]!.amountAtoms);
  const t7 = advanceTo(t1.state, 7);
  const t8 = advanceEconomy(t7, 8, midpoint);
  const settlements = t8.corporateEntries.filter((entry) => entry.causeId === revenue.causeId);
  assert.equal(settlements.length, 2);
  assert.equal(settlements.find((entry) => entry.kind === 'SUPPLIER_PAYMENT')!.lines[0]!.amountAtoms, revenue.lines[0]!.amountAtoms);
  assert.equal(settlements.find((entry) => entry.kind === 'CONTRACT_COLLECTION')!.lines[0]!.amountAtoms, revenue.lines[0]!.amountAtoms);
  const t9 = advanceEconomy(t8.state, 9, midpoint);
  assert.equal(t9.corporateEntries.filter((entry) => entry.causeId === revenue.causeId).length, 0);
});
test('supplier capacity shortfalls redirect purchases externally and preserve matching financial entries', () => {
  const initial = createEconomyState('capacity');
  const constrained = validateEconomyState({ ...initial, companies: initial.companies.map((entry) => entry.symbol === 'HGI' ? { ...entry, capacity: '0.1', volume: '0.1' } : entry) });
  const next = advanceEconomy(constrained, 1, midpoint);
  const hgi = company(next.state, 'HGI');
  const internalRevenue = next.corporateEntries.filter((entry) => entry.issuerId === hgi.issuerId && entry.kind === 'CONTRACT_REVENUE').reduce((sum, entry) => sum + BigInt(entry.lines[0]!.amountAtoms), 0n);
  assert(internalRevenue <= BigInt(hgi.currentQuarter.revenueAtoms));
  assert(next.corporateEntries.some((entry) => entry.issuerId === company(next.state, 'VTR').issuerId && entry.kind === 'OPERATING_EXPENSE'));
  for (const entry of next.corporateEntries) entryBalanced(entry);
});
test('unpaid intercompany obligations never overdraw cash; a creditor impairment does not erase the debt', () => {
  const initial = createEconomyState('default');
  const debtor = company(initial, 'DNL'); const creditor = company(initial, 'NXC');
  const obligation = parseMoney('1000000000000');
  const cause = 'defaulted_contract'; const contractId = 'baseline_NXC_DNL_SERVICE';
  const item = { causeId: cause, contractId, amountAtoms: obligation.toString(), dueTick: 1, overdueSinceTick: null };
  const state = validateEconomyState({ ...initial, companies: initial.companies.map((entry) => entry.symbol === 'DNL' ? {
    ...debtor, balances: { ...debtor.balances, cash: '0', retained_earnings: (BigInt(debtor.balances.retained_earnings) - BigInt(debtor.balances.cash) - obligation).toString(), trade_payables: (BigInt(debtor.balances.trade_payables) + obligation).toString() },
    workingCapital: [{ ...item, id: 'defaulted_AP', kind: 'AP', counterparty: 'NXC' }, ...debtor.workingCapital],
  } : entry.symbol === 'NXC' ? {
    ...creditor, balances: { ...creditor.balances, receivables: (BigInt(creditor.balances.receivables) + obligation).toString(), retained_earnings: (BigInt(creditor.balances.retained_earnings) + obligation).toString() },
    workingCapital: [...creditor.workingCapital, { ...item, id: 'defaulted_AR', kind: 'AR', counterparty: 'DNL' }],
  } : entry) });
  const t21 = advanceTo(state, 21);
  const t22 = advanceEconomy(t21, 22, midpoint);
  assert(t22.corporateEntries.some((entry) => entry.kind === 'RECEIVABLE_IMPAIRMENT' && entry.causeId === cause));
  assert(company(t22.state, 'DNL').workingCapital.some((entry) => entry.id === 'defaulted_AP' && BigInt(entry.amountAtoms) > 0n));
  assert(!company(t22.state, 'NXC').workingCapital.some((entry) => entry.id === 'defaulted_AR'));
  assert.equal(company(t22.state, 'DNL').status, 'STRESSED');
  assert(t22.state.companies.every((entry) => BigInt(entry.balances.cash) >= 0n));
  const t23 = advanceEconomy(t22.state, 23, midpoint);
  assert(!t23.corporateEntries.some((entry) => entry.kind === 'RECEIVABLE_IMPAIRMENT' && entry.causeId === cause));
});
test('CAPEX is a construction asset, completes after six ticks and depreciates only after operation', () => {
  const initial = createEconomyState('capex');
  const t1 = advanceEconomy(initial, 1, midpoint).state;
  assert.equal(company(t1, 'NXC').investments[0]!.status, 'PLANNED');
  assert.equal(company(t1, 'NXC').balances.construction_in_progress, '0');
  const t3 = advanceTo(t1, 3);
  const nxc3 = company(t3, 'NXC');
  const investment = nxc3.investments[0]!;
  assert.equal(investment.status, 'IN_PROGRESS');
  assert.equal(investment.completionTick, 9);
  assert.equal(nxc3.balances.construction_in_progress, investment.amountAtoms);
  assert.equal(investment.depreciatedAtoms, '0');
  const t8 = advanceTo(t3, 8);
  assert.equal(company(t8, 'NXC').investments[0]!.status, 'IN_PROGRESS');
  const t9 = advanceEconomy(t8, 9, midpoint);
  assert.equal(company(t9.state, 'NXC').investments[0]!.status, 'OPERATING');
  assert.equal(company(t9.state, 'NXC').investments[0]!.depreciatedAtoms, '0');
  assert.equal(company(t9.state, 'NXC').balances.construction_in_progress, '0');
  assert(t9.corporateEntries.some((entry) => entry.kind === 'CAPEX_COMPLETION'));
  const t10 = advanceEconomy(t9.state, 10, midpoint);
  assert(BigInt(company(t10.state, 'NXC').investments[0]!.depreciatedAtoms) > 0n);
  assert(t10.corporateEntries.some((entry) => entry.kind === 'PROJECT_DEPRECIATION'));
});
test('only scheduled variable loans reset; interest accrual and contractual payment are distinct', () => {
  const state = advanceTo(createEconomyState('interest'), 20);
  const before = company(state, 'HGI');
  assert(BigInt(before.balances.interest_payable) > 0n);
  const altered = { ...state, macro: { ...state.macro, policyRate: '0.1' } };
  const t21 = advanceEconomy(altered, 21, midpoint);
  const after = company(t21.state, 'HGI');
  const fixedBefore = before.debtContracts.find((debt) => debt.rateType === 'FIXED')!;
  const variableBefore = before.debtContracts.find((debt) => debt.rateType === 'VARIABLE')!;
  assert.equal(after.debtContracts.find((debt) => debt.id === fixedBefore.id)!.annualEffectiveRate, fixedBefore.annualEffectiveRate);
  assert.notEqual(after.debtContracts.find((debt) => debt.id === variableBefore.id)!.annualEffectiveRate, variableBefore.annualEffectiveRate);
  assert(t21.corporateEntries.some((entry) => entry.kind === 'INTEREST_ACCRUAL'));
  assert(t21.corporateEntries.some((entry) => entry.kind === 'INTEREST_PAYMENT'));
  const control = advanceEconomy(state, 21, midpoint);
  const accrued = (entries: readonly CorporateJournalEntry[]) => BigInt(entries.find((entry) => entry.kind === 'INTEREST_ACCRUAL' && entry.causeId === variableBefore.id)!.lines[0]!.amountAtoms);
  assert.equal(accrued(t21.corporateEntries), accrued(control.corporateEntries), 'a boundary reset cannot change the just-ended interval');
  const t22 = advanceEconomy(t21.state, 22, midpoint);
  const control22 = advanceEconomy(control.state, 22, midpoint);
  assert(accrued(t22.corporateEntries) > accrued(control22.corporateEntries), 'the next interval accrues the new rate');
});
test('private macro changes are not released before monthly publication and expectation sees published data only', () => {
  const initial = createEconomyState('publication');
  const t1 = advanceEconomy(initial, 1, { uniform: () => '0.8' });
  assert.notDeepEqual(t1.state.macro, initial.macro);
  assert.deepEqual(t1.state.lastPublishedMacro, initial.macro);
  assert.equal(t1.publications.filter(publication=>publication.kind==='MACRO').length, 0);
  assert.deepEqual(t1.policyExpectation, policyExpectation(initial.macro, 21));
  const t20 = advanceTo(t1.state, 20);
  const t21 = advanceEconomy(t20, 21, midpoint);
  assert.equal(t21.publications[0]!.kind, 'MACRO');
  assert.equal(t21.state.macroPublishedTick, 21);
  assert.equal(t21.state.lastPublishedMacro.policyRate, t21.state.macro.policyRate);
  const probs = t21.policyExpectation;
  assert(new FinancialDecimal(probs.decreaseProbability).plus(probs.unchangedProbability).plus(probs.increaseProbability).eq('1'));
});
test('monthly measurement uncertainty does not mutate the actual macro or policy decision', () => {
  const random: EconomyRandom = { uniform: (context) => context.eventChannel.startsWith('measurement-') ? '0.8' : '0.5' };
  const t20 = advanceTo(createEconomyState('uncertainty'), 20, random);
  const next = advanceEconomy(t20, 21, random);
  assert.notEqual(next.state.macro.inflation, next.state.lastPublishedMacro.inflation);
  assert.notEqual(next.state.macro.outputGap, next.state.lastPublishedMacro.outputGap);
  assert.notEqual(next.state.macro.creditStress, next.state.lastPublishedMacro.creditStress);
  assert.notEqual(next.state.macro.riskAppetite, next.state.lastPublishedMacro.riskAppetite);
  assert.equal(next.state.macro.policyRate, next.state.lastPublishedMacro.policyRate);
  const control = advanceEconomy(t20, 21, midpoint);
  assert.deepEqual(next.state.macro, control.state.macro);
  assert.deepEqual(next.policyExpectation, policyExpectation(next.state.lastPublishedMacro, 42));
  const actual = createEconomyState('regime_copy').macro;
  assert.deepEqual(observeMacro(actual, 21, midpoint), observeMacro({ ...actual, regime: 'RECESSION', regimeSinceTick: 12 }, 21, midpoint), 'public regime is estimated from observed indicators');
});
test('closed quarters survive later events and publish on the specified per-company offsets', () => {
  let state = advanceTo(createEconomyState('quarters'), 63);
  const saved = state.companies.map((item) => JSON.stringify(item.sealedQuarters.at(-1)));
  assert(state.companies.every((item) => item.sealedQuarters.at(-1)!.closedTick === 63));
  const expected = [['HGI', 'DNL'], ['TLR', 'RVI'], ['NXC', 'VTR'], ['AUR', 'LMB']];
  for (let tick = 64; tick <= 67; tick++) {
    const next = advanceEconomy(state, tick, midpoint); state = next.state;
    assert.deepEqual(next.publications.filter((item) => item.kind === 'EARNINGS').map((item) => item.symbol), expected[tick - 64]);
    assert.deepEqual(state.companies.map((item) => JSON.stringify(item.sealedQuarters.at(-1))), saved);
  }
});
test('same seed and context replay exactly; different seed changes economic path without investor inputs', () => {
  const seed = randomBytes(32); const initial = createEconomyState('determinism'); const frozen = JSON.stringify(initial);
  const first = advanceTo(initial, 12, new DeterministicRandom(seed));
  const second = advanceTo(JSON.parse(frozen) as EconomyState, 12, new DeterministicRandom(seed));
  assert.deepEqual(second, first);
  assert.equal(JSON.stringify(initial), frozen);
  assert.notDeepEqual(advanceTo(initial, 12, new DeterministicRandom(randomBytes(32))), first);
});
test('strict replay rejects malformed atoms, imbalance, duplicate obligations and skipped ticks', () => {
  const initial = createEconomyState('invalid');
  const bad = structuredClone(initial) as unknown as { companies: { balances: { cash: string }; workingCapital: unknown[] }[] };
  bad.companies[0]!.balances.cash = '01'; assert.throws(() => validateEconomyState(bad));
  const imbalance = structuredClone(initial) as unknown as { companies: { balances: { cash: string } }[] }; imbalance.companies[0]!.balances.cash = '0';
  assert.throws(() => validateEconomyState(imbalance));
  const duplicate = structuredClone(initial) as unknown as { companies: { workingCapital: unknown[] }[] };
  duplicate.companies[0]!.workingCapital.push(duplicate.companies[0]!.workingCapital[0]); assert.throws(() => validateEconomyState(duplicate));
  assert.throws(() => advanceEconomy(initial, 2, midpoint));
  assert.throws(() => advanceEconomy(initial, 1, { uniform: () => '1' }));
});
test('eight maturity dates and 504 ticks keep cash nonnegative, debt subledgers and balance sheets exact', () => {
  let state = createEconomyState('maturities');
  const replay = new Map(state.companies.map((entry) => [entry.issuerId, { ...entry.balances } as Record<CorporateAccount, string>]));
  for (let tick = 1; tick <= 504; tick++) {
    const result = advanceEconomy(state, tick, midpoint); state = result.state;
    for (const entry of result.corporateEntries) {
      entryBalanced(entry);
      if(!replay.has(entry.issuerId)) {
        assert.equal(entry.kind,'REPLACEMENT_OPENING');
        const replacement=state.companies.find(item=>item.issuerId===entry.issuerId)!;
        replay.set(entry.issuerId,Object.fromEntries(Object.keys(replacement.balances).map(account=>[account,'0'])) as Record<CorporateAccount,string>);
      }
      const balances = replay.get(entry.issuerId)!;
      for (const line of entry.lines) {
        const increases = ASSET_ACCOUNTS.includes(line.account) ? line.side === 'DR' : line.side === 'CR';
        balances[line.account] = (BigInt(balances[line.account]) + (increases ? BigInt(line.amountAtoms) : -BigInt(line.amountAtoms))).toString();
      }
    }
    for (const item of [...state.companies,...state.retiredCompanies]) { assert(BigInt(item.balances.cash) >= 0n); checkCorporateBalance(item); assert.deepEqual(replay.get(item.issuerId), item.balances); }
    if (tick % 63 === 0) assert(state.companies.every((item) => item.sealedQuarters.length === 4 + Math.floor(tick/63)-Math.floor(item.createdTick/63)));
  }
  assert(state.companies.every((item) => BigInt(item.balances.debt) <= parseMoney(INITIAL_COMPANIES.find((fixture) => fixture.symbol === item.symbol)!.interestBearingDebt)));
  assert([...state.companies,...state.retiredCompanies].some((item) => item.status === 'STRESSED'));
  assert.deepEqual(validateEconomyState(JSON.parse(JSON.stringify(state))), state);
});
