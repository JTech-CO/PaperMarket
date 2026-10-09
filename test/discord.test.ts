import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { ChannelType, InteractionContextType, MessageFlags, PermissionFlagsBits, PermissionsBitField,
  ButtonStyle, type Interaction, type TextChannel } from 'discord.js';
import type { Backend, EconomyView, MarketView, QuoteView, ServiceRequest, ServiceResponse } from '../src/application/contracts.js';
import { BrokerRepository } from '../src/broker/index.js';
import { buildCommands, createInteractionHandler } from '../src/discord/index.js';
import { UI_COLORS, displayDirection, displayNumber, errorEmbed } from '../src/discord/messages.js';
import { renderFinancial, renderMarket, renderNotice, renderServiceResponse, type ReplyView } from '../src/discord/render.js';
import { renderPrivacyNotice } from '../src/policy/index.js';
import { openDatabase } from '../src/storage/database.js';

const guildId = '100000000000000001';
const userId = '100000000000000002';
const channelId = '100000000000000003';
const messageId = '100000000000000004';
const botId = '100000000000000005';
const fixedNow = new Date('2026-10-03T12:00:00.000Z');
const operator = { operatorName: 'PaperMarket Test', supportContact: 'support@example.com' };
const token = 'opaque_server_nonce_123456';
const market: MarketView = {
  marketId: 'market_test', state: 'OPEN', tickNo: 0, marketVersion: 1, sequenceNo: 99,
  nextBoundaryAt: '2026-10-03T12:05:00.000Z', updatedAt: fixedNow.toISOString(), priceSource: 'TRIAL',
  channelId, boardMessageId: null,
  listings: [{ listingId: 'listing_hgi', symbol: 'HGI', name: '한결산업', slotId: 'O1', category: 'ORDINARY', price: '1000' }],
};
const quote: QuoteView = {
  token, orderIntentId: 'intent_test', symbol: 'HGI', side: 'BUY', quantity: '0.123456', price: '1000',
  gross: '123.456', fee: '0.123456', total: '123.579456', cashAfter: '9876.420544', marketVersion: 1,
  expiresAt: '2026-10-03T12:00:30.000Z',
};
const publicEconomy: EconomyView = {
  engineVersion: '0.2.0', economyTick: 64,
  macro: { policyRate: '0.0325', cashAnnualRate: '0.0275', cashDailyRate: '0.000107658627', inflation: '0.023', outputGap: '0.01',
    industrialDemand: '104', consumerDemand: '101', metals: '105', energy: '97', fx: '103', creditStress: '0.2', riskAppetite: '-0.1',
    observedTick: 63, nextMeetingTick: 84, policyProbabilities: { decrease: '0.2', unchanged: '0.5', increase: '0.3' } },
  companies: [{ symbol: 'HGI', name: '한결산업', reportKind: 'ACTUAL', quarterNo: 1, closedTick: 63, publishedTick: 64, nextEarningsTick: 127,
    revenue: '450000000', operatingProfit: '54000000', interestExpense: '3750000', netProfit: '40200000', cash: '200000000', debt: '300000000',
    operatingCashFlow: '30000000', capex: '5000000', annualRevenueForecast: '1800000000', operatingMarginForecast: '0.12', growthForecast: '0.04' }],
  disclosures: [{ id: 'earnings-hgi-1', kind: 'EARNINGS', publishedTick: 64, symbol: 'HGI', title: 'HGI 분기 실적', summary: '매출 실제 4.5억 · 예상 4.4억 · 이전 4.3억' }],
};

interface FakeOptions {
  command?: string; button?: string; strings?: Record<string, string>; booleans?: Record<string, boolean>;
  guild?: string | null; permissions?: bigint; channel?: ReturnType<typeof fakeChannel>; ackFail?: boolean; editFail?: boolean;
  previousChannel?: ReturnType<typeof fakeChannel>;
  interactionId?: string;
}

