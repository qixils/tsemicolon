import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  DiscordAPIError,
  EmbedBuilder,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  TextInputBuilder,
  TextInputStyle,
  escapeMarkdown,
  type ButtonComponent,
  type Guild,
  type Message,
  type MessageComponentInteraction,
  type User,
} from 'discord.js'
import { customId, localizedName, type Feature } from '../feature.js'
import { t, type MaybeLocales, type MessageKey } from '../i18n.js'
import { channelSubcommand, configureChannel, getSettingChannel } from '../settings.js'
import { addMediaPreview, displayContent, outranks, truncate } from '../util/discord.js'
import { getRuleById, listRules } from './rules.js'

const NAMESPACE = 'report'
const REPORT_COLOR = 0xde3d28
const MENU_NAME = t([], 'command.report.name')
/** discord's max 25 with room for "Other" */
const MAX_RULE_OPTIONS = 24

const userLine = (user: User, locales: MaybeLocales) => t(locales, 'common.user', { user: user.toString(), tag: escapeMarkdown(user.tag), id: user.id })

const reportsChannel = (guild: Guild) => getSettingChannel(guild, 'reports_channel', [PermissionFlagsBits.EmbedLinks])

const detailsModal = (channelId: string, messageId: string, locales: MaybeLocales) =>
  new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'other', channelId, messageId))
    .setTitle(t(locales, 'report.modal.title'))
    .addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId('details')
        .setLabel(t(locales, 'report.modal.label'))
        .setStyle(TextInputStyle.Paragraph)
        .setMaxLength(1000)
        .setRequired(true),
    ))

/** Posts a report to the mods. Returns an error message key on failure. */
const sendReport = async (
  guild: Guild,
  reporter: User,
  channelId: string,
  messageId: string,
  rule: string,
  ping: boolean,
): Promise<MessageKey | null> => {
  const destination = reportsChannel(guild)
  if (!destination) return 'report.not_setup'

  const source = guild.channels.cache.get(channelId)
  const message = source?.isTextBased() ? await source.messages.fetch(messageId).catch(() => null) : null
  if (!source || !message) return 'report.message_gone'

  const locales = guild.preferredLocale

  const embed = new EmbedBuilder()
    .setTitle(truncate(t(locales, 'report.embed.title', { channel: source.name }), 256))
    .setColor(REPORT_COLOR)
    .setDescription(t(locales, 'report.embed.jump', { url: message.url }))
    .setTimestamp(message.createdAt)
    .addFields(
      { name: t(locales, 'report.embed.reporter'), value: userLine(reporter, locales) },
      { name: t(locales, 'report.embed.reported'), value: userLine(message.author, locales) },
      { name: t(locales, 'report.embed.rule'), value: truncate(rule, 1024) },
      { name: t(locales, 'report.embed.content'), value: displayContent(message.content, 1024, locales) },
    )
  addMediaPreview(embed, message, locales)

  const actions = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(customId(NAMESPACE, 'delete', channelId, messageId))
      .setStyle(ButtonStyle.Danger).setLabel(t(locales, 'report.button.delete')),
    new ButtonBuilder().setCustomId(customId(NAMESPACE, 'kick', message.author.id))
      .setStyle(ButtonStyle.Danger).setLabel(t(locales, 'report.button.kick')),
    new ButtonBuilder().setCustomId(customId(NAMESPACE, 'ban', message.author.id))
      .setStyle(ButtonStyle.Danger).setLabel(t(locales, 'report.button.ban')),
    new ButtonBuilder().setCustomId(customId(NAMESPACE, 'dismiss'))
      .setStyle(ButtonStyle.Secondary).setLabel(t(locales, 'report.button.dismiss')),
  )

  await destination.send({
    ...(ping && { content: '@here', allowedMentions: { parse: ['everyone'] } }),
    embeds: [embed],
    components: [actions],
  })
  return null
}

/** Updates a report to note the action taken and disables that action */
const annotate = (report: Message, line: string, remove: string[] | 'all', locales: MaybeLocales) => {
  const source = report.embeds[0]
  const embed = source ? EmbedBuilder.from(source) : new EmbedBuilder()
  const fields = embed.data.fields ?? []
  const existing = fields.find(field => field.name === t(locales, 'report.embed.actions'))
  if (existing) existing.value = truncate(`${existing.value}\n${line}`, 1024)
  else embed.addFields({ name: t(locales, 'report.embed.actions'), value: line })

  const buttons = remove === 'all' ? [] : report.components
    .flatMap(row => row.type === ComponentType.ActionRow ? row.components : [])
    .filter((component): component is ButtonComponent => component.type === ComponentType.Button)
    .filter(button => !remove.includes(button.customId?.split(':')[1] ?? ''))
    .map(button => ButtonBuilder.from(button))

  return {
    embeds: [embed],
    components: buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : [],
  }
}

