import { FinancialDecimal as D, MONEY_SCALE, moneyFromAtoms, parseMoney, parseRate } from '../domain/numeric.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import { parseEngineVersion, parseIssuerId, parseTickNo } from '../domain/identifiers.js';
import { ASSET_ACCOUNTS, checkCorporateBalance, initialCorporateState } from './corporate.js';
import type { CompanyTrueState, CorporateAccount, CorporateAction, CorporateDividend, CorporateJournalEntry, CorporateLifecycle, EconomyRandom, LiquidationPlan, MacroState } from './types.js';

const atom = (value: string): bigint => moneyFromAtoms(value);
const min = (...values: bigint[]): bigint => values.reduce((a, b) => a < b ? a : b);
const max = (a: bigint, b: bigint): bigint => a > b ? a : b;
const ratio = (numerator: bigint, denominator: bigint): string => denominator === 0n ? '0' : parseRate(new D(numerator.toString()).div(denominator.toString()).toString());
const pointsPerShare = (atoms: bigint, shares: string): string => new D(atoms.toString()).div(MONEY_SCALE.toString()).div(shares).toString();
/** Integer largest-remainder allocation never gives a creditor more than its own claim. */
function proRata(paid: bigint, weights: readonly bigint[]): readonly bigint[] {
  const total = weights.reduce((sum, weight) => sum + weight, 0n);
  if (paid < 0n || paid > total || weights.some((weight) => weight < 0n)) throw new Error('Invalid proportional recovery');
  if (total === 0n) return weights.map(() => 0n);
  const allocations = weights.map((weight) => paid * weight / total); let remainder = paid - allocations.reduce((sum, value) => sum + value, 0n);
  const ordered = weights.map((weight, index) => ({ index, residual: paid * weight % total })).sort((a, b) => a.residual === b.residual ? a.index - b.index : a.residual > b.residual ? -1 : 1);
  for (const item of ordered) {
    if (remainder === 0n) break;
    if (allocations[item.index]! < weights[item.index]!) { allocations[item.index] = allocations[item.index]! + 1n; remainder -= 1n; }
  }
  if (remainder !== 0n) throw new Error('Recovery allocation does not reconcile'); return allocations;
}
export function economicPublicSymbol(company: Pick<CompanyTrueState, 'symbol' | 'generation'>): string { return company.generation === 1 ? company.symbol : `${company.symbol}${company.generation}`; }

