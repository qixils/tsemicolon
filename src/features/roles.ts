import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  DiscordAPIError,
  EmbedBuilder,
  escapeMarkdown,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  RESTJSONErrorCodes,
  StringSelectMenuBuilder,
  type ChatInputCommandInteraction,
  type GuildMember,
  type MessageComponentInteraction,
  type Role,
} from 'discord.js'
import { optionalText, text, withSchema } from '../db.js'
import { customId, localizedDescription, localizedName, type Feature } from '../feature.js'
import { t, type MaybeLocales } from '../i18n.js'
import { truncate } from '../util/discord.js'

const PAGE_SIZE = 25
const COLOR_PREFIX = 'color-'
/** unique palette for mods */
const STAFF_COLOR_PREFIX = 'scolor-'
const DEFAULT_COLOR = 0x88297c

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS flairs (
    guild_id    TEXT NOT NULL,
    role_id     TEXT NOT NULL,
    description TEXT,
    PRIMARY KEY (guild_id, role_id)
  ) WITHOUT ROWID;
`)

export const addFlair = (guildId: string, roleId: string, description: string | null) =>
  Number(db().prepare('INSERT OR IGNORE INTO flairs (guild_id, role_id, description) VALUES (?, ?, ?)')
    .run(guildId, roleId, description).changes) > 0

const byPosition = (a: Role, b: Role) => b.position - a.position

const navigation = (namespace: string, page: number, pages: number, locales: MaybeLocales, extra: ButtonBuilder[] = []) => {
  const buttons = pages > 1
    ? [
        new ButtonBuilder().setCustomId(customId(namespace, 'page', page - 1, 'prev')).setEmoji('⬅️')
          .setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(customId(namespace, 'page', page, 'current'))
          .setLabel(t(locales, 'pagination.page', { page: page + 1, pages })).setStyle(ButtonStyle.Secondary).setDisabled(true),
        new ButtonBuilder().setCustomId(customId(namespace, 'page', page + 1, 'next')).setEmoji('➡️')
          .setStyle(ButtonStyle.Secondary).setDisabled(page >= pages - 1),
      ]
    : []
  buttons.push(...extra)
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : []
}

const clampPage = (page: number, pages: number) => Math.max(0, Math.min(Number.isFinite(page) ? page : 0, pages - 1))

const checkManageRoles = async (interaction: ChatInputCommandInteraction<'cached'> | MessageComponentInteraction<'cached'>) => {
  if (interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return true
  await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'roles.bot_no_permission'), flags: MessageFlags.Ephemeral })
  return false
}

//////////////////
///// COLORS /////
//////////////////

const colorOptions = (member: GuildMember) => {
  const { guild } = member
  const find = (prefix: string) =>
    [...guild.roles.cache.filter(role => role.name.startsWith(prefix) && role.editable && !role.managed).values()].sort(byPosition)

  const staff = member.id === guild.ownerId
    || member.permissions.any([PermissionFlagsBits.Administrator, PermissionFlagsBits.ManageMessages])
  const staffRoles = staff ? find(STAFF_COLOR_PREFIX) : []
  const prefix = staffRoles.length ? STAFF_COLOR_PREFIX : COLOR_PREFIX
  return { prefix, roles: staffRoles.length ? staffRoles : find(COLOR_PREFIX) }
}

/**
 * Lists all the colors as role mentions so the user can see the color,
 * and adds a select menu to pick one or navigate to other pages.
 */
const colorPage = (member: GuildMember, requested: number, locales: MaybeLocales) => {
  const { prefix, roles } = colorOptions(member)
  const pages = Math.max(1, Math.ceil(roles.length / PAGE_SIZE))
  const page = clampPage(requested, pages)
  const shown = roles.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)
  const current = member.roles.cache.filter(role => role.name.startsWith(prefix))

  const embed = new EmbedBuilder()
    .setColor(member.displayColor || DEFAULT_COLOR)
    .setDescription(shown.map(role => `${role}${current.has(role.id) ? ' ✓' : ''}`).join('\n'))
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId('color', 'pick', page))
    .setPlaceholder(t(locales, 'color.placeholder'))
    .addOptions(shown.map(role => ({ label: truncate(role.name, 100), value: role.id })))
  const remove = current.size
    ? [new ButtonBuilder().setCustomId(customId('color', 'remove')).setLabel(t(locales, 'color.remove')).setStyle(ButtonStyle.Danger)]
    : []

  return {
    content: t(locales, 'color.prompt'),
    embeds: [embed],
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), ...navigation('color', page, pages, locales, remove)],
  }
}

const removeColors = async (member: GuildMember, prefix: string, keep?: string) => {
  const current = member.roles.cache.filter(role => role.name.startsWith(prefix) && role.editable && role.id !== keep)
  if (current.size) await member.roles.remove([...current.keys()])
}

const onColor = async (interaction: MessageComponentInteraction<'cached'>, [action = '', page = '0']: string[]) => {
  if (!await checkManageRoles(interaction)) return
  const { member } = interaction
  const locales = [interaction.locale, interaction.guildLocale]

  if (action === 'page') {
    await interaction.update(colorPage(member, Number(page), locales))
    return
  }

  const { prefix, roles } = colorOptions(member)
  if (action === 'remove') {
    await removeColors(member, prefix)
    await interaction.update({ content: t(locales, 'color.removed'), embeds: [], components: [] })
    return
  }

  if (action === 'pick' && interaction.isStringSelectMenu()) {
    const role = roles.find(role => role.id === interaction.values[0])
    if (!role) {
      await interaction.update(colorPage(member, Number(page), locales))
      return
    }
    await removeColors(member, prefix, role.id)
    if (!member.roles.cache.has(role.id)) await member.roles.add(role)
    await interaction.update({ content: t(locales, 'color.set', { role: role.toString() }), embeds: [], components: [] })
  }
}

//////////////////
///// FLAIRS /////
//////////////////

const flairOptions = (member: GuildMember) =>
  db().prepare('SELECT role_id, description FROM flairs WHERE guild_id = ?').all(member.guild.id)
    .flatMap(row => {
      const role = member.guild.roles.cache.get(text(row, 'role_id'))
      return role ? [{ role, description: optionalText(row, 'description') }] : []
    })
    .sort((a, b) => byPosition(a.role, b.role))

const flairPage = (member: GuildMember, requested: number, locales: MaybeLocales, notice?: string) => {
  const flairs = flairOptions(member)
  const pages = Math.max(1, Math.ceil(flairs.length / PAGE_SIZE))
  const page = clampPage(requested, pages)
  const select = new StringSelectMenuBuilder()
    .setCustomId(customId('flair', 'pick', page))
    .setPlaceholder(t(locales, 'flair.placeholder'))
    .addOptions(flairs.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE).map(({ role, description }) => ({
      label: truncate(role.name, 100),
      value: role.id,
      ...(description && { description: truncate(description, 100) }),
      ...(member.roles.cache.has(role.id) && { emoji: '✅' }),
    })))

  return {
    content: [notice, t(locales, 'flair.prompt')].filter(Boolean).join('\n'),
    components: [new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select), ...navigation('flair', page, pages, locales)],
  }
}

const isForbidden = (error: unknown) =>
  error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.MissingPermissions

const onFlair = async (interaction: MessageComponentInteraction<'cached'>, [action = '', page = '0']: string[]) => {
  if (!await checkManageRoles(interaction)) return
  const { member } = interaction
  const locales = [interaction.locale, interaction.guildLocale]

  if (action === 'page') {
    await interaction.update(flairPage(member, Number(page), locales))
    return
  }
  if (action !== 'pick' || !interaction.isStringSelectMenu()) return

  const flair = flairOptions(member).find(({ role }) => role.id === interaction.values[0])
  if (!flair) {
    await interaction.update(flairPage(member, Number(page), locales))
    return
  }

  const had = member.roles.cache.has(flair.role.id)
  try {
    if (had) await member.roles.remove(flair.role)
    else await member.roles.add(flair.role)
  } catch (error) {
    if (!isForbidden(error)) throw error
    await interaction.update(flairPage(member, Number(page), locales, t(locales, 'flair.too_high')))
    return
  }
  // keep the menu open so several flairs can be toggled in a row
  await interaction.update(flairPage(member, Number(page), locales, t(locales, had ? 'flair.removed' : 'flair.added', { role: flair.role.toString() })))
}

/** fetches the requested role or throws an error */
const assignableRole = async (interaction: ChatInputCommandInteraction<'cached'>) => {
  const role = interaction.options.getRole('role', true)
  if (role.managed || role.id === interaction.guildId) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'flair.unassignable'), flags: MessageFlags.Ephemeral })
    return null
  }
  if (!role.editable) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'flair.add_too_high'), flags: MessageFlags.Ephemeral })
    return null
  }
  return role
}

/** for setup commands, verifies the member can manage roles */
const checkMemberManageRoles = async (interaction: ChatInputCommandInteraction<'cached'>) => {
  if (interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) return checkManageRoles(interaction)
  await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'roles.no_permission'), flags: MessageFlags.Ephemeral })
  return false
}

const roleOption = {
  type: ApplicationCommandOptionType.Role as const,
  ...localizedName('command.setup.flair.option.role.name'),
  ...localizedDescription('command.setup.flair.option.role.description'),
  required: true,
}
const descriptionOption = {
  type: ApplicationCommandOptionType.String as const,
  ...localizedName('command.setup.flair.option.description.name'),
  ...localizedDescription('command.setup.flair.option.description.description'),
  max_length: 100,
}

export const rolesFeature: Feature = {
  commands: [{
    ...localizedName('command.role.name'),
    ...localizedDescription('command.role.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.role.color.name'),
        ...localizedDescription('command.role.color.description'),
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.role.flair.name'),
        ...localizedDescription('command.role.flair.description'),
      },
    ],
  }],
  setup: [{
    type: ApplicationCommandOptionType.SubcommandGroup,
    ...localizedName('command.setup.flair.name'),
    ...localizedDescription('command.setup.flair.description'),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.flair.add.name'),
        ...localizedDescription('command.setup.flair.add.description'),
        options: [roleOption, descriptionOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.flair.create.name'),
        ...localizedDescription('command.setup.flair.create.description'),
        options: [
          { type: ApplicationCommandOptionType.String, ...localizedName('command.setup.flair.option.name.name'), ...localizedDescription('command.setup.flair.option.name.description'), required: true, max_length: 100 },
          descriptionOption,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.flair.remove.name'),
        ...localizedDescription('command.setup.flair.remove.description'),
        options: [roleOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.flair.description.name'),
        ...localizedDescription('command.setup.flair.description.description'),
        options: [roleOption, descriptionOption],
      },
    ],
  }],
  chat: {
    'role color': async interaction => {
      if (!interaction.inCachedGuild() || !await checkManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      if (colorOptions(interaction.member).roles.length === 0) {
        let content = t(locales, 'color.none', { prefix: COLOR_PREFIX })
        if (interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
          content += `\n*${t(locales, 'color.mod_tip')}*`
        }
        await interaction.reply({ content, flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.reply({ ...colorPage(interaction.member, 0, locales), flags: MessageFlags.Ephemeral })
    },
    'role flair': async interaction => {
      if (!interaction.inCachedGuild() || !await checkManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      if (flairOptions(interaction.member).length === 0) {
        let content = t(locales, 'flair.none')
        if (interaction.member.permissions.has(PermissionFlagsBits.ManageRoles)) {
          content += `\n*${t(locales, 'flair.mod_tip')}*`
        }
        await interaction.reply({ content, flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.reply({ ...flairPage(interaction.member, 0, locales), flags: MessageFlags.Ephemeral })
    },
    'setup flair add': async interaction => {
      if (!interaction.inCachedGuild() || !await checkMemberManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      const role = await assignableRole(interaction)
      if (!role) return
      const added = addFlair(interaction.guildId, role.id, interaction.options.getString('description'))
      await interaction.reply({ content: t(locales, added ? 'flair.add_success' : 'flair.exists', { role: role.toString() }), flags: MessageFlags.Ephemeral })
    },
    'setup flair create': async interaction => {
      if (!interaction.inCachedGuild() || !await checkMemberManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      const name = interaction.options.getString('name', true)
      const description = interaction.options.getString('description')
      const existing = interaction.guild.roles.cache.find(role => role.name === name)
      if (existing && !existing.editable) {
        await interaction.reply({ content: t(locales, 'flair.add_too_high'), flags: MessageFlags.Ephemeral })
        return
      }
      const role = existing ?? await interaction.guild.roles.create({ name, reason: t(interaction.guildLocale, 'audit.requested_by', { user: interaction.user.tag }) })
      const added = addFlair(interaction.guildId, role.id, description)
      await interaction.reply({
        content: t(locales, !added ? 'flair.exists' : existing ? 'flair.add_success' : 'flair.create_success', { role: role.toString() }),
        flags: MessageFlags.Ephemeral,
      })
    },
    'setup flair remove': async interaction => {
      if (!interaction.inCachedGuild() || !await checkMemberManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      const role = interaction.options.getRole('role', true)
      const removed = Number(db().prepare('DELETE FROM flairs WHERE guild_id = ? AND role_id = ?').run(interaction.guildId, role.id).changes) > 0
      await interaction.reply({ content: t(locales, removed ? 'flair.remove_success' : 'flair.not_flair', { role: role.toString() }), flags: MessageFlags.Ephemeral })
    },
    'setup flair description': async interaction => {
      if (!interaction.inCachedGuild() || !await checkMemberManageRoles(interaction)) return
      const locales = [interaction.locale, interaction.guildLocale]
      const role = interaction.options.getRole('role', true)
      const description = interaction.options.getString('description')
      const updated = Number(db().prepare('UPDATE flairs SET description = ? WHERE guild_id = ? AND role_id = ?')
        .run(description, interaction.guildId, role.id).changes) > 0
      if (!updated) {
        await interaction.reply({ content: t(locales, 'flair.not_flair', { role: role.toString() }), flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.reply({
        content: t(locales, 'flair.description_success', { role: role.toString(), description: description ? `\`${escapeMarkdown(description)}\`` : t(locales, 'message.blank') }),
        flags: MessageFlags.Ephemeral,
      })
    },
  },
  components: {
    color: async (interaction, args) => {
      if (interaction.inCachedGuild()) await onColor(interaction, args)
    },
    flair: async (interaction, args) => {
      if (interaction.inCachedGuild()) await onFlair(interaction, args)
    },
  },
  attach(client) {
    client.on(Events.GuildRoleDelete, role => {
      db().prepare('DELETE FROM flairs WHERE guild_id = ? AND role_id = ?').run(role.guild.id, role.id)
    })
  },
  forgetGuild: guildId => Number(db().prepare('DELETE FROM flairs WHERE guild_id = ?').run(guildId).changes),
}