const deny = (interaction: MessageComponentInteraction, key: MessageKey, vars = {}) =>
  interaction.reply({ content: t([interaction.locale, interaction.guildLocale], key, vars), flags: MessageFlags.Ephemeral })

const isMissing = (error: unknown) =>
  error instanceof DiscordAPIError
  && (error.code === RESTJSONErrorCodes.UnknownMessage || error.code === RESTJSONErrorCodes.UnknownMember)

const selectRuleAction = async (interaction: MessageComponentInteraction<'cached'>, args: string[]) => {
  const locales = [interaction.locale, interaction.guildLocale]
  if (!interaction.isStringSelectMenu()) return
  const [channelId = '', messageId = ''] = args
  const choice = interaction.values[0] ?? 'other'
  if (choice === 'other') {
    await interaction.showModal(detailsModal(channelId, messageId, locales))
    return
  }
  const rule = getRuleById(interaction.guildId, Number(choice))
  const error = await sendReport(interaction.guild, interaction.user, channelId, messageId, rule?.text ?? t(interaction.guildLocale, 'report.other'), rule?.ping ?? false)
  await interaction.update({ content: t(locales, error ?? 'report.sent'), components: [] })
}

const quickAction = async (interaction: MessageComponentInteraction<'cached'>, action: string, args: string[]) => {
  const { guild, member } = interaction
  const viewerLocales = [interaction.locale, interaction.guildLocale]
  const publicLocales = [interaction.guildLocale]
  const me = guild.members.me
  if (!me) return
  const reason = t(publicLocales, 'report.action.reason', { moderator: interaction.user.tag, id: interaction.user.id })
  const moderator = interaction.user.toString()

  switch (action) {
    case 'dismiss': {
      await interaction.update(annotate(interaction.message, t(publicLocales, 'report.action.dismissed', { moderator }), 'all', publicLocales))
      return
    }

    case 'delete': {
      const [channelId = '', messageId = ''] = args
      const channel = guild.channels.cache.get(channelId)
      if (channel?.isTextBased()) {
        if (!channel.permissionsFor(member).has(PermissionFlagsBits.ManageMessages)) return deny(interaction, 'report.no_permission')
        if (!channel.permissionsFor(me).has(PermissionFlagsBits.ManageMessages)) return deny(interaction, 'report.bot_no_permission')
        await channel.messages.delete(messageId).catch(error => { if (!isMissing(error)) throw error })
      }
      await interaction.update(annotate(interaction.message, t(publicLocales, 'report.action.deleted', { moderator }), ['delete'], publicLocales))
      return
    }

    case 'kick': {
      const [userId = ''] = args
      if (!member.permissions.has(PermissionFlagsBits.KickMembers)) return deny(interaction, 'report.no_permission')
      if (!me.permissions.has(PermissionFlagsBits.KickMembers)) return deny(interaction, 'report.bot_no_permission')
      const target = await guild.members.fetch(userId).catch(() => null)
      if (!target) return deny(interaction, 'report.user_gone')
      if (!target.kickable || !outranks(member, target)) return deny(interaction, 'report.hierarchy')
      await target.kick(reason)
      await interaction.update(annotate(interaction.message, t(publicLocales, 'report.action.kicked', { moderator }), ['kick'], publicLocales))
      return
    }

    case 'ban': {
      const [userId = ''] = args
      if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return deny(interaction, 'report.no_permission')
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) return deny(interaction, 'report.bot_no_permission')
      const target = await guild.members.fetch(userId).catch(() => null)
      if (target && (!target.bannable || !outranks(member, target))) return deny(interaction, 'report.hierarchy')

      const days = new StringSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'bandays', userId, interaction.message.id))
        .setPlaceholder(t(viewerLocales, 'report.ban.placeholder'))
        .addOptions(Array.from({ length: 8 }, (_, count) => ({
          label: count === 0 ? t(viewerLocales, 'report.ban.keep_messages') : t(viewerLocales, 'report.ban.days', { count }),
          value: String(count),
        })))
      await interaction.reply({
        content: t(viewerLocales, 'report.ban.prompt'),
        components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(days)],
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    case 'bandays': {
      if (!interaction.isStringSelectMenu()) return
      const [userId = '', reportId = ''] = args
      if (!member.permissions.has(PermissionFlagsBits.BanMembers)) return deny(interaction, 'report.no_permission')
      if (!me.permissions.has(PermissionFlagsBits.BanMembers)) return deny(interaction, 'report.bot_no_permission')
      const days = Number(interaction.values[0] ?? 0)
      await guild.bans.create(userId, { deleteMessageSeconds: days * 24 * 60 * 60, reason })

      const report = await interaction.channel?.messages.fetch(reportId).catch(() => null)
      await report?.edit(annotate(report, t(publicLocales, 'report.action.banned', { moderator }), ['ban', 'kick'], publicLocales))
      await interaction.update({ content: t(viewerLocales, 'report.ban.done', { user: `<@${userId}>` }), components: [] })
      return
    }
  }
}

