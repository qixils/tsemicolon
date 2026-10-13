import {
  ApplicationCommandOptionType,
  AuditLogEvent,
  EmbedBuilder,
  Events,
  MessageFlags,
  MessageType,
  PermissionFlagsBits,
  SnowflakeUtil,
  TimestampStyles,
  escapeMarkdown,
  time,
  type Client,
  type Guild,
  type GuildBan,
  type GuildMember,
  type GuildTextBasedChannel,
  type Message,
  type PartialGuildMember,
  type PartialMessage,
  type PartialUser,
  type User,
} from 'discord.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { formatNumber, t, type MaybeLocales } from '../i18n.js'
import { channelSubcommand, configureChannel, getSetting, setSetting, getSettingChannel } from '../settings.js'
import { recentAuditEntries } from '../util/audit.js'
import { postBatched } from '../util/batch.js'
import { displayContent, truncate } from '../util/discord.js'
import { botEmoji } from '../util/emoji.js'
import { isPluralKitOriginal } from '../util/pluralkit.js'

const EDIT_COLOR = 0xf5ba5b
const DELETE_COLOR = 0xde3d28
/** Accounts younger than this get flagged when they join */
const NEW_ACCOUNT_AGE_MILLIS = 24 * 60 * 60 * 1000
/** How far back to look for the audit entry explaining a kick, ban or timeout */
const MODERATION_AUDIT_AGE_MILLIS = 15 * 1000
/** How far back to look for a prune audit entry */
const PRUNE_AUDIT_AGE_MILLIS = 15 * 1000
/** How far back to look for a delete audit entry */
const DELETE_AUDIT_AGE_MILLIS = 15 * 60 * 1000

const who = (user: User | PartialUser) => ({ user: user.toString(), tag: escapeMarkdown(user.tag ?? user.id) })

const moderationDetails = (moderator: User | PartialUser | null, reason: string | null, locales: MaybeLocales) =>
  moderator
    ? t(locales, 'joinlog.details.moderator', { ...who(moderator), reason: reason ?? t(locales, 'common.unavailable') })
    : reason ? t(locales, 'joinlog.details.reason', { reason }) : ''

const joinlog = (guild: Guild) => getSettingChannel(guild, 'joinlog_channel')
const namelog = (guild: Guild) => getSetting(guild.id, 'namelog_channel')
  ? getSettingChannel(guild, 'namelog_channel')
  : joinlog(guild)

const onJoin = async (member: GuildMember) => {
  const channel = joinlog(member.guild)
  if (!channel) return
  const locales = [member.guild.preferredLocale]
  const isNew = Date.now() - member.user.createdTimestamp < NEW_ACCOUNT_AGE_MILLIS
  await postBatched(channel, t(locales, 'joinlog.join', {
    emoji: botEmoji('join', channel),
    ...who(member.user),
    count: formatNumber(locales, member.guild.memberCount),
    flag: isNew ? `${botEmoji('newAccount', channel)} ` : '',
    created: time(member.user.createdAt, TimestampStyles.LongDateShortTime),
  }))
}

/** Checks if a batch of departures was caused by a prune and prepends info about it if so */
const pruneNotice = (channel: GuildTextBasedChannel) => async () => {
  const { guild } = channel
  const entry = (await recentAuditEntries(guild, AuditLogEvent.MemberPrune, PRUNE_AUDIT_AGE_MILLIS))[0]
  if (!entry?.executor) return null
  const { extra } = entry
  const locales = [guild.preferredLocale]
  return t(locales, 'joinlog.prune', {
    emoji: botEmoji('prune', channel),
    ...who(entry.executor),
    count: formatNumber(locales, extra?.removed ?? 0),
    days: extra?.days ?? 0,
  })
}

const onLeave = async (member: GuildMember | PartialGuildMember) => {
  const { guild } = member
  const locales = [guild.preferredLocale]
  const channel = joinlog(guild)
  if (!channel) return

  const kick = (await recentAuditEntries(guild, AuditLogEvent.MemberKick, MODERATION_AUDIT_AGE_MILLIS))
    .find(entry => entry.targetId === member.id)

  const line = kick
    ? t(locales, 'joinlog.kick', { emoji: botEmoji('kick', channel), ...who(member.user), details: moderationDetails(kick.executor, kick.reason, locales) })
    : t(locales, 'joinlog.leave', { emoji: botEmoji('leave', channel), ...who(member.user), count: formatNumber(locales, guild.memberCount) })

  await postBatched(channel, line, { key: 'prune', run: pruneNotice(channel) })
}

