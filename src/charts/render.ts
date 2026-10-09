import { createHash } from 'node:crypto';
import { Resvg } from '@resvg/resvg-js';
import { FinancialDecimal } from '../domain/numeric.js';
import { chartRenderOptions } from './fonts.js';

export interface ChartPoint { readonly tickNo: number; readonly at: string; readonly value: string }
export interface ChartAnnotation { readonly tickNo: number; readonly label: string }
export interface PriceChartInput {
  readonly symbol: string; readonly name: string; readonly generation: number;
  readonly series: 'PRICE' | 'TOTAL_RETURN'; readonly scale: 'LINEAR' | 'LOG';
  readonly points: readonly ChartPoint[]; readonly annotations: readonly ChartAnnotation[];
  readonly marketVersion: number; readonly state: string;
}
export interface RenderedChart { readonly png: Buffer; readonly name: string; readonly svg: string; readonly description: string }

const COLORS = { up: '#15803D', down: '#B91C1C', flat: '#6B7280', text: '#111827', grid: '#E5E7EB' } as const;
const WIDTH = 1000; const HEIGHT = 480;

function xml(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function n(value: number): string { return value.toFixed(2); }
function numeric(value: string): string {
  const decimal = new FinancialDecimal(value);
  return decimal.abs().gte('1e9') || (!decimal.isZero() && decimal.abs().lt('0.01'))
    ? decimal.toSignificantDigits(5).toString() : decimal.toFixed(2);
}
function time(at: string): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(at));
}

