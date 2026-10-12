import { Client, Events, GatewayIntentBits, Partials, REST, Routes, type RESTPutAPIApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { DATA_DIR, LEGACY_DATA_DIR, LEGACY_IMPORT_LOG, OWNER_ID } from './config.js';
import { closeDb, migrateAll } from './db.js';
import { FeatureRegistry, replyWithError } from './feature.js';
import { antispamFeature } from './features/antispam.js';
import { clearFeature } from './features/clear.js';
import { htstemFeature } from './features/htstem.js';
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
import { registerDefaultChannelLinks, settingsFeature } from './settings.js';
import { join } from 'node:path';

const { APPLICATION_ID, TOKEN } = process.env;
if (!APPLICATION_ID) throw Error('No client id');
if (!TOKEN) throw Error('No token');

await mkdir(DATA_DIR, { recursive: true })

// to avoid nested transactions let's initialize all tables & migrations early
migrateAll()

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    // bans, unbans
    GatewayIntentBits.GuildModeration,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
    // admin DM commands
    GatewayIntentBits.DirectMessages,
    // privileged: join/role/timeout logs and the member cache they diff against
    // TODO GatewayIntentBits.GuildMembers,
    // privileged: message logs and antispam read message text
    // TODO GatewayIntentBits.MessageContent,
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

// annotated since the owner feature refers back to it
const registry: FeatureRegistry = new FeatureRegistry([
  clearFeature,
  pokemonFeature,
  settingsFeature,
  logsFeature,
  starboardFeature,
  rulesFeature,
  reportsFeature,
  // TODO antispamFeature,
  joinRoleFeature,
  pollFeature,
  remindersFeature,
  moderationFeature,
  rolesFeature,
  subscriptionsFeature,
  ...(OWNER_ID === '140564059417346049' ? [htstemFeature] : []),
  ownerFeature(shutdown, {
    guild: (id, client) => registry.forgetGuild(id, client),
    user: (id, client) => registry.forgetUser(id, client),
  }),
])

////////////////////
///// COMMANDS /////
////////////////////

const GLOBAL = 'global'
/** map of server ID or {@link GLOBAL} to commands body */
type CommandScopes = Record<string, RESTPutAPIApplicationCommandsJSONBody>

const commands: CommandScopes = { [GLOBAL]: registry.commands, ...registry.guildCommands }

const cmdsPath = join(DATA_DIR, "saved_commands.json")
let oldCommands: CommandScopes = {}
try {
  const file = await readFile(cmdsPath)
  const contents = JSON.parse(file.toString('utf-8'))
  // older saves only held the global command list
  oldCommands = Array.isArray(contents) ? { [GLOBAL]: contents } : contents
} catch {
  // pass
}

const savedCommands: CommandScopes = { ...oldCommands }
const rest = new REST({ version: '10' }).setToken(TOKEN);
// includes old scopes so servers that lost all their commands get cleared
for (const scope of new Set([...Object.keys(commands), ...Object.keys(oldCommands)])) {
  const body = commands[scope] ?? []
  if (isDeepStrictEqual(body, oldCommands[scope] ?? [])) continue

  try {
    const route = scope === GLOBAL ? Routes.applicationCommands(APPLICATION_ID) : Routes.applicationGuildCommands(APPLICATION_ID, scope)
    await rest.put(route, { body });
    if (body.length > 0) savedCommands[scope] = body
    else delete savedCommands[scope]
  } catch (error) {
    console.error(`Failed to register ${scope} commands:`, error);
  }
}

if (!isDeepStrictEqual(savedCommands, oldCommands)) await writeFile(cmdsPath, JSON.stringify(savedCommands))

///////////////////
///// STARTUP /////
///////////////////

registry.attach(client)
registerPokemonImport()
registerConfigImports()
registerDefaultChannelLinks()

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