const onBan = async (ban: GuildBan) => {
  const locales = [ban.guild.preferredLocale]
  const channel = joinlog(ban.guild)
  if (!channel) return

  const entry = (await recentAuditEntries(ban.guild, AuditLogEvent.MemberBanAdd, MODERATION_AUDIT_AGE_MILLIS))
    .find(entry => entry.targetId === ban.user.id)
  let reason = entry?.reason ?? ban.reason ?? null
  if (!entry && reason === null && ban.partial) reason = (await ban.fetch().catch(() => null))?.reason ?? null

  await postBatched(channel, t(locales, 'joinlog.ban', {
    emoji: botEmoji('ban', channel),
    ...who(ban.user),
    details: moderationDetails(entry?.executor ?? null, reason, locales),
  }))
}

const onUnban = async (ban: GuildBan) => {
  const channel = joinlog(ban.guild)
  if (!channel) return
  await postBatched(channel, t([ban.guild.preferredLocale], 'joinlog.unban', { emoji: botEmoji('unban', channel), ...who(ban.user) }))
}

const onTimeoutChange = async (member: GuildMember, before: number | null, after: number | null) => {
  const now = Date.now()
  const timedOut = after !== null && after > now
  const lifted = !timedOut && before !== null && before > now
  if (!timedOut && !lifted) return

  const channel = joinlog(member.guild)
  if (!channel) return
  const locales = [member.guild.preferredLocale]

  const entry = (await recentAuditEntries(member.guild, AuditLogEvent.MemberUpdate, MODERATION_AUDIT_AGE_MILLIS))
    .find(entry => entry.targetId === member.id && entry.changes.some(change => change.key === 'communication_disabled_until'))
  const details = moderationDetails(entry?.executor ?? null, entry?.reason ?? null, locales)

  await postBatched(channel, timedOut
    ? t(locales, 'joinlog.timeout', {
        emoji: botEmoji('timeout', channel),
        ...who(member.user),
        until: time(new Date(after), TimestampStyles.LongDateShortTime),
        relative: time(new Date(after), TimestampStyles.RelativeTime),
        details,
      })
    : t(locales, 'joinlog.untimeout', { emoji: botEmoji('untimeout', channel), ...who(member.user), details }))
}

const onRoleChange = async (before: GuildMember, after: GuildMember) => {
  const added = after.roles.cache.filter(role => !before.roles.cache.has(role.id))
  const removed = before.roles.cache.filter(role => !after.roles.cache.has(role.id))
  if (added.size === 0 && removed.size === 0) return

  const channel = getSettingChannel(after.guild, 'rolelog_channel')
  if (!channel) return
  const locales = [after.guild.preferredLocale]

  for (const role of added.values()) {
    await postBatched(channel, t(locales, 'rolelog.added', { ...who(after.user), role: role.toString() }))
  }
  for (const role of removed.values()) {
    await postBatched(channel, t(locales, 'rolelog.removed', { ...who(after.user), role: role.toString() }))
  }
}

const onUserUpdate = async (client: Client, before: User, after: User) => {
  for (const guild of client.guilds.cache.values()) {
    if (!guild.members.cache.has(after.id)) continue
    const channel = namelog(guild)
    if (!channel) continue
    const locales = [guild.preferredLocale]
    const lines = [
      ...(before.username !== after.username
        ? [t(locales, 'joinlog.rename.username', { emoji: botEmoji('rename', channel), user: after.toString(), before: escapeMarkdown(before.username), after: escapeMarkdown(after.username) })]
        : []),
        // TODO: option to log display name changes?
      // ...(before.globalName !== after.globalName
      //   ? [t(locales, 'joinlog.rename.display_name', {
      //       emoji: botEmoji('rename', channel),
      //       user: after.toString(),
      //       before: escapeMarkdown(before.globalName ?? before.username),
      //       after: escapeMarkdown(after.globalName ?? after.username),
      //     })]
      //   : []),
    ]
    for (const line of lines) await postBatched(channel, line)
  }
}

////////////////////////
///// MESSAGE LOGS /////
////////////////////////

const isIgnored = (guildId: string, userId: string) =>
  (getSetting(guildId, 'messagelog_ignored') ?? []).includes(userId)

const footer = (authorId: string, messageId: string, channelId: string, locales: MaybeLocales) =>
  ({ text: t(locales, 'messagelog.footer', { author: authorId, message: messageId, channel: channelId }) })

