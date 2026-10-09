import { FinancialDecimal, MONEY_SCALE, addFractions, decimalFraction, fraction, moneyFromAtoms, multiplyFractions, parseFraction, parseMoney, parseRate, quantizeMoney, serializeFraction } from '../domain/numeric.js';
import { annualEffectiveRateForDays } from '../domain/rates.js';
import { INITIAL_COMPANIES } from '../fixtures/initial-companies.js';
import type { AccountBalances, CompanyTrueState, CorporateAccount, CorporateJournalEntry, DebtContract, EconomicSymbol, EconomyRandom, FinancialReport, IntercompanyContract, InvestmentProject, MacroState, QuarterTotals, WorkingCapitalItem } from './types.js';
import { normalInnovation } from './macro.js';
import type { CompanyEventModifier } from '../events/types.js';

const D = FinancialDecimal;
const exportExposure = (symbol: EconomicSymbol) => symbol === 'HGI' ? '0.22' : symbol === 'TLR' ? '0.18' : symbol === 'VTR' ? '0.12' : '0';
type DecimalValue = InstanceType<typeof D>;
const RATE_CACHE = new Map<string, string>();
function dailyRate(annualRate: string): string {
  let cached = RATE_CACHE.get(annualRate);
  if (cached === undefined) {
    cached = annualEffectiveRateForDays(parseRate(annualRate), 1);
    if (RATE_CACHE.size >= 1024) RATE_CACHE.clear();
    RATE_CACHE.set(annualRate, cached);
  }
  return cached;
}
export const ASSET_ACCOUNTS: readonly CorporateAccount[] = ['cash', 'receivables', 'inventory', 'operating_assets', 'intangible_assets', 'construction_in_progress'];
export const LIABILITY_ACCOUNTS: readonly CorporateAccount[] = ['trade_payables', 'debt', 'interest_payable', 'tax_payable', 'dividend_payable', 'contract_liability'];
export const EQUITY_ACCOUNTS: readonly CorporateAccount[] = ['paid_in_capital', 'retained_earnings'];
const OFFSETS: Record<EconomicSymbol, number> = { HGI: 1, DNL: 1, TLR: 2, NXC: 3, VTR: 3, AUR: 4, LMB: 4, RVI: 2 };
const costs = {
  HGI: ['0.42', '0.08', '0.20', '0.06', '0.02', '0.10', '0.65', '0.04'],
  DNL: ['0.45', '0.05', '0.25', '0.07', '0.01', '0.07', '0.75', '0.04'],
  TLR: ['0.40', '0.23', '0.15', '0.06', '0.005', '0.035', '0.85', '0.05'],
  NXC: ['0', '0.08', '0.43', '0.24', '0.24', '0.06', '0.45', '0.12'],
  VTR: ['0.34', '0.07', '0.25', '0.10', '0.15', '0.06', '0.50', '0.10'],
  AUR: ['0.35', '0.10', '0.45', '0.20', '0.65', '0.05', '0.25', '0.06'],
  LMB: ['0.10', '0.08', '0.60', '0.22', '2.80', '0.20', '0.15', '0.04'],
  RVI: ['0', '0.16', '0.20', '0.21', '0.01', '0.17', '0.80', '0.05'],
} as const;
export function zeroQuarter(): QuarterTotals {
  return { revenueAtoms: '0', rawMaterialsAtoms: '0', energyAtoms: '0', laborAtoms: '0', serviceAtoms: '0', researchAtoms: '0', depreciationAtoms: '0', interestAtoms: '0', taxAtoms: '0', operatingCashFlowAtoms: '0', capexAtoms: '0', debtRepaidAtoms: '0', debtIssuedAtoms: '0', oneOffProfitAtoms: '0', foreignExchangeProfitAtoms: '0' };
}
function atoms(input: string): bigint { return moneyFromAtoms(input); }
function scaled(value: DecimalValue): bigint { return moneyFromAtoms(value.toDecimalPlaces(0, D.ROUND_HALF_EVEN).toFixed(0)); }
function pointAtoms(value: DecimalValue): bigint { return scaled(value.mul(MONEY_SCALE.toString())); }
function sumAccounts(balance: AccountBalances, keys: readonly CorporateAccount[]): bigint { return keys.reduce((sum, key) => sum + atoms(balance[key]), 0n); }
function baseCompany(symbol: EconomicSymbol) { return INITIAL_COMPANIES.find((item) => item.symbol === symbol)!; }
export function checkCorporateBalance(company: CompanyTrueState): void {
  for (const key of [...ASSET_ACCOUNTS, ...LIABILITY_ACCOUNTS, ...EQUITY_ACCOUNTS]) {
    const value = atoms(company.balances[key]);
    if (key !== 'retained_earnings' && value < 0n) throw new Error('Corporate asset or liability cannot be negative');
  }
  if (sumAccounts(company.balances, ASSET_ACCOUNTS) !== sumAccounts(company.balances, LIABILITY_ACCOUNTS) + sumAccounts(company.balances, EQUITY_ACCOUNTS)) throw new Error('Corporate balance sheet does not reconcile');
  const debt = company.debtContracts.reduce((sum, item) => sum + atoms(item.principalAtoms), 0n);
  const interest = company.debtContracts.reduce((sum, item) => sum + atoms(item.accruedInterestAtoms), 0n);
  if (debt !== atoms(company.balances.debt) || interest !== atoms(company.balances.interest_payable)) throw new Error('Corporate debt subledger does not reconcile');
  const ar = company.workingCapital.filter((item) => item.kind === 'AR').reduce((sum, item) => sum + atoms(item.amountAtoms), 0n);
  const ap = company.workingCapital.filter((item) => item.kind === 'AP').reduce((sum, item) => sum + atoms(item.amountAtoms), 0n);
  if (ar !== atoms(company.balances.receivables) || ap !== atoms(company.balances.trade_payables)) throw new Error('Working capital subledger does not reconcile');
  const dividend = company.dividends.reduce((sum, item) => sum + atoms(item.remainingPayableAtoms), 0n);
  if (dividend !== atoms(company.balances.dividend_payable)) throw new Error('Dividend obligations do not reconcile');
  if (atoms(company.reservedDividendAtoms) < 0n || atoms(company.reservedDividendAtoms) > dividend) throw new Error('Invalid reserved dividend cash');
}
export function initialCorporateState(): readonly CompanyTrueState[] {
  return INITIAL_COMPANIES.map((source) => {
    const symbol = source.symbol as EconomicSymbol;
    const openingAsset = (code: string) => parseMoney(source.balanceSheet.assets.find((item) => item.code === code)!.amount).toString();
    const balances: AccountBalances = {
      cash: openingAsset('cash'), receivables: openingAsset('trade_receivables'), inventory: openingAsset('inventory'),
      operating_assets: openingAsset('property_plant_equipment'), intangible_assets: openingAsset('intangible_assets'), construction_in_progress: '0',
      trade_payables: parseMoney(source.totalLiabilities).toString() === parseMoney(source.interestBearingDebt).toString() ? '0'
        : (parseMoney(source.totalLiabilities) - parseMoney(source.interestBearingDebt)).toString(),
      debt: parseMoney(source.interestBearingDebt).toString(), interest_payable: '0', tax_payable: '0', dividend_payable: '0', contract_liability: '0',
      paid_in_capital: (parseMoney(source.totalEquity) - parseMoney(source.distributableProfit)).toString(), retained_earnings: parseMoney(source.distributableProfit).toString(),
    };
    const debtContracts: DebtContract[] = source.debtTranches.flatMap((tranche, index) => (['FIXED', 'VARIABLE'] as const).map((rateType) => ({
      id: `${symbol}_debt_${index}_${rateType.toLowerCase()}`, rateType,
      principalAtoms: parseMoney(rateType === 'FIXED' ? tranche.fixedPrincipal : tranche.variablePrincipal).toString(),
      annualEffectiveRate: tranche.initialAnnualEffectiveRate, spread: tranche.initialVariableSpread,
      maturityTick: tranche.maturityTick, nextResetTick: 21, nextInterestPaymentTick: 21,
      accruedInterestAtoms: '0', interestCarry: { numerator: '0', denominator: '1' },
    })));
    const workingCapital: WorkingCapitalItem[] = [
      { id: `${symbol}_opening_ar`, causeId: `${symbol}_opening`, contractId: null, counterparty: 'EXTERNAL', counterpartyIssuerId: null, kind: 'AR', amountAtoms: balances.receivables, dueTick: 14, overdueSinceTick: null },
      { id: `${symbol}_opening_ap`, causeId: `${symbol}_opening`, contractId: null, counterparty: 'EXTERNAL', counterpartyIssuerId: null, kind: 'AP', amountAtoms: balances.trade_payables, dueTick: 21, overdueSinceTick: null },
    ].filter((item) => item.amountAtoms !== '0') as WorkingCapitalItem[];
    const financialBase = { cashAtoms: balances.cash, debtAtoms: balances.debt, assetsAtoms: parseMoney(source.totalAssets).toString(), liabilitiesAtoms: parseMoney(source.totalLiabilities).toString(), equityAtoms: parseMoney(source.totalEquity).toString(), receivablesAtoms: balances.receivables, payablesAtoms: balances.trade_payables, issuedShares: source.issuedShares, operatingAssetsAtoms: (atoms(balances.operating_assets) + atoms(balances.intangible_assets)).toString(), dividendPayableAtoms: '0', oneOffProfitAtoms: '0', foreignExchangeProfitAtoms: '0' };
    const sealedQuarters: FinancialReport[] = source.syntheticHistory.map((quarter, index) => ({
      ...financialBase, kind: 'SYNTHETIC_INITIALIZATION', quarterNo: index - 4, closedTick: 0, publishTick: 0,
      revenueAtoms: parseMoney(quarter.revenue).toString(), operatingProfitAtoms: parseMoney(quarter.operatingProfit).toString(), interestExpenseAtoms: parseMoney(quarter.interestExpense).toString(),
      pretaxProfitAtoms: parseMoney(quarter.pretaxProfit).toString(), corporateTaxAtoms: parseMoney(quarter.corporateTax).toString(), netProfitAtoms: parseMoney(quarter.netProfit).toString(),
      depreciationAtoms: pointAtoms(new D(source.annualRevenue).mul(costs[symbol][5]).div('4')).toString(),
      operatingCashFlowAtoms: (parseMoney(quarter.netProfit) + pointAtoms(new D(source.annualRevenue).mul(costs[symbol][5]).div('4'))).toString(),
      capexAtoms: pointAtoms(new D(source.annualRevenue).mul(costs[symbol][7]).div('4')).toString(), debtIssuedAtoms: '0', debtRepaidAtoms: '0',
    }));
    const company: CompanyTrueState = { issuerId: source.issuerId, listingId: source.listingId, slotId: source.slotId, category: source.category, symbol, name: source.name, issuedShares: source.issuedShares, status: 'NORMAL', generation: 1, createdTick: 0, lifecycle: 'OPERATING', lifecycleSinceTick: 0, dividendBan: false, financingAttempts: 0, eventEquityIssues: 0, reservedDividendAtoms: '0', dividends: [], liquidation: null, balances, debtContracts, workingCapital, investments: [], currentQuarter: zeroQuarter(), sealedQuarters, unitPrice: '1000', unitPriceBasis: '1000', volume: new D(source.annualRevenue).div('252').div('1000').toString(), capacity: new D(source.annualRevenue).div('252').div('1000').mul('1.25').toString(), productivity: '1', customerBase: '1' };
    checkCorporateBalance(company);
    return company;
  });
}
/** The initialization bridge is public fixture material, not a projection of evolving private state. */
export const INITIAL_PUBLIC_REPORTS = Object.freeze(Object.fromEntries(initialCorporateState().map((company) => [company.symbol,
  Object.freeze(company.sealedQuarters.map((report) => Object.freeze({ ...report }))),
]))) as Readonly<Record<EconomicSymbol, readonly FinancialReport[]>>;
export const INITIAL_CONTRACTS: readonly IntercompanyContract[] = [
  ['TLR', 'HGI', 'RAW_MATERIALS', 'rawMaterials', '0.20'], ['TLR', 'VTR', 'RAW_MATERIALS', 'rawMaterials', '0.10'],
  ['HGI', 'VTR', 'RAW_MATERIALS', 'rawMaterials', '0.15'], ['HGI', 'AUR', 'RAW_MATERIALS', 'rawMaterials', '0.10'],
  ['VTR', 'HGI', 'CAPEX', 'capex', '0.20'], ['VTR', 'DNL', 'CAPEX', 'capex', '0.20'],
  ['NXC', 'HGI', 'SERVICE', 'service', '0.10'], ['NXC', 'DNL', 'SERVICE', 'service', '0.10'], ['NXC', 'VTR', 'SERVICE', 'service', '0.10'], ['NXC', 'RVI', 'SERVICE', 'service', '0.10'],
  ['RVI', 'NXC', 'SERVICE', 'service', '0.15'],
].map(([supplier, customer, kind, costBucket, exposure]) => ({ contractId: `baseline_${supplier}_${customer}_${kind}`, supplier: supplier as EconomicSymbol, customer: customer as EconomicSymbol, kind: kind as IntercompanyContract['kind'], costBucket: costBucket as IntercompanyContract['costBucket'], exposure: parseRate(exposure!), settlementLagTicks: 7 }));