export interface DividendCapacity {
  readonly normalizedProfitAtoms: string; readonly profitLimitAtoms: string;
  readonly unrestrictedCashAtoms: string; readonly safetyReserveAtoms: string;
  readonly retainedLimitAtoms: string; readonly totalAtoms: string;
}
/** One versioned policy; cash obligations already in operating costs are not counted twice. */
export function dividendCapacity(company: CompanyTrueState, tick: number): DividendCapacity {
  const reports = company.sealedQuarters.slice(-4);
  const normalized = reports.reduce((sum, report) => { const recurringPretax = atom(report.pretaxProfitAtoms) - atom(report.oneOffProfitAtoms); return sum + recurringPretax - (recurringPretax > 0n ? recurringPretax / 5n : 0n); }, 0n) / BigInt(reports.length || 1);
  const source = INITIAL_COMPANIES.find((item) => item.symbol === company.symbol)!;
  const profitLimit = BigInt(new D(max(normalized, 0n).toString()).mul(source.targetPayoutRatio).toDecimalPlaces(0, D.ROUND_FLOOR).toFixed(0));
  const latest = reports.at(-1)!;
  // Cash operating expenses exclude noncash depreciation and debt interest.
  const quarterCost = max(0n, atom(latest.revenueAtoms) - atom(latest.operatingProfitAtoms) - atom(latest.depreciationAtoms));
  const operating21 = quarterCost * 21n / 63n;
  const overdue = company.workingCapital.some((item) => item.kind === 'AP' && item.overdueSinceTick !== null && atom(item.amountAtoms) > 0n)
    || company.debtContracts.some((debt) => debt.maturityTick <= tick && atom(debt.principalAtoms) > 0n);
  const duePrincipal = company.debtContracts.filter((debt) => debt.maturityTick <= tick + 21).reduce((sum, debt) => sum + atom(debt.principalAtoms), 0n);
  const interest = atom(company.balances.interest_payable) + company.debtContracts.filter((debt) => debt.nextInterestPaymentTick <= tick + 21).reduce((sum, debt) => {
    const days = Math.max(0, Math.min(21, debt.nextInterestPaymentTick - tick));
    return sum + BigInt(new D(debt.principalAtoms).mul(new D('1').plus(debt.annualEffectiveRate).pow(new D(days.toString()).div('252')).minus('1')).toDecimalPlaces(0, D.ROUND_FLOOR).toFixed(0));
  }, 0n);
  const tax = atom(company.balances.tax_payable);
  const committed = company.investments.filter((project) => project.status === 'PLANNED').reduce((sum, project) => sum + atom(project.amountAtoms), 0n);
  const buffer = operating21 / 3n;
  const reserve = operating21 + duePrincipal + interest + tax + committed + buffer;
  const cash = max(0n, atom(company.balances.cash) - atom(company.reservedDividendAtoms));
  const retained = max(0n, atom(company.balances.retained_earnings));
  const prohibited = company.dividendBan || overdue || company.status === 'STRESSED' || !['OPERATING', 'WATCH'].includes(company.lifecycle) || company.category === 'GROWTH' || company.category === 'THEMATIC';
  const total = prohibited ? 0n : max(0n, min(profitLimit, cash - reserve, retained));
  return { normalizedProfitAtoms: normalized.toString(), profitLimitAtoms: profitLimit.toString(), unrestrictedCashAtoms: cash.toString(), safetyReserveAtoms: reserve.toString(), retainedLimitAtoms: retained.toString(), totalAtoms: total.toString() };
}

interface Mutation { company: CompanyTrueState; entries: CorporateJournalEntry[]; actions: CorporateAction[] }
function output(mutation: Mutation): Mutation { return { company: mutation.company, entries: mutation.entries, actions: mutation.actions }; }
function mutator(source: CompanyTrueState, marketId: string, tick: number): Mutation & { post(kind: string, cause: string, debit: CorporateAccount, credit: CorporateAccount, amount: bigint): void; set(company: CompanyTrueState): void } {
  const entries: CorporateJournalEntry[] = []; const actions: CorporateAction[] = [];
  const result = { company: source, entries, actions, set(company: CompanyTrueState) { this.company = company; }, post(kind: string, cause: string, debit: CorporateAccount, credit: CorporateAccount, amount: bigint) {
    if (amount === 0n) return; if (amount < 0n) throw new Error('Invalid corporate action journal amount');
    const balances = { ...this.company.balances };
    for (const [account, side] of [[debit, 'DR'], [credit, 'CR']] as const) balances[account] = moneyFromAtoms((atom(balances[account]) + ((ASSET_ACCOUNTS.includes(account) ? side === 'DR' : side === 'CR') ? amount : -amount)).toString()).toString();
    this.company = { ...this.company, balances };
    entries.push({ entryId: `${marketId}_action_${tick}_${source.issuerId}_${entries.length}`, causeId: cause, marketId, issuerId: source.issuerId, tickNo: tick, kind, contractId: null, lines: [{ account: debit, side: 'DR', amountAtoms: amount.toString() }, { account: credit, side: 'CR', amountAtoms: amount.toString() }] });
  } };
  return result;
}
function identity(company: CompanyTrueState, tick: number, suffix: string) { return { id: `${company.issuerId}_${suffix}_${tick}`, effectiveTick: tick, issuerId: company.issuerId, listingId: company.listingId, symbol: economicPublicSymbol(company) }; }
function changeLifecycle(mutation: ReturnType<typeof mutator>, lifecycle: CorporateLifecycle, tick: number): void {
  if (mutation.company.lifecycle === lifecycle) return;
  const previousLifecycle = mutation.company.lifecycle;
  mutation.set({ ...mutation.company, lifecycle, lifecycleSinceTick: tick });
  mutation.actions.push({ ...identity(mutation.company, tick, `lifecycle_${lifecycle.toLowerCase()}`), kind: 'LIFECYCLE_CHANGED', previousLifecycle, lifecycle });
}
function replaceDividend(company: CompanyTrueState, dividend: CorporateDividend): CompanyTrueState { return { ...company, dividends: company.dividends.map((item) => item.id === dividend.id ? dividend : item) }; }