function fakeInteraction(input: FakeOptions = {}) {
  const events: string[] = [];
  const replies: ReplyView[] = [];
  const acknowledgements: unknown[] = [];
  const fake = {
    id: input.interactionId ?? '100000000000000006', guildId: input.guild === undefined ? guildId : input.guild,
    user: { id: userId, username: 'private_name' }, memberPermissions: new PermissionsBitField(input.permissions ?? 0n),
    commandName: input.command ?? 'market', customId: input.button,
    // Forged input metadata must never replace the authenticated Gateway owner and server receipt time.
    createdTimestamp: 1, token: 'discord_interaction_secret',
    guild: { channels: {
      resolve: (id: string) => input.channel?.id === id ? input.channel : null,
      async fetch(id: string) { return input.previousChannel?.id === id ? input.previousChannel : input.channel?.id === id ? input.channel : null; },
    }, members: { me: { id: botId } } },
    options: {
      getString(name: string, required = false): string | null {
        const value = input.strings?.[name];
        if (required && value === undefined) throw new Error('required');
        return value ?? null;
      },
      getBoolean(name: string, required = false): boolean | null {
        const value = input.booleans?.[name];
        if (required && value === undefined) throw new Error('required');
        return value ?? null;
      },
      getInteger: () => null,
      getChannel: () => ({ id: input.channel?.id ?? channelId }),
    },
    isChatInputCommand: () => input.button === undefined,
    isButton: () => input.button !== undefined,
    async deferReply(payload: unknown) {
      events.push('defer'); acknowledgements.push(payload);
      if (input.ackFail) throw new Error('ACK_PRIVATE_TOKEN');
    },
    async editReply(payload: ReplyView) {
      events.push('edit');
      if (input.editFail) throw new Error('EDIT_PRIVATE_TOKEN');
      replies.push(payload);
    },
  };
  return { interaction: fake as unknown as Interaction, events, replies, acknowledgements };
}

function fakeBackend(response: ServiceResponse = { kind: 'MARKET', market }) {
  const requests: ServiceRequest[] = [];
  const backend: Backend = { async execute(request) { requests.push(request); return response; } };
  return { backend, requests };
}

function fakeChannel(input: { id?: string; guildId?: string; type?: ChannelType; permissions?: boolean;
  missingPermission?: bigint; existing?: boolean; fetchError?: unknown; author?: string; editFails?: boolean; onEdit?: () => void } = {}) {
  const sent: ReplyView[] = []; const edited: ReplyView[] = []; let deleted = 0;
  const events: string[] = [];
  const message = { id: messageId, author: { id: input.author ?? botId },
    async edit(payload: ReplyView) { events.push('board-edit'); input.onEdit?.(); if (input.editFails) throw new Error('PRIVATE_PERMISSION_ERROR'); edited.push(payload); },
    async delete() { events.push('board-delete'); deleted += 1; } };
  return { id: input.id ?? channelId, guildId: input.guildId ?? guildId, type: input.type ?? ChannelType.GuildText, client: { user: { id: botId } },
    permissionsFor: () => ({ has: (permissions: bigint | readonly bigint[]) => input.permissions !== false
      && !(input.missingPermission !== undefined && (typeof permissions === 'bigint' ? permissions === input.missingPermission : permissions.includes(input.missingPermission))) }),
    messages: { async fetch() { events.push('board-fetch'); if (input.fetchError) throw input.fetchError;
      if (!input.existing) throw { code: 10008 }; return message; } },
    async send(payload: ReplyView) { events.push('board-send'); sent.push(payload); return message; },
    sent, edited, events, get deleted() { return deleted; },
  };
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
  assert.ok((data.title?.length ?? 0) <= 40);
  assert.ok((data.description?.length ?? 0) <= 1_200);
  assert.ok((data.fields?.length ?? 0) <= 6);
  for (const field of data.fields ?? []) assert.ok(field.value.length <= 1_024);
  assert.ok(prose(view).length <= 6_000);
  assert.ok(view.components.length <= 1);
  assert.deepEqual(view.allowedMentions, { parse: [] });
}

test('guild commands require explicit acknowledgements and minimal setup permission', () => {
  const commands = buildCommands().map((command) => command.toJSON());
  assert.deepEqual(commands.map((command) => command.name), ['setup', 'open', 'market', 'company', 'news', 'calendar', 'chart', 'performance', 'export', 'alerts', 'economy', 'financial', 'buy', 'sell', 'orders', 'portfolio', 'funding', 'history', 'status', 'help', 'privacy', 'close']);
  for (const command of commands) assert.deepEqual(command.contexts, [InteractionContextType.Guild]);
  const setup = commands.find((command) => command.name === 'setup')!;
  assert.equal(setup.default_member_permissions, PermissionFlagsBits.ManageGuild.toString());
  assert.equal(BigInt(setup.default_member_permissions!), PermissionFlagsBits.ManageGuild);
  const open = commands.find((command) => command.name === 'open')!;
  assert.deepEqual(open.options?.map((option) => [option.name, option.required]), [['age_14_plus', true], ['agree_terms', true]]);
  assert.ok(commands.find((command) => command.name === 'close')?.options?.every((option) => option.required));
});

