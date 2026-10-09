import { ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, type EmbedBuilder } from 'discord.js';
import type { AlertsView, CalendarView, EconomyView, ExportView, FinancialView, MarketView, NewsView, PerformanceView, PublicViewMeta, ScheduledOrderView, ServiceResponse, StockView } from '../application/contracts.js';
import { FinancialDecimal } from '../domain/numeric.js';
import { baseEmbed, displayExact, displayNumber, errorEmbed, safeText, UI_COLORS } from './messages.js';
import { renderChart, type PriceChartInput } from '../charts/render.js';

export interface ReplyView {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
  allowedMentions: { parse: [] };
  files?: AttachmentBuilder[];
}

export function navigationRow(actions: readonly { readonly id: string; readonly label: string; readonly disabled?: boolean }[]): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(actions.slice(0, 4).map((action) => new ButtonBuilder()
    .setCustomId(action.id).setLabel(action.label.slice(0, 40)).setStyle(ButtonStyle.Secondary).setDisabled(action.disabled ?? false)));
}

export function renderPriceChart(chart: PriceChartInput, renderer: typeof renderChart = renderChart): ReplyView {
  const first = chart.points[0]; const last = chart.points.at(-1);
  const text = first && last ? `${safeText(chart.name, 60)} · ${chart.generation}세대\n${chart.series === 'PRICE' ? '원가격 · 포인트' : '배당 포함 1주 총가치 · 포인트'} · ${chart.scale === 'LOG' ? '로그축' : '선형축'}\n${first.tickNo}~${last.tickNo}틱 · ${displayNumber(first.value)} → ${displayNumber(last.value)}\n확정 기록 ${chart.points.length}개 · 버전 ${chart.marketVersion}${chart.state === 'OPEN' ? '' : ' · 거래 중단'}` : '확정된 기록이 아직 없습니다. 다음 확정 틱 이후 다시 조회하세요.';
  const embed = baseEmbed(`PaperMarket · ${safeText(chart.symbol, 12)} 차트`, text);
  const row = navigationRow([
    { id: `pm:view:company:${chart.symbol}:${chart.generation}`, label: '기업' },
    { id: `pm:chart:${chart.symbol}:${chart.generation}:${chart.series === 'PRICE' ? 'TOTAL_RETURN' : 'PRICE'}:${chart.scale}`, label: chart.series === 'PRICE' ? '배당 총가치' : '원가격' },
    { id: `pm:chart:${chart.symbol}:${chart.generation}:${chart.series}:${chart.scale === 'LOG' ? 'LINEAR' : 'LOG'}`, label: chart.scale === 'LOG' ? '선형축' : '로그축' },
  ]);
  const view = replyView(embed, [row]);
  if (chart.series === 'TOTAL_RETURN') embed.addFields({ name: '1주 총가치 산식', value: '최초 1주의 현재 가치 + 누적 지급 배당·청산 현금 + 미지급 권리 현재 평가. 현금이자·수수료·배당 재투자를 제외하므로 계좌 성과와 다릅니다.' });
  if (!chart.points.length) return view;
  try {
    const rendered = renderer(chart);
    embed.setImage(`attachment://${rendered.name}`);
    view.files = [new AttachmentBuilder(rendered.png, { name: rendered.name, description: rendered.description.slice(0, 1_000) })];
  } catch {
    embed.addFields({ name: '이미지 표시 안내', value: '차트를 그리지 못했습니다. 위 확정 기록 요약으로 확인할 수 있으며 조회·거래 결과에는 영향이 없습니다.' });
  }
  return view;
}

export function replyView(embed: EmbedBuilder, components: readonly ActionRowBuilder<ButtonBuilder>[] = []): ReplyView {
  return { embeds: [embed], components: [...components], allowedMentions: { parse: [] } };
}

/** Policy notices retain every paragraph without exceeding description/field limits. */
export function renderNotice(title: string, text: string): ReplyView {
  if (text.length > 4_000) return replyView(errorEmbed('INTERNAL_ERROR'));
  const chunks: string[] = [];
  let current = '';
  for (const paragraph of text.split('\n\n')) {
    if (current && current.length + paragraph.length + 2 > 1_000) { chunks.push(current); current = ''; }
    if (paragraph.length > 1_000) {
      if (current) { chunks.push(current); current = ''; }
      for (let offset = 0; offset < paragraph.length; offset += 1_000) chunks.push(paragraph.slice(offset, offset + 1_000));
    } else current += `${current ? '\n\n' : ''}${paragraph}`;
  }
  if (current) chunks.push(current);
  const embed = baseEmbed(title, chunks[0] ?? '');
  for (const [index, chunk] of chunks.slice(1).entries()) embed.addFields({ name: `안내 ${index + 2}`, value: chunk });
  return replyView(embed);
}

export function displayTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.valueOf())) return '확인 중';
  return `${new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(date)} KST`;
}

function metaText(meta: PublicViewMeta): string {
  return `${meta.state === 'OPEN' ? '거래 가능' : '거래 중단'} · ${meta.tickNo}틱 · 버전 ${meta.marketVersion}\n최근 확정 ${displayTime(meta.updatedAt)} · 다음 틱 ${displayTime(meta.nextBoundaryAt)}`;
}

function signedAmount(value: string): string {
  const number = new FinancialDecimal(value);
  return number.isZero() ? displayNumber('0') : `${number.isNegative() ? '-' : '+'}${displayNumber(number.abs().toString())}`;
}

