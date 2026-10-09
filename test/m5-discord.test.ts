import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ButtonStyle, ComponentType, InteractionContextType, MessageFlags, PermissionsBitField, type Interaction } from 'discord.js';
import type { Backend, ServiceRequest, ServiceResponse, StockView } from '../src/application/contracts.js';
import { buildCommands, createInteractionHandler } from '../src/discord/index.js';
import { UI_COLORS, errorEmbed } from '../src/discord/messages.js';
import { renderAlerts, renderCalendar, renderExport, renderNews, renderPriceChart, renderServiceResponse, renderStock, type ReplyView } from '../src/discord/render.js';
import { tradeModal } from '../src/discord/forms.js';
import { visualQaFixtures } from '../src/charts/qa-fixtures.js';

const now = new Date('2026-10-05T12:00:00.000Z');
const operator = { operatorName: 'PaperMarket tests', supportContact: 'support@example.com' };
const stock: StockView = {
  tickNo: 68, marketVersion: 69, updatedAt: now.toISOString(), nextBoundaryAt: '2026-10-05T12:05:00.000Z', state: 'OPEN',
  listing: { listingId: 'listing-test', symbol: 'RVI', name: '리버인프라', slotId: 'D1', category: 'DIVIDEND', price: '985', generation: 1 },
  currentPrice: '985', referencePrice: '985', previousRawPrice: '1000', exAdjustment: true, financial: null,
  latestDisclosures: [{ id: 'disclosure', kind: 'CORPORATE_ACTION', publishedTick: 68, symbol: 'RVI', title: '분기배당 결의', summary: '주당 15.00 · 권리 확정 68틱 · 지급 70틱' }],
  lifecycle: 'OPERATING', generation: 1, businessSummary: '장기 계약 기반 인프라 운영',
};
function text(view: ReplyView): string { return JSON.stringify(view.embeds.map((item) => item.toJSON())); }
function budget(view: ReplyView) {
  assert.equal(view.embeds.length, 1); const data = view.embeds[0]!.toJSON();
  assert.ok((data.title?.length ?? 0) <= 40); assert.ok((data.description?.length ?? 0) <= 1200);
  assert.ok((data.fields?.length ?? 0) <= 6); assert.ok((data.fields ?? []).every((field) => field.value.length <= 1024));
  assert.ok(text(view).length <= 6000); assert.ok(view.components.length <= 1);
  for (const row of view.components) assert.ok(row.toJSON().components.length <= 4);
  assert.deepEqual(view.allowedMentions, { parse: [] });
}
function fake(input: { command?: string; button?: string; modal?: string; strings?: Record<string, string>; integers?: Record<string, number>; booleans?: Record<string, boolean>; fields?: Record<string, string>; guild?: string | null; user?: string } = {}) {
  const events: string[] = []; const replies: ReplyView[] = []; const shown: unknown[] = [];
  const interaction = {
    id: '100000000000000030', guildId: input.guild === undefined ? '100000000000000001' : input.guild,
    user: { id: input.user ?? '100000000000000002' }, memberPermissions: new PermissionsBitField(0n),
    commandName: input.command, customId: input.modal ?? input.button, createdTimestamp: 1,
    isChatInputCommand: () => Boolean(input.command), isButton: () => Boolean(input.button), isModalSubmit: () => Boolean(input.modal),
    options: { getString: (name: string) => input.strings?.[name] ?? null, getInteger: (name: string) => input.integers?.[name] ?? null, getBoolean: (name: string) => input.booleans?.[name] ?? null },
    fields: { getTextInputValue: (name: string) => input.fields?.[name] ?? '' },
    async deferReply(options: unknown) { events.push('defer'); assert.deepEqual(options, { flags: MessageFlags.Ephemeral }); },
    async editReply(view: ReplyView) { events.push('edit'); replies.push(view); },
    async showModal(modal: { toJSON(): unknown }) { events.push('modal'); shown.push(modal.toJSON()); },
  };
  return { interaction: interaction as unknown as Interaction, events, replies, shown };
}
function backend(response: ServiceResponse = { kind: 'STOCK', stock }) {
  const requests: ServiceRequest[] = [];
  return { requests, value: { async execute(request: ServiceRequest) { requests.push(request); return response; } } satisfies Backend };
}

