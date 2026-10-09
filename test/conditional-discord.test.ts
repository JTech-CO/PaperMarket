import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ButtonStyle, MessageFlags, PermissionsBitField, type Interaction } from 'discord.js';
import type { Backend, QuoteView, ScheduledOrderView, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { buildCommands } from '../src/discord/commands.js';
import { createInteractionHandler } from '../src/discord/handler.js';
import { renderOrders, renderServiceResponse, type ReplyView } from '../src/discord/render.js';
import { UI_COLORS } from '../src/discord/messages.js';

const operator = { operatorName: 'PaperMarket Test', supportContact: 'support@example.com' };
const guildId = '111111111111111111';
const userId = '222222222222222222';
const interactionId = '333333333333333333';
const fixedNow = new Date('2026-10-04T00:00:00.000Z');
const orderId = '0ac92543-57d6-4cc7-9103-1a332b290000';
const token = 'x'.repeat(43);
const order: ScheduledOrderView = { orderId, symbol: 'HGI', side: 'BUY', orderType: 'LIMIT', quantity: '1', conditionPrice: '990',
  timeInForce: 'TICK_COUNT', expiresTick: 121, status: 'OPEN', reservedCash: '990.99', reservedQuantity: '0', sequenceNo: 7, createdTick: 100 };
const quote: QuoteView = { token, orderIntentId: 'intent_example', symbol: 'HGI', side: 'BUY', quantity: '1', price: '1000',
  gross: '990', fee: '0.99', total: '990.99', cashAfter: '9009.01', marketVersion: 101,
  expiresAt: '2026-10-04T00:00:30.000Z', orderType: 'LIMIT', conditionPrice: '990', timeInForce: 'TICK_COUNT', expiresTick: 121,
  reservedCash: '990.99', reservedQuantity: '0' };

function interaction(input: { command?: string; button?: string; strings?: Record<string, string>; booleans?: Record<string, boolean>;
  integers?: Record<string, number>; ackFails?: boolean; editFails?: boolean; guild?: string | null } = {}) {
  const events: string[] = []; const replies: ReplyView[] = []; const acknowledgements: unknown[] = [];
  const fake = { id: interactionId, guildId: input.guild === undefined ? guildId : input.guild, user: { id: userId },
    memberPermissions: new PermissionsBitField(0n), commandName: input.command ?? 'buy', customId: input.button,
    createdTimestamp: 1, token: 'private_discord_token',
    options: { getString: (name: string) => input.strings?.[name] ?? null,
      getBoolean: (name: string) => input.booleans?.[name] ?? null, getInteger: (name: string) => input.integers?.[name] ?? null },
    isChatInputCommand: () => input.button === undefined, isButton: () => input.button !== undefined,
    async deferReply(payload: unknown) { events.push('defer'); acknowledgements.push(payload); if (input.ackFails) throw new Error('private_ack_error'); },
    async editReply(payload: ReplyView) { events.push('edit'); if (input.editFails) throw new Error('private_edit_error'); replies.push(payload); },
  };
  return { value: fake as unknown as Interaction, events, replies, acknowledgements };
}

function backend(response: ServiceResponse) {
  const requests: ServiceRequest[] = [];
  return { requests, value: { async execute(request: ServiceRequest) { requests.push(request); return response; } } satisfies Backend };
}

function prose(view: ReplyView): string {
  return view.embeds.map((embed) => {
    const data = embed.toJSON();
    return [data.title, data.description, ...(data.fields ?? []).flatMap((field) => [field.name, field.value]), data.footer?.text].join('\n');
  }).join('\n');
}

function assertBudget(view: ReplyView) {
  assert.equal(view.embeds.length, 1);
  const data = view.embeds[0]!.toJSON();
  assert.ok((data.title?.length ?? 0) <= 40); assert.ok((data.description?.length ?? 0) <= 1_200);
  assert.ok((data.fields?.length ?? 0) <= 6); for (const field of data.fields ?? []) assert.ok(field.value.length <= 1_024);
  assert.ok(prose(view).length <= 6_000); assert.ok(view.components.length <= 1);
  for (const row of view.components) assert.ok(row.toJSON().components.length <= 4);
  assert.deepEqual(view.allowedMentions, { parse: [] }); assert.equal(data.color, UI_COLORS.neutral);
}

test('commands expose market/limit buy, market/limit/stop sell, bounded ticks and private orders entry point', () => {
  const commands = buildCommands().map((command) => command.toJSON());
  assert.equal(commands.length, 21); assert.ok(commands.some((command) => command.name === 'orders'));
  const buy = commands.find((command) => command.name === 'buy')!;
  const sell = commands.find((command) => command.name === 'sell')!;
  const option = (command: typeof buy, name: string) => command.options?.find((item) => item.name === name);
  const buyType = option(buy, 'order_type'); const sellType = option(sell, 'order_type');
  assert.ok(buyType && 'choices' in buyType); assert.ok(sellType && 'choices' in sellType);
  assert.deepEqual(buyType.choices?.map((choice) => choice.value), ['MARKET', 'LIMIT']);
  assert.deepEqual(sellType.choices?.map((choice) => choice.value), ['MARKET', 'LIMIT', 'STOP']);
  const ticks = option(buy, 'ticks'); assert.ok(ticks && 'min_value' in ticks && 'max_value' in ticks);
  assert.equal(ticks.min_value, 1); assert.equal(ticks.max_value, 10_000);
});

test('conditional quote defers privately before forwarding server-bound identity and default 21 tick duration', async () => {
  const fake = interaction({ strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '990',
    accountId: 'victim_account', discordUserId: 'victim_user', receivedAt: '1900', reservedCash: '0' } });
  const requests: ServiceRequest[] = [];
  const service: Backend = { async execute(request) { fake.events.push('backend'); requests.push(request); return { kind: 'QUOTE', quote }; } };
  await createInteractionHandler(service, { operator, now: () => fixedNow })(fake.value);
  assert.deepEqual(fake.events, ['defer', 'backend', 'edit']); assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
  assert.ok(requests[0]?.type === 'quote'); const request = requests[0];
  assert.equal(request.orderType, 'LIMIT'); assert.equal(request.conditionPrice, '990'); assert.equal(request.validForTicks, 21);
  assert.equal(request.timeInForce, 'TICK_COUNT');
  assert.deepEqual(request.context, { guildId, discordUserId: userId, interactionId, receivedAt: fixedNow.toISOString(), guildPermissions: '0' });
  assert.equal('accountId' in request, false); assert.equal('reservedCash' in request, false); assertBudget(fake.replies[0]!);
});

