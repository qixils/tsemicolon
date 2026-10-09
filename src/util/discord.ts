import {
  ChannelType,
  PermissionFlagsBits,
  type ApplicationCommandOptionAllowedChannelType,
  type EmbedBuilder,
  type Guild,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type MessageMentionOptions,
  type PermissionResolvable,
} from 'discord.js'
import { t } from '../i18n.js'

/**
 * Channels the bot can be configured to consistently post to.
 * Not an exhaustive list of what the bot technically "could" do, because we don't really want an admin to set joinlog to go to a voice channel.
 * Threads are excluded as they require extra lookups.
 */
export const SENDABLE_TEXT_CHANNEL_TYPES: ApplicationCommandOptionAllowedChannelType[] = [ChannelType.GuildText, ChannelType.GuildAnnouncement]

export const MESSAGE_LIMIT = 2000
export const EMBED_FIELD_LIMIT = 1024

/** Extracts a snowflake out of a raw ID or mention */
export const parseSnowflake = (input: string): string | null =>
  /^(?:<[@#][!&]?)?(\d{17,20})>?$/.exec(input.trim())?.[1] ?? null

export const truncate = (text: string, limit: number) =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

/** Splits text into messages on line breaks, hard-wrapping any line too long on its own */
export const chunkLines = (text: string, limit = MESSAGE_LIMIT): string[] => {
  const chunks: string[] = []
  for (let line of text.split('\n')) {
    const last = chunks.at(-1)
    if (last !== undefined && last.length + 1 + line.length <= limit) {
      chunks[chunks.length - 1] = `${last}\n${line}`
      continue
    }
    while (line.length > limit) {
      chunks.push(line.slice(0, limit))
      line = line.slice(limit)
    }
    chunks.push(line)
  }
  return chunks.filter(chunk => chunk.trim())
}

/**
 * Given a guild and channel ID,
 * fetches a channel by that given ID if the bot can post in it
 * and meets the `extra` permission threshold,
 * otherwise returns null.
 */
export const postableChannel = (
  guild: Guild,
  channelId: string | null | undefined,
  extra: PermissionResolvable[] = [],
): GuildTextBasedChannel | null => {
  if (!channelId) return null
  const channel = guild.channels.cache.get(channelId)
  const me = guild.members.me
  if (!channel?.isTextBased() || !me) return null

  const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages
  if (!channel.permissionsFor(me).has([PermissionFlagsBits.ViewChannel, send, ...extra])) return null
  
  return channel
}

const IMAGE = /\.(png|jpe?g|gif|webp)$/i

/**
 * Shows the first image attachment in the embed
 * and notes how many other attachments and embeds were left out
 */
export const addMediaPreview = (embed: EmbedBuilder, message: Message, locales: (string | null | undefined)[] = []) => {
  let shown = false
  let hiddenAttachments = 0
  for (const attachment of message.attachments.values()) {
    if (!shown && !attachment.spoiler && IMAGE.test(attachment.name)) {
      embed.setImage(attachment.url)
      shown = true
    } else {
      hiddenAttachments++
    }
  }

  const notes = [
    ...(hiddenAttachments ? [t(locales, 'media.hidden_attachments', { count: hiddenAttachments })] : []),
    ...(message.embeds.length ? [t(locales, 'media.hidden_embeds', { count: message.embeds.length })] : []),
  ]
  if (notes.length) embed.addFields({ name: t(locales, 'media.not_shown'), value: notes.join('\n') })
}

/** Truncates the input text, or returns a placeholder if no content is provided */
export const displayContent = (content: string | null | undefined, limit: number, locales: (string | null | undefined)[] = []) =>
  content ? truncate(content, limit) : t(locales, 'message.blank')

/** Whether `member` has higher role(s) than `comparedTo` */
export const outranks = (member: GuildMember, comparedTo: GuildMember) => {
  if (member.id === member.guild.ownerId) return true
  if (comparedTo.id === comparedTo.guild.ownerId) return false
  return member.roles.highest.comparePositionTo(comparedTo.roles.highest) > 0
}
