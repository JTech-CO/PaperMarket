import { ChannelType, Client, Events, GatewayIntentBits } from 'discord.js';
import { createInteractionHandler } from '../discord/handler.js';
import { renderMarket } from '../discord/render.js';
import { WorkerBackend } from './backend.js';
import { readRuntimeConfig } from './config.js';
import { diagnostic } from './diagnostics.js';
import { MarketBoardPublisher } from './boards.js';
import { NotificationPublisher, renderNotification } from '../notifications/publisher.js';
import { BackupRuntime } from '../ops/backup-runtime.js';
import { OperationalMetrics } from '../ops/metrics.js';

async function run(): Promise<void> {
  const config = readRuntimeConfig();
  const metrics=new OperationalMetrics();
  let fatalHandler: (() => void) | undefined;
  const backend = new WorkerBackend({ databasePath: config.databasePath, identityKey: config.identityKey,
    economySeed: config.economySeed,
    onObservation:(value)=>{
      metrics.increment('requests');metrics.observe(({QUERY:'queryMs',FINANCIAL:'financialMs',TICK:'tickMs',BACKGROUND:'backgroundMs'} as const)[value.operation],value.elapsedMs);
      if(value.serviceMs!==undefined)metrics.observe('workerServiceMs',value.serviceMs);
      if(value.queueAndTransportMs!==undefined)metrics.observe('queueAndTransportMs',value.queueAndTransportMs);
      if(value.outcome==='ERROR')metrics.increment('errors');
      if(value.outcome==='BUSY')metrics.increment(value.gateRejected?'gateBusy':'databaseBusy');
      if(value.integrityFailure)metrics.increment('integrityFailures');
    },
    onDiagnostic:(code)=>{diagnostic(code);if(code==='ZERO_CORPORATE_REFERENCE')metrics.increment('zeroCorporateReference');},
    onOperationalState:(state)=>{if(!state){diagnostic('OPERATIONAL_STATUS_UNAVAILABLE');return;}process.stderr.write(`${JSON.stringify({code:'OPERATIONAL_STATUS',timestamp:new Date().toISOString(),...state})}\n`);},
    onUnexpectedExit: () => {
      diagnostic('REPOSITORY_WORKER_EXITED'); process.exitCode = 1; fatalHandler?.();
    },
  });
  try { await backend.start(); }
  catch { await backend.close(); throw new Error('Repository startup failed'); }
  const backups=new BackupRuntime({databasePath:config.databasePath,backupDirectory:config.backupDirectory,backupKey:config.backupKey,identityKey:config.identityKey,economySeed:config.economySeed,...(config.backupMirrorDirectory?{mirrorDirectory:config.backupMirrorDirectory}:{}),
    onObservation:value=>{if(value.created||value.failed)metrics.observe('backupMs',value.elapsedMs);if(value.created)diagnostic('BACKUP_VERIFIED');if(value.mirrored)diagnostic('BACKUP_MIRRORED');if(value.rehearsed)diagnostic('BACKUP_REHEARSAL_VERIFIED');},
    onFailure:()=>{metrics.increment('backupFailures');diagnostic('BACKUP_FAILED');}});
  try{await backups.start();}catch{await backups.stop();await backend.close();throw new Error('Backup startup failed');}
  const client = new Client({ intents: [GatewayIntentBits.Guilds], allowedMentions: { parse: [] } });
  const handler = createInteractionHandler(backend, { operator: config.operator, onDiagnostic: diagnostic,onDefer:elapsed=>metrics.observe('deferMs',elapsed) });
  client.on(Events.InteractionCreate, (interaction) => {
    // This trial installation is confined to the operator's configured guild.
    if (interaction.guildId !== config.guildId && interaction.isRepliable()) {
      void interaction.reply({ content: '이 시험 봇은 지정된 서버에서만 이용할 수 있습니다.', flags: 64, allowedMentions: { parse: [] } })
        .catch(() => diagnostic('INTERACTION_RESPONSE_FAILED'));
      return;
    }
    void handler(interaction).catch(() => diagnostic('INTERACTION_HANDLER_FAILED'));
  });
  client.once(Events.ClientReady, () => diagnostic('TRIAL_BOT_READY'));
  client.on(Events.Error, () => diagnostic('DISCORD_CLIENT_ERROR'));
  client.on(Events.Warn, () => diagnostic('DISCORD_CLIENT_WARNING'));

  const boards = new MarketBoardPublisher(async (market) => {
    if (!market.channelId || !market.boardMessageId) return;
    const channel = await client.channels.fetch(market.channelId);
    if (!channel || channel.type !== ChannelType.GuildText || channel.guildId !== config.guildId) return;
    const board = await channel.messages.fetch(market.boardMessageId);
    if (board.author.id !== client.user?.id) return;
    await board.edit(renderMarket(market));
  }, () => diagnostic('MARKET_BOARD_UPDATE_FAILED'));

  const notifications = new NotificationPublisher(backend,async (delivery)=>{
    if(delivery.guildId!==config.guildId) throw new Error('Notification guild is unavailable');
    // The repository resolved this target from the authenticated account's explicit DM consent.
    await client.users.send(delivery.discordUserId,renderNotification(delivery));
  },{onFailure:()=>{metrics.increment('notificationFailures');diagnostic('PERSONAL_NOTIFICATION_DELIVERY_FAILED');},onRetryAfter:()=>metrics.increment('discord429')});
  const notificationInterval=setInterval(()=>{
    if(client.isReady()) void notifications.flush();
  },1000);
  notificationInterval.unref();
  const metricsInterval=setInterval(()=>{process.stderr.write(`${JSON.stringify({code:'OPERATIONAL_METRICS',timestamp:new Date().toISOString(),...metrics.snapshot()})}\n`);},60_000);
  metricsInterval.unref();

  let ticking = false;
  const interval = setInterval(() => {
    if (ticking) return;
    ticking = true;
    void (async () => {
      const response = await backend.execute({ type: 'tick', now: new Date().toISOString() });
      if (response.kind === 'ERROR') { diagnostic('MARKET_TICK_FAILED'); return; }
      if (response.kind !== 'TICKED') return;
      boards.enqueue(response.markets);
    })().catch(() => diagnostic('MARKET_TICK_FAILED')).finally(() => { ticking = false; });
  }, 1000);
  interval.unref();

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) return;
    stopping = true;
    clearInterval(interval);clearInterval(notificationInterval);clearInterval(metricsInterval);boards.stop();notifications.stop();await client.destroy();await backups.stop();await backend.close();
  };
  fatalHandler = () => { void stop().catch(() => diagnostic('SHUTDOWN_FAILED')); };
  process.once('SIGINT', () => { void stop().catch(() => diagnostic('SHUTDOWN_FAILED')); });
  process.once('SIGTERM', () => { void stop().catch(() => diagnostic('SHUTDOWN_FAILED')); });
  try { await client.login(config.botToken); }
  catch { await stop(); throw new Error('Discord login failed'); }
}

void run().catch(() => { diagnostic('STARTUP_FAILED_CHECK_CONFIGURATION'); process.exitCode = 1; });
