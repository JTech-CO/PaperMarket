import { moneyToString, parseMoney, parsePrice, parseRate } from '../domain/numeric.js';

export type InitialCompanyCategory = 'ORDINARY' | 'GROWTH' | 'THEMATIC' | 'DIVIDEND';
export type InitialSlotId = 'O1' | 'O2' | 'O3' | 'G1' | 'G2' | 'T1' | 'T2' | 'D1';

export interface OpeningAccount {
  readonly code: string;
  readonly amount: string;
}

export interface InitialDebtTranche {
  readonly maturityTick: number;
  readonly principal: string;
  readonly fixedPrincipal: string;
  readonly variablePrincipal: string;
  readonly initialAnnualEffectiveRate: string;
  readonly initialVariableSpread: string;
}

export interface SyntheticQuarter {
  readonly kind: 'SYNTHETIC_INITIALIZATION';
  readonly quarter: 'Q-4' | 'Q-3' | 'Q-2' | 'Q-1';
  readonly revenue: string;
  readonly operatingProfit: string;
  readonly interestExpense: string;
  readonly pretaxProfit: string;
  readonly corporateTax: string;
  readonly netProfit: string;
}

export interface InitialCompany {
  readonly issuerId: string;
  readonly listingId: string;
  readonly slotId: InitialSlotId;
  readonly category: InitialCompanyCategory;
  readonly symbol: string;
  readonly name: string;
  readonly issuedShares: string;
  readonly initialPrice: string;
  readonly initialMarketCapitalization: string;
  readonly totalAssets: string;
  readonly totalLiabilities: string;
  readonly totalEquity: string;
  readonly cash: string;
  readonly interestBearingDebt: string;
  readonly distributableProfit: string;
  readonly annualRevenue: string;
  readonly operatingMargin: string;
  readonly annualBorrowingRate: string;
  readonly fixedDebtFraction: string;
  readonly nominalRevenueGrowth: string | null;
  readonly targetPayoutRatio: string;
  readonly balanceSheet: {
    readonly assets: readonly OpeningAccount[];
    readonly liabilities: readonly OpeningAccount[];
    readonly equity: readonly OpeningAccount[];
  };
  readonly debtTranches: readonly InitialDebtTranche[];
  readonly syntheticHistory: readonly SyntheticQuarter[];
  readonly syntheticHistoryBridge: {
    readonly fourQuarterNetProfit: string;
    readonly retainedEarningsAdjustment: string;
    readonly openingDistributableRetainedEarnings: string;
  };
  readonly fixtureAssumptions: readonly string[];
}

export interface InitialListing {
  readonly issuerId: string;
  readonly listingId: string;
  readonly slotId: InitialSlotId;
  readonly category: InitialCompanyCategory;
  readonly symbol: string;
  readonly price: string;
}

interface SourceCompany {
  readonly slotId: InitialSlotId;
  readonly category: InitialCompanyCategory;
  readonly symbol: string;
  readonly name: string;
  readonly issuedShares: string;
  readonly assetsEok: string;
  readonly liabilitiesEok: string;
  readonly equityEok: string;
  readonly cashEok: string;
  readonly debtEok: string;
  readonly distributableProfitEok: string;
  readonly revenueEok: string;
  readonly operatingMargin: string;
  readonly borrowingRate: string;
  readonly fixedFraction: string;
  readonly growth: string | null;
  readonly payout: string;
  readonly noncashWeights: readonly [string, string, string, string];
}