test('ephemeral acknowledgement completes before backend execution', async () => {
  const fake = fakeInteraction();
  const backend: Backend = { async execute() { fake.events.push('backend'); return { kind: 'MARKET', market }; } };
  await createInteractionHandler(backend, { operator, now: () => fixedNow })(fake.interaction);
  assert.deepEqual(fake.events, ['defer', 'backend', 'edit']);
  assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
  assertBudget(fake.replies[0]!);
});

test('failed initial acknowledgement never performs financial work', async () => {
  const fake = fakeInteraction({ command: 'buy', strings: { symbol: 'HGI', quantity: '1' }, ackFail: true });
  const { backend, requests } = fakeBackend(); const diagnostics: string[] = [];
  await createInteractionHandler(backend, { operator, onDiagnostic: (code) => diagnostics.push(code) })(fake.interaction);
  assert.equal(requests.length, 0); assert.deepEqual(fake.events, ['defer']); assert.deepEqual(diagnostics, ['ACK_FAILED']);
});

test('DM commands are private refusals and never guess a server market', async () => {
  const fake = fakeInteraction({ guild: null }); const { backend, requests } = fakeBackend();
  await createInteractionHandler(backend, { operator })(fake.interaction);
  assert.equal(requests.length, 0); assert.match(prose(fake.replies[0]!), /서버 안에서/);
  assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
});

test('authenticated identity, permissions and receipt time cannot be overridden by options', async () => {
  const fake = fakeInteraction({ command: 'buy', permissions: PermissionFlagsBits.ViewChannel,
    strings: { symbol: 'HGI', quantity: '1', discordUserId: 'attacker', accountId: 'victim', receivedAt: '1900', guildPermissions: '8' } });
  const { backend, requests } = fakeBackend({ kind: 'QUOTE', quote });
  await createInteractionHandler(backend, { operator, now: () => fixedNow })(fake.interaction);
  const request = requests[0]!;
  assert.equal(request.type, 'quote');
  assert.ok('context' in request);
  assert.deepEqual(request.context, { guildId, discordUserId: userId, interactionId: '100000000000000006',
    receivedAt: fixedNow.toISOString(), guildPermissions: PermissionFlagsBits.ViewChannel.toString() });
  assert.equal('accountId' in request, false); assert.equal('receivedAt' in request, false);
});

test('buy exactly-one input validation rejects missing/both/excess length before backend', async () => {
  for (const strings of [{ symbol: 'HGI' }, { symbol: 'HGI', quantity: '1', budget: '1000' }, { symbol: 'HGI', quantity: '1'.repeat(97) }]) {
    const fake = fakeInteraction({ command: 'buy', strings }); const { backend, requests } = fakeBackend();
    await createInteractionHandler(backend, { operator })(fake.interaction);
    assert.equal(requests.length, 0); assert.match(prose(fake.replies[0]!), /하나/);
  }
});

test('budget buy and all-share sell forward bounded strings and boolean flags', async () => {
  const buy = fakeInteraction({ command: 'buy', strings: { symbol: 'HGI', budget: '100' } });
  const sell = fakeInteraction({ command: 'sell', strings: { symbol: 'HGI' }, booleans: { all: true } });
  const { backend, requests } = fakeBackend({ kind: 'QUOTE', quote });
  const handler = createInteractionHandler(backend, { operator });
  await handler(buy.interaction); await handler(sell.interaction);
  assert.ok(requests[0]?.type === 'quote' && requests[0].budget === '100' && requests[0].quantity === undefined);
  assert.ok(requests[1]?.type === 'quote' && requests[1].all === true && requests[1].side === 'SELL');
});

test('static persistent button routes bind tokens to authenticated owner on every click', async () => {
  const { backend, requests } = fakeBackend({ kind: 'CANCELLED', orderIntentId: 'intent_test' });
  const handler = createInteractionHandler(backend, { operator });
  for (const action of ['confirm', 'cancel']) await handler(fakeInteraction({ button: `pm:${action}:${token}` }).interaction);
  assert.deepEqual(requests.map((request) => request.type), ['confirm', 'cancel']);
  for (const request of requests) { assert.ok('context' in request); assert.equal(request.context.discordUserId, userId); }
  const forged = fakeInteraction({ button: 'pm:confirm:too-short' }); await handler(forged.interaction);
  assert.equal(requests.length, 2); assert.equal(forged.replies[0]?.components.length, 0);
});