export function renderStock(stock: StockView): ReplyView {
  const change = new FinancialDecimal(stock.referencePrice).isZero() ? null : new FinancialDecimal(stock.currentPrice).div(stock.referencePrice).minus(1).times(100).toString();
  const rawChange = stock.previousRawPrice === null ? null : new FinancialDecimal(stock.currentPrice).minus(stock.previousRawPrice).toString();
  const tradable = !['LIQUIDATING', 'EXTINGUISHED'].includes(stock.lifecycle) && stock.state === 'OPEN';
  const embed = baseEmbed(`${safeText(stock.listing.name, 22)} · ${safeText(stock.listing.symbol, 12)}`, [
    `${displayNumber(stock.currentPrice)} 포인트 · ${change === null ? '기준가 0 · 변화율 산정 없음' : percent(change)}`,
    `기업행동 조정 기준가 ${displayNumber(stock.referencePrice)} 대비 · ${stock.generation}세대 · ${lifecycle(stock.lifecycle)}`,
    safeText(stock.businessSummary, 240), metaText(stock),
  ].join('\n\n')).setColor(change === null || new FinancialDecimal(change).isZero() ? UI_COLORS.neutral : new FinancialDecimal(change).isPositive() ? UI_COLORS.up : UI_COLORS.down);
  if (stock.exAdjustment || rawChange !== null) embed.addFields({ name: '원가격 변화와 배당락', value: [
    stock.previousRawPrice === null ? '이전 원가격 기록 없음' : `이전 원가격 ${displayNumber(stock.previousRawPrice)} · 원가격 변화 ${signedAmount(rawChange!)}`,
    stock.exAdjustment ? `배당락 반영 ${signedAmount(new FinancialDecimal(stock.referencePrice).minus(stock.previousRawPrice ?? stock.referencePrice).toString())} · 일반 시세 변화 ${signedAmount(new FinancialDecimal(stock.currentPrice).minus(stock.referencePrice).toString())}` : '이번 확정 틱에 배당락 조정 없음',
    '배당락은 일반 시세 변화와 분리합니다. 받을 배당 권리는 /portfolio에서 확인하세요.',
  ].join('\n') });
  if (stock.financial) {
    const f = stock.financial;
    embed.addFields({ name: `공개 실적 · ${f.reportKind === 'ACTUAL' ? `${f.quarterNo}분기` : '합성 초기화'}`, value: `매출 ${displayNumber(f.revenue)} · 영업이익 ${displayNumber(f.operatingProfit)}\n순이익 ${displayNumber(f.netProfit)} · 현금 ${displayNumber(f.cash)} · 차입 ${displayNumber(f.debt)}\n마감 ${f.closedTick} · 공개 ${f.publishedTick} · ${stock.lifecycle === 'EXTINGUISHED' ? '종료 전 발표 일정' : '다음 발표'} ${f.nextEarningsTick}틱` },
      { name: stock.lifecycle === 'EXTINGUISHED' ? '시장 전망 · 종료 전 공개 기록' : '시장 전망 · 확정 실적 아님', value: `연 매출 ${displayNumber(f.annualRevenueForecast)} · 영업이익률 ${ratioPercent(f.operatingMarginForecast)}\n명목 성장 ${ratioPercent(f.growthForecast)} · 가상 연 기준` });
    const dividend = f.dividends?.at(-1);
    if (dividend) embed.addFields({ name: '최근 배당 · 경제 틱 기준', value: `주당 ${displayNumber(dividend.dps)} · ${rightStatus(dividend.status)}\n선언 ${dividend.declaredTick} · 권리 확정 ${dividend.exTick} · 지급 ${dividend.payTick}틱\n회수율 ${ratioPercent(dividend.recoveryRatio)} · 지급 및 가격 변동 위험 존재` });
  }
  const latest = stock.latestDisclosures[0];
  if (latest) embed.addFields({ name: `최근 공시 · ${latest.publishedTick}틱`, value: `${safeText(latest.title, 100)}\n${safeText(latest.summary, 400)}` });
  return replyView(embed, [navigationRow([
    { id: `pm:trade:BUY:${stock.listing.symbol}:${stock.generation}`, label: '매수', disabled: !tradable },
    { id: `pm:trade:SELL:${stock.listing.symbol}:${stock.generation}`, label: '매도', disabled: !tradable },
    { id: `pm:view:financial:${stock.listing.symbol}:${stock.generation}`, label: '재무' },
    { id: `pm:chart:${stock.listing.symbol}:${stock.generation}:PRICE:LINEAR`, label: '차트' },
  ])]);
}

export function renderNews(news: NewsView, symbol?: string): ReplyView {
  const embed = baseEmbed('PaperMarket · 공개 공시', `${metaText(news)}\n\n${symbol ? `${safeText(symbol, 12)} 공시 · ` : ''}이미 공개된 기록만 표시합니다. 예상은 확정 결과가 아닙니다.`);
  for (const item of news.items.slice(0, 4)) embed.addFields({ name: `${item.publishedTick}틱 · ${safeText(item.title, 80)}`, value: safeText(item.summary, 600) || '공개 기록' });
  if (!news.items.length) embed.addFields({ name: '공시', value: '조회 범위에 공개 공시가 없습니다.' });
  const actions = [{ id: 'pm:view:market', label: '시장' }, { id: 'pm:view:calendar', label: '일정' }];
  if (news.more && news.nextCursor) actions.push({ id: `pm:news:${news.nextCursor}${symbol ? `:${symbol}` : ''}`, label: '이전 공시' });
  else if (news.more && news.nextBeforeTick !== null) actions.push({ id: `pm:news:${news.nextBeforeTick}:${symbol ?? 'ALL'}`, label: '이전 공시' });
  return replyView(embed, [navigationRow(actions)]);
}

export function renderCalendar(calendar: CalendarView): ReplyView {
  const embed = baseEmbed('PaperMarket · 공개 일정', `${metaText(calendar)}\n\n예정 틱은 가상 시간입니다. 확정된 선언·공개 규칙에 따른 일정이며 미래 실적·배당을 추정해 만들지 않습니다.`);
  const labels = { EARNINGS: '실적 발표', POLICY: '정책회의', DIVIDEND_EX: '배당 권리 확정', DIVIDEND_PAYMENT: '배당 지급' } as const;
  for (const [index, group] of [calendar.items.slice(0, 4), calendar.items.slice(4, 8), calendar.items.slice(8, 12), calendar.items.slice(12, 16)].entries()) {
    if (group.length) embed.addFields({ name: `공개 일정 ${index * 4 + 1}~${index * 4 + group.length}`, value: group.map((item) => `${item.eventTick}틱 · ${labels[item.kind]}${item.symbol ? ` · ${safeText(item.symbol, 12)} ${item.generation ?? 1}세대` : ''}\n${safeText(item.title, 80)} · 안내 ${item.announcedTick}틱`).join('\n\n').slice(0, 1_000) });
  }
  if (!calendar.items.length) embed.addFields({ name: '일정', value: '공개된 향후 일정이 없습니다.' });
  if (calendar.items.length > 16) embed.addFields({ name: '표시 범위', value: `가까운 16개 표시 · 전체 공개 일정 ${calendar.items.length}개` });
  return replyView(embed, [navigationRow([{ id: 'pm:view:market', label: '시장' }, { id: 'pm:view:news', label: '공시' }])]);
}

