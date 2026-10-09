import {
  ApplicationCommandOptionType,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  type GuildMember,
} from 'discord.js'
import { localizedDescription, type Feature } from '../feature.js'
import { t } from '../i18n.js'
import { getSetting, setSetting } from '../settings.js'

/**
 * Gives the configured role once a member has agreed to the server's rules,
 * or straight away in servers without rules screening.
 */
const giveJoinRole = async (member: GuildMember) => {
  const roleId = getSetting(member.guild.id, 'join_role')
  if (!roleId || member.roles.cache.has(roleId)) return
  const role = member.guild.roles.cache.get(roleId)
  // editable covers both Manage Roles and the role sitting below the bot's own
  if (!role?.editable) return
  await member.roles.add(role, t([member.guild.preferredLocale], 'joinrole.reason'))
}

export const joinRoleFeature: Feature = {
  setup: [{
    type: ApplicationCommandOptionType.Subcommand,
    name: 'joinrole',
    ...localizedDescription('command.setup.joinrole.description'),
    options: [{
      type: ApplicationCommandOptionType.Role,
      name: 'role',
      ...localizedDescription('command.setup.joinrole.option.role'),
      required: true,
    }],
  }],
  chat: {
    'setup joinrole': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const role = interaction.options.getRole('role', true)
      const fail = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral })

      if (role.managed || role.id === interaction.guildId) return await fail(t(locales, 'setup.joinrole.unassignable'))
      if (!interaction.guild.members.me?.permissions.has(PermissionFlagsBits.ManageRoles)) return await fail(t(locales, 'roles.bot_no_permission'))
      if (!role.editable) return await fail(t(locales, 'setup.joinrole.too_high', { role: role.toString() }))

      setSetting(interaction.guildId, 'join_role', role.id)
      await interaction.reply({ content: t(locales, 'setup.joinrole.done', { role: role.toString() }), flags: MessageFlags.Ephemeral })
    },
  },
  attach(client) {
    const give = (member: GuildMember) => {
      giveJoinRole(member).catch(error => console.error(`Couldn't give ${member.id} the join role:`, error))
    }

    // members still pending haven't agreed to the rules yet; they're handled below once they do
    client.on(Events.GuildMemberAdd, member => {
      if (!member.pending) give(member)
    })
    client.on(Events.GuildMemberUpdate, (before, after) => {
      if (!before.partial && before.pending && !after.pending) give(after)
    })
  },
}