test('milestone5 commands are guild-only and contain bounded options and canonical company name', () => {
  const commands = buildCommands().map((command) => command.toJSON());
  assert.equal(commands.length, 21); assert.equal(new Set(commands.map((command) => command.name)).size, commands.length);
  for (const name of ['company', 'news', 'calendar', 'chart', 'performance', 'export', 'alerts']) assert.ok(commands.some((command) => command.name === name));
  for (const command of commands) assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  assert.equal(commands.some((command) => command.name === 'stock'), false);
});

test('company detail separates adjusted-reference performance, raw ex change and ordinary change', () => {
  const view = renderStock(stock); budget(view); const content = text(view);
  assert.match(content, /985\.00.*보합 0\.00%/); assert.match(content, /기업행동 조정 기준가/);
  assert.match(content, /배당락 반영 -15\.00.*일반 시세 변화 0\.00/); assert.match(content, /원가격 변화 -15\.00/);
  assert.equal(view.embeds[0]!.toJSON().color, UI_COLORS.neutral);
  const buttons = view.components[0]!.toJSON().components;
  assert.equal(buttons.length, 4); for (const button of buttons) { assert.equal(button.type, ComponentType.Button); if (button.type === ComponentType.Button) assert.equal(button.style, ButtonStyle.Secondary); }
});

test('single company highlight reflects price direction and never buy/sell intent', () => {
  for (const [price, color, direction] of [['1000', UI_COLORS.up, '상승 +1.52%'], ['970', UI_COLORS.down, '하락 -1.52%']] as const) {
    const view = renderStock({ ...stock, currentPrice: price }); budget(view);
    assert.equal(view.embeds[0]!.toJSON().color, color); assert.ok(text(view).includes(direction));
  }
});

test('retired issuer keeps exact generation and disables both trade actions', () => {
  const view = renderStock({ ...stock, lifecycle: 'EXTINGUISHED', currentPrice: '0', referencePrice: '0', generation: 2 }); budget(view);
  assert.match(text(view), /2세대.*최종 소멸/);
  assert.match(text(view), /기준가 0.*변화율 산정 없음/); assert.doesNotMatch(text(view), /보합 0\.00%/);
  for (const button of view.components[0]!.toJSON().components.slice(0, 2)) if (button.type === ComponentType.Button) {
    assert.equal(button.disabled, true); assert.ok('custom_id' in button); assert.match(button.custom_id, /:RVI:2$/);
  }
});

test('trade buttons open modern Label modal without acknowledging a reply or submitting an order', async () => {
  const fakeButton = fake({ button: 'pm:trade:BUY:RVI:1' }); const service = backend();
  await createInteractionHandler(service.value, { operator, now: () => now })(fakeButton.interaction);
  assert.deepEqual(fakeButton.events, ['modal']); assert.equal(service.requests.length, 0);
  const modal = tradeModal('BUY', 'RVI', 1).toJSON(); assert.equal(modal.components.length, 4);
  assert.ok(modal.components.every((component) => component.type === ComponentType.Label));
});

test('modal submit is private, generation-bound, server-owned and only creates a quote', async () => {
  const submission = fake({ modal: 'pm:tradeform:SELL:RVI:1', fields: { quantity: '1.25', order_type: 'STOP', price: '900', duration: 'UC', owner: 'victim' } });
  const service = backend({ kind: 'ERROR', code: 'STALE_QUOTE' });
  await createInteractionHandler(service.value, { operator, now: () => now })(submission.interaction);
  assert.deepEqual(submission.events, ['defer', 'edit']); assert.equal(service.requests.length, 1);
  const request = service.requests[0]!; assert.equal(request.type, 'quote');
  if (request.type === 'quote') {
    assert.equal(request.generation, 1); assert.equal(request.orderType, 'STOP'); assert.equal(request.quantity, '1.25');
    assert.equal(request.timeInForce, 'UNTIL_CANCELLED'); assert.equal(request.validForTicks, undefined);
    assert.equal(request.context.discordUserId, '100000000000000002'); assert.equal(request.context.receivedAt, now.toISOString());
    assert.equal('owner' in request, false);
  }
  assert.match(text(submission.replies[0]!), /새 견적/); budget(submission.replies[0]!);
});