const onEdit = async (client: Client, before: Message | PartialMessage, updated: Message | PartialMessage) => {
  if (!updated.inGuild()) return
  const message = updated.partial ? await updated.fetch().catch(() => null) : updated
  if (!message?.inGuild()) return
  if (message.type !== MessageType.Default && message.type !== MessageType.Reply) return
  if (!before.partial && message.content === before.content) return
  if (message.author.id === client.user?.id) return
  if (isIgnored(message.guildId, message.author.id)) return

  const channel = getSettingChannel(message.guild, 'messagelog_channel', [PermissionFlagsBits.EmbedLinks])
  if (!channel) return
  const locales = [message.guild.preferredLocale]

  const embed = new EmbedBuilder()
    .setColor(EDIT_COLOR)
    .setTitle(truncate(t(locales, 'messagelog.edit.title', { channel: message.channel.name }), 256))
    .setDescription(t(locales, 'messagelog.jump', { url: message.url }))
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ extension: 'png', size: 128 }) })
    .addFields(
      // 'no content' message for blank contents is added in displayContent
      { name: t(locales, 'messagelog.edit.before'), value: displayContent(before.partial ? t(locales, 'common.unavailable') : before.content, 1024, locales) },
      { name: t(locales, 'messagelog.edit.after'), value: displayContent(message.content, 1024, locales) },
    )
    .setFooter(footer(message.author.id, message.id, message.channelId, locales))
    .setTimestamp(message.createdAt)

  await channel.send({ embeds: [embed] })
}

const deletionEmbed = (message: Message<true> | PartialMessage, channelName: string, locales: MaybeLocales, deleter?: User | PartialUser) => {
  const embed = new EmbedBuilder()
    .setColor(DELETE_COLOR)
    .setTimestamp(SnowflakeUtil.timestampFrom(message.id))

  if (message.partial) {
    return embed
      .setTitle(truncate(t(locales, 'messagelog.delete.uncached_title', { channel: channelName }), 256))
      .setFooter(footer(t(locales, 'common.unavailable'), message.id, message.channelId, locales))
  }

  embed
    .setTitle(truncate(t(locales, 'messagelog.delete.title', { channel: channelName }), 256))
    .setAuthor({ name: message.author.username, iconURL: message.author.displayAvatarURL({ extension: 'png', size: 128 }) })
    .setDescription(displayContent(message.content, 4096, locales))
    .setFooter(footer(message.author.id, message.id, message.channelId, locales))
  if (deleter) embed.addFields({ name: t(locales, 'messagelog.delete.deleter'), value: t(locales, 'common.user', { ...who(deleter), id: deleter.id }) })
  return embed
}

const channelName = (message: Message | PartialMessage) =>
  message.channel && 'name' in message.channel && message.channel.name ? message.channel.name : message.channelId

const onDelete = async (message: Message | PartialMessage) => {
  const guild = message.guild
  if (!guild) return
  const locales = [guild.preferredLocale]
  if (!message.partial && isIgnored(guild.id, message.author.id)) return

  const fromUser = message.partial || !(message.author.bot || message.webhookId)
  if (fromUser && await isPluralKitOriginal(message.id)) return

  const channel = getSettingChannel(guild, 'messagelog_channel', [PermissionFlagsBits.EmbedLinks])
  if (!channel) return

  let deleter: User | PartialUser | undefined
  if (!message.partial) {
    // deleting your own message leaves no audit entry, so default to the author
    const entry = (await recentAuditEntries(guild, AuditLogEvent.MessageDelete, DELETE_AUDIT_AGE_MILLIS)).find(entry =>
      entry.targetId === message.author.id
      && (entry.extra as { channel?: { id: string } } | null)?.channel?.id === message.channelId)
    deleter = entry?.executor ?? message.author
  }

  await channel.send({ embeds: [deletionEmbed(message as Message<true> | PartialMessage, channelName(message), locales, deleter)] })
}

const onBulkDelete = async (messages: ReadonlyMap<string, Message | PartialMessage>, guild: Guild | null) => {
  if (!guild) return
  const locales = [guild.preferredLocale]
  const channel = getSettingChannel(guild, 'messagelog_channel', [PermissionFlagsBits.EmbedLinks])
  if (!channel) return

  const embeds = [...messages.values()]
    .filter(message => message.partial || !isIgnored(guild.id, message.author.id))
    .sort((a, b) => SnowflakeUtil.timestampFrom(a.id) - SnowflakeUtil.timestampFrom(b.id))
    .map(message => deletionEmbed(message as Message<true> | PartialMessage, channelName(message), locales))

  // ten embeds per message, rather than one message per deletion
  for (let i = 0; i < embeds.length; i += 10) {
    await channel.send({ embeds: embeds.slice(i, i + 10) })
  }
}

