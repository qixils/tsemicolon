import { ActionRowBuilder, ApplicationCommandOptionType, ApplicationCommandType, ButtonBuilder, ButtonStyle, ChatInputCommandInteraction, Constants, InteractionContextType, Message, MessageFlags, PermissionFlagsBits, type GuildTextBasedChannel } from "discord.js"
import { customId, localizedDescription, localizedName, type Feature } from "../feature.js"
import { t } from "../i18n.js"

const NAMESPACE = 'clear'

/** active purges by the ID of the initiating interaction */
const running = new Map<string, AbortController>()

/** Deletes the given messages, returning how many were deleted. Abortable via signal. */
const purge = async (channel: GuildTextBasedChannel, msgs: Message[], signal: AbortSignal): Promise<number> => {
  const now = Date.now()
  const recent: Message[] = []
  const old: Message[] = []
  let deleted = 0

  for (const msg of msgs) {
    if (now - msg.createdTimestamp < Constants.MaxBulkDeletableMessageAge) recent.push(msg)
    else old.push(msg)
  }

  // bulk delete API only works in batches of 2-100 and only on recent messages
  for (let i = 0; i < recent.length; i += 100) {
    if (signal.aborted) return deleted
    const chunk = recent.slice(i, i + 100)
    if (chunk.length === 1) {
      await chunk[0]!.delete()
      deleted++
    }
    else deleted += (await channel.bulkDelete(chunk, true)).size
  }

  // anything older has to be deleted one at a time
  for (const msg of old) {
    if (signal.aborted) return deleted
    await msg.delete()
    deleted++
  }

  return deleted
}

const ensurePurgeableChannel = async (interaction: ChatInputCommandInteraction): Promise<GuildTextBasedChannel | null> => {
  if (!interaction.inGuild() || !interaction.guild?.members?.me || !interaction.channel) {
    // inaccurate error message but realistically impossible branch
    await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'clear.text_only'), flags: MessageFlags.Ephemeral })
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

/** fetches every message with an id greater than `after` (and, if given, less than `before`) */
const collectMessagesAfter = async (channel: GuildTextBasedChannel, signal: AbortSignal, after: string, before?: string): Promise<Message[]> => {
  const messages: Message[] = []
  let cursor = BigInt(after)
  const limit = before ? BigInt(before) : null

  while (!signal.aborted) {
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

/** fetches the latest `amount` messages */
const collectLatestMessages = async (channel: GuildTextBasedChannel, signal: AbortSignal, amount: number): Promise<Message[]> => {
  const messages: Message<true>[] = []
  let before: string | undefined
  while (messages.length < amount && !signal.aborted) {
    const fetchOptions = { limit: Math.min(100, amount - messages.length), ...(before && { before }) }
    if (!fetchOptions.limit) break
    const batch = await channel.messages.fetch(fetchOptions)
    if (batch.size === 0) break // end of the channel?
    messages.push(...batch.values())
    before = batch.last()?.id
  }
  return messages
}

const runPurge = async (
  interaction: ChatInputCommandInteraction,
  channel: GuildTextBasedChannel,
  collect: (signal: AbortSignal) => Promise<Message[]>,
) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const controller = new AbortController()
  const { signal } = controller
  running.set(interaction.id, controller)

  try {
    const cancel = new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'cancel', interaction.id))
      .setStyle(ButtonStyle.Danger)
      .setLabel(t(locales, 'common.cancel'))
    await interaction.reply({
      content: t(locales, 'clear.working'),
      components: [new ActionRowBuilder<ButtonBuilder>().addComponents(cancel)],
      flags: MessageFlags.Ephemeral,
    })

    const messages = await collect(signal)
    const deleted = signal.aborted ? 0 : await purge(channel, messages, signal)

    const content = signal.aborted ? t(locales, 'clear.cancelled', { count: deleted })
      : messages.length === 0 ? t(locales, 'clear.none')
      : t(locales, 'clear.done', { count: deleted })
    await interaction.editReply({ content, components: [] })
  } catch (error) {
    // don't leave a dead cancel button behind
    if (interaction.replied) await interaction.editReply({ components: [] }).catch(() => {})
    throw error
  } finally {
    running.delete(interaction.id)
  }
}

export const handleClearAfter = async (interaction: ChatInputCommandInteraction) => {
  const channel = await ensurePurgeableChannel(interaction)
  if (!channel) return

  const after = interaction.options.getString("after", true)
  const before = interaction.options.getString("before", false)

  await runPurge(interaction, channel, signal => collectMessagesAfter(channel, signal, after, before ?? undefined))
}

export const handleClearCount = async (interaction: ChatInputCommandInteraction) => {
  const channel = await ensurePurgeableChannel(interaction)
  if (!channel) return

  const amount = interaction.options.getInteger("amount", true)

  await runPurge(interaction, channel, signal => collectLatestMessages(channel, signal, amount))
}

export const clearFeature: Feature = {
  commands: [{
    ...localizedName('command.clear.name'),
    ...localizedDescription('command.clear.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
    default_member_permissions: PermissionFlagsBits.ManageMessages.toString(),
    options: [
      {
        ...localizedName('command.clear.amount.name'),
        ...localizedDescription('command.clear.amount.description'),
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            ...localizedName('command.clear.amount.option.amount.name'),
            ...localizedDescription('command.clear.amount.option.amount.description'),
            type: ApplicationCommandOptionType.Integer,
            required: true,
            min_value: 1,
            max_value: 2000,
          },
        ],
      },
      {
        ...localizedName('command.clear.after.name'),
        ...localizedDescription('command.clear.after.description'),
        type: ApplicationCommandOptionType.Subcommand,
        options: [
          {
            ...localizedName('command.clear.after.option.after.name'),
            ...localizedDescription('command.clear.after.option.after.description'),
            type: ApplicationCommandOptionType.String,
            required: true,
          },
          {
            ...localizedName('command.clear.after.option.before.name'),
            ...localizedDescription('command.clear.after.option.before.description'),
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
  components: {
    [NAMESPACE]: async (interaction, [action = '', id = '']) => {
      if (action !== 'cancel') return
      const controller = running.get(id)
      if (!controller) {
        // the deletion is no longer running
        await interaction.update({ content: t([interaction.locale, interaction.guildLocale], 'clear.cancel_expired'), components: [] })
        return
      }
      controller.abort()
      // the running command edits in the result
      await interaction.deferUpdate()
    },
  },
}
