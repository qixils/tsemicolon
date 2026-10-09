import { Client, Events, GatewayIntentBits, Partials, REST, Routes, type RESTPutAPIApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { isDeepStrictEqual } from 'util';
import { clearFeature } from './clear.js';
import { DATA_DIR, LEGACY_DATA_DIR, LEGACY_IMPORT_LOG } from './config.js';
import { closeDb } from './db.js';
import { FeatureRegistry, replyWithError } from './feature.js';
import { antispamFeature } from './features/antispam.js';
import { joinRoleFeature } from './features/join-role.js';
import { logsFeature } from './features/logs.js';
import { moderationFeature } from './features/moderation.js';
import { ownerFeature } from './features/owner.js';
import { pollFeature } from './features/poll.js';
import { remindersFeature } from './features/reminders.js';
import { reportsFeature } from './features/reports.js';
import { rolesFeature } from './features/roles.js';
import { rulesFeature } from './features/rules.js';
import { starboardFeature } from './features/starboard.js';
import { subscriptionsFeature } from './features/subscriptions.js';
import { t } from './i18n.js';
import { registerConfigImports } from './legacy/config-db.js';
import { runLegacyImports } from './legacy.js';
import { pokemonFeature } from './pokemon/commands.js';
import { registerPokemonImport } from './pokemon/legacy-import.js';
import { settingsFeature } from './settings.js';

const { CLIENT_ID, TOKEN } = process.env;
if (!CLIENT_ID) throw Error('No client id');
if (!TOKEN) throw Error('No token');

await mkdir(DATA_DIR, { recursive: true })

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // privileged: join/role/timeout logs and the member cache they diff against
    GatewayIntentBits.GuildMembers,
    // bans, unbans
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    // privileged: message logs and antispam read message text
    GatewayIntentBits.MessageContent,
    // admin DM commands
    GatewayIntentBits.DirectMessages,
  ],
  // events for things that aren't cached: reactions on old messages, deletions, DMs
  partials: [Partials.Channel, Partials.Message, Partials.Reaction, Partials.User, Partials.GuildMember],
  // nothing pings unless a message opts in explicitly
  allowedMentions: { parse: [], repliedUser: false },
});

let shuttingDown = false
const shutdown = async (reason: string) => {
  if (shuttingDown) return
  shuttingDown = true
  console.log(`Shutting down: ${reason}`)
  await client.destroy()
  closeDb()
  process.exit(0)
}

const registry = new FeatureRegistry([
  clearFeature,
  pokemonFeature,
  settingsFeature,
  logsFeature,
  starboardFeature,
  rulesFeature,
  reportsFeature,
  antispamFeature,
  joinRoleFeature,
  pollFeature,
  remindersFeature,
  moderationFeature,
  rolesFeature,
  subscriptionsFeature,
  ownerFeature(shutdown),
])

////////////////////
///// COMMANDS /////
////////////////////

const commands: RESTPutAPIApplicationCommandsJSONBody = registry.commands

const cmdsPath = "saved_commands.json"
let oldCommands: RESTPutAPIApplicationCommandsJSONBody = []
try {
  const file = await readFile(cmdsPath)
  const contents = file.toString('utf-8')
  oldCommands = JSON.parse(contents)
} catch {
  // pass
}

if (!isDeepStrictEqual(commands, oldCommands)) {
  const rest = new REST({ version: '10' }).setToken(TOKEN);

  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: commands });
    await writeFile(cmdsPath, JSON.stringify(commands))
  } catch (error) {
    console.error(error);
  }
}

///////////////////
///// STARTUP /////
///////////////////

registry.attach(client)
registerPokemonImport()
registerConfigImports()

client.once(Events.ClientReady, async readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}!`);
  // importers can look up servers and channels once the client is ready
  await runLegacyImports(LEGACY_DATA_DIR, LEGACY_IMPORT_LOG, readyClient)
    .catch(error => console.error('Legacy import failed:', error))
});

client.on(Events.InteractionCreate, async interaction => {
  try {
    await registry.dispatch(interaction)
  } catch (error) {
    console.error(`Interaction ${interaction.id} failed:`, error)
    // otherwise the user just sees "the application did not respond"
    await replyWithError(interaction, t([interaction.locale, interaction.guildLocale], 'error.generic')).catch(() => {})
  }
});

process.on('SIGINT', () => void shutdown('SIGINT'))
process.on('SIGTERM', () => void shutdown('SIGTERM'))

client.login(TOKEN);