export function renderPerformance(p: PerformanceView): ReplyView {
  const embed = baseEmbed('PaperMarket · 투자 성과', [
    `순자산 ${displayNumber(p.equity)} · 총수익률 ${percent(p.totalReturnPct)}`,
    `직전 확정 틱 변화 ${p.previousTickChangePct === null ? '기록 없음' : percent(p.previousTickChangePct)} · 최대낙폭 ${displayNumber(p.maxDrawdownPct)}%`,
    `${p.startedTick}~${p.currentTick}틱 · 확정 표본 ${p.sampleCount}개 · 현금 비중 ${displayNumber(p.cashWeightPct)}%`, metaText(p),
    p.missingHistory ? '도입 이전 전체 경로를 복원할 수 없어 낙폭은 저장된 확정 표본 범위에서 계산합니다.' : '수익률은 초기금 10,000 기준이며 외부 입출금은 없습니다.',
  ].join('\n\n'));
  embed.addFields({ name: '수익 기여 · 포인트', value: `실현손익 ${signedAmount(p.realizedPnl)} · 평가손익 ${signedAmount(p.unrealizedPnl)}\n현금이자(지급+발생) ${signedAmount(p.cashInterest)}\n배당 기여(지급+권리 평가) ${signedAmount(p.dividends)}\n청산 기여 ${signedAmount(p.liquidation)} · 기타 권리 기여 ${signedAmount(p.otherRightsPnl)}\n수수료 ${displayNumber(p.fees)} · 반올림 조정 ${signedAmount(p.rounding)}\n수수료는 취득원가·실현손익에 포함됩니다.\n합계 대조 ${p.reconciled ? '일치' : '확인 필요'}` },
    { name: '동일 계좌 시작점의 기준전략', value: `전액 현금 ${percent(p.baselines.cash.totalReturnPct)} · ${p.baselines.cash.startTick}틱 시작\n8종목 최초 매수 후 보유 ${percent(p.baselines.hold8.totalReturnPct)} · ${p.baselines.hold8.startTick}틱 시작\n매매 수수료·배당·권리·현금 이자를 반영합니다.${p.baselines.hold8.openingPolicy === 'LEGACY_BOUNDARY_ONLY' ? '\n기존 계좌의 최초 틱 부분 보유시간을 복원할 수 없어 해당 부분의 이자를 제외합니다. 이후 확정 가격·금리·기업행동을 적용했습니다.' : ''}` },
    { name: '시장 PM8 · 별도 기준 시점', value: `시장 총수익 ${percent(p.pm8.totalReturnPct)} · 지수 ${displayNumber(p.pm8.index)}\n시장 ${p.pm8.startTick}틱부터 · 21틱마다 동일 비중 재조정` },
    { name: '낙폭 정의', value: safeText(p.drawdownDefinition, 500) });
  return replyView(embed, [navigationRow([{ id: 'pm:view:portfolio', label: '내 자산' }, { id: 'pm:view:history', label: '내역' }, { id: 'pm:export:CSV:LATEST', label: 'CSV 내보내기' }])]);
}

export function renderExport(data: ExportView, format: 'CSV' | 'JSON' = 'CSV'): ReplyView {
  const embed = baseEmbed('PaperMarket · 본인 기록 내보내기', `본인 기록 ${data.recordCount}건 · ${format}\n비공개 응답에만 첨부하며 생성 파일을 서버 디스크에 저장하지 않습니다.${data.truncated ? '\n한 페이지 용량 제한에 도달했습니다. 이전 기록 페이지를 이어서 받으세요.' : ''}`);
  const actions = [{ id: `pm:export:${format === 'CSV' ? 'JSON' : 'CSV'}:LATEST`, label: format === 'CSV' ? 'JSON 다운로드' : 'CSV 다운로드' }, { id: 'pm:view:history', label: '내역' }];
  if (data.nextBeforeSequence !== null) {
    if (!Number.isSafeInteger(data.nextBeforeSequence) || data.nextBeforeSequence < 1
      || (data.nextBeforeEventId !== undefined && data.nextBeforeEventId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(data.nextBeforeEventId))) return replyView(errorEmbed('INTERNAL_ERROR'));
    actions.push({ id: `pm:export:${format}:${data.nextBeforeSequence}${data.nextBeforeEventId ? `:${data.nextBeforeEventId}` : ''}`, label: '이전 기록 파일' });
  }
  const view = replyView(embed, [navigationRow(actions)]);
  if (data.files.length > 10 || new Set(data.files.map((file) => file.name)).size !== data.files.length
    || data.files.some((file) => !/^[A-Za-z0-9_-]{1,96}\.(csv|json)$/.test(file.name)
      || (file.name.endsWith('.csv') ? file.mimeType !== 'text/csv' : file.mimeType !== 'application/json'))
    || data.files.reduce((sum, file) => sum + Buffer.byteLength(file.content, 'utf8'), 0) > 2_000_000) return replyView(errorEmbed('INTERNAL_ERROR'));
  view.files = data.files.map((file) => new AttachmentBuilder(Buffer.from(file.content, 'utf8'), { name: file.name }));
  return view;
}

