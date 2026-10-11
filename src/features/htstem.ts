import { ApplicationCommandOptionType, ApplicationCommandType, MessageFlags, PermissionFlagsBits } from 'discord.js'
import type { Feature } from '../feature.js'
import { OWNER_ID } from '../config.js'

// i18n isn't used in this file since it's server-specific
// (honestly, it wouldn't hurt to use but I don't want to make volunteers from potential other communities try to translate in-jokes)

const HTSTEM_GUILD_ID = '282219466589208576'
const SILLS_ID = '198191547970355200'

export const htstemFeature: Feature = {
  guildCommands: {
    [HTSTEM_GUILD_ID]: [{
      name: 'nick_sills',
      description: "Change sills' nickname",
      type: ApplicationCommandType.ChatInput,
      options: [{
        type: ApplicationCommandOptionType.String,
        name: "nickname",
        description: "New nickname, or blank to reset to display name",
        max_length: 32,
      }]
    }],
  },
  chat: {
    nick_sills: async interaction => {
      const { members } = interaction.guild!
      const sills = members.cache.get(SILLS_ID) ?? await members.fetch(SILLS_ID)
      if (!sills) {
        await interaction.reply({
          content: "Sorry sills left the server again I guess",
          flags: MessageFlags.Ephemeral,
        })
        return
      }

      if (!sills.moderatable || !members.me?.permissions.has(PermissionFlagsBits.ManageNicknames)) {
        if (!OWNER_ID) {
          await interaction.reply({
            content: `sorry I can't change sills nickname rn`,
            flags: MessageFlags.Ephemeral,
          })
          return   
        }
        await interaction.reply({
          content: `<@${OWNER_ID}> help I can't change sills nickname`,
          allowedMentions: { users: [OWNER_ID] },
        })
        return   
      }

      let nick = interaction.options.getString('nickname')
      if (!nick) nick = null;

      await sills.setNickname(nick, `Requested by ${interaction.user.toString()} (${interaction.user.tag})`)

      await interaction.reply({
        content: "done",
        flags: MessageFlags.Ephemeral,
      })
    },
  },
}