test('market default keeps quantity/budget and available all-share behavior while omitting conditional fields', async () => {
  const service = backend({ kind: 'QUOTE', quote }); const handler = createInteractionHandler(service.value, { operator });
  for (const fake of [interaction({ strings: { symbol: 'HGI', quantity: '1' } }), interaction({ strings: { symbol: 'HGI', budget: '1000' } }),
    interaction({ command: 'sell', strings: { symbol: 'HGI' }, booleans: { all: true } })]) await handler(fake.value);
  assert.equal(service.requests.length, 3);
  for (const request of service.requests) { assert.ok(request.type === 'quote'); assert.equal(request.orderType, 'MARKET');
    assert.equal(request.conditionPrice, undefined); assert.equal(request.validForTicks, undefined); }
});

test('limit sell and stop sell support explicit duration or until-cancelled without client financial totals', async () => {
  const service = backend({ kind: 'QUOTE', quote }); const handler = createInteractionHandler(service.value, { operator });
  await handler(interaction({ command: 'sell', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '1200' }, integers: { ticks: 7 } }).value);
  await handler(interaction({ command: 'sell', strings: { symbol: 'HGI', quantity: '1', order_type: 'STOP', price: '950', time_in_force: 'UNTIL_CANCELLED' } }).value);
  assert.ok(service.requests[0]?.type === 'quote' && service.requests[0].validForTicks === 7 && service.requests[0].side === 'SELL');
  assert.ok(service.requests[1]?.type === 'quote' && service.requests[1].orderType === 'STOP' && service.requests[1].timeInForce === 'UNTIL_CANCELLED');
  assert.equal(service.requests[1].validForTicks, undefined); assert.equal('gross' in service.requests[1], false);
});