/** SVG contains only bounded committed facts, escaped text, numeric paths, and no external resources. */
export function chartSvg(input: PriceChartInput): { svg: string; description: string } {
  if (!/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(input.symbol) || input.name.length > 100 || !Number.isSafeInteger(input.generation)
    || input.generation < 1 || !Number.isSafeInteger(input.marketVersion) || input.marketVersion < 0
    || !['PRICE', 'TOTAL_RETURN'].includes(input.series) || !['LINEAR', 'LOG'].includes(input.scale)
    || input.points.length < 1 || input.points.length > 10_000 || input.annotations.length > 1000) throw new Error('INVALID_CHART');
  let previousTick = -1; let previousAt = -1;
  const values = input.points.map((point) => {
    const at = new Date(point.at).valueOf();
    if (!Number.isSafeInteger(point.tickNo) || point.tickNo < 0 || point.tickNo <= previousTick || !Number.isFinite(at) || at < previousAt
      || point.value.length > 96) throw new Error('INVALID_CHART');
    const decimal = new FinancialDecimal(point.value);
    if (!decimal.isFinite() || decimal.isNegative() || decimal.gt('1e60') || (!decimal.isZero() && decimal.lt('1e-60'))) throw new Error('INVALID_CHART');
    previousTick = point.tickNo; previousAt = at;
    return decimal;
  });
  for (const annotation of input.annotations) if (!Number.isSafeInteger(annotation.tickNo) || annotation.tickNo < 0 || annotation.label.length > 120) throw new Error('INVALID_CHART');
  const first = input.points[0]!; const last = input.points.at(-1)!;
  const baseline = values[0]!; const final = values.at(-1)!;
  const change = baseline.isZero() ? null : final.div(baseline).minus(1).times(100);
  const direction = change === null ? '시작값 0 · 변화율 없음' : change.isZero() ? '보합 0.00%' : `${change.isPositive() ? '+' : '-'}${numeric(change.abs().toString())}%`;
  const color = final.eq(baseline) ? COLORS.flat : final.gt(baseline) ? COLORS.up : COLORS.down;
  const label = input.series === 'PRICE' ? '원가격 · 포인트' : '배당 포함 1주 총가치 · 포인트';
  const scale = input.scale === 'LOG' ? '로그축' : '선형축';
  const description = `${input.symbol} ${input.generation}세대 · ${label} · ${first.tickNo}~${last.tickNo}틱 · ${numeric(first.value)} → ${numeric(last.value)} · ${direction} · ${scale} · 버전 ${input.marketVersion}`;
  const positive = values.filter((value) => value.gt(0));
  // Zero is an explicit terminal marker on a log chart, never a fabricated epsilon price.
  const plotted = input.scale === 'LOG' ? positive.map((value) => value.ln()) : values;
  let low = plotted.length ? plotted.reduce((minimum, value) => value.lt(minimum) ? value : minimum) : new FinancialDecimal(0);
  let high = plotted.length ? plotted.reduce((maximum, value) => value.gt(maximum) ? value : maximum) : new FinancialDecimal(1);
  const padding = high.eq(low) ? (high.isZero() ? new FinancialDecimal(1) : high.abs().times('0.02')) : high.minus(low).times('0.10');
  low = low.minus(padding); high = high.plus(padding);
  if (input.scale === 'LINEAR' && low.isNegative()) low = new FinancialDecimal(0);
  const left = 95; const right = 965; const top = 100; const bottom = 355;
  const span = Math.max(1, last.tickNo - first.tickNo);
  const x = (tick: number) => left + (tick - first.tickNo) / span * (right - left);
  // Convert only a normalized coordinate to Number, preserving tiny and very large stored values.
  const y = (value: InstanceType<typeof FinancialDecimal>) => bottom - (input.scale === 'LOG' ? value.ln() : value).minus(low).div(high.minus(low)).toNumber() * (bottom - top);
  let path = ''; let interrupted = true;
  const elements: string[] = [];
  for (let index = 0; index < input.points.length; index += 1) {
    const point = input.points[index]!; const value = values[index]!;
    if (input.scale === 'LOG' && value.isZero()) {
      elements.push(`<path d="M ${n(x(point.tickNo)-5)} ${bottom-5} l 10 10 m -10 0 l 10 -10" stroke="${COLORS.down}" stroke-width="3"/><text x="${n(Math.min(right-65,x(point.tickNo)))}" y="${bottom+23}" fill="${COLORS.text}">청산 0</text>`);
      interrupted = true; continue;
    }
    path += `${interrupted ? 'M' : 'L'} ${n(x(point.tickNo))} ${n(y(value))} `; interrupted = false;
  }
  const parts = [`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}">`,
    `<rect width="${WIDTH}" height="${HEIGHT}" fill="#FFFFFF"/><g font-family="Malgun Gothic,Noto Sans KR,Arial,sans-serif" font-size="14" fill="${COLORS.text}">`,
    `<text x="34" y="35" font-size="22" font-weight="600">${xml(input.name.slice(0, 20))} · ${input.symbol} · ${input.generation}세대</text>`,
    `<text x="34" y="65">${label} · ${scale} · 버전 ${input.marketVersion}${input.state === 'OPEN' ? '' : ' · 거래 중단'}</text>`,
    `<text x="965" y="35" text-anchor="end" font-size="22" fill="${color}">${xml(direction)}</text>`];
  if (!plotted.length) parts.push('<text x="500" y="227" text-anchor="middle">양수 기록 없음 · 청산 0 종료 표식</text>');
  for (let row = 0; row < (plotted.length ? 5 : 0); row += 1) {
    const height = bottom - row / 4 * (bottom-top); const raw = low.plus(high.minus(low).times(row).div(4));
    const value = input.scale === 'LOG' ? raw.exp().toString() : raw.toString();
    parts.push(`<line x1="${left}" y1="${n(height)}" x2="${right}" y2="${n(height)}" stroke="${COLORS.grid}"/><text x="${left-12}" y="${n(height+5)}" text-anchor="end">${xml(numeric(value))}</text>`);
  }
  parts.push(`<path d="${path}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`);
  if (input.points.length === 1 && !(input.scale === 'LOG' && final.isZero())) parts.push(`<circle cx="${left}" cy="${n(y(final))}" r="4" fill="${color}"/>`);
  parts.push(...elements);
  const inRange = input.annotations.filter((item) => item.tickNo >= first.tickNo && item.tickNo <= last.tickNo);
  for (const [index, annotation] of inRange.slice(-4).entries()) {
    const xpos = x(annotation.tickNo);
    parts.push(`<line x1="${n(xpos)}" y1="${top}" x2="${n(xpos)}" y2="${bottom}" stroke="${COLORS.flat}" stroke-dasharray="3 4"/><text x="${n(Math.max(left,Math.min(right-130,xpos+4)))}" y="${top+17+index*20}" font-size="12">${xml(annotation.label)}</text>`);
  }
  parts.push(`<text x="${left}" y="408">${first.tickNo}틱 · ${xml(time(first.at))} KST</text><text x="${right}" y="408" text-anchor="end">${last.tickNo}틱 · ${xml(time(last.at))} KST</text>`,
    `<text x="34" y="${input.series === 'PRICE' ? 448 : 438}" font-size="13">실제 확정 기록 ${input.points.length}개 · 가상 시장 · 실거래 아님${input.series === 'PRICE' ? ' · 배당 총가치는 별도 조회' : ' · 원가격은 별도 조회'}</text>`);
  if (input.series === 'TOTAL_RETURN') parts.push('<text x="34" y="462" font-size="12">최초 1주 가치 + 배당·청산 현금 + 미지급 권리 · 현금이자·수수료·재투자 제외</text>');
  parts.push('</g></svg>');
  return { svg: parts.join(''), description };
}

/** Rendering has no persistence, prices, random stream, secrets, network, or user-controlled file path. */
export function renderChart(input: PriceChartInput): RenderedChart {
  const { svg, description } = chartSvg(input);
  const png = Buffer.from(new Resvg(svg, chartRenderOptions).render().asPng());
  if (png.length > 250_000) throw new Error('CHART_BUDGET');
  const name = `papermarket-${createHash('sha256').update(svg).digest('hex').slice(0, 16)}.png`;
  return { png, svg, name, description };
}