test('order confirmation shows server-calculated terms with neutral style and two same-row actions', () => {
  const view = renderServiceResponse({ kind: 'QUOTE', quote }); const text = prose(view); assertBudget(view);
  for (const expected of ['0.123456', '1,000.00', '123.456', '0.123456', '123.579456', '9,876.420544', '버전 1', '21:00:30 KST']) assert.ok(text.includes(expected));
  assert.equal(view.embeds[0]?.toJSON().color, UI_COLORS.neutral);
  assert.equal(text.includes(token), false);
  const buttons = view.components[0]!.toJSON().components;
  assert.equal(buttons.length, 2); assert.equal(buttons[0]?.style, ButtonStyle.Primary); assert.equal(buttons[1]?.style, ButtonStyle.Secondary);
  assert.deepEqual(buttons.map((button) => 'custom_id' in button ? button.custom_id : null), [`pm:confirm:${token}`, `pm:cancel:${token}`]);
});

test('unsupported server token format cannot create routing controls', () => {
  const view = renderServiceResponse({ kind: 'QUOTE', quote: { ...quote, token: 'pm:confirm:injected' } });
  assert.equal(view.components.length, 0); assert.match(prose(view), /완료하지 못/);
});

test('unexpected exception text, SQL, stack and credentials stay out of replies and diagnostics', async () => {
  const backend: Backend = { async execute() { throw new Error('SELECT secret_token FROM /private/db.sqlite discord_secret'); } };
  const fake = fakeInteraction(); const diagnostics: string[] = [];
  await createInteractionHandler(backend, { operator, onDiagnostic: (code) => diagnostics.push(code) })(fake.interaction);
  const text = prose(fake.replies[0]!); assert.doesNotMatch(text, /SELECT|secret|sqlite|private/);
  assert.deepEqual(diagnostics, ['BACKEND_FAILED']);
  assert.equal(errorEmbed('SELECT secret').toJSON().description, errorEmbed('INTERNAL_ERROR').toJSON().description);
});

test('a failed post-commit reply never retries backend execution or modifies the committed result', async () => {
  let committed = 0;
  const backend: Backend = { async execute() { committed += 1; return { kind: 'CANCELLED', orderIntentId: 'intent_test' }; } };
  const diagnostics: string[] = [];
  await createInteractionHandler(backend, { operator, onDiagnostic: (code) => diagnostics.push(code) })(fakeInteraction({ button: `pm:confirm:${token}`, editFail: true }).interaction);
  assert.equal(committed, 1); assert.deepEqual(diagnostics, ['REPLY_FAILED']);
});

test('setup requires current ManageGuild permission and usable existing channel', async () => {
  const { backend, requests } = fakeBackend({ kind: 'SETUP', market });
  const denied = fakeInteraction({ command: 'setup', channel: fakeChannel() });
  const unusable = fakeInteraction({ command: 'setup', channel: fakeChannel({ permissions: false }), permissions: PermissionFlagsBits.ManageGuild });
  const missing = fakeInteraction({ command: 'setup', permissions: PermissionFlagsBits.ManageGuild });
  const handler = createInteractionHandler(backend, { operator });
  await handler(denied.interaction); await handler(unusable.interaction); await handler(missing.interaction);
  assert.equal(requests.length, 0);
  assert.match(prose(denied.replies[0]!), /서버 관리/); assert.match(prose(unusable.replies[0]!), /메시지 기록 보기 권한/);
  assert.match(prose(missing.replies[0]!), /텍스트 채널/);
});

test('each missing board permission blocks setup before database or public message mutation', async () => {
  for (const permission of [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
    PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]) {
    const channel = fakeChannel({ missingPermission: permission });
    const fake = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
    const { backend, requests } = fakeBackend({ kind: 'SETUP', market });
    await createInteractionHandler(backend, { operator })(fake.interaction);
    assert.equal(requests.length, 0); assert.equal(channel.sent.length, 0); assert.equal(channel.edited.length, 0);
    assert.match(prose(fake.replies[0]!), /권한/);
  }
});