test('invalid or nonpositive limit prices are refused after defer and before any backend work', async () => {
  for (const price of ['0', '-1', 'NaN', 'Infinity', '@everyone', '1e1001', '9'.repeat(97)]) {
    const fake = interaction({ strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price } });
    const service = backend({ kind: 'QUOTE', quote }); await createInteractionHandler(service.value, { operator })(fake.value);
    assert.equal(service.requests.length, 0); assert.deepEqual(fake.events, ['defer', 'edit']); assert.match(prose(fake.replies[0]!), /조건가격/);
    assert.doesNotMatch(prose(fake.replies[0]!), /@everyone|Infinity|NaN/);
  }
});

test('unsupported conditional combinations, durations and over-precision quantities never reach backend', async () => {
  const cases = [
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'STOP', price: '950' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT' } },
    { command: 'buy', strings: { symbol: 'HGI', order_type: 'LIMIT', price: '950', budget: '1000' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '950', budget: '1000' } },
    { command: 'sell', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '950' }, booleans: { all: false } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '0.0000001', order_type: 'LIMIT', price: '950' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', price: '950' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'OCO', price: '950' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '950', time_in_force: 'UNKNOWN' } },
    { command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '950', time_in_force: 'UNTIL_CANCELLED' }, integers: { ticks: 21 } },
    ...[0, 10_001, 1.5].map((ticks) => ({ command: 'buy', strings: { symbol: 'HGI', quantity: '1', order_type: 'LIMIT', price: '950' }, integers: { ticks } })),
  ];
  for (const input of cases) { const fake = interaction(input); const service = backend({ kind: 'QUOTE', quote });
    await createInteractionHandler(service.value, { operator })(fake.value); assert.equal(service.requests.length, 0); assertBudget(fake.replies[0]!); }
});

test('orders and UUID cancellation routes defer privately and bind every operation to the authenticated owner', async () => {
  const service = backend({ kind: 'ORDERS', orders: [order] }); const handler = createInteractionHandler(service.value, { operator, now: () => fixedNow });
  const list = interaction({ command: 'orders', strings: { userId: 'victim' } });
  const cancel = interaction({ button: `pm:ordercancel:${orderId}`, strings: { accountId: 'victim' } });
  await handler(list.value); await handler(cancel.value);
  assert.deepEqual(service.requests.map((request) => request.type), ['orders', 'cancel-order']);
  assert.ok(service.requests[1]?.type === 'cancel-order'); assert.equal(service.requests[1].orderId, orderId);
  for (const request of service.requests) { assert.ok('context' in request); assert.equal(request.context.discordUserId, userId); }
  for (const fake of [list, cancel]) { assert.equal(fake.events[0], 'defer'); assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]); }
});

test('malformed order IDs, failed acknowledgement and DM routes cannot mutate scheduled orders', async () => {
  const service = backend({ kind: 'SCHEDULED_CANCELLED', order: { ...order, status: 'CANCELLED' } });
  const handler = createInteractionHandler(service.value, { operator });
  const malformed = interaction({ button: 'pm:ordercancel:victim/private/id' });
  const failed = interaction({ button: `pm:ordercancel:${orderId}`, ackFails: true });
  const dm = interaction({ button: `pm:ordercancel:${orderId}`, guild: null });
  await handler(malformed.value); await handler(failed.value); await handler(dm.value);
  assert.equal(service.requests.length, 0); assert.equal(failed.replies.length, 0); assert.match(prose(dm.replies[0]!), /서버 안에서/);
});

test('owner rejection is generic, contains no raw identities or exception text and offers safe next action', async () => {
  const service = backend({ kind: 'ERROR', code: 'INTENT_NOT_FOUND' });
  const fake = interaction({ button: `pm:ordercancel:${orderId}` });
  await createInteractionHandler(service.value, { operator })(fake.value);
  assert.match(prose(fake.replies[0]!), /권한이 없거나/); assert.doesNotMatch(prose(fake.replies[0]!), /222222|333333|private_discord_token|accountId|actor_hash/);
  assert.equal(fake.replies[0]?.components.length, 0);
});