/** Declaration does not read price, holders or user count. */
export function declareDividend(company: CompanyTrueState, marketId: string, tick: number): Mutation {
  const m = mutator(company, marketId, tick);
  if (tick - company.createdTick < 63 || company.sealedQuarters.at(-1)?.kind !== 'ACTUAL' || company.sealedQuarters.at(-1)?.publishTick !== tick || company.dividends.some((item) => item.declaredTick === tick)) return output(m);
  const total = atom(dividendCapacity(company, tick).totalAtoms); if (total === 0n) return output(m);
  const dividend: CorporateDividend = { id: `${company.issuerId}_dividend_${tick}`, issuerId: company.issuerId, listingId: company.listingId, declaredTick: tick, exTick: tick + 3, payTick: tick + 5, status: 'DECLARED', issuedShares: company.issuedShares, totalNominalAtoms: total.toString(), dps: pointsPerShare(total, company.issuedShares), remainingPayableAtoms: total.toString(), recoveryRatio: '1', paidAtoms: '0' };
  m.post('DIVIDEND_DECLARATION', dividend.id, 'retained_earnings', 'dividend_payable', total);
  m.set({ ...m.company, reservedDividendAtoms: (atom(m.company.reservedDividendAtoms) + total).toString(), dividends: [...m.company.dividends, dividend] });
  m.actions.push({ ...identity(company, tick, 'dividend_declared'), kind: 'DIVIDEND_DECLARED', dividend }); checkCorporateBalance(m.company); return output(m);
}
/** Rights are detached before the interval's operations and payment uses the protected cash. */
export function advanceDividendBoundary(company: CompanyTrueState, marketId: string, tick: number): Mutation {
  const m = mutator(company, marketId, tick);
  for (const source of company.dividends) {
    let dividend = source;
    if (tick === source.exTick && (source.status === 'DECLARED' || source.status === 'IMPAIRED')) {
      dividend = { ...source, status: 'EX_ENTITLED' };
      m.set(replaceDividend(m.company, dividend)); m.actions.push({ ...identity(company, tick, `dividend_ex_${source.id}`), kind: 'DIVIDEND_EX', dividend });
    }
    if (tick !== source.payTick || source.status === 'PAID' || source.status === 'SETTLED' || company.lifecycle === 'LIQUIDATING' || company.lifecycle === 'EXTINGUISHED') continue;
    const payable = atom(dividend.remainingPayableAtoms);
    const paid = min(payable, atom(m.company.balances.cash), atom(m.company.reservedDividendAtoms));
    if (paid < payable) {
      const lost = payable - paid;
      m.post('DIVIDEND_OBLIGATION_IMPAIRMENT', source.id, 'dividend_payable', 'retained_earnings', lost);
      dividend = { ...dividend, status: 'IMPAIRED', remainingPayableAtoms: paid.toString(), recoveryRatio: ratio(atom(dividend.paidAtoms) + paid, atom(dividend.totalNominalAtoms)) };
      m.actions.push({ ...identity(company, tick, `dividend_impaired_${source.id}`), kind: 'DIVIDEND_IMPAIRED', dividend });
    }
    m.post('DIVIDEND_PAYMENT', source.id, 'dividend_payable', 'cash', paid);
    dividend = { ...dividend, status: paid === atom(source.totalNominalAtoms) ? 'PAID' : 'SETTLED', paidAtoms: (atom(dividend.paidAtoms) + paid).toString(), remainingPayableAtoms: '0' };
    m.set({ ...replaceDividend(m.company, dividend), reservedDividendAtoms: max(0n, atom(m.company.reservedDividendAtoms) - payable).toString() });
    m.actions.push({ ...identity(company, tick, `dividend_paid_${source.id}`), kind: 'DIVIDEND_PAYMENT', dividend });
  }
  checkCorporateBalance(m.company); return output(m);
}

