import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  EmbedBuilder,
  Events,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  escapeMarkdown,
  type Message,
} from 'discord.js'
import { customId, localizedDescription, type Feature } from '../feature.js'
import { t } from '../i18n.js'
import { notifyMuted } from './moderation.js'
import { clearSetting, getSetting, setSetting, settingChannel } from '../settings.js'
import { SENDABLE_TEXT_CHANNEL_TYPES, postableChannel, truncate } from '../util/discord.js'
import { lookupPluralKit } from '../util/pluralkit.js'

const NAMESPACE = 'antispam'
/** Repeats count toward the threshold until this long after the latest one */
const WINDOW_MILLIS = 20 * 1000
/** How long to automatically mute for */
const TIMEOUT_MILLIS = 15 * 60 * 1000
/** Embed color */
const ALERT_COLOR = 0xde3d28

interface Streak {
  messages: Map<string, Message<true>>
  updated: number
}
const streaks = new Map<string, Streak>()

/**
 * Returns the unique content identifying this message.
 * When the message has no content, it returns the filenames of any attached files,
 * ONLY if more than 1 is attached (to avoid someone getting muted for say,
 * dumping a meme collection all named "untitled" or whatever)
 */
const fingerprint = (message: Message<true>): string => {
  // TODO: is there ever a context we want to handle bots?
  if (message.author.bot) return ''

  const prefix = `${message.guildId}:${message.author.id}`

  if (message.content.trim()) return `${prefix}:text:${message.content}`

  const images = [...message.attachments.values()].filter(attachment =>
    attachment.contentType?.startsWith('image/') ?? /\.(png|jpe?g|gif|webp)$/i.test(attachment.name))
  if (images.length > 1) return `${prefix}:images:${images.map(image => image.name).sort().join('/')}`

  return '' // !?
}

const alertChannel = (message: Message<true>) =>
  settingChannel(message.guild, 'antispam_channel') ?? settingChannel(message.guild, 'reports_channel')

/** Removes a message along with PluralKit's repost of it */
const purge = async (message: Message<true>) => {
  await message.delete().catch(() => {})
  // TODO: sleep?
  const proxy = await lookupPluralKit(message.id)
  if (proxy?.original === message.id) await message.channel.messages.delete(proxy.id).catch(() => {})
}

const punish = async (message: Message<true>, messages: Message<true>[]) => {
  const alert = alertChannel(message)
  if (!alert) return
  const locales = [message.guild.preferredLocale]
  const { member } = message
  if (member?.moderatable) {
    const reason = t(locales, 'antispam.reason')
    await member.timeout(TIMEOUT_MILLIS, reason)
    await notifyMuted(member, new Date(Date.now() + TIMEOUT_MILLIS), reason)
  }
  await Promise.all(messages.map(purge))

  const sample = message.content.trim()
    ? truncate(message.content, 1024)
    : [...message.attachments.values()].map(attachment => attachment.name).join('\n')
  const embed = new EmbedBuilder()
    .setColor(ALERT_COLOR)
    .setAuthor({ name: message.author.tag, iconURL: message.author.displayAvatarURL({ extension: 'png', size: 128 }) })
    .setDescription(sample)
    .setFooter({ text: t(locales, 'antispam.footer', { count: messages.length }) })
    .setTimestamp(message.createdAt)
  const lift = new ButtonBuilder()
    .setCustomId(customId(NAMESPACE, 'lift', message.author.id))
    .setStyle(ButtonStyle.Secondary)
    .setLabel(t(locales, 'antispam.lift'))

  await alert.send({
    content: `@here ${t(locales, member?.moderatable ? 'antispam.alert' : 'antispam.alert_untouchable', {
      user: message.author.toString(),
      tag: escapeMarkdown(message.author.tag),
      channel: message.channel.toString(),
    })}`,
    embeds: [embed],
    components: member?.moderatable ? [new ActionRowBuilder<ButtonBuilder>().addComponents(lift)] : [],
    // the alert exists to get moderators' attention
    allowedMentions: { parse: ['everyone'] },
  })
}