const SOURCE_COMPANIES: readonly SourceCompany[] = [
  { slotId: 'O1', category: 'ORDINARY', symbol: 'HGI', name: '한결산업', issuedShares: '1000000', assetsEok: '14', liabilitiesEok: '5', equityEok: '9', cashEok: '2', debtEok: '3', distributableProfitEok: '1.2', revenueEok: '18', operatingMargin: '0.12', borrowingRate: '0.05', fixedFraction: '0.6', growth: '0.04', payout: '0.25', noncashWeights: ['0.15', '0.25', '0.6', '0'] },
  { slotId: 'O2', category: 'ORDINARY', symbol: 'DNL', name: '다온생활', issuedShares: '800000', assetsEok: '10', liabilitiesEok: '3', equityEok: '7', cashEok: '1.5', debtEok: '1.6', distributableProfitEok: '1', revenueEok: '12', operatingMargin: '0.1', borrowingRate: '0.045', fixedFraction: '0.7', growth: '0.03', payout: '0.35', noncashWeights: ['0.15', '0.25', '0.6', '0'] },
  { slotId: 'O3', category: 'ORDINARY', symbol: 'TLR', name: '태림자원', issuedShares: '1200000', assetsEok: '18', liabilitiesEok: '8', equityEok: '10', cashEok: '1.8', debtEok: '6', distributableProfitEok: '1', revenueEok: '22', operatingMargin: '0.12', borrowingRate: '0.06', fixedFraction: '0.5', growth: '0.03', payout: '0.15', noncashWeights: ['0.15', '0.25', '0.6', '0'] },
  { slotId: 'G1', category: 'GROWTH', symbol: 'NXC', name: '넥스클라우드', issuedShares: '2000000', assetsEok: '9', liabilitiesEok: '2', equityEok: '7', cashEok: '3.5', debtEok: '1', distributableProfitEok: '0', revenueEok: '8', operatingMargin: '-0.05', borrowingRate: '0.065', fixedFraction: '0.4', growth: '0.18', payout: '0', noncashWeights: ['0.15', '0', '0.2', '0.65'] },
  { slotId: 'G2', category: 'GROWTH', symbol: 'VTR', name: '벡터로보틱스', issuedShares: '1500000', assetsEok: '14', liabilitiesEok: '6', equityEok: '8', cashEok: '2.5', debtEok: '4', distributableProfitEok: '0', revenueEok: '10', operatingMargin: '0.03', borrowingRate: '0.06', fixedFraction: '0.5', growth: '0.12', payout: '0', noncashWeights: ['0.15', '0.25', '0.5', '0.1'] },
  { slotId: 'T1', category: 'THEMATIC', symbol: 'AUR', name: '오로라모빌리티', issuedShares: '1000000', assetsEok: '6', liabilitiesEok: '2', equityEok: '4', cashEok: '2', debtEok: '1', distributableProfitEok: '0', revenueEok: '1.2', operatingMargin: '-0.8', borrowingRate: '0.08', fixedFraction: '0.3', growth: null, payout: '0', noncashWeights: ['0.05', '0.1', '0.45', '0.4'] },
  { slotId: 'T2', category: 'THEMATIC', symbol: 'LMB', name: '루멘바이오', issuedShares: '1000000', assetsEok: '5', liabilitiesEok: '1', equityEok: '4', cashEok: '2.4', debtEok: '0.5', distributableProfitEok: '0', revenueEok: '0.3', operatingMargin: '-3', borrowingRate: '0.09', fixedFraction: '0.3', growth: null, payout: '0', noncashWeights: ['0.05', '0', '0.2', '0.75'] },
  { slotId: 'D1', category: 'DIVIDEND', symbol: 'RVI', name: '리버인프라', issuedShares: '1000000', assetsEok: '22', liabilitiesEok: '12', equityEok: '10', cashEok: '2.4', debtEok: '10', distributableProfitEok: '1.5', revenueEok: '8', operatingMargin: '0.25', borrowingRate: '0.075', fixedFraction: '0.75', growth: '0.02', payout: '0.6', noncashWeights: ['0.05', '0', '0.95', '0'] },
];

const MONEY_SCALE = 1_000_000_000_000n;
const EOK_POINTS = 100_000_000n;
const ASSET_CODES = ['trade_receivables', 'inventory', 'property_plant_equipment', 'intangible_assets'] as const;
const ASSUMPTIONS = [
  'Amounts are points; whitepaper corporate amounts in eok are multiplied by 100000000.',
  'Noncash assets use explicitly chosen initialization weights; they are synthetic assumptions, not observed financial data.',
  'Non-interest-bearing liabilities are opening trade payables; equity is paid-in capital plus distributable retained earnings.',
  'Each historical quarter is one quarter of the annual reference income statement; debt interest is principal times annual rate.',
  'Corporate tax is 20 percent of positive reference pretax profit; losses create no tax refund.',
  'Historical income statements do not add cash or equity. The retained-earnings bridge reconciles them to the prescribed opening balance.',
] as const;