test('foreign-guild and non-text channels cannot be selected for setup', async () => {
  for (const channel of [fakeChannel({ guildId: '999999999999999999' }), fakeChannel({ type: ChannelType.GuildAnnouncement })]) {
    const fake = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
    const { backend, requests } = fakeBackend({ kind: 'SETUP', market });
    await createInteractionHandler(backend, { operator })(fake.interaction);
    assert.equal(requests.length, 0); assert.equal(channel.sent.length, 0); assert.match(prose(fake.replies[0]!), /기존 텍스트 채널/);
  }
});

test('stale/expired confirmations require a new quote and explicit confirmation without automatic retrading', async () => {
  for (const code of ['STALE_QUOTE', 'ORDER_EXPIRED'] as const) {
    const fake = fakeInteraction({ button: `pm:confirm:${token}` });
    const { backend, requests } = fakeBackend({ kind: 'ERROR', code });
    await createInteractionHandler(backend, { operator })(fake.interaction);
    assert.equal(requests.length, 1); assert.equal(requests[0]?.type, 'confirm');
    assert.match(prose(fake.replies[0]!), /\/buy 또는 \/sell/); assert.match(prose(fake.replies[0]!), /새 견적/);
    assert.match(prose(fake.replies[0]!), /확인 버튼/); assert.equal(fake.replies[0]?.components.length, 0);
  }
});

test('setup commits before public publication and saves exactly one sanitized market board reference', async () => {
  const channel = fakeChannel(); const events: string[] = []; const requests: ServiceRequest[] = [];
  const backend: Backend = { async execute(request) { requests.push(request); events.push(request.type);
    return request.type === 'setup' ? { kind: 'SETUP', market } : { kind: 'BOARD_SAVED' }; } };
  const fake = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
  await createInteractionHandler(backend, { operator })(fake.interaction);
  assert.deepEqual(events, ['setup', 'save-board']); assert.equal(channel.sent.length, 1);
  assert.equal(requests[1]?.type, 'save-board');
  const publicText = JSON.stringify(channel.sent[0]!.embeds.map((embed) => embed.toJSON()));
  assert.doesNotMatch(publicText, /private_name|discord_interaction_secret|accountId|sequenceNo|boardMessageId|channelId/);
  assertBudget(channel.sent[0]!); assert.equal(channel.sent[0]?.components.length, 0);
});

test('setup edits its existing fixed message, rebuilds a deleted message and avoids duplicates on network failures', async () => {
  for (const scenario of ['existing', 'deleted', 'network'] as const) {
    const channel = fakeChannel({ existing: scenario === 'existing', ...(scenario === 'network' ? { fetchError: new Error('network') } : {}) });
    const backend: Backend = { async execute(request) { return request.type === 'setup' ? { kind: 'SETUP', market: { ...market, boardMessageId: messageId } } : { kind: 'BOARD_SAVED' }; } };
    const fake = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
    await createInteractionHandler(backend, { operator })(fake.interaction);
    assert.equal(channel.edited.length, scenario === 'existing' ? 1 : 0);
    assert.equal(channel.sent.length, scenario === 'deleted' ? 1 : 0);
    if (scenario === 'network') assert.match(prose(fake.replies[0]!), /설정은 저장/);
  }
});

test('setup never edits another author message and removes an unsaved newly-created board', async () => {
  const foreign = fakeChannel({ existing: true, author: '999999999999999999' });
  const orphan = fakeChannel();
  const backend: Backend = { async execute(request) { return request.type === 'setup'
    ? { kind: 'SETUP', market: { ...market, boardMessageId: messageId } } : { kind: 'ERROR', code: 'INTERNAL_ERROR' }; } };
  const handler = createInteractionHandler(backend, { operator });
  await handler(fakeInteraction({ command: 'setup', channel: foreign, permissions: PermissionFlagsBits.ManageGuild }).interaction);
  await handler(fakeInteraction({ command: 'setup', channel: orphan, permissions: PermissionFlagsBits.ManageGuild }).interaction);
  assert.equal(foreign.edited.length, 0); assert.equal(foreign.sent.length, 0);
  assert.equal(orphan.sent.length, 1); assert.equal(orphan.deleted, 1);
});