export function renderAlerts(alerts: AlertsView, beforeId?: string): ReplyView {
  const embed = baseEmbed('PaperMarket · 개인 알림함', `미읽음 ${alerts.inbox.unreadCount}건 · DM 수신 ${alerts.dmEnabled ? '동의함' : '동의하지 않음'}\n관심종목 ${alerts.settings.watchlist.filter((item) => item.enabled).length}개 · 가격 임계 알림 ${alerts.settings.priceAlerts.length}개 · /alerts에서 관심종목·가격·DM을 명시적으로 설정하세요.\nDM 동의가 없어도 중요 공시·본인 권리·예약 주문 결과는 이 알림함에 보관합니다.`);
  for (const item of alerts.inbox.items.slice(0, 4)) embed.addFields({ name: `${item.tickNo}틱 · ${item.read ? '읽음' : '미읽음'} · ${safeText(item.title, 60)}`, value: `${safeText(item.summary, 600)}\n버전 ${item.marketVersion} · ${displayTime(item.createdAt)}` });
  if (alerts.settings.priceAlerts.length) embed.addFields({ name: '가격 알림 · 최근 4개', value: alerts.settings.priceAlerts.slice(-4).map((item) => `${safeText(item.symbol, 12)} ${item.direction === 'ABOVE' ? '상향' : '하향'} ${displayExact(item.threshold)} · ${item.enabled ? item.armed ? '대기' : '반대 방향 통과 후 재무장' : '종목 종료로 중단'}\nID ${safeText(item.alertId, 80)}`).join('\n\n').slice(0, 1_000) });
  if (alerts.settings.watchlist.length) embed.addFields({ name: '관심종목', value: alerts.settings.watchlist.slice(-8).map((item) => `${safeText(item.symbol, 12)} · ${item.enabled ? '관심 등록' : '종목 종료로 중단'}`).join('\n') });
  const actions = [{ id: 'pm:alerts:REFRESH', label: '새로고침' },
    { id: `pm:alerts:READ${beforeId ? `:${beforeId}` : ''}`, label: '현재 페이지 읽음' }];
  if (alerts.inbox.nextBeforeId !== null) actions.push({ id: `pm:alerts:BEFORE:${alerts.inbox.nextBeforeId}`, label: '이전 알림' });
  return replyView(embed, [navigationRow(actions)]);
}

/** Only allowlisted market facts reach the shared board. No account, request or sequence fields are serialized. */
export function renderMarket(market: MarketView, actions = true): ReplyView {
  const economic = market.priceSource === 'ECONOMY';
  const lines = market.listings.slice(0, 8).map((listing) =>
    `**${safeText(listing.symbol, 12)}** ${safeText(listing.name, 40)}\n${displayNumber(listing.price)} · ${economic ? percent(listing.changePct ?? '0') : '보합 (고정 시험 시세)'}`);
  const embed = baseEmbed(economic ? 'PaperMarket · 가상 시장' : 'PaperMarket · 시험 시장', [
    `상태 ${market.state === 'OPEN' ? '거래 가능' : '거래 중단'} · 가상 틱 ${market.tickNo} · 버전 ${market.marketVersion}`,
    ...lines,
    `최근 확정 ${displayTime(market.updatedAt)} · 다음 틱 ${displayTime(market.nextBoundaryAt)}`,
    ...(market.pm8 ? [`PM8 시장 총수익 ${percent(market.pm8.totalReturnPct)} · 지수 ${displayNumber(market.pm8.index)}`] : []),
    economic ? '공개 실적·전망·가상 금리에 따른 모의 시세입니다. /economy · /financial에서 근거를 확인하세요.'
      : '개발용 고정 시험 시세입니다. 기업 경제 모드가 활성화되지 않았습니다.',
    '/buy · /sell로 견적 확인 · /portfolio로 내 자산 조회',
  ].join('\n\n'));
  if (economic && market.economy) embed.addFields({ name: '공개 금리', value:
    `정책 ${ratioPercent(market.economy.macro.policyRate)} · 현금 예치 연 ${ratioPercent(market.economy.macro.cashAnnualRate)}\n가상 연 252틱 · 경제 ${market.economy.economyTick}틱` });
  return replyView(embed, actions ? [navigationRow([{ id: 'pm:selectcompany', label: '종목 선택' }, { id: 'pm:view:portfolio', label: '내 자산' },
    { id: 'pm:view:news', label: '공시' }, { id: 'pm:view:economy', label: '경제' }])] : []);
}

function ratioPercent(value: string): string { return `${displayNumber(new FinancialDecimal(value).times('100').toString())}%`; }

export function renderEconomy(economy: EconomyView, meta?: PublicViewMeta): ReplyView {
  const macro = economy.macro;
  const embed = baseEmbed('PaperMarket · 공개 경제', [
    `경제 ${economy.economyTick}틱 · 지표 관측 ${macro.observedTick}틱 · 가상 연 252틱`,
    `정책금리 ${ratioPercent(macro.policyRate)} · 현금 예치 연 ${ratioPercent(macro.cashAnnualRate)}`,
    `물가 ${ratioPercent(macro.inflation)} · 산출갭 ${ratioPercent(macro.outputGap)}`,
    `산업수요 ${displayNumber(macro.industrialDemand)} · 소비수요 ${displayNumber(macro.consumerDemand)}`,
    `금속 ${displayNumber(macro.metals)} · 에너지 ${displayNumber(macro.energy)} · 환율 ${displayNumber(macro.fx)} (상승=모의통화 약세)`,
    `신용위험 ${displayNumber(macro.creditStress, 3)} · 위험선호 ${displayNumber(macro.riskAppetite, 3)}`,
    `다음 가상 정책회의 ${macro.nextMeetingTick}틱`,
    `인하 ${ratioPercent(macro.policyProbabilities.decrease)} · 동결 ${ratioPercent(macro.policyProbabilities.unchanged)} · 인상 ${ratioPercent(macro.policyProbabilities.increase)}`,
    '공개 관측·추정치이며 미래 결과가 아닙니다. 실제 금리·뉴스를 입력하지 않습니다.',
    ...(meta ? [metaText(meta)] : []),
  ].join('\n\n'));
  for (const disclosure of economy.disclosures.slice(0, 4)) embed.addFields({
    name: `${disclosure.publishedTick}틱 · ${safeText(disclosure.title, 100)}`,
    value: safeText(disclosure.summary, 600) || '공개 기록',
  });
  if (!economy.disclosures.length) embed.addFields({ name: '공개 일정', value: '경제 지표 21틱마다 · 기업 실적 63틱 마감 후 종목별 1~4틱 시차' });
  return replyView(embed);
}

