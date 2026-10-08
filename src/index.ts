import { ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction, Client, CommandInteraction, Events, GatewayIntentBits, MessageFlags, REST, Routes, type APIApplicationCommand, type RESTPutAPIApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { isDeepStrictEqual } from 'util';
import { handleClearAfter, handleClearCount } from './clear.js';
import { DATA_DIR, LEGACY_DATA_DIR, LEGACY_IMPORT_LOG } from './config.js';
import { runLegacyImports } from './legacy.js';
import { handlePokemonCatch, handlePokemonLeaderboard, handlePokemonSearch } from './pokemon/commands.js';
import { startDex } from './pokemon/dex.js';
import { registerPokemonImport } from './pokemon/legacy-import.js';

const { CLIENT_ID, TOKEN } = process.env;
if (!CLIENT_ID) throw Error('No client id');
if (!TOKEN) throw Error('No token');

////////////////////
///// COMMANDS /////
////////////////////

const commands: RESTPutAPIApplicationCommandsJSONBody = [
  {
    name: 'clear',
    description: 'Delete messages',
    options: [
      {
        name: 'amount',
        description: 'Clear a number of messages',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'amount',
            description: 'Amount of messages to clear',
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1,
            max_value: 2000,
          },
        ],
      },
      {
        name: 'after',
        description: 'Clear messages between an ID range',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'after',
            description: 'Message ID to delete from',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'before',
            description: 'Message ID to delete to',
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      }
    ]
  },
  {
    name: 'role',
    description: 'Pick roles to apply',
    options: [
      {
        name: 'color',
        description: 'Pick a color role to apply if available',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'flair',
        description: 'Pick an optional role to apply if available',
        type: ApplicationCommandOptionType.Subcommand,
      },
    ],
  },
  {
    name: 'pokemon',
    description: 'Become a virtual Pokémon Trainer',
    options: [
      {
        name: 'catch',
        description: 'Catch a Pokémon! Once per minute',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'leaderboard',
        description: 'Display the top Pokémon trainers',
        type: ApplicationCommandOptionType.Subcommand,
      },
      {
        name: 'search',
        description: 'Look up a Pokémon',
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'pokemon',
            description: 'Name or Pokédex ID of the Pokémon',
            type: ApplicationCommandOptionType.String,
            required: true,
          },
        ],
      },
    ],
  },

];

// register commands

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

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.on(Events.ClientReady, readyClient => {
  console.log(`Logged in as ${readyClient.user.tag}!`);
});

const chatCommands: Record<string, (interaction: ChatInputCommandInteraction) => Promise<any>> = {
  'clear after': handleClearAfter,
  'clear amount': handleClearCount,
  'pokemon catch': handlePokemonCatch,
  'pokemon leaderboard': handlePokemonLeaderboard,
  'pokemon search': handlePokemonSearch,
}

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return

  const subcommand = interaction.options.getSubcommand(false)
  const key = subcommand ? `${interaction.commandName} ${subcommand}` : interaction.commandName
  const cmd = chatCommands[key]
  if (!cmd) return

  try {
    await cmd(interaction)
  } catch (error) {
    console.error(`Command "${key}" failed:`, error)
    // otherwise the user just sees "the application did not respond"
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral } as const
    await (interaction.deferred || interaction.replied
      ? interaction.followUp(reply)
      : interaction.reply(reply)).catch(() => {})
  }
});

///////////////////
///// STARTUP /////
///////////////////

await mkdir(DATA_DIR, { recursive: true })
registerPokemonImport()

// download pokedex in the background
startDex()
  .then(async dex => {
    console.log(`Loaded ${dex.entries.size} Pokémon (${dex.totalVariants} variants)`)
    await runLegacyImports(LEGACY_DATA_DIR, LEGACY_IMPORT_LOG)
  })
  .catch(error => console.error('Pokémon startup failed:', error))

client.login(TOKEN);

