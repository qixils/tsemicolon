import { ApplicationCommandOptionType, ChatInputCommandInteraction, Message, MessageFlags, type CommandInteraction } from "discord.js"

const purge = async (msgs: Message[]) => {

}

export const handleClearAfter = async (interaction: ChatInputCommandInteraction) => {
  if (!interaction.inGuild() || !interaction.guild?.members?.me || !interaction.channel || !interaction.command) {
    await interaction.reply({ content: 'This command must be run in a guild.', flags: MessageFlags.Ephemeral })
    return
  }
  const { channel, guild: { members: { me } } } = interaction

  if (channel.permissionsFor(me).missing('ManageMessages')) {
    await interaction.reply({ content: 'I do not have access to managing messages in this channel.', flags: MessageFlags.Ephemeral })
    return
  }

  const after = interaction.options.getInteger("after", true)
  const before = interaction.options.getInteger("before", false)

  await channel.messages.fetch({  })
}