import {
  ChannelType, MessageFlags, PermissionFlagsBits,
  type ButtonInteraction, type ChatInputCommandInteraction, type Guild, type Interaction, type ModalSubmitInteraction, type TextChannel,
} from 'discord.js';
import type { Backend, ServiceContext, ServiceRequest, ServiceResponse } from '../application/contracts.js';
import { parseMoney, parseOrderQuantity, parsePrice } from '../domain/numeric.js';
import { renderAccountClosureNotice, renderPolicyNotice, renderPrivacyNotice, renderTermsNotice, validatePolicyOperator } from '../policy/index.js';
import { COMMAND_NAMES } from './commands.js';
import { baseEmbed, displayNumber, errorEmbed } from './messages.js';
import { renderAlerts, renderBuyChoices, renderEconomy, renderExport, renderFinancial, renderMarket, renderNews, renderNotice, renderServiceResponse, replyView, type ReplyView } from './render.js';
import { companySelectionModal, tradeModal } from './forms.js';

export type AdapterDiagnostic = 'ACK_FAILED' | 'REPLY_FAILED' | 'BACKEND_FAILED' | 'BOARD_FAILED' | 'BOARD_ORPHAN_CLEANUP_FAILED' | 'PREVIOUS_BOARD_ARCHIVE_FAILED';
export interface HandlerOptions {
  readonly operator: { readonly operatorName: string; readonly supportContact: string };
  readonly now?: () => Date;
  readonly onDiagnostic?: (code: AdapterDiagnostic) => void;
  readonly onDefer?:(elapsedMs:number)=>void;
}

const CHANNEL_PERMISSIONS = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory];
const BUTTON_ROUTE = /^pm:(confirm|cancel):([A-Za-z0-9_-]{16,64})$/;
const SCHEDULED_CANCEL_ROUTE = /^pm:ordercancel:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;
const TRADE_ROUTE = /^pm:trade:(BUY|SELL):([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6})$/;
const TRADE_FORM_ROUTE = /^pm:tradeform:(BUY|SELL):([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6})$/;
const BUY_MENU_ROUTE = /^pm:buy:([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6})$/;
const BUY_PRESET_ROUTE = /^pm:buyquote:(1000|5000|P50):([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6})$/;
const NAV_ROUTE = /^pm:view:(market|portfolio|performance|funding|news|calendar|economy|orders|history|company|financial)(?::([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6}))?$/;
const CHART_ROUTE = /^pm:chart:([A-Z][A-Z0-9]{0,11}):([1-9][0-9]{0,6}):(PRICE|TOTAL_RETURN):(LINEAR|LOG)$/;
const NEWS_ROUTE = /^pm:news:(0|[1-9][0-9]{0,15}):(ALL|[A-Z][A-Z0-9]{0,11})$/;
const NEWS_CURSOR_ROUTE = /^pm:news:([0-9a-f]{64})(?::([A-Z][A-Z0-9]{0,11}))?$/;
const EXPORT_ROUTE = /^pm:export:(CSV|JSON):(LATEST|[1-9][0-9]{0,15})(?::([A-Za-z0-9_-]{1,64}))?$/;
const HISTORY_ROUTE = /^pm:history:([1-9][0-9]{0,15})(?::([A-Za-z0-9_-]{1,64}))?$/;
const ALERTS_ROUTE = /^pm:alerts:(REFRESH|READ|BEFORE)(?::([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))?$/i;

function validSymbol(symbol: string): string {
  if (!/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(symbol)) throw new Error('INVALID_INPUT');
  return symbol.toUpperCase();
}

function generationValue(value: number | null): number | undefined {
  if (value === null) return undefined;
  if (!Number.isInteger(value) || value < 1 || value > 1_000_000) throw new Error('INVALID_INPUT');
  return value;
}

function positiveBudget(value: string): string {
  try { if (parseMoney(value) <= 0n) throw new Error('INVALID_INPUT'); }
  catch { throw new Error('INVALID_INPUT'); }
  return value;
}

function budgetPercentValue(value: number | null): 25 | 50 | 100 | undefined {
  if (value === null) return undefined;
  if (value !== 25 && value !== 50 && value !== 100) throw new Error('INVALID_INPUT');
  return value;
}

function selectedSetupChannel(interaction: ChatInputCommandInteraction): TextChannel | null {
  const selected = interaction.options.getChannel('channel', true);
  const channel = interaction.guild?.channels.resolve(selected.id);
  if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== interaction.guildId) return null;
  return channel;
}