export function renderFinancial(financial: FinancialView, meta?: PublicViewMeta): ReplyView {
  const embed = baseEmbed(`PaperMarket · ${safeText(financial.symbol, 12)} 공개 실적`, [
    `${safeText(financial.name, 60)} · ${financial.reportKind === 'SYNTHETIC_INITIALIZATION' ? '합성 초기화 실적' : `가상 ${financial.quarterNo}분기 실적`}`,
    `기업 상태 ${lifecycle(financial.lifecycle)} · ${financial.generation ?? 1}세대`,
    `${financial.lifecycle === 'EXTINGUISHED' ? '종료 전 공개 당시 경제 틱' : '경제 틱 기준'}: 마감 ${financial.closedTick}틱 · 공개 ${financial.publishedTick}틱 · ${financial.lifecycle === 'EXTINGUISHED' ? '발표 일정' : '다음 발표'} ${financial.nextEarningsTick}틱`,
    '금액 단위: 포인트 · 실적은 마감된 분기 · 전망은 가상 연 기준',
    ...(meta ? [metaText(meta)] : []),
  ].join('\n\n'));
  embed.addFields(
    { name: '공개 손익', value: `매출 ${displayNumber(financial.revenue)}\n영업이익 ${displayNumber(financial.operatingProfit)}\n발생 이자 ${displayNumber(financial.interestExpense)}\n순이익 ${displayNumber(financial.netProfit)}` },
    { name: '공개 자금 흐름', value: `현금 ${displayNumber(financial.cash)} · 차입금 ${displayNumber(financial.debt)}\n영업현금흐름 ${displayNumber(financial.operatingCashFlow)} · 설비투자 ${displayNumber(financial.capex)}` },
    { name: '시장 전망 · 확정 실적 아님', value: `연 매출 ${displayNumber(financial.annualRevenueForecast)}\n영업이익률 ${ratioPercent(financial.operatingMarginForecast)} · 명목 매출 성장 ${ratioPercent(financial.growthForecast)}\n같은 실적도 사전 예상에 따라 전망 변화가 다릅니다.` },
  );
  if(financial.dividends?.length) embed.addFields({name:'배당 일정 · 경제 틱 기준',value:financial.dividends.slice(-4).map(dividend=>
    `주당 ${displayNumber(dividend.dps)} · ${rightStatus(dividend.status)}\n선언 ${dividend.declaredTick} · 권리 확정 ${dividend.exTick} · 지급 예정 ${dividend.payTick}틱 · 회수율 ${ratioPercent(dividend.recoveryRatio)}`).join('\n\n').slice(0,1000)});
  return replyView(embed, [navigationRow([{ id: `pm:view:company:${financial.symbol}:${financial.generation ?? 1}`, label: '기업' },
    { id: `pm:chart:${financial.symbol}:${financial.generation ?? 1}:PRICE:LINEAR`, label: '차트' }])]);
}

function lifecycle(state:string|undefined):string {return ({OPERATING:'영업 중',WATCH:'주의',DISTRESSED:'부실',RESTRUCTURING:'재구조화',LIQUIDATING:'청산 중',EXTINGUISHED:'최종 소멸'} as Record<string,string>)[state??'OPERATING']??'확인 중';}
function rightStatus(state:string):string {return ({ATTACHED:'권리 확정 전',DECLARED:'선언',EX_ENTITLED:'권리 확정',OPEN:'미지급',IMPAIRED:'회수 손상',PAID:'지급',SETTLED:'최종 정산'} as Record<string,string>)[state]??'확인 중';}

function percent(value: string): string {
  const number = new FinancialDecimal(value);
  return number.isNegative() ? `하락 -${displayNumber(number.abs().toString())}%`
    : number.isZero() ? '보합 0.00%' : `상승 +${displayNumber(value)}%`;
}

function orderTypeLabel(orderType: 'MARKET' | 'LIMIT' | 'STOP'): string {
  return orderType === 'MARKET' ? '시장가' : orderType === 'LIMIT' ? '지정가' : '스톱';
}

function conditionLabel(side: 'BUY' | 'SELL', orderType: 'LIMIT' | 'STOP', price: string): string {
  return `현재가 ${orderType === 'STOP' || side === 'BUY' ? '≤' : '≥'} ${displayExact(price)}`;
}

function expirationLabel(timeInForce: 'TICK_COUNT' | 'UNTIL_CANCELLED', expiresTick: number | null | undefined): string {
  return timeInForce === 'UNTIL_CANCELLED' ? '취소할 때까지' : `전체 시장 ${expiresTick ?? '확인 중'}틱 전에 유효 · 만료 틱에는 체결하지 않음`;
}

function scheduledStatus(status: ScheduledOrderView['status']): string {
  return ({ OPEN: '미체결', FILLED: '체결', CANCELLED: '취소', EXPIRED: '만료' } as const)[status];
}

function terminationLabel(reason: string | undefined): string {
  if (reason === undefined) return '';
  const labels: Readonly<Record<string, string>> = { USER_CANCELLED: '사용자 취소', EXPIRED: '기간 만료', CORPORATE_ACTION_CANCELLED: '기업행동 취소',
    ACCOUNT_CLOSED: '계좌 종료', FILLED: '조건 충족 체결' };
  const text = Object.hasOwn(labels, reason) ? labels[reason] : undefined;
  return text ? ` · ${text}` : '';
}