test('limit confirmation distinguishes reference prices, worst reservation, validity and no draft reservation', () => {
  const view = renderServiceResponse({ kind: 'QUOTE', quote }); assertBudget(view); const text = prose(view);
  assert.match(text, /지정가 매수/); assert.match(text, /현재가 ≤ 990\.00/); assert.match(text, /현재 확정 시세 1,000\.00 \(참고\)/);
  assert.match(text, /조건가격 기준 예상/); assert.match(text, /최대 예약 현금 990\.99/); assert.match(text, /견적은 자산을 예약하지/);
  assert.match(text, /전체 시장 121틱/); assert.match(text, /최대 30초/); assert.match(text, /이미 조건을 충족하면 현재 시세로 체결/);
  assert.match(text, /만료 → 기업행동 취소 → 새 시세 → 조건 평가/); assert.match(text, /배당락·교환·소멸/);
  assert.equal(text.includes(token), false); const buttons = view.components[0]!.toJSON().components;
  assert.equal(buttons.length, 2); assert.equal(buttons[0]?.style, ButtonStyle.Primary); assert.equal(buttons[1]?.style, ButtonStyle.Secondary);
});

test('stop confirmation warns about gap execution and retained dividend rights without guaranteeing losses', () => {
  const view = renderServiceResponse({ kind: 'QUOTE', quote: { ...quote, side: 'SELL', orderType: 'STOP', conditionPrice: '950',
    timeInForce: 'UNTIL_CANCELLED', expiresTick: null, reservedCash: '0', reservedQuantity: '1' } });
  assertBudget(view); const text = prose(view); assert.match(text, /스톱 매도/); assert.match(text, /현재가 ≤ 950\.00/);
  assert.match(text, /갭 하락 가격에 체결/); assert.match(text, /손실액을 보장하지/); assert.match(text, /취소할 때까지/);
  assert.match(text, /예약 수량 1주/);
  assert.match(text, /예약 주식은 배당 권리를 유지/);
});

test('incomplete conditional quote cannot produce a confirmation button', () => {
  const incomplete: QuoteView = { token, orderIntentId: 'intent', symbol: 'HGI', side: 'BUY', orderType: 'LIMIT', quantity: '1', price: '1000',
    gross: '1000', fee: '1', total: '1001', cashAfter: '8999', marketVersion: 1, expiresAt: fixedNow.toISOString() };
  const view = renderServiceResponse({ kind: 'QUOTE', quote: incomplete }); assert.equal(view.components.length, 0); assertBudget(view);
});

test('orders render only four open-first details and same-row neutral cancellation controls within budgets', () => {
  const orders = Array.from({ length: 25 }, (_, index): ScheduledOrderView => ({ ...order,
    orderId: `0ac92543-57d6-4cc7-9103-${index.toString().padStart(12, '0')}`, status: index < 4 ? 'CANCELLED' : 'OPEN' }));
  const view = renderOrders(orders); assertBudget(view); assert.equal(view.embeds[0]?.toJSON().fields?.length, 4);
  const buttons = view.components[0]!.toJSON().components; assert.equal(buttons.length, 4);
  for (const button of buttons) { assert.equal(button.style, ButtonStyle.Secondary); assert.ok('custom_id' in button && button.custom_id.startsWith('pm:ordercancel:')); }
  assert.match(prose(view), /미체결 21건/); assert.match(prose(view), /예약 주식도 배당 권리를 유지/);
  assert.match(prose(view), /배당락·교환·소멸/); assert.doesNotMatch(prose(view), /미체결.*사용자 취소/);
});