export const reportsFeature: Feature = {
  commands: [{
    ...localizedName('command.report.name'),
    type: ApplicationCommandType.Message,
    contexts: [InteractionContextType.Guild],
  }],
  setup: [channelSubcommand('command.setup.reports.name', 'command.setup.reports.description')],
  chat: {
    'setup reports': configureChannel({
      setting: 'reports_channel',
      defaultName: 'semicolon_modmail',
      topic: 'setup.reports.topic',
      private: true,
      done: 'setup.reports.done',
      notes: (guild, locales) => {
        const me = guild.members.me
        const missing = [
          ...(me?.permissions.has(PermissionFlagsBits.ManageMessages) ? [] : [t(locales, 'setup.reports.missing_manage_messages')]),
          ...(me?.permissions.has(PermissionFlagsBits.KickMembers) ? [] : [t(locales, 'setup.reports.missing_kick')]),
          ...(me?.permissions.has(PermissionFlagsBits.BanMembers) ? [] : [t(locales, 'setup.reports.missing_ban')]),
        ]
        return [
          t(locales, 'setup.reports.rules_hint'),
          ...missing.length ? [
            t(locales, 'setup.reports.consider'),
            ...missing,
            t(locales, 'setup.reports.consider_suffix'),
          ] : [],
        ]
      },
    }),
  },
  messageMenus: {
    [MENU_NAME]: async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const target = interaction.targetMessage
      if (target.author.id === interaction.user.id) {
        await interaction.reply({ content: t(locales, 'report.own_message'), flags: MessageFlags.Ephemeral })
        return
      }
      if (!reportsChannel(interaction.guild)) {
        await interaction.reply({ content: t(locales, 'report.not_setup'), flags: MessageFlags.Ephemeral })
        return
      }

      const rules = listRules(interaction.guildId)
      if (rules.length === 0) {
        await interaction.showModal(detailsModal(target.channelId, target.id, locales))
        return
      }

      const select = new StringSelectMenuBuilder()
        .setCustomId(customId(NAMESPACE, 'rule', target.channelId, target.id))
        .setPlaceholder(t(locales, 'report.select_placeholder'))
        .addOptions(
          ...rules.slice(0, MAX_RULE_OPTIONS).map(rule => ({ label: truncate(`${rule.number}. ${rule.text}`, 100), value: String(rule.id) })),
          { label: t(locales, 'report.other'), value: 'other' },
        )
      const jump = new ButtonBuilder().setStyle(ButtonStyle.Link).setURL(target.url).setLabel(t(locales, 'report.jump'))

      await interaction.reply({
        content: t(locales, 'report.prompt'),
        components: [
          new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select),
          new ActionRowBuilder<ButtonBuilder>().addComponents(jump),
        ],
        flags: MessageFlags.Ephemeral,
      })
    },
  },
  components: {
    [NAMESPACE]: async (interaction, [action = '', ...args]) => {
      if (!interaction.inCachedGuild()) return

      if (action === 'rule') {
        await selectRuleAction(interaction, args)
      } else {
        await quickAction(interaction, action, args)
      }
    },
  },
  modals: {
    [NAMESPACE]: async (interaction, [, channelId = '', messageId = '']) => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const details = interaction.fields.getTextInputValue('details')
      const error = await sendReport(interaction.guild, interaction.user, channelId, messageId, t(interaction.guildLocale, 'report.other_details', { details }), false)
      const content = t(locales, error ?? 'report.sent')
      if (interaction.isFromMessage()) await interaction.update({ content, components: [] })
      else await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    },
  },
  attach(client) {
    client.on('messageReactionAdd', async (reaction, user) => {
      const { emoji, message } = reaction
      if (!emoji.name) return
      if (!/^(?:00|zz)_report_to_mods$/i.test(emoji.name)) return
      if (!emoji.createdTimestamp) return
      if (emoji.createdTimestamp > 1791718250498) return // skip if newer than roughly the sunset of semicolon py
      if (!message.inGuild()) return

      try {
        await user.send({ content: t(message.guild?.preferredLocale, 'report.reaction') })
      } catch {

      }
    })
  },
}