function scheduledOrderField(order: ScheduledOrderView, index: number): { name: string; value: string } {
  return { name: `${index + 1}. ${safeText(order.symbol, 12)} · ${orderTypeLabel(order.orderType)} ${order.side === 'BUY' ? '매수' : '매도'} · ${scheduledStatus(order.status)}`,
    value: [
      `${displayExact(order.quantity, 0)}주 · 조건 ${conditionLabel(order.side, order.orderType, order.conditionPrice)}`,
      `예약 현금 ${displayExact(order.reservedCash)} · 예약 수량 ${displayExact(order.reservedQuantity, 0)}주`,
      expirationLabel(order.timeInForce, order.expiresTick),
      `접수 ${order.createdTick}틱 · 주문 ${safeText(order.orderId, 64)}${terminationLabel(order.terminationReason)}`,
    ].join('\n') };
}

function scheduledCancelButton(order: ScheduledOrderView, index: number): ButtonBuilder | null {
  if (order.status !== 'OPEN' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(order.orderId)) return null;
  return new ButtonBuilder().setCustomId(`pm:ordercancel:${order.orderId}`).setLabel(`취소 ${index + 1} · ${order.symbol.slice(0, 12)}`)
    .setStyle(ButtonStyle.Secondary);
}

export function renderOrders(orders: readonly ScheduledOrderView[]): ReplyView {
  const open = orders.filter((order) => order.status === 'OPEN');
  const shown = [...open, ...orders.filter((order) => order.status !== 'OPEN')].slice(0, 4);
  const embed = baseEmbed('PaperMarket · 예약 주문', orders.length ? [
    `조회된 미체결 ${open.length}건 · 종료 ${orders.length - open.length}건 · 최대 4건 표시 (미체결 우선)`,
    '예약 현금은 보유 현금의 일부이며 예약 주식도 배당 권리를 유지합니다. 예약 자산을 중복 사용할 수 없습니다.',
    '조건 충족 시 실제 확정 시세로 전량 체결합니다. 스톱은 갭 하락 시 손실액을 보장하지 않습니다.',
    '배당락·교환·소멸 시 미체결 주문은 취소됩니다. /history에서 체결 결과를 확인하세요.',
  ].join('\n\n') : '예약 주문이 없습니다. /buy 또는 /sell에서 order_type과 조건가격을 선택하세요.');
  const buttons: ButtonBuilder[] = [];
  for (const [index, order] of shown.entries()) {
    embed.addFields(scheduledOrderField(order, index));
    const button = scheduledCancelButton(order, index); if (button) buttons.push(button);
  }
  return replyView(embed, buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : []);
}

