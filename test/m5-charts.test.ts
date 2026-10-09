import assert from 'node:assert/strict';
import { test } from 'node:test';
import { chartSvg, renderChart, type PriceChartInput } from '../src/charts/render.js';

const chart: PriceChartInput = {
  symbol: 'RVI', name: '리버인프라', generation: 1, series: 'PRICE', scale: 'LINEAR', marketVersion: 69, state: 'OPEN',
  points: Array.from({ length: 69 }, (_, index) => ({ tickNo: index, at: new Date(Date.UTC(2026, 9, 5, 0, index * 5)).toISOString(), value: index === 68 ? '985' : (1000 + Math.sin(index / 6) * 20).toFixed(6) })),
  annotations: [{ tickNo: 68, label: '배당락 · 주당 15' }],
};

test('PNG is deterministic, 1000×480, below250KB and never uses user IDs in filenames', () => {
  const first = renderChart(chart); const second = renderChart(chart);
  assert.deepEqual(first.png, second.png); assert.equal(first.name, second.name);
  assert.equal(first.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(first.png.readUInt32BE(16), 1000); assert.equal(first.png.readUInt32BE(20), 480);
  assert.ok(first.png.length <= 250000); assert.match(first.name, /^papermarket-[0-9a-f]{16}\.png$/);
  assert.match(first.description, /原価格|원가격.*68틱/); assert.match(first.svg, /#B91C1C/);
});

test('charts distinguish raw price from dividend total return and show virtual and real axes', () => {
  const price = chartSvg(chart); const total = chartSvg({ ...chart, series: 'TOTAL_RETURN', points: [{ tickNo: 67, at: chart.points[67]!.at, value: '100' }, { tickNo: 68, at: chart.points[68]!.at, value: '100' }] });
  assert.match(price.svg, /원가격 · 포인트/); assert.match(price.svg, /배당 총가치는 별도 조회/);
  assert.match(total.svg, /배당 포함 1주 총가치 · 포인트/); assert.match(total.svg, /보합 0\.00%/);
  assert.match(total.svg, /최초 1주 가치.*현금이자·수수료·재투자 제외/);
  assert.match(price.svg, /KST/); assert.match(price.svg, /실제 확정 기록 69개/); assert.doesNotMatch(price.svg, /gradient|high|low|OHLC|candlestick/);
});

test('log chart preserves liquidation zero as an end marker rather than replacing it withepsilon', () => {
  const ending = { ...chart, scale: 'LOG' as const, points: [{ tickNo: 1, at: chart.points[1]!.at, value: '1000' }, { tickNo: 2, at: chart.points[2]!.at, value: '0' }], annotations: [] };
  const rendered = renderChart(ending); assert.match(rendered.svg, /청산 0/); assert.match(rendered.description, /1000|1000\.00/); assert.match(rendered.description, /→ 0\.00/);
  assert.doesNotMatch(rendered.svg, /NaN|Infinity|0\.00000001/); assert.ok(rendered.png.length < 250000);
  const onlyZero = renderChart({ ...ending, points: [ending.points[1]!] }); assert.match(onlyZero.svg, /청산 0/); assert.doesNotMatch(onlyZero.svg, /NaN|Infinity/);
  assert.match(onlyZero.svg, /양수 기록 없음/); assert.doesNotMatch(onlyZero.svg, /stroke="#E5E7EB"/);
});

test('SVG text is escaped, never activates scripts, resources, external links or injected shapes', () => {
  const svg = chartSvg({ ...chart, name: '<script>alert("x")</script>', annotations: [{ tickNo: 68, label: '<image href="https://evil"/>' }] }).svg;
  assert.match(svg, /&lt;script&gt;/); assert.match(svg, /&lt;image/); assert.doesNotMatch(svg, /<script|<image|xlink:href|<!DOCTYPE|<foreignObject/);
});

test('points must be finite, nonnegative, sequential and bounded; invalid chart metadata failsclosed', () => {
  for (const invalid of [
    { ...chart, symbol: '../RVI' }, { ...chart, generation: 0 }, { ...chart, points: [] },
    { ...chart, points: [{ tickNo: 1, at: chart.points[1]!.at, value: '-1' }] },
    { ...chart, points: [{ tickNo: 1, at: 'invalid', value: '100' }] },
    { ...chart, points: [chart.points[1]!, chart.points[1]!] },
    { ...chart, points: [{ tickNo: 1, at: chart.points[1]!.at, value: 'Infinity' }] },
    { ...chart, points: Array.from({ length: 10001 }, () => chart.points[1]!) },
  ]) assert.throws(() => chartSvg(invalid));
});

test('long and tiny paths remain real stored prices without fabricated intratick highs or floors', () => {
  const tiny = chartSvg({ ...chart, scale: 'LOG', points: [{ tickNo: 1, at: chart.points[1]!.at, value: '0.000000000001' }, { tickNo: 2, at: chart.points[2]!.at, value: '0.000000000002' }] });
  assert.match(tiny.description, /1e-12|0\.000000000001/); assert.match(tiny.description, /\+100\.00%/);
  const dense = renderChart({ ...chart, points: Array.from({ length: 10000 }, (_, index) => ({ tickNo: index, at: new Date(Date.UTC(2026, 9, 5, 0, index * 5)).toISOString(), value: (1000 + index / 100).toFixed(2) })), annotations: [] });
  assert.ok(dense.png.length <= 250000); assert.match(dense.svg, /실제 확정 기록 10000개/);
});

test('extreme linear and log series keep finite separated coordinates and readable units', () => {
  for (const scale of ['LINEAR', 'LOG'] as const) for (const [first, last] of [['1e-60', '2e-60'], ['5e59', '1e60']]) {
    const rendered = renderChart({ ...chart, scale, annotations: [], points: [{ tickNo: 1, at: chart.points[1]!.at, value: first! }, { tickNo: 2, at: chart.points[2]!.at, value: last! }] });
    assert.doesNotMatch(rendered.svg, /NaN|Infinity/); assert.match(rendered.description, /\+100\.00%/);
    assert.ok(rendered.png.length <= 250000);
    const coordinates = /<path d="M ([0-9.]+) ([0-9.]+) L ([0-9.]+) ([0-9.]+) /u.exec(rendered.svg);
    assert.ok(coordinates); assert.notEqual(coordinates[2], coordinates[4]);
  }
  const jump = chartSvg({ ...chart, points: [{ tickNo: 1, at: chart.points[1]!.at, value: '1e-60' }, { tickNo: 2, at: chart.points[2]!.at, value: '1e60' }], annotations: [] });
  assert.match(jump.svg, /e\+122%/); assert.doesNotMatch(jump.svg, /NaN|Infinity/);
});