function commandRequest(interaction: ChatInputCommandInteraction, context: ServiceContext): ServiceRequest | null {
  switch (interaction.commandName) {
    case 'open': return { type: 'open', context, age14Plus: interaction.options.getBoolean('age_14_plus', true),
      agreeTerms: interaction.options.getBoolean('agree_terms', true) };
    case 'market': case 'portfolio': case 'status': case 'orders': return { type: interaction.commandName, context };
    case 'funding': {
      const enabled = interaction.options.getBoolean('enabled');
      return { type: 'funding', context, ...(enabled === null ? {} : { enabled }) };
    }
    case 'history': return { type: 'history', context, limit: 4 };
    case 'company': {
      const symbol = validSymbol(interaction.options.getString('symbol', true));
      const generation = generationValue(interaction.options.getInteger('generation'));
      return { type: 'company', context, symbol, ...(generation === undefined ? {} : { generation }) };
    }
    case 'calendar': case 'performance': return { type: interaction.commandName, context };
    case 'export': {
      const format = interaction.options.getString('format') ?? 'CSV'; const beforeSequence = interaction.options.getInteger('before_sequence');
      if ((format !== 'CSV' && format !== 'JSON') || (beforeSequence !== null && (!Number.isSafeInteger(beforeSequence) || beforeSequence < 1))) throw new Error('INVALID_INPUT');
      return { type: 'export', context, format, ...(beforeSequence === null ? {} : { beforeSequence }) };
    }
    case 'news': {
      const symbolOption = interaction.options.getString('symbol');
      const beforeTick = interaction.options.getInteger('before_tick');
      if (beforeTick !== null && (!Number.isSafeInteger(beforeTick) || beforeTick < 0)) throw new Error('INVALID_INPUT');
      return { type: 'news', context, ...(beforeTick === null ? {} : { beforeTick }), ...(symbolOption === null ? {} : { symbol: validSymbol(symbolOption) }) };
    }
    case 'chart': {
      const symbol = validSymbol(interaction.options.getString('symbol', true));
      const generation = generationValue(interaction.options.getInteger('generation'));
      const series = interaction.options.getString('series') ?? 'PRICE'; const scale = interaction.options.getString('scale') ?? 'LINEAR';
      const ticks = interaction.options.getInteger('ticks') ?? 252;
      if ((series !== 'PRICE' && series !== 'TOTAL_RETURN') || (scale !== 'LINEAR' && scale !== 'LOG')
        || !Number.isInteger(ticks) || ticks < 2 || ticks > 2_000) throw new Error('INVALID_INPUT');
      return { type: 'chart', context, symbol, series, scale, limit: ticks, ...(generation === undefined ? {} : { generation }) };
    }
    case 'alerts': {
      const action = interaction.options.getString('action') ?? 'VIEW'; const symbolOption = interaction.options.getString('symbol');
      const price = interaction.options.getString('price'); const direction = interaction.options.getString('direction');
      const alertId = interaction.options.getString('alert_id'); const dm = interaction.options.getBoolean('dm');
      const symbol = symbolOption === null ? undefined : validSymbol(symbolOption);
      const hasExtras = price !== null || direction !== null || alertId !== null || dm !== null;
      if (action === 'VIEW' && symbol === undefined && !hasExtras) return { type: 'alerts', context };
      if ((action === 'WATCH' || action === 'UNWATCH') && symbol && !hasExtras) return { type: 'alerts', context, symbol, watch: action === 'WATCH' };
      if (action === 'PRICE' && symbol && price !== null && (direction === 'ABOVE' || direction === 'BELOW') && alertId === null && dm === null) {
        try { parsePrice(price); } catch { throw new Error('INVALID_INPUT'); }
        return { type: 'alerts', context, symbol, direction, threshold: price };
      }
      if (action === 'REMOVE' && symbol === undefined && price === null && direction === null && dm === null && alertId !== null
        && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(alertId)) return { type: 'alerts', context, removePriceAlertId: alertId };
      if (action === 'DM' && symbol === undefined && price === null && direction === null && alertId === null && dm !== null) return { type: 'alerts', context, dmEnabled: dm };
      if (action === 'READ' && symbol === undefined && !hasExtras) return { type: 'alerts', context, markRead: true };
      throw new Error('INVALID_INPUT');
    }
    case 'buy': case 'sell': {
      const symbol = interaction.options.getString('symbol', true);
      const quantity = interaction.options.getString('quantity');
      const budget = interaction.commandName === 'buy' ? interaction.options.getString('budget') : null;
      const budgetPercent = interaction.commandName === 'buy' ? budgetPercentValue(interaction.options.getInteger('budget_percent')) : undefined;
      const all = interaction.commandName === 'sell' ? interaction.options.getBoolean('all') : null;
      const orderType = interaction.options.getString('order_type') ?? 'MARKET';
      const conditionPrice = interaction.options.getString('price');
      const timeInForceOption = interaction.options.getString('time_in_force');
      const ticks = interaction.options.getInteger('ticks');
      if (!/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(symbol) || (quantity !== null && quantity.length > 96)
        || (budget !== null && budget.length > 64) || (orderType !== 'MARKET' && orderType !== 'LIMIT' && orderType !== 'STOP')) throw new Error('INVALID_INPUT');
      const side = interaction.commandName === 'buy' ? 'BUY' : 'SELL';
      if (orderType === 'MARKET') {
        if (conditionPrice !== null || timeInForceOption !== null || ticks !== null
          || (side === 'BUY' ? Number(quantity !== null) + Number(budget !== null) + Number(budgetPercent !== undefined) !== 1
            : Number(quantity !== null) + Number(all === true) !== 1)) throw new Error('INVALID_INPUT');
        try { if (quantity !== null) parseOrderQuantity(quantity); if (budget !== null) positiveBudget(budget); } catch { throw new Error('INVALID_INPUT'); }
        return { type: 'quote', context, side, symbol, orderType,
          ...(quantity === null ? {} : { quantity }), ...(budget === null ? {} : { budget }), ...(budgetPercent === undefined ? {} : { budgetPercent }), ...(all === null ? {} : { all }) };
      }
      if (quantity === null || conditionPrice === null || budget !== null || budgetPercent !== undefined || all !== null
        || (orderType === 'STOP' && side !== 'SELL')) throw new Error('INVALID_INPUT');
      try { parseOrderQuantity(quantity); parsePrice(conditionPrice); } catch { throw new Error('INVALID_INPUT'); }
      const timeInForce = timeInForceOption ?? 'TICK_COUNT';
      if (timeInForce !== 'TICK_COUNT' && timeInForce !== 'UNTIL_CANCELLED') throw new Error('INVALID_INPUT');
      if (timeInForce === 'UNTIL_CANCELLED' && ticks !== null) throw new Error('INVALID_INPUT');
      const validForTicks = timeInForce === 'TICK_COUNT' ? ticks ?? 21 : undefined;
      if (validForTicks !== undefined && (!Number.isInteger(validForTicks) || validForTicks < 1 || validForTicks > 10_000)) throw new Error('INVALID_INPUT');
      return { type: 'quote', context, side, symbol, quantity, orderType, conditionPrice, timeInForce,
        ...(validForTicks === undefined ? {} : { validForTicks }) };
    }
    case 'close': return { type: 'close', context, confirmed: interaction.options.getBoolean('confirmed', true) };
    default: return null;
  }
}

