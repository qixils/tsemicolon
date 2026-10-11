import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  MessageFlags,
  OverwriteType,
  PermissionFlagsBits,
  type APIApplicationCommandSubcommandOption,
  type ChatInputCommandInteraction,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type MessageComponentInteraction,
  type OverwriteResolvable,
  type PermissionResolvable,
} from 'discord.js'
import { withSchema } from './db.js'
import { customId, localizedDescription, localizedName, type ChatHandler, type Feature } from './feature.js'
import { t, type MaybeLocales, type MessageKey } from './i18n.js'
import { SENDABLE_TEXT_CHANNEL_TYPES, postableChannel } from './util/discord.js'

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (guild_id, key)
  ) WITHOUT ROWID;
`)

/** Per-server configuration */
export interface Settings {
  /** Channel to report joins, leaves, etc */
  joinlog_channel: string
  /** Channel to report name changes, if not the joinlog */
  namelog_channel: string
  /** Channel to report message edits and deletions */
  messagelog_channel: string
  /** Channel to report members gaining or losing roles */
  rolelog_channel: string
  /** Channel to share messages reported by members */
  reports_channel: string
  /** Channel to share when a user is flagged by antispam */
  antispam_channel: string
  /** Identical messages within the window before the sender is timed out; 0 to disable */
  antispam_threshold: number
  /** Users whose edits and deletions aren't logged */
  messagelog_ignored: string[]
  /** Given to members once they've agreed to the rules */
  join_role: string
}
export type SettingKey = keyof Settings

export const getSetting = <K extends SettingKey>(guildId: string, key: K): Settings[K] | undefined => {
  const row = db().prepare('SELECT value FROM guild_settings WHERE guild_id = ? AND key = ?').get(guildId, key)
  return row ? JSON.parse(String(row['value'])) as Settings[K] : undefined
}

export const setSetting = <K extends SettingKey>(guildId: string, key: K, value: Settings[K]) => {
  db().prepare(`
    INSERT INTO guild_settings (guild_id, key, value) VALUES (?, ?, ?)
    ON CONFLICT (guild_id, key) DO UPDATE SET value = excluded.value
  `).run(guildId, key, JSON.stringify(value))
}

export const clearSetting = (guildId: string, key: SettingKey) => {
  db().prepare('DELETE FROM guild_settings WHERE guild_id = ? AND key = ?').run(guildId, key)
}

/** The configured channel for `key`, if it exists and the bot can post there */
export const getSettingChannel = (
  guild: Guild,
  key: 'joinlog_channel' | 'namelog_channel' | 'messagelog_channel' | 'rolelog_channel' | 'reports_channel' | 'antispam_channel',
  extra: PermissionResolvable[] = [],
): GuildTextBasedChannel | null => postableChannel(guild, getSetting(guild.id, key), extra)

/** Generates the channel-setting option for config commands */
export const channelSubcommand = (name: MessageKey, description: MessageKey): APIApplicationCommandSubcommandOption => ({
  type: ApplicationCommandOptionType.Subcommand,
  ...localizedName(name),
  ...localizedDescription(description),
  options: [{
    type: ApplicationCommandOptionType.Channel,
    ...localizedName('command.setup.option.channel.name'),
    ...localizedDescription('command.setup.option.channel.description'),
    channel_types: SENDABLE_TEXT_CHANNEL_TYPES,
  }],
})

export interface ChannelSetup {
  setting: 'joinlog_channel' | 'namelog_channel' | 'messagelog_channel' | 'rolelog_channel' | 'reports_channel'
  /** Name used when the bot has to create the channel */
  defaultName: string
  topic: MessageKey
  /** Hides the channel from everyone but moderators */
  private?: boolean
  /** Confirmation message key. Translated with `{channel}`. */
  done: MessageKey
  /** Generates extra advice appended to the confirmation such as recommended permissions, given the guild and the viewer's locales */
  notes?: (guild: Guild, locales: MaybeLocales) => string[]
}

const NAMESPACE = 'setupchannel'

/** Every channel setup by the setting it configures */
const channelSetups = new Map<string, ChannelSetup>()

const isModeratorRole = (permissions: Readonly<{ has(permission: PermissionResolvable): boolean }>) =>
  permissions.has(PermissionFlagsBits.Administrator)
  || permissions.has([PermissionFlagsBits.KickMembers, PermissionFlagsBits.ManageMessages])

/**
 * Makes a channel for `setup`, next to the one the user is in.
 * `hidden` limits it to moderators.
 */
const createChannel = (
  interaction: ChatInputCommandInteraction<'cached'> | MessageComponentInteraction<'cached'>,
  me: GuildMember,
  setup: ChannelSetup,
  hidden: boolean,
) => {
  const { guild } = interaction
  const self = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory]
  const overwrites: OverwriteResolvable[] = hidden
    ? [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        { id: me.id, type: OverwriteType.Member, allow: self },
        ...guild.roles.cache
          .filter(role => role.id !== guild.roles.everyone.id && isModeratorRole(role.permissions))
          .map(role => ({ id: role.id, allow: [PermissionFlagsBits.ViewChannel] })),
      ]
    : [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.SendMessages] },
        { id: me.id, type: OverwriteType.Member, allow: self },
      ]

  const parent = interaction.channel && !interaction.channel.isThread() ? interaction.channel.parent : null
  return guild.channels.create({
    name: setup.defaultName,
    type: ChannelType.GuildText,
    topic: t(interaction.guildLocale, setup.topic),
    parent,
    permissionOverwrites: overwrites,
    reason: t(interaction.guildLocale, 'audit.requested_by', { user: interaction.user.tag }),
  })
}

/** Sets a feature to use this channel or reports why it's unusable */
const assignChannel = (
  guild: Guild,
  locales: MaybeLocales,
  setup: ChannelSetup,
  channel: GuildTextBasedChannel,
  created?: 'public' | 'private',
) => {
  if (!postableChannel(guild, channel.id, [PermissionFlagsBits.EmbedLinks])) {
    return t(locales, 'setup.channel_unusable', { channel: channel.toString() })
  }
  setSetting(guild.id, setup.setting, channel.id)
  const lines = [t(locales, setup.done, { channel: channel.toString() })]
  if (created) lines.push(t(locales, 'setup.channel_created'))
  lines.push(...setup.notes?.(guild, locales) ?? [])
  return lines.join('\n')
}

/** Offers to create the channel, potentially as private to moderators */
const createButtons = (setup: ChannelSetup, locales: MaybeLocales) => {
  const button = (visibility: 'public' | 'private', style: ButtonStyle) => new ButtonBuilder()
    .setCustomId(customId(NAMESPACE, setup.setting, visibility))
    .setLabel(t(locales, visibility === 'private' ? 'setup.create_private_channel' : 'setup.create_public_channel'))
    .setStyle(style)
  return new ActionRowBuilder<ButtonBuilder>().addComponents(setup.private
    ? [button('private', ButtonStyle.Primary)]
    : [button('public', ButtonStyle.Primary), button('private', ButtonStyle.Secondary)])
}

/**
 * Sets a configured channel or offers to create one
 */
export const configureChannel = (setup: ChannelSetup): ChatHandler => {
  if (channelSetups.has(setup.setting)) throw new Error(`Duplicate channel setup for "${setup.setting}"`)
  channelSetups.set(setup.setting, setup)

  return async interaction => {
    if (!interaction.inCachedGuild()) return
    const { guild } = interaction
    const locales = [interaction.locale, interaction.guildLocale]
    const me = guild.members.me
    if (!me) return

    const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement])
      ?? guild.channels.cache.find((existing): existing is GuildTextBasedChannel =>
        existing.type === ChannelType.GuildText && existing.name === setup.defaultName)
    if (channel) {
      await interaction.reply({ content: assignChannel(guild, locales, setup, channel), flags: MessageFlags.Ephemeral })
      return
    }

    const existing = getSettingChannel(guild, setup.setting)
    if (existing) {
      await interaction.reply({ content: t(locales, "setup.existing_channel", { channel: existing.toString() }), flags: MessageFlags.Ephemeral })
      return
    }

    if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
      await interaction.reply({ content: t(locales, 'setup.cannot_create_channel'), flags: MessageFlags.Ephemeral })
      return
    }

    await interaction.reply({
      content: t(locales, 'setup.offer_channel', { name: setup.defaultName }),
      components: [createButtons(setup, locales)],
      flags: MessageFlags.Ephemeral,
    })
  }
}

const DISABLEABLE: Record<string, { name: MessageKey, keys: SettingKey[], note?: MessageKey }> = {
  joinlog: { name: 'command.setup.joinlog.name', keys: ['joinlog_channel'] },
  namelog: { name: 'command.setup.namelog.name', keys: ['namelog_channel'], note: 'setup.disabled.note.namelog' },
  messagelog: { name: 'command.setup.messagelog.name', keys: ['messagelog_channel'] },
  rolelog: { name: 'command.setup.rolelog.name', keys: ['rolelog_channel'] },
  reports: { name: 'command.setup.reports.name', keys: ['reports_channel'] },
  antispam: { name: 'command.setup.antispam.name', keys: ['antispam_threshold', 'antispam_channel'] },
  joinrole: { name: 'command.setup.joinrole.name', keys: ['join_role'] },
}

export const settingsFeature: Feature = {
  setup: [{
    type: ApplicationCommandOptionType.Subcommand,
    ...localizedName('command.setup.disable.name'),
    ...localizedDescription('command.setup.disable.description'),
    options: [{
      type: ApplicationCommandOptionType.String,
      ...localizedName('command.setup.disable.option.feature.name'),
      ...localizedDescription('command.setup.disable.option.feature.description'),
      required: true,
      choices: Object.entries(DISABLEABLE).map(([value, { name }]) => ({ ...localizedName(name), value })),
    }],
  }],
  chat: {
    'setup disable': async interaction => {
      if (!interaction.inCachedGuild()) return
      const feature = interaction.options.getString('feature', true)
      const data = DISABLEABLE[feature]
      for (const key of data?.keys ?? []) clearSetting(interaction.guildId, key);

      const locales = [interaction.locale, interaction.guildLocale]
      let content = t(locales, 'setup.disabled', { feature: data ? t(locales, data.name) : feature })
      if (data?.note) content += t(locales, data.note);

      await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    },
  },
  components: {
    /** listener for channel setup buttons */
    [NAMESPACE]: async (interaction, [setting = '', visibility]) => {
      if (!interaction.inCachedGuild()) return
      const setup = channelSetups.get(setting)
      const me = interaction.guild.members.me
      if (!setup || !me) return
      const locales = [interaction.locale, interaction.guildLocale]

      // the permission may have been taken away since the buttons were offered
      if (!me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        await interaction.update({ content: t(locales, 'setup.cannot_create_channel'), components: [] })
        return
      }
      const hidden = visibility === 'private'
      const channel = await createChannel(interaction, me, setup, hidden)
      await interaction.update({
        content: assignChannel(interaction.guild, locales, setup, channel, hidden ? 'private' : 'public'),
        components: [],
      })
    },
  },
}
