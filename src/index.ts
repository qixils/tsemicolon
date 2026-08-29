import { ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction, Client, CommandInteraction, Events, GatewayIntentBits, MessageFlags, REST, Routes, type APIApplicationCommand, type RESTPutAPIApplicationCommandsJSONBody } from 'discord.js';
import 'dotenv/config';
import { readFile, writeFile } from 'fs/promises';
import { isDeepStrictEqual } from 'util';
import { handleClearAfter } from './clear.js';

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
            type: ApplicationCommandOptionType.Integer,
            required: true,
          },
          {
            name: 'before',
            description: 'Message ID to delete to',
            type: ApplicationCommandOptionType.Integer,
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
}

client.on(Events.InteractionCreate, async interaction => {
  if (interaction.isChatInputCommand()) {
    const cmd = chatCommands[interaction.commandName]
    if (cmd) await cmd(interaction)
  }
});

client.login(TOKEN);
