import { REST, Routes } from 'discord.js';
import { buildCommands } from '../discord/commands.js';
import { readRuntimeConfig } from './config.js';
import { diagnostic } from './diagnostics.js';

async function register(): Promise<void> {
  const config = readRuntimeConfig();
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  await rest.put(Routes.applicationGuildCommands(config.applicationId, config.guildId), {
    body: buildCommands().map((command) => command.toJSON()),
  });
  diagnostic('GUILD_COMMANDS_REGISTERED');
}

void register().catch(() => { diagnostic('COMMAND_REGISTRATION_FAILED'); process.exitCode = 1; });