export interface FinancialWarning { readonly runwayTicks: string; readonly obligations21Atoms: string; readonly overdueTicks: number; readonly breached: boolean }
export function financialWarning(company: CompanyTrueState, tick: number): FinancialWarning {
  const report = company.sealedQuarters.at(-1)!;
  const cost = max(1n, (atom(report.revenueAtoms) - atom(report.operatingProfitAtoms) - atom(report.depreciationAtoms)) / 63n);
  const cash = max(0n, atom(company.balances.cash) - atom(company.reservedDividendAtoms));
  const upcoming = company.workingCapital.filter((item) => item.kind === 'AP' && item.dueTick <= tick + 21).reduce((sum, item) => sum + atom(item.amountAtoms), 0n)
    + company.debtContracts.filter((item) => item.maturityTick <= tick + 21).reduce((sum, item) => sum + atom(item.principalAtoms), 0n) + atom(company.balances.interest_payable) + atom(company.balances.tax_payable);
  const overduePayables = company.workingCapital.filter((item) => item.kind === 'AP' && item.overdueSinceTick !== null && atom(item.amountAtoms) > 0n).reduce((longest, item) => Math.max(longest, tick - item.overdueSinceTick! + 1), 0);
  const overdueTicks = company.debtContracts.filter((debt) => debt.maturityTick <= tick && atom(debt.principalAtoms) > 0n).reduce((longest, debt) => Math.max(longest, tick - debt.maturityTick + 1), overduePayables);
  const assets = ASSET_ACCOUNTS.reduce((sum, key) => sum + atom(company.balances[key]), 0n);
  const breached = assets < atom(company.balances.debt) + atom(company.balances.trade_payables);
  return { runwayTicks: ratio(cash, cost), obligations21Atoms: upcoming.toString(), overdueTicks, breached };
}
/** Secured 60% debt, senior operating claims, junior 40% debt and dividends, common residual. */
export function liquidationWaterfall(company: CompanyTrueState): { readonly realizedAssetsAtoms: string; readonly costAtoms: string; readonly securedPaidAtoms: string; readonly seniorPaidAtoms: string; readonly juniorPaidAtoms: string; readonly juniorRatio: string; readonly commonAtoms: string; readonly recoveryPerShare: string } {
  const b = company.balances;
  const realized = atom(b.cash) + atom(b.receivables) * 60n / 100n + atom(b.inventory) / 2n + atom(b.operating_assets) * 35n / 100n + atom(b.intangible_assets) / 10n + atom(b.construction_in_progress) / 5n;
  const cost = realized * 3n / 100n; let available = realized - cost;
  const secured = atom(b.debt) * 60n / 100n; const securedPaid = min(available, secured); available -= securedPaid;
  const senior = atom(b.trade_payables) + atom(b.interest_payable) + atom(b.tax_payable) + atom(b.contract_liability); const seniorPaid = min(available, senior); available -= seniorPaid;
  const junior = atom(b.debt) - secured + atom(b.dividend_payable); const juniorPaid = min(available, junior); available -= juniorPaid;
  return { realizedAssetsAtoms: realized.toString(), costAtoms: cost.toString(), securedPaidAtoms: securedPaid.toString(), seniorPaidAtoms: seniorPaid.toString(), juniorPaidAtoms: juniorPaid.toString(), juniorRatio: junior === 0n ? '1' : ratio(juniorPaid, junior), commonAtoms: available.toString(), recoveryPerShare: pointsPerShare(available, company.issuedShares) };
}
export function replacementCompany(company: CompanyTrueState, tick: number): CompanyTrueState {
  const template = initialCorporateState().find((entry) => entry.symbol === company.symbol)!;
  const generation = company.generation + 1;
  const issuerId = `${company.symbol.toLowerCase()}_issuer_g${generation}`;
  return { ...template, issuerId, listingId: `${company.symbol.toLowerCase()}_listing_g${generation}`, generation, createdTick: tick, lifecycleSinceTick: tick, name: `${template.name} ${generation}세대`,
    debtContracts: template.debtContracts.map((debt) => ({ ...debt, id: `${issuerId}_${debt.id}`, maturityTick: debt.maturityTick + tick, nextResetTick: tick + 21, nextInterestPaymentTick: tick + 21 })),
    workingCapital: template.workingCapital.map((item) => ({ ...item, id: `${issuerId}_${item.id}`, causeId: `${issuerId}_${item.causeId}`, dueTick: item.dueTick + tick })),
  };
}