test('modal validates precision, side, duration, prices and generations before backend work', async () => {
  for (const input of [
    { modal: 'pm:tradeform:BUY:RVI:1', fields: { quantity: '1', order_type: 'STOP', price: '900' } },
    { modal: 'pm:tradeform:BUY:RVI:1', fields: { quantity: '1.0000001', order_type: 'MARKET' } },
    { modal: 'pm:tradeform:BUY:RVI:1', fields: { quantity: '1', order_type: 'LIMIT', price: '900', duration: '10001' } },
    { modal: 'pm:tradeform:BUY:RVI:1', fields: { quantity: '1', order_type: 'MARKET', price: '900' } },
    { modal: 'pm:tradeform:BUY:RVI:1000001', fields: { quantity: '1', order_type: 'MARKET' } },
    { modal: 'pm:companyform', fields: { symbol: 'RVI;DROP', generation: '1' } },
  ]) {
    const submission = fake(input); const service = backend(); await createInteractionHandler(service.value, { operator })(submission.interaction);
    assert.equal(service.requests.length, 0); budget(submission.replies[0]!); assert.match(text(submission.replies[0]!), /입력 형식/);
  }
});

test('public navigation opens a new private response for the clicking user and exact issuer generation', async () => {
  const button = fake({ button: 'pm:view:company:RVI:1', user: '100000000000000009' }); const service = backend();
  await createInteractionHandler(service.value, { operator })(button.interaction);
  assert.equal(service.requests[0]!.type, 'company'); const request = service.requests[0]!;
  if ('context' in request) assert.equal(request.context.discordUserId, '100000000000000009');
  assert.deepEqual(button.events, ['defer', 'edit']); budget(button.replies[0]!);
});

test('DM modal and button queries do not infer a guild or submit trades', async () => {
  const service = backend(); const handler = createInteractionHandler(service.value, { operator });
  for (const input of [{ button: 'pm:trade:BUY:RVI:1', guild: null }, { modal: 'pm:tradeform:BUY:RVI:1', guild: null }]) {
    const attempt = fake(input); await handler(attempt.interaction); assert.match(text(attempt.replies[0]!), /서버 안에서/);
    assert.deepEqual(attempt.events, ['defer', 'edit']);
  }
  assert.equal(service.requests.length, 0);
});

test('calendar and news contain only supplied public records, bounded summaries and persistent navigation', () => {
  const news = renderNews({ ...stock, items: stock.latestDisclosures, more: true, nextBeforeTick: 68 }, 'RVI'); budget(news);
  assert.match(text(news), /이미 공개된/); assert.ok(news.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === 'pm:news:68:RVI'));
  const calendar = renderCalendar({ ...stock, items: [{ kind: 'DIVIDEND_PAYMENT', title: '확정 분기 배당', symbol: 'RVI', generation: 1, eventTick: 70, announcedTick: 68 }] });
  budget(calendar); assert.match(text(calendar), /70틱.*배당 지급/); assert.doesNotMatch(text(calendar), /seed|snapshot|futureState/);
});

test('charts attach deterministic safe filenames and readable fallback when raster rendering fails', () => {
  const input = { ...stock, symbol: 'RVI', name: '리버인프라', series: 'PRICE' as const, scale: 'LINEAR' as const,
    points: [{ tickNo: 67, at: now.toISOString(), value: '1000' }, { tickNo: 68, at: now.toISOString(), value: '985' }], annotations: [{ tickNo: 68, label: '배당락' }] };
  const rendered = renderPriceChart(input); budget(rendered); assert.equal(rendered.files?.length, 1);
  assert.match(rendered.files![0]!.name ?? '', /^papermarket-[0-9a-f]{16}\.png$/);
  assert.match(rendered.embeds[0]!.toJSON().image?.url ?? '', /^attachment:\/\/papermarket-/);
  const fallback = renderPriceChart(input, () => { throw new Error('PRIVATE_PATH_TOKEN'); }); budget(fallback);
  assert.equal(fallback.files, undefined); assert.match(text(fallback), /1000|1,000/); assert.match(text(fallback), /画像|이미지 표시 안내/);
  assert.doesNotMatch(text(fallback), /PRIVATE_PATH_TOKEN/);
});

