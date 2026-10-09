import assert from 'node:assert/strict';
import { test } from 'node:test';
import { latencySummary, loadMeasurement, runLoadValidation } from '../src/validation/load.js';

test('nearest-rank p95 includes tail observations and never changes the collected samples', () => {
  const values = Array.from({ length: 20 }, (_, index) => (20 - index) * 10);
  const original = [...values], summary = latencySummary(values);
  assert.equal(summary.samples, 20); assert.equal(summary.p95Ms, 190); assert.equal(summary.p99Ms, 200);
  assert.equal(summary.medianMs, 100); assert.deepEqual(values, original);
  assert.equal(latencySummary([]).p95Ms, null);
  for (const invalid of [NaN, Infinity, -1]) assert.throws(() => latencySummary([invalid]));
});

test('fast BUSY responses cannot turn a failed load profile into a passing latency result', () => {
  const measured = loadMeasurement({ expected: 50, values: Array(50).fill(0.1), successes: [0.1], outcomes: { PORTFOLIO: 1, 'ERROR:BUSY': 49 }, succeeded: 1 }, 2000);
  assert.equal(measured.all.p95Ms, 0.1); assert.equal(measured.failed, 49); assert.equal(measured.passed, false);
  assert.equal(measured.failureRatePercent, 98); assert.equal(measured.busyRatePercent, 98);
  assert.equal(loadMeasurement({ expected: 1, values: [], successes: [], outcomes: {}, succeeded: 0 }, 1000).passed, false);
});

test('bounded actual-worker smoke profile records ownership, financial replay and synthetic volume separately', async () => {
  const report = await runLoadValidation({ markets: 2, accounts: 8, burst: 4, rounds: 1, ticks: 1, historyRecords: 30 });
  assert.equal(report.actual.markets, 2); assert.equal(report.actual.accounts, 8); assert.equal(report.actual.grants, 8);
  assert.equal(report.actual.committedBoundaryRounds, 1); assert.equal(report.actual.fills, 4);
  assert.equal(report.actual.genuineHistoryTicksPerListing, 1); assert.equal(report.actual.maximumHistoryTicksPerListing, 1);
  assert.equal(report.actual.economicSnapshots, 4); assert.equal(report.actual.publicPriceRows, 16);
  assert.equal(report.measurements.financialCommits!.succeeded, 4); assert.equal(report.measurements.acknowledgements!.succeeded, 4);
  assert.equal(report.measurements.historyQueries!.succeeded, 4); assert.equal(report.measurements.historyReopen!.succeeded, 1);
  for (const phase of ['open', 'quotes', 'duplicateConfirms', 'reopenMarketReads']) assert.equal(report.measurements[phase]!.targetMs, 2000);
  assert.equal(report.logicalClock.accelerated, true); assert.equal(report.logicalClock.queryHistoryDepth, 1);
  assert.equal(report.mockDeferHook.samples, 4); assert.equal(report.worker.historyQueries!.service.samples, 4);
  for (const value of Object.values(report.integrity)) assert.equal(value, true);
  assert.equal(report.projection?.rows, 480); assert.equal(report.projection?.productionHistory, false);
  assert.equal(report.projection?.pngWidth, 1000); assert.equal(report.projection?.pngHeight, 480);
  assert.equal(report.coverage.fullWhitepaperHistoryProfile, 'NOT_RUN'); assert.equal(report.coverage.liveDiscord, 'NOT_RUN');
  assert.doesNotMatch(JSON.stringify(report), /"(?:identityKey|economySeed|nonce|discordUserId|accountId)"|"1100000000[0-9]+"|C:\\\\Users/);
});

test('load profile rejects unbounded costs and insufficient owners before spawning workers', async () => {
  for (const input of [{ markets: 11 }, { accounts: 1001 }, { burst: 51 }, { historyRecords: 10001 }, { markets: 2, accounts: 1 }, { accounts: 8, burst: 9 }]) await assert.rejects(runLoadValidation(input));
});
