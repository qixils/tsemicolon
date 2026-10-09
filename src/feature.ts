import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  type APIApplicationCommandSubcommandGroupOption,
  type APIApplicationCommandSubcommandOption,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type Interaction,
  type MessageComponentInteraction,
  type MessageContextMenuCommandInteraction,
  type ModalSubmitInteraction,
  type RESTPostAPIApplicationCommandsJSONBody,
} from 'discord.js'
import { t, tAll, type MessageKey } from './i18n.js'

/** Returns localized description fields */
export const localizedDescription = (key: MessageKey) => ({
  description: t([], key),
  description_localizations: tAll(key),
})

export type ChatHandler = (interaction: ChatInputCommandInteraction) => Promise<unknown>
export type AutocompleteHandler = (interaction: AutocompleteInteraction) => Promise<unknown>
export type MessageMenuHandler = (interaction: MessageContextMenuCommandInteraction) => Promise<unknown>
/** `args` are the custom ID's colon-separated parts after the namespace. */
export type ComponentHandler = (interaction: MessageComponentInteraction, args: string[]) => Promise<unknown>
/** `args` are the custom ID's colon-separated parts after the namespace. */
export type ModalHandler = (interaction: ModalSubmitInteraction, args: string[]) => Promise<unknown>

/**
 * A module of the bot.
 * Handlers are invoked using `"command [group] subcommand"` for slash commands,
 * command name for context menus,
 * and namespaced `customId` for components and modals.
 */
export interface Feature {
  /** Discord command payloads */
  commands?: RESTPostAPIApplicationCommandsJSONBody[]
  /** Subcommands and subcommand groups contributed to `/setup` */
  setup?: (APIApplicationCommandSubcommandOption | APIApplicationCommandSubcommandGroupOption)[]
  /** Handlers for incoming chat commands */
  chat?: Record<string, ChatHandler>
  /** Handlers for incoming autocomplete interactions */
  autocomplete?: Record<string, AutocompleteHandler>
  /** Handlers for incoming message context menu interactions */
  messageMenus?: Record<string, MessageMenuHandler>
  /** Handlers for incoming component interactions */
  components?: Record<string, ComponentHandler>
  /** Handlers for incoming modal interactions */
  modals?: Record<string, ModalHandler>
  /** Hooks up event listeners and timers. Called once, before login. */
  attach?(client: Client): void
}

const SEPARATOR = ':'

/** Builds an ID for a persistent listener, given the ID of the listener and its arguments */
export const customId = (namespace: string, ...args: (string | number)[]) =>
  [namespace, ...args].join(SEPARATOR)

const commandKey = (interaction: ChatInputCommandInteraction | AutocompleteInteraction) =>
  [
    interaction.commandName,
    interaction.options.getSubcommandGroup(false),
    interaction.options.getSubcommand(false),
  ].filter(Boolean).join(' ')

export class FeatureRegistry {
  private readonly chat = new Map<string, ChatHandler>()
  private readonly autocomplete = new Map<string, AutocompleteHandler>()
  private readonly messageMenus = new Map<string, MessageMenuHandler>()
  private readonly components = new Map<string, ComponentHandler>()
  private readonly modals = new Map<string, ModalHandler>()
  private readonly commandList: RESTPostAPIApplicationCommandsJSONBody[] = []
  private readonly setupOptions: NonNullable<Feature['setup']> = []

  constructor(private readonly features: Feature[]) {
    for (const feature of features) {
      this.commandList.push(...feature.commands ?? [])
      this.setupOptions.push(...feature.setup ?? [])
      for (const [key, handler] of Object.entries(feature.chat ?? {})) this.add(this.chat, key, handler)
      for (const [key, handler] of Object.entries(feature.autocomplete ?? {})) this.add(this.autocomplete, key, handler)
      for (const [key, handler] of Object.entries(feature.messageMenus ?? {})) this.add(this.messageMenus, key, handler)
      for (const [key, handler] of Object.entries(feature.components ?? {})) this.add(this.components, key, handler)
      for (const [key, handler] of Object.entries(feature.modals ?? {})) this.add(this.modals, key, handler)
    }
  }

  private add<T>(map: Map<string, T>, key: string, value: T) {
    if (map.has(key)) throw new Error(`Duplicate handler for "${key}"`)
    map.set(key, value)
  }

  /** Gets every command to register with Discord */
  get commands(): RESTPostAPIApplicationCommandsJSONBody[] {
    if (this.setupOptions.length === 0) return this.commandList
    return [
      ...this.commandList,
      {
        name: 'setup',
        ...localizedDescription('command.setup.description'),
        type: ApplicationCommandType.ChatInput,
        default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
        contexts: [InteractionContextType.Guild],
        options: [...this.setupOptions].sort((a, b) =>
          // Discord lists them in registration order; alphabetical is easier to read
          Number(a.type === ApplicationCommandOptionType.SubcommandGroup) - Number(b.type === ApplicationCommandOptionType.SubcommandGroup)
          || a.name.localeCompare(b.name)),
      },
    ]
  }

  attach(client: Client) {
    for (const feature of this.features) feature.attach?.(client)
  }

  async dispatch(interaction: Interaction) {
    if (interaction.isChatInputCommand()) {
      return await this.chat.get(commandKey(interaction))?.(interaction)
    }
    if (interaction.isAutocomplete()) {
      return await this.autocomplete.get(commandKey(interaction))?.(interaction)
    }
    if (interaction.isMessageContextMenuCommand()) {
      return await this.messageMenus.get(interaction.commandName)?.(interaction)
    }
    if (interaction.isMessageComponent()) {
      const [namespace = '', ...args] = interaction.customId.split(SEPARATOR)
      return await this.components.get(namespace)?.(interaction, args)
    }
    if (interaction.isModalSubmit()) {
      const [namespace = '', ...args] = interaction.customId.split(SEPARATOR)
      return await this.modals.get(namespace)?.(interaction, args)
    }
  }
}

/** Tells the user something went wrong */
export const replyWithError = async (interaction: Interaction, content: string) => {
  if (!interaction.isRepliable()) return
  const reply = { content, flags: MessageFlags.Ephemeral } as const
  if (interaction.deferred || interaction.replied) await interaction.followUp(reply)
  else await interaction.reply(reply)
}