interface MutableCompany {
  source: CompanyTrueState; balances: Record<CorporateAccount, string>; workingCapital: WorkingCapitalItem[];
  debtContracts: DebtContract[]; investments: InvestmentProject[]; quarter: Record<keyof QuarterTotals, string>;
  unitPrice: string; unitPriceBasis: string; volume: string; capacity: string; productivity: string; customerBase: string; stressed: boolean;
}
export interface CorporateAdvanceResult { readonly companies: readonly CompanyTrueState[]; readonly entries: readonly CorporateJournalEntry[] }
/** Both counterparties are advanced together so every contract transfer is matched once. */
export function advanceCorporations(marketId: string, companies: readonly CompanyTrueState[], contracts: readonly IntercompanyContract[], macro: MacroState, tick: number, random: EconomyRandom, modifiers: Readonly<Record<string, CompanyEventModifier>> = {}): CorporateAdvanceResult {
  const mutable = new Map<EconomicSymbol, MutableCompany>(companies.map((source) => [source.symbol, { source, balances: { ...source.balances }, workingCapital: [...source.workingCapital], debtContracts: [...source.debtContracts], investments: [...source.investments], quarter: { ...source.currentQuarter }, unitPrice: source.unitPrice, unitPriceBasis: source.unitPriceBasis, volume: source.volume, capacity: source.capacity, productivity: source.productivity, customerBase: source.customerBase, stressed: false }]));
  const entries: CorporateJournalEntry[] = [];
  const availableCash = (company: MutableCompany): bigint => { const available = atoms(company.balances.cash) - atoms(company.source.reservedDividendAtoms); return available > 0n ? available : 0n; };
  const qAdd = (company: MutableCompany, field: keyof QuarterTotals, amount: bigint) => { company.quarter[field] = (atoms(company.quarter[field]) + amount).toString(); };
  const post = (company: MutableCompany, kind: string, causeId: string, debit: CorporateAccount, credit: CorporateAccount, amount: bigint, contractId: string | null = null) => {
    if (amount === 0n) return;
    if (amount < 0n) throw new Error('Journal amount cannot be negative');
    const adjust = (account: CorporateAccount, side: 'DR' | 'CR') => {
      const debitNormal = ASSET_ACCOUNTS.includes(account);
      company.balances[account] = moneyFromAtoms((atoms(company.balances[account]) + ((side === 'DR') === debitNormal ? amount : -amount)).toString()).toString();
    };
    adjust(debit, 'DR'); adjust(credit, 'CR');
    entries.push({ entryId: `${marketId}_${tick}_${company.source.symbol}_${entries.length}`, causeId, marketId, issuerId: company.source.issuerId, tickNo: tick, kind, contractId, lines: [{ account: debit, side: 'DR', amountAtoms: amount.toString() }, { account: credit, side: 'CR', amountAtoms: amount.toString() }] });
  };
  const addWorking = (company: MutableCompany, kind: 'AR' | 'AP', causeId: string, amount: bigint, dueTick: number, contractId: string | null, counterparty: EconomicSymbol | 'EXTERNAL') => {
    if (amount <= 0n) return;
    company.workingCapital.push({ id: `${causeId}_${company.source.symbol}_${kind}`, causeId, contractId, counterparty, counterpartyIssuerId: counterparty === 'EXTERNAL' ? null : mutable.get(counterparty)!.source.issuerId, kind, amountAtoms: amount.toString(), dueTick, overdueSinceTick: null, fxAtOrigination: kind === 'AR' && counterparty === 'EXTERNAL' ? macro.fx : null, foreignExposure: kind === 'AR' && counterparty === 'EXTERNAL' ? exportExposure(company.source.symbol) : '0' });
  };
  // External customer collections precede payments; no cash is created by intercompany settlement.
  for (const company of mutable.values()) {
    company.workingCapital = company.workingCapital.filter((item) => {
      if (item.kind !== 'AR' || item.counterparty !== 'EXTERNAL' || item.dueTick > tick) return true;
      const amount = atoms(item.amountAtoms); post(company, 'CUSTOMER_COLLECTION', item.causeId, 'cash', 'receivables', amount, item.contractId);
      const translation = item.fxAtOrigination ? scaled(new D(amount.toString()).mul(item.foreignExposure ?? '0').mul(new D(macro.fx).div(item.fxAtOrigination).minus(1))) : 0n;
      if (translation > 0n) { post(company, 'REALIZED_FOREIGN_EXCHANGE_GAIN', item.causeId, 'cash', 'retained_earnings', translation); qAdd(company, 'revenueAtoms', translation); }
      if (translation < 0n) { post(company, 'REALIZED_FOREIGN_EXCHANGE_LOSS', item.causeId, 'retained_earnings', 'cash', -translation); qAdd(company, 'serviceAtoms', -translation); }
      qAdd(company, 'oneOffProfitAtoms', translation); qAdd(company, 'foreignExchangeProfitAtoms', translation); qAdd(company, 'operatingCashFlowAtoms', amount + translation); return false;
    });
  }
  for (const company of mutable.values()) {
    const retained: WorkingCapitalItem[] = [];
    for (const item of company.workingCapital) {
      if (item.kind !== 'AP' || item.dueTick > tick) { retained.push(item); continue; }
      const paid = atoms(item.amountAtoms) < availableCash(company) ? atoms(item.amountAtoms) : availableCash(company);
      if (paid > 0n) {
        post(company, 'SUPPLIER_PAYMENT', item.causeId, 'trade_payables', 'cash', paid, item.contractId);
        if (item.contractId?.includes('CAPEX')) qAdd(company, 'capexAtoms', paid); else qAdd(company, 'operatingCashFlowAtoms', -paid);
        if (item.counterparty !== 'EXTERNAL' && (item.counterpartyIssuerId === null || item.counterpartyIssuerId === mutable.get(item.counterparty)!.source.issuerId)) {
          const supplier = mutable.get(item.counterparty)!;
          const index = supplier.workingCapital.findIndex((ar) => ar.kind === 'AR' && ar.causeId === item.causeId && ar.contractId === item.contractId);
          const ar = supplier.workingCapital[index];
          post(supplier, ar ? 'CONTRACT_COLLECTION' : 'BAD_DEBT_RECOVERY', item.causeId, 'cash', ar ? 'receivables' : 'retained_earnings', paid, item.contractId);
          qAdd(supplier, 'operatingCashFlowAtoms', paid);
          if (ar) {
            const remaining = atoms(ar.amountAtoms) - paid;
            if (remaining < 0n) throw new Error('Contract settlement exceeds receivable');
            if (remaining === 0n) supplier.workingCapital.splice(index, 1); else supplier.workingCapital[index] = { ...ar, amountAtoms: remaining.toString() };
          } else { qAdd(supplier, 'revenueAtoms', paid); qAdd(supplier, 'oneOffProfitAtoms', paid); }
        }
      }
      const remaining = atoms(item.amountAtoms) - paid;
      if (remaining > 0n) { retained.push({ ...item, amountAtoms: remaining.toString(), overdueSinceTick: item.overdueSinceTick ?? tick }); company.stressed = true; }
    }
    company.workingCapital = retained;
  }
  // Carry defaulted contract claims until an explicit impairment entry; debtor obligation remains.
  for (const company of mutable.values()) {
    company.workingCapital = company.workingCapital.filter((item) => {
      if (item.kind !== 'AR' || item.counterparty === 'EXTERNAL' || tick - item.dueTick < 21) return true;
      post(company, 'RECEIVABLE_IMPAIRMENT', item.causeId, 'retained_earnings', 'receivables', atoms(item.amountAtoms), item.contractId);
      qAdd(company, 'serviceAtoms', atoms(item.amountAtoms)); qAdd(company, 'oneOffProfitAtoms', -atoms(item.amountAtoms)); company.stressed = true; return false;
    });
  }
  const operations = new Map<EconomicSymbol, { revenue: bigint; rawMaterials: bigint; energy: bigint; labor: bigint; service: bigint; research: bigint; capex: bigint }>();
  const dailyPriceInflation = new D('1').plus(macro.inflation).pow(new D('1').div('252')).minus('1');
  for (const company of mutable.values()) {
    const symbol = company.source.symbol; const base = baseCompany(symbol); const parameter = costs[symbol];
    const effect = modifiers[company.source.issuerId]; const factor = (key: keyof CompanyEventModifier) => D.max('0', new D('1').plus(effect?.[key] ?? '0')); 
    const growth = new D(base.nominalRevenueGrowth ?? '0').mul(D.max('0', new D('1').minus(new D(company.source.customerBase).div('2'))));
    const dayGrowth = new D('1').plus(growth).pow(new D('1').div('252')).minus('1');
    company.customerBase = D.min('2', new D(company.source.customerBase).mul(new D('1').plus(dayGrowth))).toString();
    const priceInflation = dailyPriceInflation.mul(parameter[6]);
    const commodityPassThrough = new D(macro.metals).div('100').minus('1').mul(parameter[0]).mul(parameter[6]).mul('0.002');
    company.unitPriceBasis = new D(company.source.unitPriceBasis).mul(new D('1').plus(priceInflation).plus(commodityPassThrough)).toString();
    company.unitPrice = new D(company.unitPriceBasis).mul(factor('unitPrice')).mul(new D('1').plus(new D(effect?.productMix ?? '0').mul('0.5'))).toString();
    const demand = new D(symbol === 'DNL' ? macro.consumerDemand : symbol === 'LMB' ? '100' : macro.industrialDemand).div('100');
    const salesNoise = normalInnovation(random, tick, company.source.issuerId, 'corporate-sales').mul(company.source.category === 'THEMATIC' ? '0.025' : '0.004');
    const volume = D.max('0', D.min(D.max('0', new D(company.source.capacity).mul(D.min('1',factor('capacity'))).minus(effect?.reservedVolume ?? '0')), new D(base.annualRevenue).div('252000').mul(company.customerBase).mul(demand).mul(new D('1').plus(salesNoise)).mul(company.source.productivity).mul(factor('demand')).mul(factor('customerBase')).mul(factor('productivity')).mul(D.max('0', new D('1').minus(new D(effect?.unitPrice ?? '0').mul('0.35'))))));
    company.volume = volume.toString();
    const exportRatio = exportExposure(symbol);
    const revenue = pointAtoms(volume.mul(company.unitPrice).mul(new D('1').plus(new D(macro.fx).div('100').minus('1').mul(exportRatio))).mul(new D('1').plus(new D(effect?.exportDemand ?? '0').mul(exportRatio))));
    const baseline = new D(base.annualRevenue).div('252').mul(new D(company.customerBase).sqrt());
    const ratioVolume = volume.div(new D(base.annualRevenue).div('252000'));
    const rawMaterials = pointAtoms(new D(base.annualRevenue).div('252').mul(parameter[0]).mul(ratioVolume).mul(new D(macro.metals).div('100')).div(new D(company.source.productivity).mul(factor('productivity'))).mul(factor('rawMaterials')));
    const energy = pointAtoms(new D(base.annualRevenue).div('252').mul(parameter[1]).mul(ratioVolume.mul('0.7').plus('0.3')).mul(new D(macro.energy).div('100')).mul(factor('energy')));
    const labor = pointAtoms(baseline.mul(parameter[2]).mul(new D('1').plus(new D(macro.inflation).mul(new D(tick.toString()).div('252')))).mul(factor('labor')));
    const service = pointAtoms(baseline.mul(parameter[3]).mul(new D('1').plus(new D(macro.inflation).mul('0.25'))).mul(factor('service')));
    const research = pointAtoms(baseline.mul(parameter[4]).mul(factor('research')));
    const futureOperatingCost = rawMaterials + energy + labor + service + research;
    const annualCapex = parseMoney(base.annualRevenue) * BigInt(new D(parameter[7]).mul('10000').toFixed(0)) / 10000n;
    const capexBudget = annualCapex / 4n;
    if (tick % 63 === 1 && availableCash(company) > futureOperatingCost * 42n + capexBudget && !company.stressed) {
      company.investments.push({ id: `${symbol}_investment_${tick}`, causeId: `${marketId}_${symbol}_investment_${tick}`, contractId: symbol === 'HGI' || symbol === 'DNL' ? `baseline_VTR_${symbol}_CAPEX` : null, amountAtoms: capexBudget.toString(), startedTick: tick, completionTick: tick + 8, status: 'PLANNED', usefulLifeTicks: 2520, depreciatedAtoms: '0', productivityEffect: '0.005' });
    }
    const planned = company.investments.find((project) => project.status === 'PLANNED' && tick >= project.startedTick + 2);
    const capex = planned && availableCash(company) > futureOperatingCost * 42n + atoms(planned.amountAtoms) && !company.stressed ? atoms(planned.amountAtoms) : 0n;
    operations.set(symbol, { revenue, rawMaterials, energy, labor, service, research, capex });
  }
  const incoming = new Map<EconomicSymbol, bigint>(); const outgoing = new Map<string, bigint>();
  for (const contract of contracts) {
    const customer = mutable.get(contract.customer)!; const supplier = mutable.get(contract.supplier)!;
    const operation = operations.get(contract.customer)!;
    const requested = scaled(new D(operation[contract.costBucket].toString()).mul(contract.exposure));
    const capacity = operations.get(contract.supplier)!.revenue - (incoming.get(contract.supplier) ?? 0n);
    const amount = requested < capacity ? requested : capacity;
    // A supplier's production constraint redirects the remainder to the external economy.
    // It never restricts an investor order or causes a financial-invariant failure.
    if (amount <= 0n) continue;
    const cause = `${marketId}_${contract.contractId}_${tick}`;
    post(supplier, 'CONTRACT_REVENUE', cause, 'receivables', 'retained_earnings', amount, contract.contractId);
    post(customer, contract.kind === 'CAPEX' ? 'CONTRACT_CAPEX' : 'CONTRACT_EXPENSE', cause, contract.kind === 'CAPEX' ? 'construction_in_progress' : 'retained_earnings', 'trade_payables', amount, contract.contractId);
    addWorking(supplier, 'AR', cause, amount, tick + contract.settlementLagTicks, contract.contractId, contract.customer);
    addWorking(customer, 'AP', cause, amount, tick + contract.settlementLagTicks, contract.contractId, contract.supplier);
    qAdd(supplier, 'revenueAtoms', amount);
    if (contract.kind !== 'CAPEX') qAdd(customer, contract.costBucket === 'rawMaterials' ? 'rawMaterialsAtoms' : 'serviceAtoms', amount);
    incoming.set(contract.supplier, (incoming.get(contract.supplier) ?? 0n) + amount);
    const key = `${contract.customer}_${contract.costBucket}`; outgoing.set(key, (outgoing.get(key) ?? 0n) + amount);
  }
  for (const company of mutable.values()) {
    const symbol = company.source.symbol; const operation = operations.get(symbol)!; const cause = `${marketId}_${symbol}_operations_${tick}`;
    const externalRevenue = operation.revenue - (incoming.get(symbol) ?? 0n);
    if (externalRevenue < 0n) throw new Error('Contract allocation exceeded the supplier revenue plan');
    post(company, 'EXTERNAL_SALES', cause, 'receivables', 'retained_earnings', externalRevenue);
    addWorking(company, 'AR', cause, externalRevenue, tick + (symbol === 'RVI' ? 7 : 14), null, 'EXTERNAL'); qAdd(company, 'revenueAtoms', externalRevenue);
    for (const [bucket, quarterField] of [['rawMaterials', 'rawMaterialsAtoms'], ['energy', 'energyAtoms'], ['labor', 'laborAtoms'], ['service', 'serviceAtoms'], ['research', 'researchAtoms']] as const) {
      const expense = operation[bucket] - (outgoing.get(`${symbol}_${bucket}`) ?? 0n);
      if (expense < 0n) throw new Error('Contract purchases exceed cost-bucket exposure');
      const turnover = new D(modifiers[company.source.issuerId]?.inventoryTurnover ?? '0');
      const requestedConsumption = bucket === 'rawMaterials' && turnover.gt(0) ? scaled(new D(expense.toString()).mul(turnover)) : 0n;
      const consumedInventory = requestedConsumption < atoms(company.balances.inventory) ? requestedConsumption : atoms(company.balances.inventory);
      post(company, 'EVENT_INVENTORY_CONSUMPTION', `${cause}_${bucket}`, 'retained_earnings', 'inventory', consumedInventory);
      const payableExpense = expense - consumedInventory;
      post(company, bucket === 'research' ? 'RESEARCH_EXPENSE' : 'OPERATING_EXPENSE', `${cause}_${bucket}`, 'retained_earnings', 'trade_payables', payableExpense);
      addWorking(company, 'AP', `${cause}_${bucket}`, payableExpense, tick + (bucket === 'labor' || bucket === 'research' ? 1 : 7), null, 'EXTERNAL'); qAdd(company, quarterField, expense);
      if (bucket === 'rawMaterials' && turnover.lt(0)) {
        const inventoryPurchase = scaled(new D(expense.toString()).mul(turnover.abs()));
        post(company, 'EVENT_INVENTORY_BUFFER_PURCHASE', `${cause}_inventory`, 'inventory', 'trade_payables', inventoryPurchase);
        addWorking(company, 'AP', `${cause}_inventory`, inventoryPurchase, tick + 7, null, 'EXTERNAL');
      }
    }
    if (operation.capex > 0n) {
      const internal = outgoing.get(`${symbol}_capex`) ?? 0n; const external = operation.capex - internal;
      post(company, 'CAPEX_SPEND', `${cause}_capex`, 'construction_in_progress', 'cash', external); qAdd(company, 'capexAtoms', external);
      const projectIndex = company.investments.findIndex((project) => project.status === 'PLANNED' && tick >= project.startedTick + 2);
      const planned = company.investments[projectIndex];
      if (!planned) throw new Error('CAPEX requires an approved plan');
      company.investments[projectIndex] = { ...planned, startedTick: tick, completionTick: tick + 6, status: 'IN_PROGRESS', contractId: internal > 0n ? `baseline_VTR_${symbol}_CAPEX` : null };
    }
    const updatedInvestments: InvestmentProject[] = [];
    for (const project of company.investments) {
      if (project.status === 'IN_PROGRESS' && project.completionTick <= tick) {
        post(company, 'CAPEX_COMPLETION', project.causeId, 'operating_assets', 'construction_in_progress', atoms(project.amountAtoms), project.contractId);
        company.productivity = D.min('1.4', new D(company.productivity).plus(project.productivityEffect)).toString();
        company.capacity = new D(company.capacity).mul('1.005').toString(); updatedInvestments.push({ ...project, status: 'OPERATING' });
      } else if (project.status === 'OPERATING' && tick > project.completionTick) {
        const age = tick - project.completionTick;
        const target = age >= project.usefulLifeTicks ? atoms(project.amountAtoms) : atoms(project.amountAtoms) * BigInt(age) / BigInt(project.usefulLifeTicks);
        const plannedDepreciation = target - atoms(project.depreciatedAtoms);
        const assetAccount = project.assetAccount ?? 'operating_assets';
        const depreciation = plannedDepreciation < atoms(company.balances[assetAccount]) ? plannedDepreciation : atoms(company.balances[assetAccount]);
        post(company, 'PROJECT_DEPRECIATION', project.causeId, 'retained_earnings', assetAccount, depreciation, project.contractId); qAdd(company, 'depreciationAtoms', depreciation);
        updatedInvestments.push({ ...project, depreciatedAtoms: target.toString() });
      } else updatedInvestments.push(project);
    }
    company.investments = updatedInvestments;
    const base = baseCompany(symbol); const originalAssets = parseMoney(base.balanceSheet.assets.find((item) => item.code === 'property_plant_equipment')!.amount) + parseMoney(base.balanceSheet.assets.find((item) => item.code === 'intangible_assets')!.amount);
    const annualDep = pointAtoms(new D(base.annualRevenue).mul(costs[symbol][5]));
    const age = tick - company.source.createdTick;
    const previousAccumulated = annualDep * BigInt(age - 1) / 252n; const targetAccumulated = annualDep * BigInt(age) / 252n;
    const previousLimited = previousAccumulated < originalAssets ? previousAccumulated : originalAssets;
    const targetLimited = targetAccumulated < originalAssets ? targetAccumulated : originalAssets;
    const dep = targetLimited - previousLimited;
    const openingIntangible = parseMoney(base.balanceSheet.assets.find((item) => item.code === 'intangible_assets')!.amount);
    const intangibleWeight = originalAssets === 0n ? 0n : openingIntangible * targetLimited / originalAssets - openingIntangible * previousLimited / originalAssets;
    const actualIntangible = intangibleWeight < atoms(company.balances.intangible_assets) ? intangibleWeight : atoms(company.balances.intangible_assets);
    const plannedOperating = dep - intangibleWeight; const actualOperating = plannedOperating < atoms(company.balances.operating_assets) ? plannedOperating : atoms(company.balances.operating_assets);
    post(company, 'OPENING_ASSET_DEPRECIATION', cause, 'retained_earnings', 'intangible_assets', actualIntangible);
    post(company, 'OPENING_ASSET_DEPRECIATION', cause, 'retained_earnings', 'operating_assets', actualOperating); qAdd(company, 'depreciationAtoms', actualIntangible + actualOperating);
    const updatedDebts: DebtContract[] = [];
    for (const original of company.debtContracts) {
      let debt = original;
      // The just-ended interval earns its pre-boundary contract rate.
      // A meeting/reset committed at this boundary applies to the following interval.
      const accruedRate = dailyRate(debt.annualEffectiveRate);
      const exactInterest = addFractions(multiplyFractions(fraction(atoms(debt.principalAtoms), MONEY_SCALE), decimalFraction(accruedRate)), parseFraction(debt.interestCarry));
      const settlement = quantizeMoney(exactInterest, 'floor');
      const accrual = settlement.money; const carry = addFractions(exactInterest, fraction(-accrual, MONEY_SCALE));
      post(company, 'INTEREST_ACCRUAL', debt.id, 'retained_earnings', 'interest_payable', accrual); qAdd(company, 'interestAtoms', accrual);
      debt = { ...debt, accruedInterestAtoms: (atoms(debt.accruedInterestAtoms) + accrual).toString(), interestCarry: serializeFraction(carry) };
      if (debt.rateType === 'VARIABLE' && tick >= debt.nextResetTick) debt = { ...debt, annualEffectiveRate: parseRate(new D(macro.policyRate).plus(debt.spread).toString()), nextResetTick: tick + 21 };
      if (tick >= debt.nextInterestPaymentTick) {
        const payable = atoms(debt.accruedInterestAtoms); const paid = payable < availableCash(company) ? payable : availableCash(company);
        post(company, 'INTEREST_PAYMENT', debt.id, 'interest_payable', 'cash', paid); qAdd(company, 'operatingCashFlowAtoms', -paid);
        const unpaid = payable - paid; if (unpaid > 0n) company.stressed = true;
        debt = { ...debt, accruedInterestAtoms: unpaid.toString(), nextInterestPaymentTick: unpaid > 0n ? tick + 1 : tick + 21 };
      }
      if (tick >= debt.maturityTick) {
        const principal = atoms(debt.principalAtoms); const paid = principal < availableCash(company) ? principal : availableCash(company);
        post(company, 'DEBT_REPAYMENT', debt.id, 'debt', 'cash', paid); qAdd(company, 'debtRepaidAtoms', paid);
        const unpaid = principal - paid; if (unpaid > 0n) company.stressed = true;
        debt = { ...debt, principalAtoms: unpaid.toString() };
      }
      updatedDebts.push(debt);
    }
    company.debtContracts = updatedDebts;
    const taxPaid = atoms(company.balances.tax_payable) < availableCash(company) ? atoms(company.balances.tax_payable) : availableCash(company);
    post(company, 'TAX_PAYMENT', `${symbol}_tax`, 'tax_payable', 'cash', taxPaid); qAdd(company, 'operatingCashFlowAtoms', -taxPaid);
    if (atoms(company.balances.tax_payable) > 0n) company.stressed = true;
    if (tick % 63 === 0) {
      const quarter = company.quarter;
      const operatingProfit = atoms(quarter.revenueAtoms) - atoms(quarter.rawMaterialsAtoms) - atoms(quarter.energyAtoms) - atoms(quarter.laborAtoms) - atoms(quarter.serviceAtoms) - atoms(quarter.researchAtoms) - atoms(quarter.depreciationAtoms);
      const pretaxProfit = operatingProfit - atoms(quarter.interestAtoms); const tax = pretaxProfit > 0n ? pretaxProfit / 5n : 0n;
      post(company, 'CORPORATE_TAX_ACCRUAL', `${symbol}_quarter_${tick / 63}`, 'retained_earnings', 'tax_payable', tax); qAdd(company, 'taxAtoms', tax);
    }
  }
  const output = [...mutable.values()].map((company): CompanyTrueState => {
    const balances = company.balances; let sealedQuarters = company.source.sealedQuarters; let currentQuarter: QuarterTotals = company.quarter;
    if (tick % 63 === 0) {
      const quarter = company.quarter;
      const operatingProfit = atoms(quarter.revenueAtoms) - atoms(quarter.rawMaterialsAtoms) - atoms(quarter.energyAtoms) - atoms(quarter.laborAtoms) - atoms(quarter.serviceAtoms) - atoms(quarter.researchAtoms) - atoms(quarter.depreciationAtoms);
      const pretaxProfit = operatingProfit - atoms(quarter.interestAtoms);
      const report: FinancialReport = { kind: 'ACTUAL', quarterNo: tick / 63, closedTick: tick, publishTick: tick + OFFSETS[company.source.symbol], revenueAtoms: quarter.revenueAtoms, operatingProfitAtoms: operatingProfit.toString(), interestExpenseAtoms: quarter.interestAtoms, pretaxProfitAtoms: pretaxProfit.toString(), corporateTaxAtoms: quarter.taxAtoms, netProfitAtoms: (pretaxProfit - atoms(quarter.taxAtoms)).toString(), depreciationAtoms: quarter.depreciationAtoms, operatingCashFlowAtoms: quarter.operatingCashFlowAtoms, capexAtoms: quarter.capexAtoms, debtIssuedAtoms: quarter.debtIssuedAtoms, debtRepaidAtoms: quarter.debtRepaidAtoms, cashAtoms: balances.cash, debtAtoms: balances.debt, assetsAtoms: sumAccounts(balances, ASSET_ACCOUNTS).toString(), liabilitiesAtoms: sumAccounts(balances, LIABILITY_ACCOUNTS).toString(), equityAtoms: sumAccounts(balances, EQUITY_ACCOUNTS).toString(), receivablesAtoms: balances.receivables, payablesAtoms: balances.trade_payables, issuedShares: company.source.issuedShares, operatingAssetsAtoms: (atoms(balances.operating_assets) + atoms(balances.intangible_assets)).toString(), dividendPayableAtoms: balances.dividend_payable, oneOffProfitAtoms: quarter.oneOffProfitAtoms, foreignExchangeProfitAtoms: quarter.foreignExchangeProfitAtoms };
      sealedQuarters = [...sealedQuarters, Object.freeze(report)]; currentQuarter = zeroQuarter();
    }
    const result: CompanyTrueState = { ...company.source, balances, debtContracts: company.debtContracts, workingCapital: company.workingCapital, investments: company.investments, currentQuarter, sealedQuarters, unitPrice: company.unitPrice, unitPriceBasis: company.unitPriceBasis, volume: company.volume, capacity: company.capacity, productivity: company.productivity, customerBase: company.customerBase, status: company.stressed || company.workingCapital.some((item) => item.kind === 'AP' && item.overdueSinceTick !== null) ? 'STRESSED' : 'NORMAL' };
    checkCorporateBalance(result); return result;
  });
  return { companies: output, entries };
}
