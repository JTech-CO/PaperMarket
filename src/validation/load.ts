import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { cpus, tmpdir, totalmem, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import Database from 'better-sqlite3';
import { MessageFlags, PermissionsBitField, type Interaction } from 'discord.js';
import { z } from 'zod';
import type { Backend, MarketView, ServiceContext, ServiceRequest, ServiceResponse } from '../application/contracts.js';
import { WorkerBackend, type BackendObservation } from '../runtime/backend.js';
import { createInteractionHandler } from '../discord/handler.js';
import type { ReplyView } from '../discord/render.js';
import { renderChart } from '../charts/render.js';

const profileSchema = z.strictObject({
  markets: z.number().int().min(1).max(10).default(10),
  accounts: z.number().int().min(1).max(1000).default(1000),
  burst: z.number().int().min(1).max(50).default(50),
  rounds: z.number().int().min(1).max(10).default(3),
  ticks: z.number().int().min(1).max(21).default(3),
  historyRecords: z.number().int().min(1).max(10000).default(10000),
  projectionVolume: z.boolean().default(true),
}).refine(v => v.accounts >= v.markets && v.burst <= v.accounts, 'Each market and burst require accounts.');
export type LoadProfile = z.infer<typeof profileSchema>;
export interface LatencySummary { readonly samples: number; readonly minMs: number | null; readonly medianMs: number | null; readonly p95Ms: number | null; readonly p99Ms: number | null; readonly maxMs: number | null }
export interface LoadMeasurement {
  readonly expected: number; readonly succeeded: number; readonly failed: number; readonly outcomes: Readonly<Record<string, number>>;
  readonly failureRatePercent: number; readonly busyRatePercent: number;
  readonly all: LatencySummary; readonly successes: LatencySummary; readonly targetMs: number | null; readonly passed: boolean;
}
interface Samples { expected: number; values: number[]; successes: number[]; outcomes: Record<string, number>; succeeded: number }
export interface LoadReport {
  readonly milestone: 6; readonly profile: LoadProfile; readonly result: 'PARTIAL_PROFILE_PASS' | 'PROFILE_TARGET_MISSED'; readonly measuredTargetsPassed: boolean;
  readonly startedAt: string; readonly hardware: { readonly os: string; readonly architecture: string; readonly cpu: string; readonly logicalCpus: number; readonly memoryGiB: number; readonly node: string; readonly sqlite: string; readonly disk: 'UNKNOWN' };
  readonly actual: { readonly markets: number; readonly accounts: number; readonly committedBoundaryRounds: number; readonly genuineHistoryTicksPerListing: number; readonly maximumHistoryTicksPerListing: number; readonly economicSnapshots: number; readonly publicPriceRows: number; readonly fills: number; readonly grants: number };
  readonly logicalClock: { readonly accelerated: true; readonly restartOffsetMs: number; readonly queryHistoryDepth: number };
  readonly coverage: { readonly liveDiscord: 'NOT_RUN'; readonly fullWhitepaperHistoryProfile: 'NOT_RUN'; readonly note: string };
  readonly measurements: Readonly<Record<string, LoadMeasurement>>;
  readonly worker: Readonly<Record<string, { readonly observations: number; readonly service: LatencySummary; readonly queueAndTransport: LatencySummary; readonly roundtrip: LatencySummary; readonly maxPending: number; readonly gateRejected: number; readonly errors: number; readonly integrityFailures: number }>>;
  readonly mockDeferHook: LatencySummary;
  readonly integrity: { readonly ownerResponsesMatched: boolean; readonly privateAcknowledgements: boolean; readonly financialReplaysMatched: boolean; readonly fillsEqualSuccessfulCommits: boolean; readonly initialGrantsEqualOpenedAccounts: boolean; readonly historyRoundsMatched: boolean; readonly activeSlots: boolean; readonly foreignKeys: boolean; readonly quickCheck: boolean; readonly reopenSucceeded: boolean };
  readonly projection: ProjectionReport | null;
}
export interface ProjectionReport {
  readonly kind: 'SYNTHETIC_PUBLIC_PROJECTION_VOLUME'; readonly productionHistory: false; readonly rows: number; readonly markets: number; readonly listings: number; readonly recordsPerListing: number;
  readonly insertedMs: number; readonly indexedQuery: LatencySummary; readonly queryPlan: readonly string[];
  readonly pngBytes: number; readonly pngMs: number; readonly pngWidth: number; readonly pngHeight: number; readonly note: string;
}

/** Nearest-rank percentiles include all completions, including rejected requests. */
export function latencySummary(input: readonly number[]): LatencySummary {
  if (input.some(v => !Number.isFinite(v) || v < 0)) throw new RangeError('Invalid latency sample.');
  const values = [...input].sort((a, b) => a - b);
  const rank = (p: number) => values.length ? values[Math.max(0, Math.ceil(values.length * p) - 1)]! : null;
  return { samples: values.length, minMs: values[0] ?? null, medianMs: rank(0.5), p95Ms: rank(0.95), p99Ms: rank(0.99), maxMs: values.at(-1) ?? null };
}
function samples(expected = 0): Samples { return { expected, values: [], successes: [], outcomes: {}, succeeded: 0 }; }
function record(sample: Samples, response: ServiceResponse, expectedKind: ServiceResponse['kind'], elapsed: number, extraValid = true): void {
  const outcome = response.kind === 'ERROR' ? `ERROR:${response.code}` : response.kind;
  sample.outcomes[outcome] = (sample.outcomes[outcome] ?? 0) + 1; sample.values.push(elapsed);
  if (response.kind === expectedKind && extraValid) { sample.succeeded++; sample.successes.push(elapsed); }
}
export function loadMeasurement(sample: { expected: number; values: number[]; successes: number[]; outcomes: Record<string, number>; succeeded: number }, targetMs: number | null): LoadMeasurement {
  const all = latencySummary(sample.values), successes = latencySummary(sample.successes);
  const failed = sample.expected - sample.succeeded;
  return { expected: sample.expected, succeeded: sample.succeeded, failed, outcomes: { ...sample.outcomes },
    failureRatePercent: sample.expected ? failed / sample.expected * 100 : 0,
    busyRatePercent: sample.expected ? (sample.outcomes['ERROR:BUSY'] ?? 0) / sample.expected * 100 : 0, all, successes, targetMs,
    passed: failed === 0 && sample.values.length === sample.expected && (targetMs === null || (successes.p95Ms !== null && successes.p95Ms <= targetMs)) };
}

function syntheticProjection(path: string, profile: LoadProfile): ProjectionReport {
  const db = new Database(path);
  try {
    db.pragma('journal_mode = WAL'); db.pragma('synchronous = FULL');
    db.exec(`CREATE TABLE synthetic_public_prices(
      market_no INTEGER NOT NULL,listing_no INTEGER NOT NULL,tick_no INTEGER NOT NULL,
      price TEXT NOT NULL,committed_at TEXT NOT NULL,
      PRIMARY KEY(market_no,listing_no,tick_no)) STRICT, WITHOUT ROWID`);
    const insert = db.prepare('INSERT INTO synthetic_public_prices(market_no,listing_no,tick_no,price,committed_at) VALUES(?,?,?,?,?)');
    const start = performance.now();
    db.transaction(() => {
      for (let market = 0; market < profile.markets; market++) for (let listing = 0; listing < 8; listing++) for (let tick = 0; tick < profile.historyRecords; tick++) {
        // Values are explicit synthetic integer-price strings, never invented economic snapshots.
        const price = (900n + BigInt((tick + listing) % 200)).toString();
        insert.run(market, listing, tick, price, new Date(Date.UTC(2026, 0, 1) + tick * 300000).toISOString());
      }
    }).immediate();
    const insertedMs = performance.now() - start;
    const rows = (db.prepare('SELECT count(*) AS n FROM synthetic_public_prices').get() as { n: number }).n;
    const query = db.prepare('SELECT tick_no,price,committed_at FROM synthetic_public_prices WHERE market_no=? AND listing_no=? ORDER BY tick_no DESC LIMIT ?');
    const times: number[] = [];
    for (let index = 0; index < profile.burst * profile.rounds; index++) {
      const slot = index % (profile.markets * 8); const started = performance.now();
      const page = query.all(Math.floor(slot / 8), slot % 8, Math.min(profile.historyRecords, 2000));
      times.push(performance.now() - started);
      if (page.length !== Math.min(profile.historyRecords, 2000)) throw new Error('Projection volume count differs.');
    }
    const series = query.all(0, 0, profile.historyRecords) as Array<{ tick_no: number; price: string; committed_at: string }>;
    const pngStarted = performance.now();
    const rendered = renderChart({ symbol: 'LOAD', name: '합성 조회 부하 표본', generation: 1, series: 'PRICE', scale: 'LINEAR',
      marketVersion: 0, state: 'OPEN', annotations: [], points: series.reverse().map(row => ({ tickNo: row.tick_no, at: row.committed_at, value: row.price })) });
    const pngMs = performance.now() - pngStarted;
    const plan = db.prepare('EXPLAIN QUERY PLAN SELECT tick_no,price,committed_at FROM synthetic_public_prices WHERE market_no=? AND listing_no=? ORDER BY tick_no DESC LIMIT ?').all(0, 0, 252) as { detail: string }[];
    return { kind: 'SYNTHETIC_PUBLIC_PROJECTION_VOLUME', productionHistory: false, rows, markets: profile.markets, listings: profile.markets * 8, recordsPerListing: profile.historyRecords,
      insertedMs, indexedQuery: latencySummary(times), queryPlan: plan.map(row => row.detail), pngBytes: rendered.png.length, pngMs,
      pngWidth: rendered.png.readUInt32BE(16), pngHeight: rendered.png.readUInt32BE(20),
      note: 'Separate synthetic projection table. This measures indexed row-volume queries and rendering, not the production economic-history read model or 10,000 genuine economic ticks.' };
  } finally { db.close(); }
}

/** Runs an isolated real Worker/SQLite profile. Identity, seed, tokens and account IDs never enter the report. */
export async function runLoadValidation(input: Partial<LoadProfile> = {}, options: { readonly onProgress?: (message: string) => void } = {}): Promise<LoadReport> {
  const profile = profileSchema.parse(input), startedAt = new Date().toISOString();
  const temporaryRoot = resolve(tmpdir()), directory = mkdtempSync(join(temporaryRoot, 'papermarket-load-'));
  const databasePath = join(directory, 'worker.sqlite'), identityKey = randomBytes(32), economySeed = randomBytes(32);
  let backend: WorkerBackend | undefined; let sequence = 110000000001000000n;
  const BASE = 110000000000000000n;
  const guild = (index: number) => (BASE + BigInt(index + 1)).toString();
  const user = (index: number) => (BASE + 100000n + BigInt(index)).toString();
  const context = (index: number, admin = false): ServiceContext => ({ guildId: guild(index % profile.markets), discordUserId: user(index),
    interactionId: (++sequence).toString(), receivedAt: new Date().toISOString(), guildPermissions: admin ? '32' : '0' });
  const progress = (message: string) => { options.onProgress?.(message); };
  const phases: Record<string, Samples> = {
    startup: samples(1), setup: samples(profile.markets), open: samples(profile.accounts),
    queries: samples(profile.burst * profile.rounds), acknowledgements: samples(profile.burst),
    acknowledgedQueries: samples(profile.burst), quotes: samples(profile.burst * profile.rounds),
    financialCommits: samples(profile.burst * profile.rounds), duplicateConfirms: samples(profile.burst * profile.rounds),
    allMarketTicks: samples(profile.ticks), reopen: samples(1), reopenMarketReads: samples(profile.markets), postRestartQueries: samples(profile.burst),
    historyReopen: samples(1), historyQueries: samples(profile.burst),
  };
  const accounts = new Map<number, string>(), markets = new Map<string, MarketView>();
  let ownerResponsesMatched = true, privateAcknowledgements = true, financialReplaysMatched = true;
  let boundaryRounds = 0, reopened = false, historyReopened = false, restartOffsetMs = 0, sqlite = 'unavailable';
  let currentPhase = 'startup'; const workerSamples: Record<string, BackendObservation[]> = {}, deferHooks: number[] = [];
  const observe = (value: BackendObservation) => { (workerSamples[currentPhase] ??= []).push(value); };
  async function execute(request: ServiceRequest, phase: string, kind: ServiceResponse['kind'], valid?: (response: ServiceResponse) => boolean): Promise<ServiceResponse> {
    currentPhase = phase; const start = performance.now(); const response = await backend!.execute(request);
    record(phases[phase]!, response, kind, performance.now() - start, valid?.(response) ?? true); return response;
  }
  try {
    backend = new WorkerBackend({ databasePath, identityKey, economySeed, onObservation: observe });
    let started = performance.now(); await backend.start();
    record(phases.startup!, { kind: 'RECOVERED' }, 'RECOVERED', performance.now() - started);
    for (let index = 0; index < profile.markets; index++) {
      const response = await execute({ type: 'setup', context: context(index, true), channelId: (BASE + 200000n + BigInt(index)).toString() }, 'setup', 'SETUP');
      if (response.kind === 'SETUP') markets.set(response.market.marketId, response.market);
    }
    progress(`Created ${markets.size} markets.`);
    for (let start = 0; start < profile.accounts; start += 50) {
      await Promise.all(Array.from({ length: Math.min(50, profile.accounts - start) }, async (_, offset) => {
        const index = start + offset; const response = await execute({ type: 'open', context: context(index), age14Plus: true, agreeTerms: true }, 'open', 'ACCOUNT');
        if (response.kind === 'ACCOUNT') accounts.set(index, response.account.accountId);
      }));
      progress(`Opened ${accounts.size} accounts.`);
    }
    for (let round = 0; round < profile.rounds; round++) {
      await Promise.all(Array.from({ length: profile.burst }, async (_, index) => {
        const ownerIndex = (round * profile.burst + index) % profile.accounts;
        const response = await execute({ type: 'portfolio', context: context(ownerIndex) }, 'queries', 'PORTFOLIO');
        if (response.kind === 'PORTFOLIO' && response.portfolio.account.accountId !== accounts.get(ownerIndex)) ownerResponsesMatched = false;
      }));
    }
    const diagnosticCodes: Record<string, number> = {}, acknowledged = new Set<string>();
    const measuredBackend: Backend = { async execute(request) {
      if ('context' in request && !acknowledged.has(request.context.interactionId)) privateAcknowledgements = false;
      const response = await execute(request, 'acknowledgedQueries', 'PORTFOLIO');
      if (request.type === 'portfolio' && response.kind === 'PORTFOLIO' && response.portfolio.account.accountId !== accounts.get(Number(BigInt(request.context.discordUserId) - BASE - 100000n))) ownerResponsesMatched = false;
      return response;
    } };
    const handler = createInteractionHandler(measuredBackend, { operator: { operatorName: 'Synthetic load validation', supportContact: 'load@example.invalid' },
      onDefer(elapsedMs) { deferHooks.push(elapsedMs); },
      onDiagnostic(code) { diagnosticCodes[code] = (diagnosticCodes[code] ?? 0) + 1; } });
    await Promise.all(Array.from({ length: profile.burst }, async (_, index) => {
      const owner = context((profile.rounds * profile.burst + index) % profile.accounts); const received = performance.now();
      const interaction = {
        id: owner.interactionId, guildId: owner.guildId, user: { id: owner.discordUserId }, memberPermissions: new PermissionsBitField(0n), commandName: 'portfolio',
        isChatInputCommand: () => true, isButton: () => false, isModalSubmit: () => false,
        async deferReply(value: { flags: number }) {
          const isPrivate = value.flags === MessageFlags.Ephemeral; privateAcknowledgements &&= isPrivate;
          acknowledged.add(owner.interactionId);
          record(phases.acknowledgements!, { kind: 'RECOVERED' }, 'RECOVERED', performance.now() - received, isPrivate);
        },
        async editReply(view: ReplyView) { privateAcknowledgements &&= view.allowedMentions.parse.length === 0; },
      };
      await handler(interaction as unknown as Interaction);
    }));
    if (Object.keys(diagnosticCodes).length) privateAcknowledgements = false;
    for (let round = 0; round < profile.rounds; round++) {
      const ownerIndex = (index: number) => ((profile.rounds + 1 + round) * profile.burst + index) % profile.accounts;
      const quotes = await Promise.all(Array.from({ length: profile.burst }, (_, index) => execute({ type: 'quote', context: context(ownerIndex(index)), symbol: 'HGI', side: 'BUY', quantity: '1' }, 'quotes', 'QUOTE')));
      const fills = await Promise.all(quotes.map(async (response, index) => response.kind === 'QUOTE'
        ? execute({ type: 'confirm', context: context(ownerIndex(index)), token: response.quote.token }, 'financialCommits', 'FILLED')
        : (record(phases.financialCommits!, response, 'FILLED', 0), response)));
      await Promise.all(quotes.map(async (response, index) => {
        if (response.kind !== 'QUOTE') { record(phases.duplicateConfirms!, response, 'FILLED', 0); return; }
        const repeated = await execute({ type: 'confirm', context: context(ownerIndex(index)), token: response.quote.token }, 'duplicateConfirms', 'FILLED');
        if (JSON.stringify(repeated) !== JSON.stringify(fills[index])) financialReplaysMatched = false;
      }));
    }
    await backend.close(); backend = undefined;
    // Restart on the actual monotonic wall clock before advancing accelerated logical time.
    currentPhase = 'reopen'; backend = new WorkerBackend({ databasePath, identityKey, economySeed, onObservation: observe }); started = performance.now();
    try { await backend.start(); reopened = true; record(phases.reopen!, { kind: 'RECOVERED' }, 'RECOVERED', performance.now() - started); }
    catch { record(phases.reopen!, { kind: 'ERROR', code: 'INTERNAL_ERROR' }, 'RECOVERED', performance.now() - started); }
    for (let index = 0; index < profile.markets; index++) {
      const response = await execute({ type: 'market', context: context(index) }, 'reopenMarketReads', 'MARKET');
      if (response.kind === 'MARKET') markets.set(response.market.marketId, response.market);
    }
    await Promise.all(Array.from({ length: profile.burst }, async (_, index) => {
      const ownerIndex = ((profile.rounds + 4) * profile.burst + index) % profile.accounts;
      const response = await execute({ type: 'portfolio', context: context(ownerIndex) }, 'postRestartQueries', 'PORTFOLIO');
      if (response.kind === 'PORTFOLIO' && response.portfolio.account.accountId !== accounts.get(ownerIndex)) ownerResponsesMatched = false;
    }));
    for (let index = 0; index < profile.ticks; index++) {
      const next = Math.max(...[...markets.values()].map(market => Date.parse(market.nextBoundaryAt))) + 1;
      const response = await execute({ type: 'tick', now: new Date(next).toISOString() }, 'allMarketTicks', 'TICKED', value => value.kind === 'TICKED' && value.markets.length === profile.markets);
      if (response.kind === 'TICKED') { for (const market of response.markets) markets.set(market.marketId, market); if (response.markets.length === profile.markets) boundaryRounds++; }
      progress(`Completed boundary attempt ${index + 1}/${profile.ticks}; committed all-market rounds: ${boundaryRounds}.`);
    }
    // A validation-only logical clock follows the committed checkpoint, without changing database timestamps.
    await backend.close(); backend = undefined;
    const checkpointDb = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const checkpoint = (checkpointDb.prepare('SELECT max(checkpoint_at) AS checkpoint FROM market_settings').get() as { checkpoint: string | null }).checkpoint;
      const checkpointMs = checkpoint === null ? Date.now() : Date.parse(checkpoint);
      if (!Number.isFinite(checkpointMs)) throw new Error('Invalid committed checkpoint.');
      restartOffsetMs = Math.max(0, checkpointMs - Date.now() + 100);
    } finally { checkpointDb.close(); }
    currentPhase = 'historyReopen';
    backend = new WorkerBackend({ databasePath, identityKey, economySeed, validationClockOffsetMs: restartOffsetMs, onObservation: observe }); started = performance.now();
    try { await backend.start(); historyReopened = true; record(phases.historyReopen!, { kind: 'RECOVERED' }, 'RECOVERED', performance.now() - started); }
    catch { record(phases.historyReopen!, { kind: 'ERROR', code: 'INTERNAL_ERROR' }, 'RECOVERED', performance.now() - started); }
    await Promise.all(Array.from({ length: profile.burst }, async (_, index) => {
      const ownerIndex = ((profile.rounds + 5) * profile.burst + index) % profile.accounts;
      const response = await execute({ type: 'portfolio', context: context(ownerIndex) }, 'historyQueries', 'PORTFOLIO');
      if (response.kind === 'PORTFOLIO' && response.portfolio.account.accountId !== accounts.get(ownerIndex)) ownerResponsesMatched = false;
    }));
    await backend.close(); backend = undefined;
    const db = new Database(databasePath, { readonly: true, fileMustExist: true });
    let grants: number, fills: number, activeSlots: boolean, foreignKeys: boolean, quickCheck: boolean, economicSnapshots: number, publicPriceRows: number;
    let minimumHistoryTicks: number, maximumHistoryTicks: number, historyRoundsMatched: boolean;
    try {
      sqlite = (db.prepare('SELECT sqlite_version() AS version').get() as { version: string }).version;
      grants = (db.prepare("SELECT count(*) AS n FROM cash_journal WHERE entry_type='INITIAL_GRANT'").get() as { n: number }).n;
      fills = (db.prepare('SELECT count(*) AS n FROM fills').get() as { n: number }).n;
      economicSnapshots = (db.prepare('SELECT count(*) AS n FROM economy_snapshots').get() as { n: number }).n;
      publicPriceRows = (db.prepare('SELECT count(*) AS n FROM economy_prices').get() as { n: number }).n;
      const priceHistory = db.prepare('SELECT min(n) AS minimum,max(n) AS maximum FROM (SELECT count(*) AS n FROM economy_prices WHERE tick_no>0 GROUP BY market_id,listing_id)').get() as { minimum: number | null; maximum: number | null };
      minimumHistoryTicks = priceHistory.minimum ?? 0; maximumHistoryTicks = priceHistory.maximum ?? 0;
      const marketHistory = db.prepare('SELECT min(n) AS minimum,max(n) AS maximum FROM (SELECT count(*) AS n FROM economy_snapshots WHERE tick_no>0 GROUP BY market_id)').get() as { minimum: number | null; maximum: number | null };
      historyRoundsMatched = (marketHistory.minimum ?? 0) === boundaryRounds && (marketHistory.maximum ?? 0) === boundaryRounds;
      const slots = db.prepare("SELECT market_id,count(*) AS n FROM listings WHERE status='ACTIVE' GROUP BY market_id").all() as { market_id: string; n: number }[];
      activeSlots = slots.length === markets.size && slots.every(value => value.n === 8);
      foreignKeys = (db.pragma('foreign_key_check') as unknown[]).length === 0;
      quickCheck = (db.pragma('quick_check') as { quick_check: string }[]).every(row => row.quick_check === 'ok');
    } finally { db.close(); }
    const projection = profile.projectionVolume ? syntheticProjection(join(directory, 'synthetic-projection.sqlite'), profile) : null;
    const measurements: Record<string, LoadMeasurement> = {};
    const commandTargets = new Set(['open', 'queries', 'acknowledgedQueries', 'quotes', 'financialCommits', 'duplicateConfirms', 'reopenMarketReads', 'postRestartQueries', 'historyQueries']);
    for (const [name, sample] of Object.entries(phases)) measurements[name] = loadMeasurement(sample,
      name === 'acknowledgements' ? 1000 : commandTargets.has(name) ? 2000 : name === 'allMarketTicks' ? 5000 : null);
    const worker: LoadReport['worker'] = Object.fromEntries(Object.entries(workerSamples).map(([name, observations]) => [name, {
      observations: observations.length, service: latencySummary(observations.flatMap(value => value.serviceMs === undefined ? [] : [value.serviceMs])),
      queueAndTransport: latencySummary(observations.flatMap(value => value.queueAndTransportMs === undefined ? [] : [value.queueAndTransportMs])),
      roundtrip: latencySummary(observations.map(value => value.elapsedMs)), maxPending: Math.max(0, ...observations.map(value => value.pending)),
      gateRejected: observations.filter(value => value.gateRejected).length, errors: observations.filter(value => value.outcome !== 'OK').length,
      integrityFailures: observations.filter(value => value.integrityFailure).length,
    }]));
    const integrity = { ownerResponsesMatched, privateAcknowledgements, financialReplaysMatched, fillsEqualSuccessfulCommits: fills === phases.financialCommits!.succeeded,
      initialGrantsEqualOpenedAccounts: grants === accounts.size, historyRoundsMatched, activeSlots, foreignKeys, quickCheck, reopenSucceeded: reopened && historyReopened };
    const measuredTargetsPassed = Object.values(measurements).every(value => value.passed) && Object.values(integrity).every(Boolean);
    return { milestone: 6, profile, result: measuredTargetsPassed ? 'PARTIAL_PROFILE_PASS' : 'PROFILE_TARGET_MISSED', measuredTargetsPassed, startedAt,
      hardware: { os: `${platform()} ${release()}`, architecture: process.arch, cpu: cpus()[0]?.model ?? 'unavailable', logicalCpus: cpus().length, memoryGiB: Math.round(totalmem() / (1024 ** 3) * 100) / 100, node: process.version, sqlite, disk: 'UNKNOWN' },
      actual: { markets: markets.size, accounts: accounts.size, committedBoundaryRounds: boundaryRounds, genuineHistoryTicksPerListing: minimumHistoryTicks, maximumHistoryTicksPerListing: maximumHistoryTicks, economicSnapshots, publicPriceRows, fills, grants },
      logicalClock: { accelerated: true, restartOffsetMs, queryHistoryDepth: boundaryRounds },
      coverage: { liveDiscord: 'NOT_RUN', fullWhitepaperHistoryProfile: 'NOT_RUN', note: 'Warm queries, financial commands and the first cold restart use actual wall time at history depth 0. Scheduled boundaries attempt genuine economic advancement; actual reports committed counts, and failed startup/tick/query attempts remain failures. A second cold restart follows the committed checkpoint with a validation-only clock offset and attempts portfolio queries at the reported history depth; timestamps and journals are never rewritten. This is not wall-clock history generation. The production 10,000-tick history profile and live Discord are not run; synthetic volume rows are separate. Disk model/type/speed: UNKNOWN (not measured).' },
      measurements, worker, mockDeferHook: latencySummary(deferHooks), integrity, projection };
  } finally {
    await backend?.close();
    if (dirname(resolve(directory)) !== temporaryRoot || !basename(directory).startsWith('papermarket-load-')) throw new Error('Unsafe load cleanup target.');
    rmSync(directory, { recursive: true, force: true });
  }
}