test('export attaches memory buffers privately and rejects unsafe filenames and oversized payloads', () => {
  const view = renderExport({ files: [{ name: 'papermarket-1234.csv', mimeType: 'text/csv', content: 'kind,amount\nFILL,-1\n' }], recordCount: 1, nextBeforeSequence: 12, truncated: false });
  budget(view); assert.equal(view.files?.length, 1); assert.ok(Buffer.isBuffer(view.files![0]!.attachment));
  assert.equal(view.files![0]!.attachment.toString(), 'kind,amount\nFILL,-1\n');
  for (const name of ['../secret.csv', 'raw-user-id/secret.json']) {
    const invalid = renderExport({ files: [{ name, mimeType: 'text/csv', content: 'secret' }], recordCount: 1, nextBeforeSequence: null, truncated: false });
    assert.equal(invalid.files, undefined); assert.doesNotMatch(text(invalid), /secret/);
  }
  for (const files of [
    [{ name: 'records.csv', mimeType: 'text/csv', content: '가'.repeat(666_667) }],
    [{ name: 'records.csv', mimeType: 'text/csv', content: 'a'.repeat(1_000_001) }, { name: 'summary.csv', mimeType: 'text/csv', content: 'b'.repeat(1_000_000) }],
    Array.from({ length: 11 }, (_, index) => ({ name: `records-${index}.csv`, mimeType: 'text/csv', content: 'ok' })),
    [{ name: 'records.csv', mimeType: 'text/html', content: '<script>SECRET</script>' }],
    [{ name: 'records.csv', mimeType: 'text/csv', content: 'first' }, { name: 'records.csv', mimeType: 'text/csv', content: 'second' }],
  ]) {
    const invalid = renderExport({ files, recordCount: 1, nextBeforeSequence: null, truncated: true });
    assert.equal(invalid.files, undefined); assert.doesNotMatch(text(invalid), /SECRET|first|second/); budget(invalid);
  }
  const ten = renderExport({ files: Array.from({ length: 10 }, (_, index) => ({ name: `records-${index}.json`, mimeType: 'application/json', content: '{}' })), recordCount: 10, nextBeforeSequence: null, truncated: false });
  assert.equal(ten.files?.length, 10); budget(ten);
});

test('history requests exactly the displayed page and retains the server cursor for every entry kind', async () => {
  const entries = ['FILL', 'DIVIDEND', 'INTEREST', 'CORRECTION'].map((kind, index) => ({
    eventId: `event-${index}`, kind: kind as 'FILL' | 'DIVIDEND' | 'INTEREST' | 'CORRECTION', tickNo: 68,
    sequenceNo: 20 - index, marketVersion: 69, createdAt: now.toISOString(), symbol: 'RVI', title: `${kind} 확정`, amount: '15',
  }));
  const service = backend({ kind: 'HISTORY', fills: [], entries, nextBeforeSequence: 17 });
  const handler = createInteractionHandler(service.value, { operator, now: () => now });
  for (const input of [{ command: 'history' }, { button: 'pm:view:history' }, { button: 'pm:history:17' }]) {
    const attempt = fake(input); await handler(attempt.interaction); budget(attempt.replies[0]!);
    assert.match(text(attempt.replies[0]!), /FILL.*DIVIDEND.*INTEREST.*CORRECTION/);
    assert.ok(attempt.replies[0]!.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === 'pm:history:17'));
  }
  for (const request of service.requests) { assert.equal(request.type, 'history'); if (request.type === 'history') assert.equal(request.limit, 4); }
  const previous = service.requests.at(-1)!; if (previous.type === 'history') assert.equal(previous.beforeSequence, 17);
});

test('history retains a unique event cursor when a financial boundary gives several entries one sequence', async () => {
  const eventId = 'a1234567-1234-4234-8234-123456789abc';
  const response: ServiceResponse = { kind: 'HISTORY', fills: [], entries: [{ eventId, kind: 'DIVIDEND', tickNo: 68, sequenceNo: 17,
    marketVersion: 69, createdAt: now.toISOString(), symbol: 'RVI', title: '배당 지급', amount: '15' }], nextBeforeSequence: 17, nextBeforeEventId: eventId };
  const view = renderServiceResponse(response); budget(view); const route = `pm:history:17:${eventId}`;
  assert.ok(route.length <= 92);
  assert.ok(view.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === route));
  const service = backend(response); const click = fake({ button: route }); await createInteractionHandler(service.value, { operator })(click.interaction);
  const request = service.requests[0]!; assert.equal(request.type, 'history');
  if (request.type === 'history') { assert.equal(request.beforeSequence, 17); assert.equal(request.beforeEventId, eventId); assert.equal(request.limit, 4); assert.equal(request.context.discordUserId, '100000000000000002'); }
  budget(click.replies[0]!);
  const malformed = renderServiceResponse({ ...response, nextBeforeEventId: '../private' }); budget(malformed); assert.equal(malformed.components.length, 0); assert.doesNotMatch(text(malformed), /private/);
});