export function advanceFinancialLifecycle(company: CompanyTrueState, marketId: string, tick: number, macro: MacroState, random: EconomyRandom): Mutation & { readonly replacement: CompanyTrueState | null } {
  const m = mutator(company, marketId, tick); let replacement: CompanyTrueState | null = null;
  if (company.lifecycle === 'LIQUIDATING' || company.lifecycle === 'EXTINGUISHED') return { ...output(m), replacement };
  const warning = financialWarning(company, tick); const cash = max(0n, atom(company.balances.cash) - atom(company.reservedDividendAtoms));
  const unpaid = warning.overdueTicks > 0 || (company.status === 'STRESSED' && (atom(company.balances.interest_payable) > 0n || atom(company.balances.tax_payable) > 0n));
  const distressed = unpaid || warning.breached;
  if (distressed && company.lifecycle !== 'DISTRESSED' && company.lifecycle !== 'RESTRUCTURING') changeLifecycle(m, 'DISTRESSED', tick);
  else if (!distressed) {
    const next = new D(warning.runwayTicks).lt('42') || atom(warning.obligations21Atoms) > cash ? 'WATCH' : 'OPERATING';
    changeLifecycle(m, next, tick);
    if (next === 'OPERATING' && m.company.dividendBan) m.set({ ...m.company, dividendBan: false });
  }
  const persistent = (m.company.lifecycle === 'DISTRESSED' || m.company.lifecycle === 'RESTRUCTURING') && tick - m.company.lifecycleSinceTick >= 21;
  if (persistent && tick - company.createdTick >= 63) {
    changeLifecycle(m, 'RESTRUCTURING', tick);
    const attempts = m.company.financingAttempts;
    const source = INITIAL_COMPANIES.find((entry) => entry.symbol === company.symbol)!;
    const need = max(parseMoney(source.cash) / 4n, atom(warning.obligations21Atoms) - cash);
    const cap = parseMoney(source.cash) * 2n;
    const creditProbability = D.max('0.05', new D('0.9').minus(new D(macro.creditStress).mul('0.5')).minus(warning.breached ? '0.25' : '0'));
    const draw = new D(random.uniform({ engineVersion: parseEngineVersion('actions-v1'), tick: parseTickNo(tick), issuerId: parseIssuerId(company.issuerId), eventChannel: 'external-capital', drawIndex: attempts }));
    if (!draw.isFinite() || draw.lt('0') || draw.gte('1')) throw new Error('Invalid financing random draw');
    if (attempts < 2 && need <= cap && draw.lt(creditProbability)) {
      const raised = need; const addedShares = max(1n, (raised + parseMoney('250') - 1n) / parseMoney('250'));
      const before = m.company.issuedShares; const after = (BigInt(before) + addedShares).toString();
      m.post('EXTERNAL_SHARE_ISSUE', `${company.issuerId}_financing_${tick}`, 'cash', 'paid_in_capital', raised);
      m.set({ ...m.company, issuedShares: after, financingAttempts: attempts + 1, dividendBan: true });
      m.actions.push({ ...identity(company, tick, 'financing'), kind: 'FINANCING', raisedAtoms: raised.toString(), issuedSharesBefore: before, issuedSharesAfter: after });
    } else {
      changeLifecycle(m, 'LIQUIDATING', tick);
      const waterfall = liquidationWaterfall(m.company);
      const liquidation: LiquidationPlan = { id: `${company.issuerId}_liquidation_${tick}`, enteredTick: tick, settlementTick: tick + 5, estimatedRealizedAssetsAtoms: waterfall.realizedAssetsAtoms, liquidationCostAtoms: waterfall.costAtoms, estimatedRecoveryPerShare: waterfall.recoveryPerShare, realizedRecoveryPerShare: null };
      m.set({ ...m.company, liquidation, dividendBan: true, volume: '0' });
      m.actions.push({ ...identity(company, tick, 'liquidation'), kind: 'LIQUIDATION_STARTED', liquidationId: liquidation.id, settlementTick: liquidation.settlementTick, estimatedRecoveryPerShare: liquidation.estimatedRecoveryPerShare, dividendRecoveryRatio: waterfall.juniorRatio });
      if (new D(waterfall.juniorRatio).lt('1')) {
        const dividends = m.company.dividends.map((dividend) => {
          if (atom(dividend.remainingPayableAtoms) === 0n) return dividend;
          // Preserve nominal liability until settlement; the disclosed mark uses the expected recovery.
          const impaired: CorporateDividend = { ...dividend, status: 'IMPAIRED', recoveryRatio: waterfall.juniorRatio };
          m.actions.push({ ...identity(company, tick, `dividend_liquidation_mark_${dividend.id}`), kind: 'DIVIDEND_IMPAIRED', dividend: impaired }); return impaired;
        });
        m.set({ ...m.company, dividends });
      }
      replacement = replacementCompany(m.company, tick);
      m.actions.push({ ...identity(company, tick, 'replacement'), kind: 'REPLACEMENT', baseSymbol: replacement.symbol, generation: replacement.generation, createdTick: tick, newIssuerId: replacement.issuerId, newListingId: replacement.listingId, newSymbol: economicPublicSymbol(replacement), newName: replacement.name, issuedShares: replacement.issuedShares });
    }
  }
  checkCorporateBalance(m.company); return { company: m.company, entries: m.entries, actions: m.actions, replacement };
}