test('opened and cancelled orders explain reservations while no identities or hidden termination text cross the output boundary', () => {
  const opened = renderServiceResponse({ kind: 'ORDER_OPENED', order }); assertBudget(opened);
  assert.match(prose(opened), /현재 조건을 충족하지 않아 미체결/);
  assert.match(prose(opened), /\/orders에서 취소/); assert.equal(opened.components[0]?.toJSON().components.length, 1);
  const cancelled = renderServiceResponse({ kind: 'SCHEDULED_CANCELLED', order: { ...order, status: 'CANCELLED', reservedCash: '0',
    terminationReason: 'SQL_SECRET actor_hash victim@example.com' } }); assertBudget(cancelled);
  assert.match(prose(cancelled), /예약 자산을 해제/); assert.doesNotMatch(prose(cancelled), /SQL_SECRET|actor_hash|victim@example/);
  assert.equal(cancelled.components.length, 0);
});

test('mentions and Markdown in rendered symbols cannot ping users and opaque routing remains separate from prose', () => {
  const view = renderOrders([{ ...order, symbol: '@everyone **' }]); assertBudget(view);
  assert.doesNotMatch(prose(view), /@everyone/); assert.match(prose(view), /\\\*/); assert.equal(prose(view).includes('pm:ordercancel:'), false);
});

test('cancellation recovery renders an already-filled or expired order without claiming a new cancellation', () => {
  const filled = renderServiceResponse({ kind: 'SCHEDULED_CANCELLED', order: { ...order, status: 'FILLED', reservedCash: '0', terminationReason: 'FILLED' } });
  assertBudget(filled); assert.match(prose(filled), /이미 체결한 주문/); assert.match(prose(filled), /\/history/);
  assert.doesNotMatch(prose(filled), /총 현금·주식은 바뀌지|예약 자산을 해제/); assert.equal(filled.components.length, 0);
  const expired = renderServiceResponse({ kind: 'SCHEDULED_CANCELLED', order: { ...order, status: 'EXPIRED', reservedCash: '0', terminationReason: 'EXPIRED' } });
  assertBudget(expired); assert.match(prose(expired), /주문 상태 만료 · 기간 만료/); assert.match(prose(expired), /다시 처리하지/);
});

test('eight positions, reservations and many rights remain fully bounded without double-counting reserved cash', () => {
  const view = renderServiceResponse({ kind: 'PORTFOLIO', portfolio: {
    account: { accountId: 'private_account', status: 'ACTIVE', accountVersion: 3, createdAt: fixedNow.toISOString(), cash: '10000' },
    marketVersion: 101, equity: '11000', totalReturnPct: '10', availableCash: '9009.01', reservedCash: '990.99',
    positions: Array.from({ length: 8 }, (_, index) => ({ listingId: `private_listing_${index}`, symbol: `PM${index}`, name: '가상 기업',
      quantity: '0.123456', availableQuantity: '0.023456', reservedQuantity: '0.1', price: '1000', value: '123.456', cost: '120', unrealizedPnl: '3.456' })),
    rights: Array.from({ length: 9 }, (_, index) => ({ rightId: `private_right_${index}`, kind: 'DIVIDEND' as const, symbol: 'HGI',
      status: 'OPEN' as const, quantity: '1', nominal: '10', currentValue: '10', paid: '0', cost: '0', realizedPnl: '0', eligibleTick: 98, paymentTick: 102 })),
  } }); assertBudget(view); const text = prose(view);
  assert.match(text, /현금 10,000\.00/); assert.match(text, /가용 현금 9,009\.01 · 예약 현금 990\.99/);
  assert.match(text, /예약 현금은 총 현금에 포함/); assert.match(text, /가용 0\.023456주 · 예약 0\.1주/);
  for (let index = 0; index < 8; index++) assert.ok(text.includes(`PM${index}`));
  assert.doesNotMatch(text, /private_account|private_listing|private_right/);
});

test('post-commit scheduled cancellation reply failure never reruns backend and logs only a constant diagnostic', async () => {
  const service = backend({ kind: 'SCHEDULED_CANCELLED', order: { ...order, status: 'CANCELLED' } }); const diagnostics: string[] = [];
  await createInteractionHandler(service.value, { operator, onDiagnostic: (code) => diagnostics.push(code) })(interaction({ button: `pm:ordercancel:${orderId}`, editFails: true }).value);
  assert.equal(service.requests.length, 1); assert.deepEqual(diagnostics, ['REPLY_FAILED']);
});
