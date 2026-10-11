import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  TimestampStyles,
  escapeMarkdown,
  time,
  type ChatInputCommandInteraction,
  type Client,
  type GuildMember,
} from 'discord.js'
import { text, withSchema } from '../db.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { t, type MessageKey, type Vars } from '../i18n.js'
import { outranks, parseSnowflake, truncate } from '../util/discord.js'
import { parseWhen } from '../util/time.js'

/** Longest possible timeout duration */
const MAX_TIMEOUT_MILLIS = 28 * 24 * 60 * 60 * 1000
const DAY_SECONDS = 24 * 60 * 60

// discord's new Timeout is more visually obvious and they're starting to send DMs for punishments
// so I don't see much need for the hacky mute roles anymore.
// still need to track the old ones to expire them tho
const db = withSchema(`
  CREATE TABLE IF NOT EXISTS legacy_unmutes (
    guild_id TEXT    NOT NULL,
    user_id  TEXT    NOT NULL,
    role_id  TEXT    NOT NULL,
    run_at   INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id, role_id)
  ) WITHOUT ROWID;
`)

export const addLegacyUnmute = (unmute: { guildId: string, userId: string, roleId: string, runAt: number }) => {
  db().prepare('INSERT OR REPLACE INTO legacy_unmutes (guild_id, user_id, role_id, run_at) VALUES (?, ?, ?, ?)')
    .run(unmute.guildId, unmute.userId, unmute.roleId, unmute.runAt)
}

const runLegacyUnmutes = async (client: Client) => {
  const due = db().prepare('SELECT * FROM legacy_unmutes WHERE run_at <= ?').all(Date.now())
  for (const row of due) {
    const [guildId, userId, roleId] = [text(row, 'guild_id'), text(row, 'user_id'), text(row, 'role_id')]
    const guild = client.guilds.cache.get(guildId)
    if (guild) {
      const role = guild.roles.cache.get(roleId)
      const member = await guild.members.fetch(userId).catch(() => null)
      if (role?.editable && member?.roles.cache.has(roleId)) {
        await member.roles.remove(role, t([guild.preferredLocale], 'mute.legacy_expired')).catch(() => {})
      }
    }
    db().prepare('DELETE FROM legacy_unmutes WHERE guild_id = ? AND user_id = ? AND role_id = ?').run(guildId, userId, roleId)
  }
}

/** DMs a member that they've been muted. Returns whether it was delivered */
export const notifyMuted = async (member: GuildMember, until: Date, reason?: string | null) => {
  try {
    // we don't know the member's own locale outside of their interactions
    const locales = [member.guild.preferredLocale]
    const lines = [t(locales, 'mute.dm', {
      guild: escapeMarkdown(member.guild.name),
      until: time(until, TimestampStyles.FullDateShortTime),
      relative: time(until, TimestampStyles.RelativeTime),
    })]
    if (reason) lines.push(t(locales, 'mute.dm_reason', { reason }))
    return await member.send({ content: lines.join('\n') }).then(() => true, () => false)
  } catch {
    return false
  }
}

const fail = (interaction: ChatInputCommandInteraction, key: MessageKey, vars: Vars = {}) =>
  interaction.reply({ content: t([interaction.locale, interaction.guildLocale], key, vars), flags: MessageFlags.Ephemeral })

const auditReason = (interaction: ChatInputCommandInteraction, command: MessageKey) => {
  const reason = interaction.options.getString('reason')
  const signature = t(interaction.guildLocale, 'moderation.audit', { moderator: interaction.user.tag, id: interaction.user.id, command: t(interaction.guildLocale, command) })
  return truncate(reason ? `${reason}\n${signature}` : signature, 512)
}