function atomsToString(atoms: bigint): string {
  const negative = atoms < 0n;
  const magnitude = negative ? -atoms : atoms;
  const integer = magnitude / MONEY_SCALE;
  const fractional = (magnitude % MONEY_SCALE).toString().padStart(12, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${integer}${fractional ? `.${fractional}` : ''}`;
}

function eok(value: string): string {
  return atomsToString(parseMoney(value) * EOK_POINTS);
}

function ratio(value: unknown): { numerator: bigint; denominator: bigint } {
  if (typeof value !== 'string' || value.length > 40 || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,12})?$/.test(value)) {
    throw new Error('Fixture ratio must be a bounded decimal string');
  }
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const denominator = 10n ** BigInt(fraction.length);
  const numerator = BigInt(integer) * denominator + BigInt(fraction || '0');
  return { numerator: negative ? -numerator : numerator, denominator };
}

function multiplyRatio(atoms: bigint, value: string): bigint {
  const { numerator, denominator } = ratio(value);
  const product = atoms * numerator;
  if (product % denominator !== 0n) throw new Error('Fixture arithmetic must be exact at money-atom precision');
  return product / denominator;
}

function divideExactly(atoms: bigint, divisor: bigint): bigint {
  if (atoms % divisor !== 0n) throw new Error('Fixture subdivision must be exact at money-atom precision');
  return atoms / divisor;
}

function makeCompany(source: SourceCompany): InitialCompany {
  const totalAssets = eok(source.assetsEok);
  const totalLiabilities = eok(source.liabilitiesEok);
  const totalEquity = eok(source.equityEok);
  const cash = eok(source.cashEok);
  const debt = eok(source.debtEok);
  const distributableProfit = eok(source.distributableProfitEok);
  const annualRevenue = eok(source.revenueEok);
  const noncash = parseMoney(totalAssets) - parseMoney(cash);
  const debtPrincipal = parseMoney(debt);
  const principalPerTranche = divideExactly(debtPrincipal, 8n);
  const fixedPerTranche = multiplyRatio(principalPerTranche, source.fixedFraction);
  const variableSpread = atomsToString(parseMoney(source.borrowingRate) - parseMoney('0.03'));
  const annualOperatingProfit = multiplyRatio(parseMoney(annualRevenue), source.operatingMargin);
  const annualInterest = multiplyRatio(debtPrincipal, source.borrowingRate);
  const annualPretax = annualOperatingProfit - annualInterest;
  const annualTax = annualPretax > 0n ? divideExactly(annualPretax, 5n) : 0n;
  const annualNet = annualPretax - annualTax;
  const quarters = ['Q-4', 'Q-3', 'Q-2', 'Q-1'] as const;
  return {
    issuerId: `fixture_issuer_${source.symbol.toLowerCase()}`,
    listingId: `fixture_listing_${source.symbol.toLowerCase()}`,
    slotId: source.slotId,
    category: source.category,
    symbol: source.symbol,
    name: source.name,
    issuedShares: source.issuedShares,
    initialPrice: '1000',
    initialMarketCapitalization: atomsToString(BigInt(source.issuedShares) * parseMoney('1000')),
    totalAssets,
    totalLiabilities,
    totalEquity,
    cash,
    interestBearingDebt: debt,
    distributableProfit,
    annualRevenue,
    operatingMargin: source.operatingMargin,
    annualBorrowingRate: source.borrowingRate,
    fixedDebtFraction: source.fixedFraction,
    nominalRevenueGrowth: source.growth,
    targetPayoutRatio: source.payout,
    balanceSheet: {
      assets: [
        { code: 'cash', amount: cash },
        ...ASSET_CODES.map((code, index) => ({ code, amount: atomsToString(multiplyRatio(noncash, source.noncashWeights[index]!)) })),
      ],
      liabilities: [
        { code: 'interest_bearing_debt', amount: debt },
        { code: 'trade_payables', amount: atomsToString(parseMoney(totalLiabilities) - debtPrincipal) },
      ],
      equity: [
        { code: 'paid_in_capital', amount: atomsToString(parseMoney(totalEquity) - parseMoney(distributableProfit)) },
        { code: 'distributable_retained_earnings', amount: distributableProfit },
      ],
    },
    debtTranches: Array.from({ length: 8 }, (_, index) => ({
      maturityTick: (index + 1) * 63,
      principal: atomsToString(principalPerTranche),
      fixedPrincipal: atomsToString(fixedPerTranche),
      variablePrincipal: atomsToString(principalPerTranche - fixedPerTranche),
      initialAnnualEffectiveRate: source.borrowingRate,
      initialVariableSpread: variableSpread,
    })),
    syntheticHistory: quarters.map((quarter) => ({
      kind: 'SYNTHETIC_INITIALIZATION',
      quarter,
      revenue: atomsToString(divideExactly(parseMoney(annualRevenue), 4n)),
      operatingProfit: atomsToString(divideExactly(annualOperatingProfit, 4n)),
      interestExpense: atomsToString(divideExactly(annualInterest, 4n)),
      pretaxProfit: atomsToString(divideExactly(annualPretax, 4n)),
      corporateTax: atomsToString(divideExactly(annualTax, 4n)),
      netProfit: atomsToString(divideExactly(annualNet, 4n)),
    })),
    syntheticHistoryBridge: {
      fourQuarterNetProfit: atomsToString(annualNet),
      retainedEarningsAdjustment: atomsToString(parseMoney(distributableProfit) - annualNet),
      openingDistributableRetainedEarnings: distributableProfit,
    },
    fixtureAssumptions: ASSUMPTIONS,
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const INITIAL_COMPANIES: readonly InitialCompany[] = deepFreeze(SOURCE_COMPANIES.map(makeCompany));

function record(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum) throw new Error(`${label} has an invalid string length`);
  return value;
}

function amount(value: unknown, label: string, nonnegative = true): bigint {
  const input = text(value, label, 128);
  const parsed = parseMoney(input);
  if (moneyToString(parsed) !== input) throw new Error(`${label} must be canonical money text`);
  if (nonnegative && parsed < 0n) throw new Error(`${label} must not be negative`);
  return parsed;
}

function fixedArray(value: unknown, label: string, length: number): unknown[] {
  if (!Array.isArray(value) || value.length !== length) throw new Error(`${label} must contain ${length} entries`);
  return value as unknown[];
}

function checkRatio(value: unknown, label: string, minimum: bigint, maximum: bigint): string {
  const input = text(value, label, 40);
  const parsed = ratio(input);
  if (parsed.numerator < minimum * parsed.denominator || parsed.numerator > maximum * parsed.denominator) {
    throw new Error(`${label} is outside its allowed range`);
  }
  return input;
}

function checkAccounts(value: unknown, label: string, expectedCodes: readonly string[], expectedTotal: bigint): Map<string, bigint> {
  const entries = fixedArray(value, label, expectedCodes.length);
  const accounts = new Map<string, bigint>();
  for (const item of entries) {
    const entry = record(item, label);
    const code = text(entry.code, `${label}.code`, 64);
    if (!expectedCodes.includes(code) || accounts.has(code)) throw new Error(`${label} has an unknown or duplicate account`);
    accounts.set(code, amount(entry.amount, `${label}.${code}`));
  }
  const total = [...accounts.values()].reduce((sum, current) => sum + current, 0n);
  if (total !== expectedTotal) throw new Error(`${label} does not reconcile to the opening total`);
  return accounts;
}

/** Validate a complete opening snapshot before any initialization is committed. */
export function validateInitialCompanies(companies: unknown): asserts companies is readonly InitialCompany[] {
  const entries = fixedArray(companies, 'Initial companies', 8);
  const seenSlots = new Set<string>();
  const seenIssuers = new Set<string>();
  const seenListings = new Set<string>();
  const seenSymbols = new Set<string>();
  for (const candidate of entries) {
    const company = record(candidate, 'Initial company');
    const slot = text(company.slotId, 'slotId', 2);
    const source = SOURCE_COMPANIES.find((item) => item.slotId === slot);
    if (!source || company.category !== source.category || company.symbol !== source.symbol || seenSlots.has(slot)) {
      throw new Error('Initial slots, symbols and classifications must match the eight-company universe');
    }
    seenSlots.add(slot);
    for (const [key, seen] of [['issuerId', seenIssuers], ['listingId', seenListings], ['symbol', seenSymbols]] as const) {
      const identifier = text(company[key], key, 64);
      if (!/^[A-Za-z0-9_-]+$/.test(identifier) || seen.has(identifier)) throw new Error(`${key} must be valid and unique`);
      seen.add(identifier);
    }
    if (company.issuerId === company.listingId) throw new Error('Issuer and listing identities must remain distinct');
    text(company.name, 'name', 128);
    const shares = text(company.issuedShares, 'issuedShares', 40);
    if (!/^[1-9]\d*$/.test(shares) || shares !== source.issuedShares) throw new Error('Issued shares must match the specified initial company');
    if (parsePrice(company.initialPrice) !== '1000' || company.initialPrice !== '1000') throw new Error('Initial price must be canonical 1000');
    if (amount(company.initialMarketCapitalization, 'initialMarketCapitalization') !== BigInt(shares) * parseMoney('1000')) {
      throw new Error('Initial market capitalization must reconcile to issued shares times initial price');
    }
    const assets = amount(company.totalAssets, 'totalAssets');
    const liabilities = amount(company.totalLiabilities, 'totalLiabilities');
    const equity = amount(company.totalEquity, 'totalEquity');
    const cash = amount(company.cash, 'cash');
    const debt = amount(company.interestBearingDebt, 'interestBearingDebt');
    const retained = amount(company.distributableProfit, 'distributableProfit');
    const revenue = amount(company.annualRevenue, 'annualRevenue');
    if (assets !== liabilities + equity) throw new Error('Initial assets must equal liabilities plus equity');
    if (cash > assets || debt > liabilities || retained > equity) throw new Error('Opening subaccounts must stay within their parent totals');
    for (const [key, sourceAmount] of [
      ['totalAssets', source.assetsEok], ['totalLiabilities', source.liabilitiesEok], ['totalEquity', source.equityEok],
      ['cash', source.cashEok], ['interestBearingDebt', source.debtEok], ['distributableProfit', source.distributableProfitEok],
      ['annualRevenue', source.revenueEok],
    ] as const) {
      if (company[key] !== eok(sourceAmount)) throw new Error(`${key} must match the whitepaper initial financial table`);
    }
    for (const [key, sourceRatio] of [
      ['operatingMargin', source.operatingMargin], ['annualBorrowingRate', source.borrowingRate],
      ['fixedDebtFraction', source.fixedFraction], ['nominalRevenueGrowth', source.growth], ['targetPayoutRatio', source.payout],
    ] as const) {
      if (company[key] !== sourceRatio) throw new Error(`${key} must match the whitepaper initial operating table`);
    }
    const margin = checkRatio(company.operatingMargin, 'operatingMargin', -3n, 1n);
    const fixedFraction = checkRatio(company.fixedDebtFraction, 'fixedDebtFraction', 0n, 1n);
    checkRatio(company.targetPayoutRatio, 'targetPayoutRatio', 0n, 1n);
    const borrowingRate = parseRate(company.annualBorrowingRate);
    if (ratio(borrowingRate).numerator < 0n) throw new Error('Initial borrowing rate must not be negative');
    if (source.category === 'THEMATIC') {
      if (company.nominalRevenueGrowth !== null) throw new Error('Thematic growth must use scenarios rather than a fixed annual growth rate');
    } else {
      checkRatio(company.nominalRevenueGrowth, 'nominalRevenueGrowth', 0n, 1n);
      parseRate(company.nominalRevenueGrowth);
    }
    const balance = record(company.balanceSheet, 'balanceSheet');
    const assetAccounts = checkAccounts(balance.assets, 'assets', ['cash', ...ASSET_CODES], assets);
    const debtAccounts = checkAccounts(balance.liabilities, 'liabilities', ['interest_bearing_debt', 'trade_payables'], liabilities);
    const equityAccounts = checkAccounts(balance.equity, 'equity', ['paid_in_capital', 'distributable_retained_earnings'], equity);
    if (assetAccounts.get('cash') !== cash || debtAccounts.get('interest_bearing_debt') !== debt || equityAccounts.get('distributable_retained_earnings') !== retained) {
      throw new Error('Opening account detail must match the prescribed subaccount total');
    }
    const tranches = fixedArray(company.debtTranches, 'debtTranches', 8);
    const principalPerTranche = divideExactly(debt, 8n);
    const expectedFixed = multiplyRatio(principalPerTranche, fixedFraction);
    for (const [index, candidateTranche] of tranches.entries()) {
      const tranche = record(candidateTranche, 'debtTranche');
      if (tranche.maturityTick !== (index + 1) * 63) throw new Error('Debt maturity ticks must be 63 through 504 in order');
      const principal = amount(tranche.principal, 'principal');
      const fixed = amount(tranche.fixedPrincipal, 'fixedPrincipal');
      const variable = amount(tranche.variablePrincipal, 'variablePrincipal');
      if (principal !== principalPerTranche || fixed !== expectedFixed || fixed + variable !== principal) throw new Error('Debt tranches must preserve principal and fixed/variable fractions');
      if (parseRate(tranche.initialAnnualEffectiveRate) !== borrowingRate) throw new Error('Debt tranche rate must match the initial company borrowing rate');
      if (amount(tranche.initialVariableSpread, 'initialVariableSpread', false) !== parseMoney(borrowingRate) - parseMoney('0.03')) throw new Error('Variable spread must reconcile to initial policy rate');
    }
    const history = fixedArray(company.syntheticHistory, 'syntheticHistory', 4);
    const annualOperating = multiplyRatio(revenue, margin);
    const annualInterest = multiplyRatio(debt, borrowingRate);
    const annualPretax = annualOperating - annualInterest;
    const annualTax = annualPretax > 0n ? divideExactly(annualPretax, 5n) : 0n;
    let historicalNet = 0n;
    for (const [index, candidateQuarter] of history.entries()) {
      const quarter = record(candidateQuarter, 'syntheticQuarter');
      if (quarter.kind !== 'SYNTHETIC_INITIALIZATION' || quarter.quarter !== `Q-${4 - index}`) throw new Error('Synthetic history must be explicitly labelled and chronologically ordered');
      const expectedFields = [
        ['revenue', revenue], ['operatingProfit', annualOperating], ['interestExpense', annualInterest],
        ['pretaxProfit', annualPretax], ['corporateTax', annualTax], ['netProfit', annualPretax - annualTax],
      ] as const;
      for (const [key, expectedAnnual] of expectedFields) {
        const actual = amount(quarter[key], `syntheticQuarter.${key}`, key !== 'operatingProfit' && key !== 'pretaxProfit' && key !== 'netProfit');
        if (actual !== divideExactly(expectedAnnual, 4n)) throw new Error(`Synthetic quarter ${key} must reconcile to its annual reference`);
        if (key === 'netProfit') historicalNet += actual;
      }
    }
    const bridge = record(company.syntheticHistoryBridge, 'syntheticHistoryBridge');
    const bridgeNet = amount(bridge.fourQuarterNetProfit, 'fourQuarterNetProfit', false);
    const adjustment = amount(bridge.retainedEarningsAdjustment, 'retainedEarningsAdjustment', false);
    if (bridgeNet !== historicalNet || bridgeNet + adjustment !== retained || amount(bridge.openingDistributableRetainedEarnings, 'openingDistributableRetainedEarnings') !== retained) {
      throw new Error('Synthetic history must reconcile to opening retained earnings without adding new income');
    }
    for (const assumption of fixedArray(company.fixtureAssumptions, 'fixtureAssumptions', ASSUMPTIONS.length)) text(assumption, 'fixtureAssumption', 256);
  }
}

export function createInitialListings(): InitialListing[] {
  return INITIAL_COMPANIES.map(({ issuerId, listingId, slotId, category, symbol, initialPrice }) => ({
    issuerId, listingId, slotId, category, symbol, price: initialPrice,
  }));
}

validateInitialCompanies(INITIAL_COMPANIES);