test('channel relocation archives the previous bot board only after the new board reference is committed', async () => {
  const targetId = '100000000000000020'; const channel = fakeChannel({ id: targetId }); let saved = false;
  const previous = fakeChannel({ existing: true, onEdit: () => assert.equal(saved, true) });
  const requests: ServiceRequest[] = [];
  const backend: Backend = { async execute(request) {
    requests.push(request);
    if (request.type === 'setup') return { kind: 'SETUP', market: { ...market, channelId: targetId }, previousBoard: { channelId, messageId } };
    saved = true; return { kind: 'BOARD_SAVED' };
  } };
  const fake = fakeInteraction({ command: 'setup', channel, previousChannel: previous, permissions: PermissionFlagsBits.ManageGuild });
  await createInteractionHandler(backend, { operator })(fake.interaction);
  assert.deepEqual(requests.map((request) => request.type), ['setup', 'save-board']);
  assert.equal(channel.sent.length, 1); assert.equal(previous.edited.length, 1); assert.equal(previous.deleted, 0);
  assert.match(prose(previous.edited[0]!), /현황판이 다른 채널로 이동/);
  assert.doesNotMatch(prose(previous.edited[0]!), /1,000|한결산업/); assertBudget(previous.edited[0]!);
});

test('old-board archive failure preserves the saved new board and reports only a private warning and safe diagnostic', async () => {
  const targetId = '100000000000000020'; const channel = fakeChannel({ id: targetId });
  const previous = fakeChannel({ existing: true, editFails: true }); const diagnostics: string[] = [];
  const backend: Backend = { async execute(request) { return request.type === 'setup'
    ? { kind: 'SETUP', market: { ...market, channelId: targetId }, previousBoard: { channelId, messageId } }
    : { kind: 'BOARD_SAVED' }; } };
  const fake = fakeInteraction({ command: 'setup', channel, previousChannel: previous, permissions: PermissionFlagsBits.ManageGuild });
  await createInteractionHandler(backend, { operator, onDiagnostic: (code) => diagnostics.push(code) })(fake.interaction);
  assert.equal(channel.sent.length, 1); assert.equal(channel.deleted, 0); assert.equal(previous.edited.length, 0);
  assert.match(prose(fake.replies[0]!), /저장했습니다/); assert.match(prose(fake.replies[0]!), /이전 채널 권한/);
  assert.deepEqual(diagnostics, ['PREVIOUS_BOARD_ARCHIVE_FAILED']); assert.doesNotMatch(prose(fake.replies[0]!), /PRIVATE_PERMISSION_ERROR/);
  assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
});

test('failed new-board save never archives the old active board', async () => {
  const targetId = '100000000000000020'; const channel = fakeChannel({ id: targetId }); const previous = fakeChannel({ existing: true });
  const backend: Backend = { async execute(request) { return request.type === 'setup'
    ? { kind: 'SETUP', market: { ...market, channelId: targetId }, previousBoard: { channelId, messageId } }
    : { kind: 'ERROR', code: 'INTERNAL_ERROR' }; } };
  const fake = fakeInteraction({ command: 'setup', channel, previousChannel: previous, permissions: PermissionFlagsBits.ManageGuild });
  await createInteractionHandler(backend, { operator })(fake.interaction);
  assert.equal(previous.events.length, 0); assert.equal(channel.deleted, 1); assert.match(prose(fake.replies[0]!), /현황판을 게시하지 못/);
});

test('concurrent setup requests serialize board creation and then reuse the saved message', async () => {
  const channel = fakeChannel({ existing: true }); let saved = false; let pending = 0; let maximumPending = 0;
  const backend: Backend = { async execute(request) {
    if (request.type === 'setup') { pending += 1; maximumPending = Math.max(maximumPending, pending);
      await new Promise<void>((resolve) => setTimeout(resolve, 5)); pending -= 1;
      return { kind: 'SETUP', market: { ...market, boardMessageId: saved ? messageId : null } }; }
    saved = true; return { kind: 'BOARD_SAVED' };
  } };
  const handler = createInteractionHandler(backend, { operator });
  await Promise.all([handler(fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild, interactionId: '100000000000000010' }).interaction),
    handler(fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild, interactionId: '100000000000000011' }).interaction)]);
  assert.equal(maximumPending, 1); assert.equal(channel.sent.length, 1); assert.equal(channel.edited.length, 1);
});