/** Logs failures instead of letting a broken log channel crash the listener. */
const safely = <A extends unknown[]>(name: string, handler: (...args: A) => Promise<unknown>) =>
  (...args: A) => {
    handler(...args).catch(error => console.error(`Log handler "${name}" failed:`, error))
  }

export const logsFeature: Feature = {
  setup: [
    channelSubcommand('command.setup.joinlog.name', 'command.setup.joinlog.description'),
    channelSubcommand('command.setup.namelog.name', 'command.setup.namelog.description'),
    channelSubcommand('command.setup.messagelog.name', 'command.setup.messagelog.description'),
    channelSubcommand('command.setup.rolelog.name', 'command.setup.rolelog.description'),
    {
      type: ApplicationCommandOptionType.Subcommand,
      ...localizedName('command.setup.messagelog-ignore.name'),
      ...localizedDescription('command.setup.messagelog-ignore.description'),
      options: [{
        type: ApplicationCommandOptionType.User,
        ...localizedName('command.setup.messagelog-ignore.option.user.name'),
        ...localizedDescription('command.setup.messagelog-ignore.option.user.description'),
        required: true,
      }],
    },
  ],
  chat: {
    'setup joinlog': configureChannel({
      setting: 'joinlog_channel',
      defaultName: 'semicolon_joins',
      topic: 'setup.joinlog.topic',
      done: 'setup.joinlog.done',
    }),
    'setup namelog': configureChannel({
      setting: 'namelog_channel',
      defaultName: 'semicolon_names',
      topic: 'setup.namelog.topic',
      done: 'setup.namelog.done',
    }),
    'setup messagelog': configureChannel({
      setting: 'messagelog_channel',
      defaultName: 'semicolon_messages',
      topic: 'setup.messagelog.topic',
      done: 'setup.messagelog.done',
    }),
    'setup rolelog': configureChannel({
      setting: 'rolelog_channel',
      defaultName: 'semicolon_roles',
      topic: 'setup.rolelog.topic',
      done: 'setup.rolelog.done',
    }),
    'setup messagelog-ignore': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const user = interaction.options.getUser('user', true)
      const ignored = new Set(getSetting(interaction.guildId, 'messagelog_ignored') ?? [])
      const nowIgnored = !ignored.delete(user.id)
      if (nowIgnored) ignored.add(user.id)
      setSetting(interaction.guildId, 'messagelog_ignored', [...ignored])
      await interaction.reply({
        content: t(locales, nowIgnored ? 'setup.messagelog-ignore.added' : 'setup.messagelog-ignore.removed', { user: user.toString() }),
        flags: MessageFlags.Ephemeral,
      })
    },
  },
  attach(client) {
    // role, timeout and rename logs diff against the cached member, so cache them all up front
    const cacheMembers = (guild: Guild) => {
      guild.members.fetch().catch(error => console.warn(`Couldn't cache members of ${guild.name}:`, error))
    }
    client.once(Events.ClientReady, ready => ready.guilds.cache.forEach(cacheMembers))
    client.on(Events.GuildCreate, cacheMembers)

    client.on(Events.GuildMemberAdd, safely('join', onJoin))
    client.on(Events.GuildMemberRemove, safely('leave', onLeave))
    client.on(Events.GuildBanAdd, safely('ban', onBan))
    client.on(Events.GuildBanRemove, safely('unban', onUnban))
    client.on(Events.GuildMemberUpdate, safely('member update', async (before, after) => {
      if (before.partial) return
      await onTimeoutChange(after, before.communicationDisabledUntilTimestamp, after.communicationDisabledUntilTimestamp)
      await onRoleChange(before, after)
    }))
    client.on(Events.UserUpdate, safely('rename', async (before, after) => {
      if (!before.partial) await onUserUpdate(client, before, after)
    }))
    // client.on(Events.MessageUpdate, safely('edit', (before, after) => onEdit(client, before, after)))
    client.on(Events.MessageDelete, safely('delete', onDelete))
    client.on(Events.MessageBulkDelete, safely('bulk delete', (messages, channel) => onBulkDelete(messages, channel.guild)))
  },
}