test('CSV and JSON export pagination forwards exact page-border event identity within custom-ID budget', async () => {
  const eventId = 'a'.repeat(64); const sequence = Number.MAX_SAFE_INTEGER;
  for (const format of ['CSV', 'JSON'] as const) {
    const response: ServiceResponse = { kind: 'EXPORT', export: { files: [{ name: `records.${format.toLowerCase()}`, mimeType: format === 'CSV' ? 'text/csv' : 'application/json', content: format === 'CSV' ? 'amount\n15\n' : '{"amount":"15"}' }], recordCount: 4, nextBeforeSequence: sequence, nextBeforeEventId: eventId, truncated: false } };
    const view = renderExport(response.export, format); budget(view);
    const route = `pm:export:${format}:${sequence}:${eventId}`; assert.ok(route.length <= 100);
    assert.ok(view.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === route));
    const service = backend(response); const click = fake({ button: route }); await createInteractionHandler(service.value, { operator })(click.interaction);
    const request = service.requests[0]!; assert.equal(request.type, 'export');
    if (request.type === 'export') { assert.equal(request.format, format); assert.equal(request.beforeSequence, sequence); assert.equal(request.beforeEventId, eventId); assert.equal(request.context.discordUserId, '100000000000000002'); }
    budget(click.replies[0]!);
    const malformed = renderExport({ ...response.export, nextBeforeEventId: '../private' }, format); budget(malformed); assert.equal(malformed.files, undefined); assert.doesNotMatch(text(malformed), /private/);
  }
  const service = backend(); const invalid = fake({ button: `pm:export:CSV:LATEST:${eventId}` }); await createInteractionHandler(service.value, { operator })(invalid.interaction);
  assert.equal(service.requests.length, 0); budget(invalid.replies[0]!);
});

test('same-tick public news pagination uses an opaque cursor rather than skipping undisplayed events', async () => {
  const cursor = 'a'.repeat(64); const news = { ...stock, items: stock.latestDisclosures, more: true, nextBeforeTick: 68, nextCursor: cursor };
  const view = renderNews(news, 'RVI'); budget(view);
  const route = `pm:news:${cursor}:RVI`;
  assert.ok(route.length < 100); assert.ok(view.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === route));
  const service = backend({ kind: 'NEWS', news }); const attempt = fake({ button: route });
  await createInteractionHandler(service.value, { operator })(attempt.interaction);
  const request = service.requests[0]!; assert.equal(request.type, 'news');
  if (request.type === 'news') { assert.equal(request.cursor, cursor); assert.equal(request.symbol, 'RVI'); assert.equal(request.beforeTick, undefined); }
  budget(attempt.replies[0]!);
});

test('read action on an older inbox page retains that page and never routes another owner', async () => {
  const beforeId = 'a1234567-1234-4234-8234-123456789abc';
  const response: ServiceResponse = { kind: 'ALERTS', alerts: { settings: { dmEnabled: false, priceAlerts: [], watchlist: [] }, inbox: { items: [], unreadCount: 7, nextBeforeId: null }, dmEnabled: false } };
  const service = backend(response); const handler = createInteractionHandler(service.value, { operator });
  const page = fake({ button: `pm:alerts:BEFORE:${beforeId}` }); await handler(page.interaction);
  const view = page.replies[0]!; budget(view);
  assert.ok(view.components[0]!.toJSON().components.some((component) => component.type === ComponentType.Button && 'custom_id' in component && component.custom_id === `pm:alerts:READ:${beforeId}`));
  const read = fake({ button: `pm:alerts:READ:${beforeId}` }); await handler(read.interaction);
  const request = service.requests[1]!; assert.equal(request.type, 'alerts');
  if (request.type === 'alerts') { assert.equal(request.beforeId, beforeId); assert.equal(request.markRead, true); assert.equal(request.context.discordUserId, '100000000000000002'); }
  budget(read.replies[0]!);
});