test('duplicate Gateway setup delivery reuses the committed fixed board through the actual SQLite broker', async (t) => {
  const db = openDatabase(':memory:'); t.after(() => db.close());
  const broker = new BrokerRepository(db, { now: () => fixedNow.toISOString() }, { identityKey: randomBytes(32) });
  const backend: Backend = { async execute(request) { return broker.dispatch(request); } };
  const channel = fakeChannel({ existing: true });
  const handler = createInteractionHandler(backend, { operator, now: () => fixedNow });
  const first = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
  const duplicate = fakeInteraction({ command: 'setup', channel, permissions: PermissionFlagsBits.ManageGuild });
  await handler(first.interaction); await handler(duplicate.interaction);
  assert.match(prose(first.replies[0]!), /저장했습니다/); assert.match(prose(duplicate.replies[0]!), /저장했습니다/);
  assert.equal(channel.sent.length, 1); assert.equal(channel.edited.length, 1);
  const settings = db.prepare('SELECT board_message_id FROM market_settings').get() as { board_message_id: string };
  assert.equal(settings.board_message_id, messageId);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM markets').get() as { count: number }).count, 1);
});

test('help/privacy and unconfirmed closure stay local and preserve the full policy notice', async () => {
  const { backend, requests } = fakeBackend(); const handler = createInteractionHandler(backend, { operator });
  const help = fakeInteraction({ command: 'help' }); const privacy = fakeInteraction({ command: 'privacy' });
  const close = fakeInteraction({ command: 'close', booleans: { confirmed: false } });
  await handler(help.interaction); await handler(privacy.interaction); await handler(close.interaction);
  assert.equal(requests.length, 0); assert.match(prose(help.replies[0]!), /시험 이용약관/);
  assert.match(prose(privacy.replies[0]!), /개발 초안이며 법률·출시 검토 완료가 아닙니다/); assert.match(prose(close.replies[0]!), /다시 열 수 없/);
  for (const fake of [help, privacy, close]) assertBudget(fake.replies[0]!);
  const expected = renderPrivacyNotice(operator).split('\n\n');
  for (const paragraph of expected) assert.ok(prose(privacy.replies[0]!).includes(paragraph));
});

test('confirmed account closure forwards only authenticated owner and explicit confirmation', async () => {
  const { backend, requests } = fakeBackend({ kind: 'CLOSED', accountId: 'account_test' });
  const fake = fakeInteraction({ command: 'close', booleans: { confirmed: true }, strings: { owner: 'victim' } });
  await createInteractionHandler(backend, { operator })(fake.interaction);
  assert.ok(requests[0]?.type === 'close' && requests[0].confirmed);
  assert.equal(requests[0].context.discordUserId, userId); assert.equal('owner' in requests[0], false);
  assert.match(prose(fake.replies[0]!), /재개설·초기금 재지급/);
});

test('public market remains neutral, bounded and accessible without row-color assumptions', () => {
  const view = renderMarket({ ...market, listings: Array.from({ length: 8 }, (_, index) => ({ ...market.listings[0]!, name: `기업${index}`, symbol: `PM${index}` })) });
  assertBudget(view); assert.equal(view.embeds[0]?.toJSON().color, UI_COLORS.neutral);
  assert.match(prose(view), /보합/); assert.match(prose(view), /시험 시세/);
  assert.equal(displayDirection('0.0125'), '상승 +1.25%'); assert.equal(displayDirection('-0.008'), '하락 -0.80%');
  assert.equal(UI_COLORS.up, 0x15803D); assert.equal(UI_COLORS.down, 0xB91C1C);
  assert.notEqual(displayNumber('0.00000001'), '0.00');
});

test('economic commands show committed public reports and probabilistic expectations after private acknowledgement', async () => {
  const response: ServiceResponse = { kind: 'MARKET', market: { ...market, priceSource: 'ECONOMY', economy: publicEconomy,
    listings: market.listings.map((listing) => ({ ...listing, price: '490', changePct: '-30' })) } };
  for (const input of [{ command: 'economy' }, { command: 'financial', strings: { symbol: 'hgi' } }]) {
    const fake = fakeInteraction(input); const backend = fakeBackend(response);
    await createInteractionHandler(backend.backend, { operator })(fake.interaction);
    assert.equal(fake.events[0], 'defer'); assert.equal(backend.requests[0]?.type, 'market');
    assert.deepEqual(fake.acknowledgements, [{ flags: MessageFlags.Ephemeral }]);
    const text = prose(fake.replies[0]!);
    assert.doesNotMatch(text, /private_name|discord_interaction_secret|orderIntent|seed/);
    if (input.command === 'economy') { assert.match(text, /인하 20\.00%.*동결 50\.00%.*인상 30\.00%/); assert.match(text, /실제.*예상.*이전/); }
    else { assert.match(text, /공개 실적/); assert.match(text, /시장 전망/); assert.match(text, /63틱.*64틱/); }
  }
  const board = prose(renderMarket(response.market));
  assert.match(board, /하락 -30\.00%/); assert.doesNotMatch(board, /고정 시험 시세/); assert.match(board, /정책 3\.25%/);
});