/** Frozen old business realizes assets once; final 0 is preserved rather than fed to logarithms. */
export function settleLiquidation(company: CompanyTrueState, marketId: string, tick: number): Mutation {
  const m = mutator(company, marketId, tick);
  if (company.lifecycle !== 'LIQUIDATING' || !company.liquidation || tick !== company.liquidation.settlementTick) return output(m);
  const waterfall = liquidationWaterfall(company); const original = company.balances;
  for (const [account, numerator, denominator] of [['receivables', 60n, 100n], ['inventory', 1n, 2n], ['operating_assets', 35n, 100n], ['intangible_assets', 1n, 10n], ['construction_in_progress', 1n, 5n]] as const) {
    const value = atom(original[account]); const recovered = value * numerator / denominator;
    m.post('LIQUIDATION_ASSET_DISPOSAL', company.liquidation.id, 'cash', account, recovered);
    m.post('LIQUIDATION_ASSET_IMPAIRMENT', company.liquidation.id, 'retained_earnings', account, value - recovered);
  }
  m.post('LIQUIDATION_COST', company.liquidation.id, 'retained_earnings', 'cash', atom(waterfall.costAtoms));
  const debtTotal = atom(original.debt); const secured = debtTotal * 60n / 100n; const juniorDebt = debtTotal - secured;
  const juniorTotal = juniorDebt + atom(original.dividend_payable);
  const juniorDebtPaid = juniorTotal === 0n ? 0n : atom(waterfall.juniorPaidAtoms) * juniorDebt / juniorTotal;
  const dividendPaid = atom(waterfall.juniorPaidAtoms) - juniorDebtPaid;
  const debtPaid = atom(waterfall.securedPaidAtoms) + juniorDebtPaid;
  m.post('LIQUIDATION_DEBT_PAYMENT', company.liquidation.id, 'debt', 'cash', debtPaid);
  const seniorAccounts = ['trade_payables', 'interest_payable', 'tax_payable', 'contract_liability'] as const;
  const seniorAllocations = proRata(atom(waterfall.seniorPaidAtoms), seniorAccounts.map((key) => atom(original[key])));
  for (let index = 0; index < seniorAccounts.length; index++) {
    const account = seniorAccounts[index]!; const paid = seniorAllocations[index]!;
    m.post('LIQUIDATION_SENIOR_PAYMENT', company.liquidation.id, account, 'cash', paid);
  }
  const recoveries: { dividendId: string; recoveryRatio: string; paidAtoms: string }[] = [];
  const outstanding = company.dividends.filter((item) => atom(item.remainingPayableAtoms) > 0n); let dividends = [...company.dividends];
  const dividendAllocations = proRata(dividendPaid, outstanding.map((dividend) => atom(dividend.remainingPayableAtoms)));
  for (let index = 0; index < outstanding.length; index++) {
    const dividend = outstanding[index]!; const nominal = atom(dividend.remainingPayableAtoms);
    const paid = dividendAllocations[index]!;
    const recoveryRatio = ratio(atom(dividend.paidAtoms) + paid, atom(dividend.totalNominalAtoms));
    const impaired: CorporateDividend = { ...dividend, status: 'IMPAIRED', recoveryRatio, remainingPayableAtoms: paid.toString() };
    if (paid < nominal) m.actions.push({ ...identity(company, tick, `dividend_liquidation_impair_${dividend.id}`), kind: 'DIVIDEND_IMPAIRED', dividend: impaired });
    m.post('DIVIDEND_LIQUIDATION_IMPAIRMENT', dividend.id, 'dividend_payable', 'retained_earnings', nominal - paid);
    m.post('DIVIDEND_LIQUIDATION_PAYMENT', dividend.id, 'dividend_payable', 'cash', paid);
    const settled: CorporateDividend = { ...impaired, status: 'SETTLED', remainingPayableAtoms: '0', paidAtoms: (atom(dividend.paidAtoms) + paid).toString() };
    dividends = dividends.map((entry) => entry.id === dividend.id ? settled : entry);
    m.actions.push({ ...identity(company, tick, `dividend_liquidation_pay_${dividend.id}`), kind: 'DIVIDEND_PAYMENT', dividend: settled });
    recoveries.push({ dividendId: dividend.id, recoveryRatio, paidAtoms: settled.paidAtoms });
  }
  const common = atom(waterfall.commonAtoms); m.post('COMMON_LIQUIDATION_DISTRIBUTION', company.liquidation.id, 'retained_earnings', 'cash', common);
  // Discharged unpaid claims stay in action history, while the extinguished balance sheet closes.
  for (const account of ['debt', 'trade_payables', 'interest_payable', 'tax_payable', 'dividend_payable', 'contract_liability'] as const) m.post('LIQUIDATION_CLAIM_DISCHARGE', company.liquidation.id, account, 'retained_earnings', atom(m.company.balances[account]));
  const paidCapital = atom(m.company.balances.paid_in_capital); m.post('LIQUIDATION_EQUITY_CLOSE', company.liquidation.id, 'paid_in_capital', 'retained_earnings', paidCapital);
  m.set({ ...m.company, lifecycle: 'EXTINGUISHED', lifecycleSinceTick: tick, status: 'STRESSED', reservedDividendAtoms: '0', dividends,
    workingCapital: [], debtContracts: company.debtContracts.map((debt) => ({ ...debt, principalAtoms: '0', accruedInterestAtoms: '0', interestCarry: { numerator: '0', denominator: '1' } })), investments: [],
    liquidation: { ...company.liquidation, realizedRecoveryPerShare: waterfall.recoveryPerShare } });
  m.actions.push({ ...identity(company, tick, 'liquidation_settled'), kind: 'LIQUIDATION_SETTLED', liquidationId: company.liquidation.id, realizedRecoveryPerShare: waterfall.recoveryPerShare, commonPaidAtoms: waterfall.commonAtoms, eligibleShares: company.issuedShares, dividendRecoveries: recoveries });
  checkCorporateBalance(m.company); return output(m);
}

