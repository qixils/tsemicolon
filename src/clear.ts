import { ApplicationCommandOptionType, ApplicationCommandType, ChatInputCommandInteraction, Constants, InteractionContextType, Message, MessageFlags, PermissionFlagsBits, type GuildTextBasedChannel } from "discord.js"
import { localizedDescription, type Feature } from "./feature.js"
import { t } from "./i18n.js"

const purge = async (channel: GuildTextBasedChannel, msgs: Message[]) => {
  const now = Date.now()
  const recent: Message[] = []
  const old: Message[] = []

  for (const msg of msgs) {
    if (now - msg.createdTimestamp < Constants.MaxBulkDeletableMessageAge) recent.push(msg)
    else old.push(msg)
  }

  // bulk delete API only works in batches of 2-100 and only on recent messages
  for (let i = 0; i < recent.length; i += 100) {
    const chunk = recent.slice(i, i + 100)
    if (chunk.length === 1) await chunk[0]!.delete()
    else await channel.bulkDelete(chunk, true)
  }

  // anything older has to be deleted one at a time
  for (const msg of old) {
    await msg.delete()
  }
}

const ensurePurgeableChannel = async (interaction: ChatInputCommandInteraction): Promise<GuildTextBasedChannel | null> => {
  if (!interaction.inGuild() || !interaction.guild?.members?.me || !interaction.channel) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'clear.guild_only'), flags: MessageFlags.Ephemeral })
    return null
  }
  const { channel, guild: { members: { me } } } = interaction

  if (!channel.isTextBased()) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'clear.text_only'), flags: MessageFlags.Ephemeral })
    return null
  }

  if (!channel.permissionsFor(me).has(PermissionFlagsBits.ManageMessages)) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'clear.bot_no_permission'), flags: MessageFlags.Ephemeral })
    return null
  }

  return channel
}

// fetches every message with an id greater than `after` (and, if given, less than `before`)
const collectMessagesAfter = async (channel: GuildTextBasedChannel, after: string, before?: string): Promise<Message[]> => {
  const messages: Message[] = []
  let cursor = BigInt(after)
  const limit = before ? BigInt(before) : null

  while (true) {
    const batch = await channel.messages.fetch({ after: cursor.toString(), limit: 100 })
    if (batch.size === 0) break

    let maxId = cursor
    for (const msg of batch.values()) {
      const id = BigInt(msg.id)
      if (id > maxId) maxId = id
      if (limit !== null && id >= limit) continue
      messages.push(msg)
    }

    if (maxId === cursor) break // safety net against an infinite loop
    cursor = maxId

    if (limit !== null && cursor >= limit) break
    if (batch.size < 100) break
  }

  return messages
}

export const handleClearAfter = async (interaction: ChatInputCommandInteraction) => {
  const channel = await ensurePurgeableChannel(interaction)
  if (!channel) return

  const after = interaction.options.getString("after", true)
  const before = interaction.options.getString("before", false)

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const messages = await collectMessagesAfter(channel, after, before ?? undefined)
  if (messages.length === 0) {
    await interaction.editReply({ content: t([interaction.locale, interaction.guildLocale], 'clear.none') })
    return
  }

  await purge(channel, messages)

  await interaction.editReply({ content: t([interaction.locale, interaction.guildLocale], 'clear.done', { count: messages.length }) })
}

export const handleClearCount = async (interaction: ChatInputCommandInteraction) => {
  const channel = await ensurePurgeableChannel(interaction)
  if (!channel) return

  const amount = interaction.options.getInteger("amount", true)
  if (amount < 1) {
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'clear.too_few'), flags: MessageFlags.Ephemeral })
    return
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const messages: Message<true>[] = []
  let before: string | undefined
  while (messages.length < amount) {
    const fetchOptions = { limit: Math.min(100, amount - messages.length), ...(before && { before }) }
    if (!fetchOptions.limit) break
    const batch = await channel.messages.fetch(fetchOptions)
    if (batch.size === 0) break // end of the channel?
    messages.push(...batch.values())
    before = batch.last()?.id
  }

  if (messages.length === 0) {
    await interaction.editReply({ content: t([interaction.locale, interaction.guildLocale], 'clear.none') })
    return
  }

  await purge(channel, messages)

  await interaction.editReply({ content: t([interaction.locale, interaction.guildLocale], 'clear.done', { count: messages.length }) })
}

export const clearFeature: Feature = {
  commands: [{
    name: 'clear',
    ...localizedDescription('command.clear.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
    default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
    options: [
      {
        name: 'amount',
        ...localizedDescription('command.clear.amount.description'),
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'amount',
            ...localizedDescription('command.clear.amount.option.amount'),
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1,
            max_value: 2000,
          },
        ],
      },
      {
        name: 'after',
        ...localizedDescription('command.clear.after.description'),
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            name: 'after',
            ...localizedDescription('command.clear.after.option.after'),
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            name: 'before',
            ...localizedDescription('command.clear.after.option.before'),
            type: ApplicationCommandOptionType.String,
            required: false,
          },
        ],
      },
    ],
  }],
  chat: {
    'clear after': handleClearAfter,
    'clear amount': handleClearCount,
  },
}
