import test from 'node:test';
import assert from 'node:assert/strict';
import { FinancialDecimal, MONEY_SCALE, parseMoney } from '../src/domain/numeric.js';
import { createEconomyState, advanceEconomy, validateEconomyState } from '../src/economy/engine.js';
import { ASSET_ACCOUNTS, checkCorporateBalance, advanceCorporations } from '../src/economy/corporate.js';
import { advanceDividendBoundary, advanceFinancialLifecycle, declareDividend, dividendCapacity, economicPublicSymbol, financialWarning, liquidationWaterfall, replacementCompany, settleLiquidation, settleLiquidationCreditors } from '../src/economy/actions.js';
import type { CompanyTrueState, CorporateAccount, CorporateDividend, CorporateJournalEntry, EconomyRandom, EconomyState } from '../src/economy/types.js';

const midpoint: EconomyRandom = { uniform: () => '0.5' };
function original(symbol = 'HGI'): CompanyTrueState { return createEconomyState('actions').companies.find((company) => company.symbol === symbol)!; }
function cash(company: CompanyTrueState, points: bigint): CompanyTrueState {
  return { ...company, balances: { ...company.balances, cash: points.toString(), paid_in_capital: (BigInt(company.balances.paid_in_capital) + points - BigInt(company.balances.cash)).toString() } };
}
function eligible(): CompanyTrueState {
  const company = cash(original(), parseMoney('1000000000'));
  const report = { ...company.sealedQuarters.at(-1)!, kind: 'ACTUAL' as const, quarterNo: 1, closedTick: 63, publishTick: 64 };
  return { ...company, sealedQuarters: [...company.sealedQuarters, report], debtContracts: company.debtContracts.map((debt) => ({ ...debt, maturityTick: debt.maturityTick + 64, nextInterestPaymentTick: 85, nextResetTick: 85 })) };
}
function balanced(entry: CorporateJournalEntry): void {
  assert.equal(entry.lines.filter((line) => line.side === 'DR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n), entry.lines.filter((line) => line.side === 'CR').reduce((sum, line) => sum + BigInt(line.amountAtoms), 0n));
}
function declared(): CompanyTrueState { return declareDividend(eligible(), 'actions', 64).company; }
function simpleCompany(cashPoints: string, debtPoints: string, payablePoints: string, dividendPoints = '0'): CompanyTrueState {
  const base = original(); const cashAtoms = parseMoney(cashPoints); const debt = parseMoney(debtPoints); const payable = parseMoney(payablePoints); const dividend = parseMoney(dividendPoints);
  const balances: Record<CorporateAccount, string> = Object.fromEntries(Object.keys(base.balances).map((key) => [key, '0'])) as Record<CorporateAccount, string>;
  Object.assign(balances, { cash: cashAtoms.toString(), debt: debt.toString(), trade_payables: payable.toString(), dividend_payable: dividend.toString(), retained_earnings: (cashAtoms - debt - payable - dividend).toString() });
  const declaredDividend: CorporateDividend = { id: `${base.issuerId}_test_dividend`, issuerId: base.issuerId, listingId: base.listingId, declaredTick: 64, exTick: 67, payTick: 69, status: 'EX_ENTITLED', issuedShares: base.issuedShares, totalNominalAtoms: dividend.toString(), remainingPayableAtoms: dividend.toString(), dps: new FinancialDecimal(dividend.toString()).div(MONEY_SCALE.toString()).div(base.issuedShares).toString(), recoveryRatio: '1', paidAtoms: '0' };
  const company: CompanyTrueState = { ...base, balances, debtContracts: base.debtContracts.map((item, index) => ({ ...item, principalAtoms: index === 0 ? debt.toString() : '0', accruedInterestAtoms: '0' })), workingCapital: payable === 0n ? [] : [{ id: 'test_ap', causeId: 'test_cause', contractId: null, counterparty: 'EXTERNAL', counterpartyIssuerId: null, amountAtoms: payable.toString(), dueTick: 1, kind: 'AP', overdueSinceTick: 1 }], investments: [], dividends: dividend === 0n ? [] : [declaredDividend], reservedDividendAtoms: dividend.toString() };
  checkCorporateBalance(company); return company;
}
function liquidating(company: CompanyTrueState): CompanyTrueState {
  const estimate = liquidationWaterfall(company);
  return { ...company, lifecycle: 'LIQUIDATING', lifecycleSinceTick: 64, liquidation: { id: 'test_liquidation', enteredTick: 64, settlementTick: 69, estimatedRealizedAssetsAtoms: estimate.realizedAssetsAtoms, liquidationCostAtoms: estimate.costAtoms, estimatedRecoveryPerShare: estimate.recoveryPerShare, realizedRecoveryPerShare: null } };
}

test('dividend policy independently limits profit, cash after safety reserve and accumulated distributable profit', () => {
  const base = eligible(); const capacity = dividendCapacity(base, 64);
  assert.equal(capacity.totalAtoms, capacity.profitLimitAtoms); assert(BigInt(capacity.totalAtoms) > 0n);
  const onlyCash = cash(base, BigInt(capacity.safetyReserveAtoms) + 17n);
  assert.equal(dividendCapacity(onlyCash, 64).totalAtoms, '17');
  const oldRetained = BigInt(base.balances.retained_earnings);
  const retained = { ...base, balances: { ...base.balances, retained_earnings: '11', paid_in_capital: (BigInt(base.balances.paid_in_capital) + oldRetained - 11n).toString() } };
  assert.equal(dividendCapacity(retained, 64).totalAtoms, '11'); checkCorporateBalance(retained);
  assert.equal(dividendCapacity(cash(base, 0n), 64).totalAtoms, '0');
});
test('normal profit below zero, debt covenant, delinquency and growth/thematic policy prohibit new dividends', () => {
  const base = eligible(); assert.equal(dividendCapacity({ ...base, dividendBan: true }, 64).totalAtoms, '0');
  assert.equal(dividendCapacity({ ...base, status: 'STRESSED' }, 64).totalAtoms, '0');
  assert.equal(dividendCapacity({ ...base, lifecycle: 'DISTRESSED' }, 64).totalAtoms, '0');
  const negative = { ...base, sealedQuarters: base.sealedQuarters.map((report) => ({ ...report, netProfitAtoms: '-1', pretaxProfitAtoms: '-1' })) };
  assert.equal(dividendCapacity(negative, 64).totalAtoms, '0');
  for (const symbol of ['NXC', 'VTR', 'AUR', 'LMB']) assert.equal(dividendCapacity(cash(original(symbol), parseMoney('1000000000')), 64).totalAtoms, '0');
});
test('normalized dividend earnings exclude nonrecurring impairments and recoveries with normalized tax', () => {
  const base = eligible(); const regular = dividendCapacity(base, 64).normalizedProfitAtoms;
  const recovered = { ...base, sealedQuarters: base.sealedQuarters.map((report) => ({ ...report, pretaxProfitAtoms: (BigInt(report.pretaxProfitAtoms) + parseMoney('1000000')).toString(), oneOffProfitAtoms: parseMoney('1000000').toString() })) };
  const impaired = { ...base, sealedQuarters: base.sealedQuarters.map((report) => ({ ...report, pretaxProfitAtoms: (BigInt(report.pretaxProfitAtoms) - parseMoney('1000000')).toString(), oneOffProfitAtoms: (-parseMoney('1000000')).toString() })) };
  assert.equal(dividendCapacity(recovered, 64).normalizedProfitAtoms, regular); assert.equal(dividendCapacity(impaired, 64).normalizedProfitAtoms, regular);
});
test('first real declaration seals DPS, T+3/T+5 schedule, protected cash and matching corporate obligation', () => {
  assert.equal(declareDividend(original(), 'actions', 0).actions.length, 0);
  const base = eligible(); const result = declareDividend(base, 'actions', 64); const dividend = result.company.dividends[0]!;
  assert.equal(dividend.declaredTick, 64); assert.equal(dividend.exTick, 67); assert.equal(dividend.payTick, 69);
  assert(new FinancialDecimal(dividend.dps).mul(base.issuedShares).mul(MONEY_SCALE.toString()).eq(dividend.totalNominalAtoms));
  assert.equal(result.company.balances.cash, base.balances.cash);
  assert.equal(result.company.balances.dividend_payable, dividend.totalNominalAtoms);
  assert.equal(result.company.reservedDividendAtoms, dividend.totalNominalAtoms);
  assert.equal(BigInt(base.balances.retained_earnings) - BigInt(result.company.balances.retained_earnings), BigInt(dividend.totalNominalAtoms));
  assert.equal(result.actions[0]!.kind, 'DIVIDEND_DECLARED'); result.entries.forEach(balanced); checkCorporateBalance(result.company);
  assert.equal(declareDividend(result.company, 'actions', 64).actions.length, 0);
});
test('reserved distribution cannot fund supplier, capex, debt, tax or interest payments again', () => {
  const base = original(); const reserved = BigInt(base.balances.cash); const template = declared().dividends[0]!;
  const dividend = { ...template, declaredTick: 0, exTick: 3, payTick: 5, totalNominalAtoms: reserved.toString(), remainingPayableAtoms: reserved.toString(), dps: new FinancialDecimal(reserved.toString()).div(MONEY_SCALE.toString()).div(base.issuedShares).toString() };
  const blocked = { ...base, reservedDividendAtoms: reserved.toString(), dividends: [dividend], balances: { ...base.balances, dividend_payable: reserved.toString(), retained_earnings: (BigInt(base.balances.retained_earnings) - reserved).toString() }, workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1 } : item), debtContracts: base.debtContracts.map((debt) => ({ ...debt, maturityTick: 1, nextInterestPaymentTick: 1 })) };
  const state = createEconomyState('reserve'); const companies = state.companies.map((company) => company.symbol === 'HGI' ? blocked : company);
  const result = advanceCorporations('reserve', companies, state.contracts, state.macro, 1, midpoint); const after = result.companies.find((company) => company.symbol === 'HGI')!;
  assert.equal(after.balances.cash, reserved.toString()); assert.equal(after.reservedDividendAtoms, reserved.toString());
  assert.equal(after.investments.length, 0); assert(result.entries.filter((entry) => entry.issuerId === base.issuerId).every((entry) => entry.kind !== 'SUPPLIER_PAYMENT' && entry.kind !== 'DEBT_REPAYMENT' && entry.kind !== 'INTEREST_PAYMENT'));
});
test('ex boundary and payment happen once; payment reduces cash and liability rather than earning another profit', () => {
  const base = declared(); const ex = advanceDividendBoundary(base, 'actions', 67);
  assert.equal(ex.actions[0]!.kind, 'DIVIDEND_EX'); assert.equal(ex.entries.length, 0);
  assert.equal(advanceDividendBoundary(ex.company, 'actions', 67).actions.length, 0);
  assert.equal(advanceDividendBoundary(ex.company, 'actions', 68).actions.length, 0);
  const before = ex.company; const paid = advanceDividendBoundary(before, 'actions', 69); const dividend = paid.company.dividends[0]!;
  assert.equal(dividend.status, 'PAID'); assert.equal(dividend.paidAtoms, dividend.totalNominalAtoms);
  assert.equal(paid.company.balances.dividend_payable, '0'); assert.equal(paid.company.reservedDividendAtoms, '0');
  assert.equal(BigInt(before.balances.cash) - BigInt(paid.company.balances.cash), BigInt(dividend.totalNominalAtoms));
  assert.equal(paid.company.balances.retained_earnings, before.balances.retained_earnings);
  assert.equal(advanceDividendBoundary(paid.company, 'actions', 69).actions.length, 0); paid.entries.forEach(balanced);
});
test('lost reserved cash retains nominal dividend, discloses matching impairment and settles actual recovery only', () => {
  const base = declared(); const nominal = BigInt(base.dividends[0]!.totalNominalAtoms);
  const damaged = cash(base, nominal / 4n); const result = advanceDividendBoundary(damaged, 'actions', 69);
  assert.deepEqual(result.actions.map((action) => action.kind), ['DIVIDEND_IMPAIRED', 'DIVIDEND_PAYMENT']);
  const dividend = result.company.dividends[0]!; assert.equal(dividend.totalNominalAtoms, nominal.toString()); assert.equal(dividend.paidAtoms, (nominal / 4n).toString());
  assert(new FinancialDecimal(dividend.recoveryRatio).lte('0.25'));
  assert.equal(result.company.balances.cash, '0'); assert.equal(result.company.balances.dividend_payable, '0'); assert.equal(result.company.reservedDividendAtoms, '0');
  result.entries.forEach(balanced); checkCorporateBalance(result.company);
});
test('corporate dividend policy and totals accept no account count, holder identity or quoted price', () => {
  const base = eligible(); const first = declareDividend(base, 'actions', 64); const replay = declareDividend(JSON.parse(JSON.stringify(base)) as CompanyTrueState, 'actions', 64);
  assert.deepEqual(first, replay); assert.equal(first.actions[0]!.kind, 'DIVIDEND_DECLARED');
  assert(!JSON.stringify(first.actions).includes('accountId')); assert(!JSON.stringify(first.actions).includes('price'));
});
test('financial warning uses cash runway, 21-tick obligations, arrears and balance-sheet breach', () => {
  const base = original(); const warning = financialWarning(base, 10); assert(new FinancialDecimal(warning.runwayTicks).gt('0'));
  assert.equal(warning.overdueTicks, 0); assert.equal(warning.breached, false);
  const delinquent = { ...base, workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1, overdueSinceTick: 1 } : item) };
  assert.equal(financialWarning(delinquent, 64).overdueTicks, 64);
  assert.equal(financialWarning(base, 64).overdueTicks, 2, 'matured unpaid principal also counts as an overdue obligation');
  assert.equal(advanceFinancialLifecycle(base, 'actions', 10, createEconomyState('actions').macro, midpoint).actions.some((action) => action.kind === 'LIQUIDATION_STARTED'), false);
});
test('successful external funding raises cash and paid capital with more issuer shares, without any holder allocation', () => {
  const base = original(); const stressed: CompanyTrueState = { ...base, lifecycle: 'DISTRESSED', lifecycleSinceTick: 1, status: 'STRESSED', workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1, overdueSinceTick: 1 } : item) };
  const result = advanceFinancialLifecycle(stressed, 'actions', 64, createEconomyState('actions').macro, { uniform: () => '0' });
  const financing = result.actions.find((action) => action.kind === 'FINANCING'); assert(financing && financing.kind === 'FINANCING');
  assert(BigInt(financing.issuedSharesAfter) > BigInt(financing.issuedSharesBefore));
  assert.equal(BigInt(result.company.balances.cash) - BigInt(stressed.balances.cash), BigInt(financing.raisedAtoms));
  assert.equal(BigInt(result.company.balances.paid_in_capital) - BigInt(stressed.balances.paid_in_capital), BigInt(financing.raisedAtoms));
  assert.equal(result.company.balances.retained_earnings, stressed.balances.retained_earnings); assert.equal(result.replacement, null);
  result.entries.forEach(balanced); checkCorporateBalance(result.company);
});
test('failed funding immediately retires old business and replaces its slot with independent issuer and listing', () => {
  const base = original(); const stressed: CompanyTrueState = { ...base, lifecycle: 'DISTRESSED', lifecycleSinceTick: 1, status: 'STRESSED', workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1, overdueSinceTick: 1 } : item) };
  const result = advanceFinancialLifecycle(stressed, 'actions', 64, createEconomyState('actions').macro, { uniform: () => '0.999' });
  assert.equal(result.company.lifecycle, 'LIQUIDATING'); assert.equal(result.company.volume, '0'); assert(result.replacement);
  assert.equal(result.replacement.category, base.category); assert.equal(result.replacement.slotId, base.slotId);
  assert.notEqual(result.replacement.issuerId, base.issuerId); assert.notEqual(result.replacement.listingId, base.listingId);
  assert.equal(result.replacement.generation, 2); assert.equal(economicPublicSymbol(result.replacement), 'HGI2'); assert.equal(result.replacement.createdTick, 64);
  assert.equal(result.replacement.issuedShares, base.issuedShares); assert.equal(result.replacement.balances.cash, original().balances.cash);
  assert.deepEqual(result.replacement.dividends, []); assert.equal(result.replacement.debtContracts[0]!.maturityTick, 127);
  assert.deepEqual(result.actions.slice(-2).map((action) => action.kind), ['LIQUIDATION_STARTED', 'REPLACEMENT']);
});
test('liquidation waterfall pays cost, secured debt, senior obligations and junior class before common shareholders', () => {
  const company = simpleCompany('10', '16', '4'); const waterfall = liquidationWaterfall(company);
  assert.equal(waterfall.costAtoms, parseMoney('0.3').toString()); assert.equal(waterfall.securedPaidAtoms, parseMoney('9.6').toString()); assert.equal(waterfall.seniorPaidAtoms, parseMoney('0.1').toString()); assert.equal(waterfall.juniorPaidAtoms, '0');
  assert.equal(waterfall.commonAtoms, '0'); assert.equal(waterfall.recoveryPerShare, '0');
  const settled = settleLiquidation(liquidating(company), 'actions', 69);
  assert.equal(settled.company.lifecycle, 'EXTINGUISHED'); assert.equal(settled.company.liquidation!.realizedRecoveryPerShare, '0'); assert(Object.values(settled.company.balances).every((amount) => amount === '0'));
  assert.equal(settleLiquidation(settled.company, 'actions', 69).entries.length, 0); settled.entries.forEach(balanced);
});
test('junior debt and nominal dividends share a shortage proportionally; common recovery never receives that cash twice', () => {
  const company = simpleCompany('20', '10', '4', '10'); const waterfall = liquidationWaterfall(company);
  assert.equal(waterfall.commonAtoms, '0'); assert(new FinancialDecimal(waterfall.juniorRatio).gt('0')); assert(new FinancialDecimal(waterfall.juniorRatio).lt('1'));
  const result = settleLiquidation(liquidating(company), 'actions', 69); const dividend = result.company.dividends[0]!;
  assert.equal(dividend.totalNominalAtoms, parseMoney('10').toString()); assert(BigInt(dividend.paidAtoms) < parseMoney('10')); assert(BigInt(dividend.paidAtoms) > 0n);
  assert.deepEqual(result.actions.filter((action) => action.kind.startsWith('DIVIDEND')).map((action) => action.kind), ['DIVIDEND_IMPAIRED', 'DIVIDEND_PAYMENT']);
  assert.equal(result.company.liquidation!.realizedRecoveryPerShare, '0'); assert(Object.values(result.company.balances).every((amount) => amount === '0')); result.entries.forEach(balanced);
  const surplus = settleLiquidation(liquidating(simpleCompany('100', '10', '4', '10')), 'actions', 69);
  assert.equal(surplus.company.dividends[0]!.paidAtoms, parseMoney('10').toString()); assert.equal(surplus.company.liquidation!.realizedRecoveryPerShare, '0.000073');
});
test('atom remainders in a senior shortage never overpay a zero tax claim or make balances negative', () => {
  const base = simpleCompany('0.000000000003', '0', '0.000000000005');
  const debt = base.debtContracts.map((item, index) => ({ ...item, accruedInterestAtoms: index === 0 ? '5' : '0' }));
  const company = { ...base, balances: { ...base.balances, interest_payable: '5', retained_earnings: (BigInt(base.balances.retained_earnings) - 5n).toString() }, debtContracts: debt };
  const result = settleLiquidation(liquidating(company), 'actions', 69);
  assert(Object.values(result.company.balances).every((amount) => amount === '0')); assert(!result.entries.some((entry) => entry.kind === 'LIQUIDATION_SENIOR_PAYMENT' && entry.lines[0]?.account === 'tax_payable'));
  result.entries.forEach(balanced);
});
test('liquidation payment publishes the exact common total and eligible shares for repeating per-share decimals', () => {
  const company = { ...simpleCompany('1', '0', '0'), issuedShares: '1000003', financingAttempts: 1 };
  const result = settleLiquidation(liquidating(company), 'actions', 69);
  const settled = result.actions.find((action) => action.kind === 'LIQUIDATION_SETTLED'); assert(settled && settled.kind === 'LIQUIDATION_SETTLED');
  assert.equal(settled.commonPaidAtoms, parseMoney('0.97').toString()); assert.equal(settled.eligibleShares, '1000003');
  assert.equal(settled.realizedRecoveryPerShare, new FinancialDecimal('0.97').div('1000003').toString());
  const journalPaid = result.entries.find((entry) => entry.kind === 'COMMON_LIQUIDATION_DISTRIBUTION')!;
  assert.equal(journalPaid.lines[0]!.amountAtoms, settled.commonPaidAtoms);
  assert.equal(BigInt(settled.commonPaidAtoms) / BigInt(settled.eligibleShares), 969_997n);
  assert(BigInt(settled.commonPaidAtoms) % BigInt(settled.eligibleShares) > 0n);
});
test('liquidation supplier payment reaches the original creditor with paired cash journal and reduced receivable', () => {
  const initial = createEconomyState('actions'); const supplier = initial.companies.find((company) => company.symbol === 'NXC')!;
  const debtorBase = simpleCompany('100', '0', '4'); const payable = { ...debtorBase.workingCapital[0]!, causeId: 'old_contract', contractId: 'baseline_NXC_HGI_SERVICE', counterparty: 'NXC' as const, counterpartyIssuerId: supplier.issuerId };
  const debtor = liquidating({ ...debtorBase, workingCapital: [payable] });
  const amount = parseMoney('4'); const creditor = { ...supplier, balances: { ...supplier.balances, receivables: (BigInt(supplier.balances.receivables) + amount).toString(), retained_earnings: (BigInt(supplier.balances.retained_earnings) + amount).toString() }, workingCapital: [...supplier.workingCapital, { ...payable, id: 'old_AR', counterparty: 'HGI' as const, counterpartyIssuerId: debtor.issuerId, kind: 'AR' as const }] };
  const settled = settleLiquidation(debtor, 'actions', 69); const collection = settleLiquidationCreditors(debtor, settled, [creditor], 'actions', 69);
  assert.equal(BigInt(collection.companies[0]!.balances.cash) - BigInt(creditor.balances.cash), amount); assert(!collection.companies[0]!.workingCapital.some((item) => item.id === 'old_AR'));
  collection.entries.forEach(balanced); checkCorporateBalance(collection.companies[0]!);
});
test('legacy stage-two state defaults upgrade in memory without changing provided original JSON', () => {
  const state = createEconomyState('legacy'); const legacy = JSON.parse(JSON.stringify(state)) as Record<string, unknown>; delete legacy.retiredCompanies;
  for (const company of legacy.companies as Record<string, unknown>[]) {
    for (const key of ['generation', 'createdTick', 'lifecycle', 'lifecycleSinceTick', 'dividendBan', 'financingAttempts', 'reservedDividendAtoms', 'dividends', 'liquidation']) delete company[key];
    delete (company.balances as Record<string, unknown>).dividend_payable;
    for (const report of company.sealedQuarters as Record<string, unknown>[]) { delete report.dividendPayableAtoms; delete report.oneOffProfitAtoms; }
    delete (company.currentQuarter as Record<string, unknown>).oneOffProfitAtoms;
    for (const obligation of company.workingCapital as Record<string, unknown>[]) delete obligation.counterpartyIssuerId;
  }
  const encoded = JSON.stringify(legacy); const upgraded = validateEconomyState(legacy); assert.equal(JSON.stringify(legacy), encoded);
  assert.deepEqual(upgraded, state); assert.throws(() => validateEconomyState({ ...state, companies: [...state.companies.slice(1), { ...state.companies[0]!, generation: 2 }] }));
});
test('full boundary preserves eight active slots and archived zero recovery through a real replacement tick', () => {
  const initial = createEconomyState('replacement'); const base = initial.companies[0]!;
  const forced = { ...cash(base, 0n), lifecycle: 'DISTRESSED' as const, lifecycleSinceTick: 1, status: 'STRESSED' as const, workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 1, overdueSinceTick: 1 } : { ...item, dueTick: 100 }) };
  let state: EconomyState = validateEconomyState({ ...initial, tickNo: 63, companies: initial.companies.map((company) => company.issuerId === base.issuerId ? forced : company) });
  const start = advanceEconomy(state, 64, { uniform: (context) => context.eventChannel === 'external-capital' ? '0.999' : '0.5' }); state = start.state;
  assert.equal(state.companies.length, 8); assert.equal(state.retiredCompanies.length, 1); assert.equal(state.retiredCompanies[0]!.issuerId, base.issuerId);
  const replacement = state.companies.find((company) => company.symbol === base.symbol)!; assert.equal(economicPublicSymbol(replacement), 'HGI2'); assert.equal(replacement.balances.cash, base.balances.cash);
  assert(start.corporateEntries.some((entry) => entry.kind === 'REPLACEMENT_OPENING' && entry.issuerId === replacement.issuerId));
  for (let tick = 65; tick <= 69; tick++) state = advanceEconomy(state, tick, midpoint).state;
  assert.equal(state.retiredCompanies[0]!.lifecycle, 'EXTINGUISHED'); assert.equal(state.companies.length, 8); checkCorporateBalance(state.retiredCompanies[0]!);
  assert.deepEqual(validateEconomyState(JSON.parse(JSON.stringify(state))), state); assert.equal(replacementCompany(replacement, 70).generation, 3);
  assert(ASSET_ACCOUNTS.every((account) => state.retiredCompanies[0]!.balances[account] === '0'));
});
test('liquidation before ex date preserves the announced nominal right and emits ex for the retired issuer', () => {
  const initial = createEconomyState('retired_ex'); const base = declared();
  const forced = { ...cash(base, 0n), lifecycle: 'DISTRESSED' as const, lifecycleSinceTick: 43, status: 'STRESSED' as const, workingCapital: base.workingCapital.map((item) => item.kind === 'AP' ? { ...item, dueTick: 43, overdueSinceTick: 43 } : { ...item, dueTick: 100 }) };
  let state: EconomyState = validateEconomyState({ ...initial, tickNo: 64, companies: initial.companies.map((company) => company.issuerId === base.issuerId ? forced : company) });
  const start = advanceEconomy(state, 65, { uniform: (context) => context.eventChannel === 'external-capital' ? '0.999' : '0.5' }); state = start.state;
  const liquidation = start.actions.find((action) => action.kind === 'LIQUIDATION_STARTED'); assert(liquidation && liquidation.kind === 'LIQUIDATION_STARTED');
  assert(new FinancialDecimal(liquidation.dividendRecoveryRatio).lte('1')); assert.equal(state.retiredCompanies[0]!.dividends[0]!.totalNominalAtoms, base.dividends[0]!.totalNominalAtoms);
  assert.equal(state.retiredCompanies[0]!.dividends[0]!.recoveryRatio, liquidation.dividendRecoveryRatio);
  for (let tick = 66; tick <= 70; tick++) {
    const next = advanceEconomy(state, tick, midpoint); state = next.state;
    if (tick === 67) assert(next.actions.some((action) => action.kind === 'DIVIDEND_EX' && action.issuerId === base.issuerId));
    if (tick === 69) assert(!next.actions.some((action) => action.kind === 'DIVIDEND_PAYMENT' && action.issuerId === base.issuerId));
    if (tick === 70) assert(next.actions.some((action) => action.kind === 'DIVIDEND_PAYMENT' && action.issuerId === base.issuerId));
  }
  const old = state.retiredCompanies[0]!; assert.equal(old.dividends[0]!.totalNominalAtoms, base.dividends[0]!.totalNominalAtoms); assert.equal(old.dividends[0]!.status, 'SETTLED'); assert.equal(old.lifecycle, 'EXTINGUISHED');
});