function isUnknownMessage(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 10008;
}

export function createInteractionHandler(backend: Backend, options: HandlerOptions): (interaction: Interaction) => Promise<void> {
  const operator = validatePolicyOperator(options.operator);
  const now = options.now ?? (() => new Date());
  const diagnose = (code: AdapterDiagnostic) => { try { options.onDiagnostic?.(code); } catch { /* Diagnostics cannot change command outcomes. */ } };
  // Serializes the async Discord board step as well as setup, so two administrators cannot create two boards.
  const setupTails = new Map<string, Promise<void>>();

  async function upsertBoard(channel: TextChannel, context: ServiceContext, marketResponse: ServiceResponse): Promise<boolean> {
    if (marketResponse.kind !== 'SETUP') return false;
    const payload = renderMarket(marketResponse.market, false);
    let created = false;
    let message;
    try {
      if (marketResponse.market.boardMessageId) {
        try { message = await channel.messages.fetch(marketResponse.market.boardMessageId); }
        catch (error) { if (!isUnknownMessage(error)) throw error; }
      }
      if (message) {
        if (message.author.id !== channel.client.user?.id) throw new Error('BOARD_NOT_OWNED');
        await message.edit(payload);
      } else {
        message = await channel.send(payload);
        created = true;
      }
      const saved = await backend.execute({ type: 'save-board', context, channelId: channel.id, messageId: message.id });
      if (saved.kind !== 'BOARD_SAVED') throw new Error('BOARD_NOT_SAVED');
      return true;
    } catch {
      diagnose('BOARD_FAILED');
      if (created && message) {
        try { await message.delete(); } catch { diagnose('BOARD_ORPHAN_CLEANUP_FAILED'); }
      }
      return false;
    }
  }

  async function archivePreviousBoard(guild: Guild, context: ServiceContext,
    previousBoard: { readonly channelId: string; readonly messageId: string }): Promise<boolean> {
    try {
      const previousChannel = await guild.channels.fetch(previousBoard.channelId);
      if (!previousChannel || previousChannel.type !== ChannelType.GuildText || previousChannel.guildId !== context.guildId) return false;
      let previousMessage;
      try { previousMessage = await previousChannel.messages.fetch(previousBoard.messageId); }
      catch (error) { if (isUnknownMessage(error)) return true; throw error; }
      if (previousMessage.author.id !== previousChannel.client.user?.id) return false;
      await previousMessage.edit(replyView(baseEmbed('PaperMarket · 현황판 이동',
        '현황판이 다른 채널로 이동했습니다. /market으로 최신 확정 시세를 확인하세요.')));
      return true;
    } catch { return false; }
  }

  async function setup(channel: TextChannel, guild: Guild, context: ServiceContext): Promise<ReplyView> {
    let release!: () => void;
    const previous = setupTails.get(context.guildId) ?? Promise.resolve();
    const tail = new Promise<void>((resolve) => { release = resolve; });
    setupTails.set(context.guildId, tail);
    await previous;
    try {
      const response = await backend.execute({ type: 'setup', context, channelId: channel.id });
      if (response.kind === 'ERROR') return renderServiceResponse(response);
      const boardOk = await upsertBoard(channel, context, response);
      if (!boardOk) return replyView(errorEmbed('BOARD_UNAVAILABLE'));
      let previousBoardArchived = true;
      if (response.kind === 'SETUP' && response.previousBoard && response.previousBoard.channelId !== channel.id) {
        previousBoardArchived = await archivePreviousBoard(guild, context, response.previousBoard);
        if (!previousBoardArchived) diagnose('PREVIOUS_BOARD_ARCHIVE_FAILED');
      }
      return replyView(baseEmbed('PaperMarket · 시장 설정',
        '가상 시장을 준비하고 고정 현황판을 저장했습니다. /open으로 모의계좌를 개설하세요.'
        + (previousBoardArchived ? '' : '\n\n이전 채널 현황판을 이동 안내로 바꾸지 못했습니다. 이전 채널 권한을 확인하고 기존 게시물의 상태를 관리자에게 확인하세요.')));
    } finally {
      release();
      if (setupTails.get(context.guildId) === tail) setupTails.delete(context.guildId);
    }
  }

  return async (interaction: Interaction): Promise<void> => {
    const modal = typeof interaction.isModalSubmit === 'function' && interaction.isModalSubmit() ? interaction : null;
    if (!interaction.isChatInputCommand() && !interaction.isButton() && !modal) return;
    if (interaction.isChatInputCommand() && !COMMAND_NAMES.some((name) => name === interaction.commandName)) return;
    if (interaction.isButton() && !interaction.customId.startsWith('pm:')) return;
    if (modal && !modal.customId.startsWith('pm:')) return;
    const acknowledged = interaction as ChatInputCommandInteraction | ButtonInteraction | ModalSubmitInteraction;
    if (interaction.isButton() && interaction.guildId) {
      const trade = TRADE_ROUTE.exec(interaction.customId);
      if (interaction.customId === 'pm:selectcompany' || (trade && Number(trade[3]) <= 1_000_000)) {
        try { await interaction.showModal(trade ? tradeModal(trade[1] as 'BUY' | 'SELL', trade[2]!, Number(trade[3])) : companySelectionModal()); }
        catch { diagnose('ACK_FAILED'); }
        return;
      }
    }
    // Capture receipt time at the authenticated Gateway boundary. Never trust client timestamps or owner options.
    const receivedAt = now().toISOString();
    const deferStartedAt=performance.now();
    try { await acknowledged.deferReply({ flags: MessageFlags.Ephemeral });try{options.onDefer?.(performance.now()-deferStartedAt);}catch{} }
    catch { diagnose('ACK_FAILED'); return; }
    let view: ReplyView;
    try {
      if (!interaction.guildId) view = replyView(errorEmbed('GUILD_ONLY'));
      else {
        const context: ServiceContext = { guildId: interaction.guildId, discordUserId: interaction.user.id,
          interactionId: interaction.id, receivedAt, guildPermissions: interaction.memberPermissions?.bitfield.toString() ?? '0' };
        if (interaction.isButton() && BUY_MENU_ROUTE.test(interaction.customId)) {
          const buy = BUY_MENU_ROUTE.exec(interaction.customId)!;
          if (Number(buy[2]) > 1_000_000) throw new Error('INVALID_INPUT');
          view = renderBuyChoices(buy[1]!, Number(buy[2]));
        } else if (interaction.isChatInputCommand() && interaction.commandName === 'help') {
          view = renderNotice('PaperMarket · 시험 이용약관', renderTermsNotice(operator));
        } else if (interaction.isChatInputCommand() && interaction.commandName === 'privacy') {
          view = renderNotice('PaperMarket · 개인정보 안내', renderPrivacyNotice(operator));
        } else if (interaction.isChatInputCommand() && (interaction.commandName === 'economy' || interaction.commandName === 'financial')) {
          const symbol = interaction.commandName === 'financial' ? interaction.options.getString('symbol', true) : null;
          if (symbol !== null && !/^[A-Za-z][A-Za-z0-9]{0,11}$/.test(symbol)) throw new Error('INVALID_INPUT');
          const response = await backend.execute({ type: 'market', context });
          if (response.kind === 'ERROR') view = renderServiceResponse(response);
          else if (response.kind !== 'MARKET' || !response.market.economy) view = replyView(baseEmbed('PaperMarket · 경제 정보', '현재 시장은 고정 시험 시세입니다. 기업 경제 모드의 공개 정보가 없습니다.'));
          else if (symbol === null) view = renderEconomy(response.market.economy, response.market);
          else {
            const company = response.market.economy.companies.find((item) => item.symbol === symbol.toUpperCase());
            view = company ? renderFinancial(company, response.market) : replyView(errorEmbed('SYMBOL_NOT_FOUND'));
          }
        } else if (interaction.isChatInputCommand() && interaction.commandName === 'close'
          && !interaction.options.getBoolean('confirmed', true)) {
          view = renderNotice('PaperMarket · 계좌 이용 중단 안내', renderAccountClosureNotice(operator));
        } else if (interaction.isChatInputCommand() && interaction.commandName === 'setup') {
          if (!interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild)) view = replyView(errorEmbed('PERMISSION_DENIED'));
          else {
            const channel = selectedSetupChannel(interaction);
            if (!channel) view = replyView(errorEmbed('INVALID_CHANNEL'));
            else {
              const bot = interaction.guild?.members.me;
              if (!bot || !channel.permissionsFor(bot)?.has(CHANNEL_PERMISSIONS)) view = replyView(errorEmbed('CHANNEL_PERMISSION_DENIED'));
              else if (!interaction.guild) view = replyView(errorEmbed('INVALID_CHANNEL'));
              else view = await setup(channel, interaction.guild, context);
            }
          }
        } else {
          let request: ServiceRequest | null = null;
          if (modal) {
            if (modal.customId === 'pm:companyform') {
              const symbol = validSymbol(modal.fields.getTextInputValue('symbol'));
              const rawGeneration = modal.fields.getTextInputValue('generation').trim();
              const generation = generationValue(rawGeneration ? Number(rawGeneration) : null);
              request = { type: 'company', context, symbol, ...(generation === undefined ? {} : { generation }) };
            } else {
              const trade = TRADE_FORM_ROUTE.exec(modal.customId);
              if (!trade || Number(trade[3]) > 1_000_000) throw new Error('INVALID_INPUT');
              const side = trade[1] as 'BUY' | 'SELL'; const quantity = modal.fields.getTextInputValue('quantity').trim();
              // A quantity-only modal opened before an update has no budget field; keep its existing route usable.
              const budgetInput = side === 'BUY' && modal.fields.fields.has('budget') ? modal.fields.getTextInputValue('budget').trim() : '';
              const percentage = /^(25|50|100)%$/.exec(budgetInput);
              const budgetPercent = percentage ? budgetPercentValue(Number(percentage[1])) : undefined;
              const budget = budgetInput && !percentage ? positiveBudget(budgetInput) : undefined;
              const orderType = modal.fields.getTextInputValue('order_type').trim().toUpperCase();
              const price = modal.fields.getTextInputValue('price').trim(); const duration = modal.fields.getTextInputValue('duration').trim().toUpperCase();
              try { if (quantity) parseOrderQuantity(quantity); } catch { throw new Error('INVALID_INPUT'); }
              if (orderType !== 'MARKET' && orderType !== 'LIMIT' && orderType !== 'STOP') throw new Error('INVALID_INPUT');
              if (orderType === 'MARKET') {
                if (price || duration || Number(Boolean(quantity)) + Number(Boolean(budgetInput)) !== 1) throw new Error('INVALID_INPUT');
                request = { type: 'quote', context, symbol: trade[2]!, generation: Number(trade[3]), side, orderType,
                  ...(quantity ? { quantity } : {}), ...(budget === undefined ? {} : { budget }), ...(budgetPercent === undefined ? {} : { budgetPercent }) };
              } else {
                if (!quantity || budgetInput || !price || (orderType === 'STOP' && side === 'BUY')) throw new Error('INVALID_INPUT');
                try { parsePrice(price); } catch { throw new Error('INVALID_INPUT'); }
                const validForTicks = duration === 'UC' ? undefined : duration ? Number(duration) : 21;
                if (validForTicks !== undefined && (!/^[0-9]{1,5}$/.test(duration || '21') || !Number.isInteger(validForTicks) || validForTicks < 1 || validForTicks > 10_000)) throw new Error('INVALID_INPUT');
                request = { type: 'quote', context, symbol: trade[2]!, generation: Number(trade[3]), side, quantity, orderType, conditionPrice: price,
                  timeInForce: duration === 'UC' ? 'UNTIL_CANCELLED' : 'TICK_COUNT', ...(validForTicks === undefined ? {} : { validForTicks }) };
              }
            }
          } else if (interaction.isButton()) {
            const match = BUTTON_ROUTE.exec(interaction.customId);
            const preset = BUY_PRESET_ROUTE.exec(interaction.customId);
            if (preset && Number(preset[3]) <= 1_000_000) {
              request = { type: 'quote', context, side: 'BUY', symbol: preset[2]!, generation: Number(preset[3]), orderType: 'MARKET',
                ...(preset[1] === 'P50' ? { budgetPercent: 50 } : { budget: preset[1]! }) };
            } else if (match && (match[1] === 'confirm' || match[1] === 'cancel') && match[2]) {
              request = { type: match[1], context, token: match[2] };
            } else {
              const scheduledCancel = SCHEDULED_CANCEL_ROUTE.exec(interaction.customId);
              if (scheduledCancel?.[1]) request = { type: 'cancel-order', context, orderId: scheduledCancel[1] };
              else {
                const chart = CHART_ROUTE.exec(interaction.customId); const nav = NAV_ROUTE.exec(interaction.customId);
                const news = NEWS_ROUTE.exec(interaction.customId); const newsCursor = NEWS_CURSOR_ROUTE.exec(interaction.customId);
                const exported = EXPORT_ROUTE.exec(interaction.customId);
                const history = HISTORY_ROUTE.exec(interaction.customId); const alerts = ALERTS_ROUTE.exec(interaction.customId);
                if (chart && Number(chart[2]) <= 1_000_000) request = { type: 'chart', context, symbol: chart[1]!, generation: Number(chart[2]),
                  series: chart[3] as 'PRICE' | 'TOTAL_RETURN', scale: chart[4] as 'LINEAR' | 'LOG', limit: 252 };
                else if (newsCursor) request = { type: 'news', context, cursor: newsCursor[1]!, ...(newsCursor[2] ? { symbol: newsCursor[2] } : {}) };
                else if (news && Number.isSafeInteger(Number(news[1]))) request = { type: 'news', context, beforeTick: Number(news[1]), ...(news[2] === 'ALL' ? {} : { symbol: news[2]! }) };
                else if (exported && (exported[2] === 'LATEST' ? exported[3] === undefined : Number.isSafeInteger(Number(exported[2])))) request = { type: 'export', context,
                  format: exported[1] as 'CSV' | 'JSON', ...(exported[2] === 'LATEST' ? {} : { beforeSequence: Number(exported[2]) }),
                  ...(exported[3] ? { beforeEventId: exported[3] } : {}) };
                else if (history && Number.isSafeInteger(Number(history[1]))) request = { type: 'history', context, beforeSequence: Number(history[1]), limit: 4,
                  ...(history[2] ? { beforeEventId: history[2] } : {}) };
                else if (alerts && (alerts[1] === 'BEFORE' ? alerts[2] !== undefined : alerts[1] === 'REFRESH' ? alerts[2] === undefined : true)) request = { type: 'alerts', context,
                  ...(alerts[1] === 'READ' ? { markRead: true } : {}), ...(alerts[2] ? { beforeId: alerts[2] } : {}) };
                else if (nav && (nav[3] === undefined || Number(nav[3]) <= 1_000_000)) {
                  const type = nav[1]!;
                  if (type === 'company' && nav[2] && nav[3]) request = { type, context, symbol: nav[2], generation: Number(nav[3]) };
                  else if (type === 'financial' && nav[2] && nav[3]) request = { type: 'company', context, symbol: nav[2], generation: Number(nav[3]) };
                  else if (type === 'history') request = { type, context, limit: 4 };
                  else if (type === 'market' || type === 'portfolio' || type === 'performance' || type === 'funding' || type === 'calendar' || type === 'orders') request = { type, context };
                  else if (type === 'news') request = { type, context };
                  else if (type === 'economy') request = { type: 'market', context };
                }
              }
            }
          } else if (interaction.isChatInputCommand()) request = commandRequest(interaction, context);
          if (request === null) view = replyView(errorEmbed('INVALID_INPUT'));
          else {
            const response = await backend.execute(request);
            view = response.kind === 'ACCOUNT' ? renderNotice('PaperMarket · 모의계좌',
              `${renderPolicyNotice(operator)}\n\n보유 현금 ${displayNumber(response.account.cash)} · 초기자금 10,000은 시장별 한 번\n/market → 금액 매수 또는 /buy budget:1000 → 확인 → /portfolio · /history\n정기 모의 입금의 일정·누적액과 자동 입금 설정은 /funding에서 확인합니다.`)
              : response.kind === 'NEWS' ? renderNews(response.news, request.type === 'news' ? request.symbol : undefined)
                : response.kind === 'EXPORT' ? renderExport(response.export, request.type === 'export' ? request.format : 'CSV')
                  : response.kind === 'ALERTS' ? renderAlerts(response.alerts, request.type === 'alerts' ? request.beforeId : undefined)
                  : response.kind === 'STOCK' && interaction.isButton() && interaction.customId.startsWith('pm:view:financial:')
                    ? response.stock.financial ? renderFinancial(response.stock.financial, response.stock) : replyView(baseEmbed('공개 실적 안내', '이 종목 세대의 공개 실적 기록이 없습니다.'))
                    : response.kind === 'MARKET' && interaction.isButton() && interaction.customId === 'pm:view:economy'
                      ? response.market.economy ? renderEconomy(response.market.economy, response.market) : replyView(baseEmbed('경제 정보', '고정 시험 시세에는 공개 경제 지표가 없습니다.'))
                      : renderServiceResponse(response);
          }
        }
      }
    } catch (error) {
      // The only public exception is our local constant input error. SQL, paths, raw IDs and Discord tokens remain private.
      if (error instanceof Error && error.message === 'INVALID_INPUT') view = replyView(errorEmbed('INVALID_INPUT'));
      else { diagnose('BACKEND_FAILED'); view = replyView(errorEmbed('INTERNAL_ERROR')); }
    }
    // A failed Discord edit cannot roll back or retry a committed trade. /history and duplicate confirmation recover it.
    try { await acknowledged.editReply(view); } catch { diagnose('REPLY_FAILED'); }
  };
}