test('chart options share server bounds and reject unsupported ranges before rendering', async () => {
  const command = buildCommands().map((item) => item.toJSON()).find((item) => item.name === 'chart')!;
  const ticks = command.options?.find((option) => option.name === 'ticks');
  assert.ok(ticks && 'min_value' in ticks && 'max_value' in ticks); assert.equal(ticks.min_value, 2); assert.equal(ticks.max_value, 2000);
  const service = backend({ kind: 'ERROR', code: 'INVALID_INPUT' }); const handler = createInteractionHandler(service.value, { operator });
  for (const value of [1, 2001]) { const attempt = fake({ command: 'chart', strings: { symbol: 'RVI' }, integers: { ticks: value } }); await handler(attempt.interaction); budget(attempt.replies[0]!); }
  assert.equal(service.requests.length, 0);
  const valid = fake({ command: 'chart', strings: { symbol: 'RVI' }, integers: { ticks: 2000 } }); await handler(valid.interaction);
  assert.equal(service.requests.length, 1); const request = service.requests[0]!; if (request.type === 'chart') assert.equal(request.limit, 2000);
});

test('alerts settings require explicit compatible options and never accept a DM recipient', async () => {
  const response: ServiceResponse = { kind: 'ALERTS', alerts: { settings: { dmEnabled: false, priceAlerts: [], watchlist: [] }, inbox: { items: [], unreadCount: 0, nextBeforeId: null }, dmEnabled: false } };
  const service = backend(response); const handler = createInteractionHandler(service.value, { operator });
  for (const input of [
    { command: 'alerts', strings: { action: 'PRICE', symbol: 'RVI', direction: 'BELOW', price: '900', recipient: 'victim' } },
    { command: 'alerts', strings: { action: 'DM' }, booleans: { dm: true } },
    { command: 'alerts', strings: { action: 'WATCH', symbol: 'RVI' } },
  ]) { const attempt = fake(input); await handler(attempt.interaction); budget(attempt.replies[0]!); }
  assert.equal(service.requests.length, 3); assert.equal('recipient' in service.requests[0]!, false);
  const invalid = fake({ command: 'alerts', strings: { action: 'DM', symbol: 'RVI' }, booleans: { dm: true } }); await handler(invalid.interaction);
  assert.equal(service.requests.length, 3); assert.match(text(invalid.replies[0]!), /입력 형식/);
  if (response.kind === 'ALERTS') budget(renderAlerts(response.alerts));
});

test('operational errors remain neutral and internal notification responses never expose delivery identity', () => {
  for (const code of ['MARKET_PAUSED', 'INTEGRITY_ERROR', 'PERMISSION_DENIED']) assert.equal(errorEmbed(code).toJSON().color, UI_COLORS.neutral);
  assert.equal(errorEmbed('MARKET_PAUSED').toJSON().title, '운영 중단');
  const view = renderServiceResponse({ kind: 'NOTIFICATION_BATCH', deliveries: [] }); budget(view); assert.match(text(view), /입력 형식/);
});

test('visual fixture payloads preserve project budgets, paused versions and legacy performance limitations', () => {
  const fixtures = visualQaFixtures();
  for (const view of Object.values(fixtures)) budget(view);
  assert.match(text(fixtures['financial-paused']!), /거래 중단.*68틱.*버전 69/);
  assert.match(text(fixtures['financial-paused']!), /최근 확정.*다음 틱/);
  assert.match(text(fixtures.performance!), /최초 틱 부분 보유시간.*이자를 제외/);
  assert.match(text(fixtures.performance!), /낙폭은 저장된 확정 표본 범위/);
  assert.match(text(fixtures.performance!), /배당 기여\(지급\+권리 평가\)/);
  assert.match(text(fixtures.performance!), /현금이자\(지급\+발생\)/);
  assert.match(text(fixtures.performance!), /기타 권리 기여/);
  assert.match(text(fixtures.performance!), /수수료는 취득원가·실현손익에 포함/);
  assert.match(text(fixtures.market!), /PM8 시장 총수익.*지수/);
  assert.equal(fixtures.market!.embeds[0]!.toJSON().color, UI_COLORS.neutral);
  assert.equal(fixtures.performance!.embeds[0]!.toJSON().color, UI_COLORS.neutral);
});