const onMessage = async (message: Message) => {
  if (!message.inGuild() || message.author.bot || message.webhookId || !message.member) return
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return

  const threshold = getSetting(message.guildId, 'antispam_threshold') ?? 0
  if (threshold <= 0) return
  if (message.member.permissions.has(PermissionFlagsBits.BanMembers)) return
  if (!message.guild.members.me?.permissions.has([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages])) return
  if (!alertChannel(message)) return

  const print = fingerprint(message)
  if (!print) return

  const streak = streaks.get(print) ?? { messages: new Map(), updated: 0 }
  streak.messages.set(message.id, message)
  streak.updated = Date.now()
  streaks.set(print, streak)

  if (streak.messages.size >= threshold) {
    // forget all of this user's streaks so we don't accidentally trigger twice
    const prefix = `${message.guildId}:${message.author.id}:`
    for (const key of streaks.keys()) if (key.startsWith(prefix)) streaks.delete(key)
    await punish(message, [...streak.messages.values()])
    return
  }
}

export const antispamFeature: Feature = {
  setup: [{
    type: ApplicationCommandOptionType.Subcommand,
    name: 'antispam',
    ...localizedDescription('command.setup.antispam.description'),
    options: [
      {
        type: ApplicationCommandOptionType.Integer,
        name: 'threshold',
        ...localizedDescription('command.setup.antispam.option.threshold'),
        required: true,
        min_value: 0,
        max_value: 50,
      },
      {
        type: ApplicationCommandOptionType.Channel,
        name: 'channel',
        ...localizedDescription('command.setup.antispam.option.channel'),
        channel_types: SENDABLE_TEXT_CHANNEL_TYPES,
      },
    ],
  }],
  chat: {
    'setup antispam': async interaction => {
      if (!interaction.inCachedGuild()) return
      const { guild } = interaction
      const locales = [interaction.locale, interaction.guildLocale]
      const threshold = interaction.options.getInteger('threshold', true)
      const channel = interaction.options.getChannel('channel', false, [ChannelType.GuildText, ChannelType.GuildAnnouncement])

      if (threshold === 0) {
        clearSetting(guild.id, 'antispam_threshold')
        await interaction.reply({ content: t(locales, 'setup.antispam.disabled'), flags: MessageFlags.Ephemeral })
        return
      }
      if (channel && !postableChannel(guild, channel.id, [PermissionFlagsBits.EmbedLinks])) {
        await interaction.reply({ content: t(locales, 'setup.channel_unusable', { channel: channel.toString() }), flags: MessageFlags.Ephemeral })
        return
      }

      setSetting(guild.id, 'antispam_threshold', threshold)
      if (channel) setSetting(guild.id, 'antispam_channel', channel.id)

      const destination = settingChannel(guild, 'antispam_channel') ?? settingChannel(guild, 'reports_channel')
      const lines = [t(locales, 'setup.antispam.done', { count: threshold })]
      lines.push(destination ? t(locales, 'setup.antispam.alerts_to', { channel: destination.toString() }) : t(locales, 'setup.antispam.no_channel'))
      if (!guild.members.me?.permissions.has([PermissionFlagsBits.ModerateMembers, PermissionFlagsBits.ManageMessages])) {
        lines.push(t(locales, 'setup.antispam.missing_permissions'))
      }
      await interaction.reply({ content: lines.join('\n'), flags: MessageFlags.Ephemeral })
    },
  },
  components: {
    [NAMESPACE]: async (interaction, [action, userId = '']) => {
      if (action !== 'lift' || !interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      if (!interaction.member.permissions.has(PermissionFlagsBits.ModerateMembers)) {
        await interaction.reply({ content: t(locales, 'report.no_permission'), flags: MessageFlags.Ephemeral })
        return
      }
      const member = await interaction.guild.members.fetch(userId).catch(() => null)
      if (member?.isCommunicationDisabled()) {
        await member.timeout(null, t(locales, 'antispam.lifted_reason', { moderator: interaction.user.tag }))
      }
      await interaction.update({
        content: `${interaction.message.content}\n${t(locales, 'antispam.lifted', { moderator: interaction.user.toString() })}`,
        components: [],
      })
    },
  },
  attach(client) {
    client.on(Events.MessageCreate, message => {
      onMessage(message).catch(error => console.error('Antispam check failed:', error))
    })
    setInterval(() => {
      const cutoff = Date.now() - WINDOW_MILLIS
      for (const [key, streak] of streaks) if (streak.updated < cutoff) streaks.delete(key)
    }, 5000).unref()
  },
}