/** Rendering reads committed views. It never changes prices, balances, order state or random streams. */
export function renderServiceResponse(response: ServiceResponse): ReplyView {
  switch (response.kind) {
    case 'STOCK': return renderStock(response.stock);
    case 'NEWS': return renderNews(response.news);
    case 'CALENDAR': return renderCalendar(response.calendar);
    case 'CHART': return renderPriceChart(response.chart);
    case 'PERFORMANCE': return renderPerformance(response.performance);
    case 'EXPORT': return renderExport(response.export);
    case 'ALERTS': return renderAlerts(response.alerts);
    case 'NOTIFICATION_BATCH': case 'NOTIFICATION_AUTHORIZED': case 'NOTIFICATION_ACK': return replyView(errorEmbed('INVALID_INPUT'));
    case 'SETUP': case 'MARKET': return renderMarket(response.market);
    case 'STATUS': return replyView(baseEmbed('PaperMarket · 운영 상태', [
      response.market.priceSource === 'ECONOMY' ? '기업 경제·공개 전망 기반 시세 · 실거래 아님' : '고정 시험 시세 공급자 · 실거래 아님',
      `상태 ${response.market.state === 'OPEN' ? '거래 가능' : '거래 중단'}`,
      `확정 버전 ${response.market.marketVersion} · 가상 틱 ${response.market.tickNo}`,
      `최근 확정 ${displayTime(response.market.updatedAt)} · 다음 틱 ${displayTime(response.market.nextBoundaryAt)}`,
    ].join('\n')));
    case 'ACCOUNT': return replyView(baseEmbed('PaperMarket · 모의계좌', [
      '계좌를 개설했거나 기존 계좌를 복원했습니다. 초기자금 10,000은 시장별 한 번만 지급됩니다.',
      `보유 현금 ${displayNumber(response.account.cash)} · 계좌 버전 ${response.account.accountVersion}`,
      '실제 현금·현금화·보상은 없습니다. /market으로 가상 시장을 조회하고 /buy로 견적을 확인하세요.',
    ].join('\n\n')));
    case 'QUOTE': {
      const quote = response.quote;
      // Tokens are opaque server-issued nonces. They only appear in routing IDs, never in prose or logs.
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(quote.token)) return replyView(errorEmbed('INTERNAL_ERROR'));
      const conditional = quote.orderType === 'LIMIT' || quote.orderType === 'STOP';
      if (conditional && (quote.conditionPrice === undefined || quote.timeInForce === undefined
        || quote.reservedCash === undefined || quote.reservedQuantity === undefined
        || (quote.timeInForce === 'TICK_COUNT' && typeof quote.expiresTick !== 'number')
        || (quote.orderType === 'STOP' && quote.side !== 'SELL'))) return replyView(errorEmbed('INTERNAL_ERROR'));
      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder().setCustomId(`pm:confirm:${quote.token}`).setLabel('확인').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`pm:cancel:${quote.token}`).setLabel('취소').setStyle(ButtonStyle.Secondary),
      );
      if (conditional && quote.conditionPrice !== undefined && quote.timeInForce !== undefined) {
        return replyView(baseEmbed('PaperMarket · 조건주문 확인', [
          `${orderTypeLabel(quote.orderType!)} ${quote.side === 'BUY' ? '매수' : '매도'} · **${safeText(quote.symbol, 12)}** · ${displayExact(quote.quantity, 0)}주`,
          `조건 ${conditionLabel(quote.side, quote.orderType as 'LIMIT' | 'STOP', quote.conditionPrice)} · 현재 확정 시세 ${displayExact(quote.price)} (참고)`,
          `조건가격 기준 예상 대금 ${displayExact(quote.gross)} · 예상 수수료 ${displayExact(quote.fee)}\n${quote.side === 'BUY' ? '최대 매수비용' : '예상 순 수취액'} ${displayExact(quote.total)} · 예상 체결 후 현금 ${displayExact(quote.cashAfter)}`,
          `확인 후 최대 예약 현금 ${displayExact(quote.reservedCash!)} · 예약 수량 ${displayExact(quote.reservedQuantity!, 0)}주\n예약만으로 현금·주식 총액이 줄지 않습니다. 예약 현금은 예치이자, 예약 주식은 배당 권리를 유지합니다. 현재 견적은 자산을 예약하지 않습니다.`,
          `${expirationLabel(quote.timeInForce, quote.expiresTick)}\n확인 토큰 만료 ${displayTime(quote.expiresAt)} · 시세 버전 ${quote.marketVersion} · 최대 30초`,
          '확인 시 이미 조건을 충족하면 현재 시세로 체결하고, 그 외에는 새 확정 시세마다 조건을 평가합니다. 실제 체결금액은 확정가로 정산합니다.',
          ...(quote.orderType === 'STOP' ? ['스톱은 발동가격보다 낮은 갭 하락 가격에 체결될 수 있으며 손실액을 보장하지 않습니다.'] : []),
          '만료 → 기업행동 취소 → 새 시세 → 조건 평가 순서입니다. 배당락·교환·소멸 때 미체결 주문은 취소됩니다.',
        ].join('\n\n')), [row]);
      }
      return replyView(baseEmbed('PaperMarket · 주문 확인', [
        `${quote.side === 'BUY' ? '매수' : '매도'} · **${safeText(quote.symbol, 12)}**`,
        `수량 ${displayExact(quote.quantity, 0)} · 실행 시세 ${displayExact(quote.price)}`,
        `거래대금 ${displayExact(quote.gross)} · 수수료 ${displayExact(quote.fee)}`,
        `${quote.side === 'BUY' ? '총 지출' : '순 수취액'} ${displayExact(quote.total)} · 체결 후 현금 ${displayExact(quote.cashAfter)}`,
        `확정 시세 버전 ${quote.marketVersion} · 만료 ${displayTime(quote.expiresAt)}`,
        '수량·시세·수수료를 확인하세요. 시세가 바뀌면 새 견적이 필요합니다.',
      ].join('\n\n')), [row]);
    }
    case 'FILLED': {
      const fill = response.fill;
      return replyView(baseEmbed('PaperMarket · 체결 내역', [
        `${fill.side === 'BUY' ? '매수' : '매도'} · **${safeText(fill.symbol, 12)}**`,
        `수량 ${displayExact(fill.quantity, 0)} · 체결 시세 ${displayExact(fill.price)}`,
        `거래대금 ${displayExact(fill.gross)} · 수수료 ${displayExact(fill.fee)}`,
        `${fill.side === 'BUY' ? '총 지출' : '순 수취액'} ${displayExact(fill.total)} · 남은 현금 ${displayExact(fill.cashAfter)}`,
        `주문 ${safeText(fill.orderId, 80)} · 버전 ${fill.marketVersion} · ${displayTime(fill.createdAt)}`,
        '결과는 /history에 저장되었습니다. 동일 확인을 다시 누르면 기존 결과를 조회합니다.',
      ].join('\n\n')));
    }
    case 'ORDER_OPENED': {
      const order = response.order;
      const embed = baseEmbed('PaperMarket · 예약 주문 접수', [
        '조건주문을 접수하고 자산을 예약했습니다. 현재 조건을 충족하지 않아 미체결 상태이며 새 확정 시세마다 조건을 평가합니다.',
        '예약은 자산 이전이 아닙니다. /portfolio에서 총자산과 가용·예약 자산을 확인하고 /orders에서 취소할 수 있습니다.',
        '실제 체결 결과는 /history에 저장됩니다. 배당락·교환·소멸 때 미체결 주문은 취소됩니다.',
      ].join('\n\n')).addFields(scheduledOrderField(order, 0));
      const cancel = scheduledCancelButton(order, 0);
      return replyView(embed, cancel ? [new ActionRowBuilder<ButtonBuilder>().addComponents(cancel)] : []);
    }
    case 'ORDERS': return renderOrders(response.orders);
    case 'SCHEDULED_CANCELLED': {
      const order = response.order;
      const explanation = order.status === 'FILLED'
        ? '이미 체결한 주문입니다. 체결 결과는 /history에 저장되어 있으며 이 확인으로 취소하거나 다시 체결하지 않습니다.'
        : order.status === 'OPEN' ? '미체결 주문입니다. /orders에서 최신 상태와 취소 가능 여부를 확인하세요.'
          : '종료된 주문의 예약 자산을 해제했습니다. 이 확인으로 종료 주문을 다시 처리하지 않습니다.';
      return replyView(baseEmbed('PaperMarket · 예약 주문 상태',
        `주문 상태 ${scheduledStatus(order.status)}${terminationLabel(order.terminationReason)}. ${explanation}`)
        .addFields(scheduledOrderField(order, 0)));
    }
    case 'CANCELLED': return replyView(baseEmbed('PaperMarket · 주문 취소', '주문을 취소했습니다. 현금과 보유량은 바뀌지 않았습니다.'));
    case 'CLOSED': return replyView(baseEmbed('PaperMarket · 계좌 이용 중단', 'Discord 사용자 ID 연결을 제거하고 미체결 조건주문을 취소해 예약 자산을 해제했습니다. 원본 확인 토큰·응답 캐시도 파기했습니다. 이 시장에서는 재개설·초기금 재지급을 할 수 없습니다. HMAC 식별자와 금융 원장은 시장 존속 기간 보관합니다. 자세한 정책과 권리 요청 경로는 /privacy에서 확인하세요.'));
    case 'PORTFOLIO': {
      const portfolio = response.portfolio;
      const positions = portfolio.positions.slice(0, 8).map((position) =>
        `**${safeText(position.symbol, 12)}** ${displayNumber(position.quantity, 6)}주 · 평가 ${displayNumber(position.value)} · 평가손익 ${displayNumber(position.unrealizedPnl)}`
        + (position.availableQuantity === undefined ? '' : `\n가용 ${displayExact(position.availableQuantity, 0)}주 · 예약 ${displayExact(position.reservedQuantity ?? '0', 0)}주`));
      const embed=baseEmbed('PaperMarket · 내 자산', [
        `순자산 ${displayNumber(portfolio.equity)} · 총수익률 ${percent(portfolio.totalReturnPct)}`,
        `현금 ${displayNumber(portfolio.account.cash)} · 계좌 버전 ${portfolio.account.accountVersion}`,
        ...(portfolio.availableCash === undefined ? [] : [`가용 현금 ${displayExact(portfolio.availableCash)} · 예약 현금 ${displayExact(portfolio.reservedCash ?? '0')}\n예약 현금은 총 현금에 포함되며 예치이자 대상입니다.`]),
        ...(portfolio.accruedCashInterest === undefined ? [] : [`미지급 현금 이자 ${displayNumber(portfolio.accruedCashInterest)} · 누적 지급 ${displayNumber(portfolio.cashInterestTotal ?? '0')}\n보유시간 기준 발생 · 틱말 지급 · 틱 내부 재복리 없음`]),
        positions.length ? `보유 종목 ${positions.length}개 · 아래 보유 내역 참조` : '보유 종목이 없습니다.',
        `시세 버전 ${portfolio.marketVersion} · 수수료 포함 취득원가 기준`,
        ...(portfolio.dividendTotal===undefined?[]:[`누적 배당 지급 ${displayNumber(portfolio.dividendTotal)} · 청산 회수 ${displayNumber(portfolio.liquidationTotal??'0')}\n지급액은 현금에 포함되며 현재 권리 평가는 순자산에 한 번 포함됩니다.`]),
      ].join('\n\n'));
      for (let index = 0; index < positions.length; index += 4) embed.addFields({ name: `보유 종목 ${index + 1}~${Math.min(index + 4, positions.length)}`,
        value: positions.slice(index, index + 4).join('\n\n').slice(0, 1_000) });
      const rights=portfolio.rights??[];
      const rightLimit = 5 - Math.ceil(positions.length / 4);
      for(const right of rights.slice(-rightLimit)) embed.addFields({name:`${safeText(right.symbol,12)} · ${right.kind==='DIVIDEND'?'배당 권리':'청산 회수권'} · ${rightStatus(right.status)}`,value:[
        `${displayNumber(right.quantity,6)}주 기준 · 현재 평가 ${displayNumber(right.currentValue)} · 실제 지급 ${displayNumber(right.paid)}`,
        right.kind==='DIVIDEND'?`명목 배당 ${displayNumber(right.nominal)} · 확정 ${right.eligibleTick} · 지급 예정 ${right.paymentTick}틱`:
          `이전 취득원가 ${displayNumber(right.cost)} · 최종 손익 ${right.status==='SETTLED'?displayNumber(right.realizedPnl):'미확정'} · 정산 예정 ${right.paymentTick}틱`,
      ].join('\n')});
      if(rights.length>rightLimit) embed.addFields({name:'권리 표시',value:`최근 ${rightLimit}건 표시 · 전체 ${rights.length}건의 현재 평가는 순자산에 포함됩니다.`});
      return replyView(embed, [navigationRow([{ id: 'pm:view:performance', label: '성과' }, { id: 'pm:view:history', label: '내역' },
        { id: 'pm:view:orders', label: '예약 주문' }])]);
    }
    case 'HISTORY': {
      if (response.entries) {
        const embed = baseEmbed('PaperMarket · 본인 원장 내역', '체결·배당·이자·청산·정정은 확정 순서대로 조회합니다. 금액 단위는 포인트입니다.');
        for (const entry of response.entries.slice(0, 4)) embed.addFields({ name: `${entry.tickNo}틱 · ${safeText(entry.title, 70)}`, value: `${entry.symbol ? `${safeText(entry.symbol, 12)} · ` : ''}${signedAmount(entry.amount)}\n${displayTime(entry.createdAt)} · 버전 ${entry.marketVersion} · 순번 ${entry.sequenceNo}` });
        if (!response.entries.length) embed.addFields({ name: '내역', value: '조회 범위에 확정 원장 내역이 없습니다.' });
        const actions = [{ id: 'pm:view:portfolio', label: '내 자산' }, { id: 'pm:export:CSV:LATEST', label: 'CSV 내보내기' }];
        if (response.nextBeforeSequence !== undefined && response.nextBeforeSequence !== null) {
          if (!Number.isSafeInteger(response.nextBeforeSequence) || response.nextBeforeSequence < 1
            || (response.nextBeforeEventId !== undefined && response.nextBeforeEventId !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(response.nextBeforeEventId))) return replyView(errorEmbed('INTERNAL_ERROR'));
          actions.push({ id: `pm:history:${response.nextBeforeSequence}${response.nextBeforeEventId ? `:${response.nextBeforeEventId}` : ''}`, label: '이전 내역' });
        }
        return replyView(embed, [navigationRow(actions)]);
      }
      const lines = response.fills.slice(0, 10).map((fill) =>
        `${displayTime(fill.createdAt)} · ${fill.side === 'BUY' ? '매수' : '매도'} **${safeText(fill.symbol, 12)}** ${displayNumber(fill.quantity, 6)}주 @ ${displayNumber(fill.price)}\n수수료 ${displayNumber(fill.fee, 6)} · 주문 ${safeText(fill.orderId, 60)}`);
      return replyView(baseEmbed('PaperMarket · 최근 체결', lines.length ? lines.join('\n\n') : '체결 내역이 없습니다. /buy 또는 /sell에서 견적을 확인하세요.'));
    }
    case 'ERROR': return replyView(errorEmbed(response.code));
    case 'BOARD_SAVED': return replyView(baseEmbed('PaperMarket · 시장 설정', '시장 설정과 고정 현황판의 메시지 참조를 저장했습니다.'));
    case 'TICKED': case 'RECOVERED': return replyView(baseEmbed('PaperMarket · 운영 상태', '가상 시장 상태를 확인했습니다.'));
  }
}
