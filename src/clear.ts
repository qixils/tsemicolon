import { ChatInputCommandInteraction, Message, MessageFlags, Constants, type GuildTextBasedChannel } from "discord.js"

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
    await interaction.reply({ content: 'This command must be run in a guild.', flags: MessageFlags.Ephemeral })
    return null
  }
  const { channel, guild: { members: { me } } } = interaction

  if (!channel.isTextBased()) {
    await interaction.reply({ content: 'This command must be run in a text channel.', flags: MessageFlags.Ephemeral })
    return null
  }

  if (!channel.permissionsFor(me).has('ManageMessages')) {
    await interaction.reply({ content: 'I do not have access to managing messages in this channel.', flags: MessageFlags.Ephemeral })
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
    await interaction.editReply({ content: 'No messages found.' })
    return
  }

  await purge(channel, messages)

  await interaction.editReply({ content: `Deleted ${messages.length} message(s).` })
}

export const handleClearCount = async (interaction: ChatInputCommandInteraction) => {
  const channel = await ensurePurgeableChannel(interaction)
  if (!channel) return

  const amount = interaction.options.getInteger("amount", true)
  if (amount < 1) {
    await interaction.reply({ content: 'Amount must be at least 1.', flags: MessageFlags.Ephemeral })
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
    await interaction.editReply({ content: 'No messages found.' })
    return
  }

  await purge(channel, messages)

  await interaction.editReply({ content: `Deleted ${messages.length} message(s).` })
}