export const moderationFeature: Feature = {
  commands: [
    {
      ...localizedName('command.ban.name'),
      ...localizedDescription('command.ban.description'),
      type: ApplicationCommandType.ChatInput,
      contexts: [InteractionContextType.Guild],
      default_member_permissions: PermissionFlagsBits.BanMembers.toString(),
      options: [
        {
          type: ApplicationCommandOptionType.String,
          ...localizedName('command.ban.option.user_id.name'),
          ...localizedDescription('command.ban.option.user_id.description'),
          required: true,
          max_length: 32,
        },
        {
          type: ApplicationCommandOptionType.Integer,
          ...localizedName('command.ban.option.delete_messages.name'),
          ...localizedDescription('command.ban.option.delete_messages.description'),
          choices: Array.from({ length: 8 }, (_, days) => ({
            ...localizedName(days === 0 ? 'ban.keep_messages' : 'ban.delete_days', { count: days }),
            value: days,
          })),
        },
        {
          type: ApplicationCommandOptionType.String,
          ...localizedName('command.ban.option.reason.name'),
          ...localizedDescription('command.ban.option.reason.description'),
          max_length: 400,
        },
      ],
    },
    {
      ...localizedName('command.mute.name'),
      ...localizedDescription('command.mute.description'),
      type: ApplicationCommandType.ChatInput,
      contexts: [InteractionContextType.Guild],
      default_member_permissions: PermissionFlagsBits.ModerateMembers.toString(),
      options: [
        {
          type: ApplicationCommandOptionType.User,
          ...localizedName('command.mute.option.member.name'),
          ...localizedDescription('command.mute.option.member.description'),
          required: true,
        },
        {
          type: ApplicationCommandOptionType.String,
          ...localizedName('command.mute.option.duration.name'),
          ...localizedDescription('command.mute.option.duration.description'),
          required: true,
          max_length: 100,
        },
        {
          type: ApplicationCommandOptionType.String,
          ...localizedName('command.mute.option.reason.name'),
          ...localizedDescription('command.mute.option.reason.description'),
          max_length: 400,
        },
        {
          type: ApplicationCommandOptionType.Boolean,
          ...localizedName('command.mute.option.notify_user.name'),
          ...localizedDescription('command.mute.option.notify_user.description'),
        },
      ],
    },
  ],
  chat: {
    ban: async interaction => {
      if (!interaction.inCachedGuild()) return
      const { guild, member } = interaction
      const locales = [interaction.locale, interaction.guildLocale]
      const id = parseSnowflake(interaction.options.getString('user_id', true))
      if (!id) return fail(interaction, 'ban.invalid_id')

      // who may use this is up to the server's Integrations settings, here we only care what the bot physically is able to do
      if (!guild.members.me?.permissions.has(PermissionFlagsBits.BanMembers)) return fail(interaction, 'moderation.bot_no_permission')
      if (id === guild.ownerId) return fail(interaction, 'ban.owner')
      if (id === interaction.user.id || id === interaction.client.user.id) return fail(interaction, 'ban.self')

      const target = await guild.members.fetch(id).catch(() => null)
      if (target && !target.bannable) return fail(interaction, 'moderation.bot_hierarchy')
      if (target && !outranks(member, target)) return fail(interaction, 'moderation.hierarchy')

      const user = target?.user ?? await interaction.client.users.fetch(id).catch(() => null)

      const days = interaction.options.getInteger('delete_messages') ?? 0
      await guild.bans.create(id, { deleteMessageSeconds: days * DAY_SECONDS, reason: auditReason(interaction, 'command.ban.name') })
      await interaction.reply({ content: t(locales, 'ban.done', { user: `<@${id}>`, tag: escapeMarkdown(user?.tag ?? t(locales, 'common.unavailable')) }), flags: MessageFlags.Ephemeral })
    },
    mute: async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const target = interaction.options.getMember('member')
      if (!target) return fail(interaction, 'mute.not_member')

      if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ModerateMembers)) return fail(interaction, 'moderation.bot_no_permission')
      if (!target.moderatable) return fail(interaction, 'moderation.bot_hierarchy')
      if (!outranks(interaction.member, target)) return fail(interaction, 'moderation.hierarchy')

      const input = interaction.options.getString('duration', true)
      const until = parseWhen(input)
      if (!until) return fail(interaction, 'mute.unparseable', { input: truncate(input, 100) })
      const duration = until.getTime() - Date.now()
      if (duration <= 0) return fail(interaction, 'mute.in_past')
      if (duration > MAX_TIMEOUT_MILLIS) return fail(interaction, 'mute.too_long')

      await target.timeout(duration, auditReason(interaction, 'command.mute.name'))
      await interaction.reply({
        content: t(locales, 'mute.done', {
          user: target.toString(),
          until: time(until, TimestampStyles.FullDateShortTime),
          relative: time(until, TimestampStyles.RelativeTime),
        }),
        flags: MessageFlags.Ephemeral,
      })
      const reason = interaction.options.getBoolean('notify_user') ? interaction.options.getString('reason') : null
      if (!await notifyMuted(target, until, reason)) {
        await interaction.followUp({ content: t(locales, 'mute.dm_failed'), flags: MessageFlags.Ephemeral })
      }
    },
  },
  attach(client) {
    setInterval(() => {
      if (client.isReady()) runLegacyUnmutes(client).catch(error => console.error('Legacy unmute failed:', error))
    }, 30 * 1000).unref()
  },
}