test('financial symbol validation and absent public economy remain safe', async () => {
  const invalid = fakeInteraction({ command: 'financial', strings: { symbol: 'HGI;DROP' } }); const backend = fakeBackend();
  await createInteractionHandler(backend.backend, { operator })(invalid.interaction);
  assert.equal(backend.requests.length, 0);
  const trial = fakeInteraction({ command: 'economy' });
  await createInteractionHandler(backend.backend, { operator })(trial.interaction);
  assert.match(prose(trial.replies[0]!), /고정 시험 시세/);
});

test('portfolio distinguishes unpaid time-weighted interest from already paid cash', () => {
  const response: ServiceResponse = { kind: 'PORTFOLIO', portfolio: {
    account: { accountId: 'account-test', status: 'ACTIVE', accountVersion: 2, createdAt: fixedNow.toISOString(), cash: '10000' },
    marketVersion: 2, positions: [], equity: '10000.5', totalReturnPct: '0.005', accruedCashInterest: '0.5', cashInterestTotal: '0.2',
  } };
  const text = prose(renderServiceResponse(response));
  assert.match(text, /미지급 현금 이자 0\.50.*누적 지급 0\.20/);
  assert.match(text, /틱 내부 재복리 없음/);
});

test('safe text blocks mentions/markdown surprises and notices enforce a message budget', () => {
  const view = renderMarket({ ...market, listings: [{ ...market.listings[0]!, name: '@everyone **hidden**\n' }] });
  assertBudget(view); assert.doesNotMatch(prose(view), /@everyone/); assert.match(prose(view), /\\\*\\\*/);
  assertBudget(renderNotice('Policy', 'x'.repeat(4_001))); assert.doesNotMatch(prose(renderNotice('Policy', 'x'.repeat(4_001))), /xxx/);
  const channel = fakeChannel(); assert.equal(channel.type, ChannelType.GuildText);
  // Keep the fake channel structurally comparable to the real adapter boundary, not a second implementation.
  const typedChannel = channel as unknown as TextChannel; assert.equal(typedChannel.id, channelId);
});

test('rights display separates nominal, current marks, cash paid and final liquidation loss within Discord limits',()=>{
  const response:ServiceResponse={kind:'PORTFOLIO',portfolio:{account:{accountId:'test',status:'ACTIVE',accountVersion:9,createdAt:fixedNow.toISOString(),cash:'100'},marketVersion:27,positions:[],equity:'112',totalReturnPct:'-98.88',dividendTotal:'6',liquidationTotal:'2',rights:Array.from({length:9},(_,index)=>({rightId:`claim_${index}`,kind:index===8?'LIQUIDATION':'DIVIDEND',symbol:'HGI',status:index===8?'SETTLED':'IMPAIRED',quantity:'2',nominal:'30',currentValue:'12',paid:'2',cost:index===8?'2002':'0',realizedPnl:index===8?'-2000':'0',eligibleTick:6,paymentTick:27}))}};
  const view=renderServiceResponse(response);assertBudget(view);const text=prose(view);
  assert.match(text,/순자산 112\.00/);assert.match(text,/명목 배당 30\.00/);assert.match(text,/현재 평가 12\.00.*실제 지급 2\.00/);
  assert.match(text,/이전 취득원가 2,002\.00.*최종 손익 -2,000\.00/);assert.match(text,/최근 5건 표시.*전체 9건/);
  assert.match(prose({embeds:[errorEmbed('CORPORATE_ACTION_CANCELLED')],components:[],allowedMentions:{parse:[]}}),/배당락 또는 청산/);
});
test('financial view discloses generation, lifecycle and dividend timing without account data',()=>{
  const view=renderFinancial({...publicEconomy.companies[0]!,symbol:'HGI2',generation:2,lifecycle:'WATCH',dividends:[{id:'div',dps:'15',status:'IMPAIRED',declaredTick:64,exTick:67,payTick:69,recoveryRatio:'0.4'}]});
  assertBudget(view);const text=prose(view);assert.match(text,/기업 상태 주의.*2세대/);assert.match(text,/선언 64.*권리 확정 67.*지급 예정 69틱.*회수율 40\.00%/);assert.doesNotMatch(text,/accountId|discordUserId/);
});