/** Existing supplier claims receive the debtor's senior payment, never the replacement issuer's money. */
export function settleLiquidationCreditors(debtor: CompanyTrueState, settlement: Mutation, companies: readonly CompanyTrueState[], marketId: string, tick: number): { readonly companies: readonly CompanyTrueState[]; readonly entries: readonly CorporateJournalEntry[] } {
  const payments = settlement.entries.filter((entry) => entry.kind === 'LIQUIDATION_SENIOR_PAYMENT').flatMap((entry) => entry.lines).filter((line) => line.account === 'trade_payables' && line.side === 'DR').reduce((sum, line) => sum + atom(line.amountAtoms), 0n);
  if (payments === 0n) return { companies, entries: [] };
  const payables = debtor.workingCapital.filter((item) => item.kind === 'AP');
  const allocations = proRata(payments, payables.map((item) => atom(item.amountAtoms)));
  const updated = [...companies]; const entries: CorporateJournalEntry[] = [];
  for (let index = 0; index < payables.length; index++) {
    const item = payables[index]!; const paid = allocations[index]!;
    if (paid === 0n || item.counterparty === 'EXTERNAL') continue;
    const creditorIndex = updated.findIndex((company) => company.symbol === item.counterparty && (item.counterpartyIssuerId === null || item.counterpartyIssuerId === company.issuerId));
    if (creditorIndex < 0) continue;
    const creditor = updated[creditorIndex]!; const m = mutator(creditor, marketId, tick);
    const receivable = creditor.workingCapital.find((claim) => claim.kind === 'AR' && claim.causeId === item.causeId && claim.contractId === item.contractId && (claim.counterpartyIssuerId === null || claim.counterpartyIssuerId === debtor.issuerId));
    const collected = min(paid, receivable ? atom(receivable.amountAtoms) : 0n); const recovery = paid - collected;
    m.post('LIQUIDATION_CONTRACT_COLLECTION', `${debtor.liquidation?.id}_${item.id}`, 'cash', 'receivables', collected);
    m.post('LIQUIDATION_BAD_DEBT_RECOVERY', `${debtor.liquidation?.id}_${item.id}`, 'cash', 'retained_earnings', recovery);
    const workingCapital = m.company.workingCapital.flatMap((claim) => claim.id === receivable?.id ? (atom(claim.amountAtoms) === collected ? [] : [{ ...claim, amountAtoms: (atom(claim.amountAtoms) - collected).toString() }]) : [claim]);
    m.set({ ...m.company, workingCapital, currentQuarter: { ...m.company.currentQuarter, operatingCashFlowAtoms: (atom(m.company.currentQuarter.operatingCashFlowAtoms) + paid).toString(), revenueAtoms: (atom(m.company.currentQuarter.revenueAtoms) + recovery).toString(), oneOffProfitAtoms: (atom(m.company.currentQuarter.oneOffProfitAtoms) + recovery).toString() } });
    checkCorporateBalance(m.company); updated[creditorIndex] = m.company; entries.push(...m.entries);
  }
  return { companies: updated, entries };
}
