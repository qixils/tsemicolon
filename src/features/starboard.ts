import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  DiscordAPIError,
  EmbedBuilder,
  Events,
  MessageFlags,
  PermissionFlagsBits,
  ReactionType,
  RESTJSONErrorCodes,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type GuildTextBasedChannel,
  type Message,
  type MessageReaction,
  type PartialMessage,
  type PartialMessageReaction,
} from 'discord.js'
import { int, optionalText, text, withSchema, type Row } from '../db.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { formatNumber, t, type MaybeLocales } from '../i18n.js'
import { SENDABLE_TEXT_CHANNEL_TYPES, addMediaPreview, postableChannel, truncate } from '../util/discord.js'
import { emojiKey, parseEmoji, reactionKey } from '../util/emoji.js'
import typia from 'typia'

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS starboards (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id          TEXT    NOT NULL,
    channel_id        TEXT    NOT NULL,
    emoji             TEXT    NOT NULL,
    threshold         INTEGER NOT NULL,
    legacy            INTEGER NOT NULL DEFAULT 0,
    legacy_thresholds TEXT,
    legacy_emojis     TEXT
  );
  CREATE INDEX IF NOT EXISTS starboards_by_guild ON starboards (guild_id);

  CREATE TABLE IF NOT EXISTS starboard_posts (
    starboard_id INTEGER NOT NULL REFERENCES starboards (id) ON DELETE CASCADE,
    message_id   TEXT    NOT NULL,
    post_id      TEXT    NOT NULL,
    PRIMARY KEY (starboard_id, message_id)
  ) WITHOUT ROWID;
  CREATE INDEX IF NOT EXISTS starboard_posts_by_post ON starboard_posts (starboard_id, post_id);

  -- the old db had one starboard per server and didn't record which server a
  -- post belonged to; these get claimed by that server's legacy starboard on use
  CREATE TABLE IF NOT EXISTS legacy_starboard_posts (
    message_id TEXT PRIMARY KEY,
    post_id    TEXT NOT NULL
  ) WITHOUT ROWID;
`)

const NAMESPACE = 'starboard'
export const DEFAULT_STAR = '⭐'
export const DEFAULT_THRESHOLD = 5

export interface Starboard {
  id: number
  guildId: string
  channelId: string
  emoji: string
  threshold: number
  /** Indicates that this starboard comes from the old db, and may have oprhaned posts in `legacy_starboard_posts` */
  legacy: boolean
  /**
   * Thresholds that used to be in effect.
   * Prevents old starboarded posts from getting deleted.
   * Maps the cutoff time as a snowflake to the old threshold for messages before it.
   */
  legacyThresholds: Record<string, number> | null
  /**
   * Emojis this starboard used before its current one.
   * They still count towards it, so changing the emoji doesn't strand old posts.
   */
  legacyEmojis: string[]
}

const toStarboard = (row: Row): Starboard => {
  const thresholds = optionalText(row, 'legacy_thresholds')
  const emojis = optionalText(row, 'legacy_emojis')
  return typia.assert<Starboard>({
    id: int(row, 'id'),
    guildId: text(row, 'guild_id'),
    channelId: text(row, 'channel_id'),
    emoji: text(row, 'emoji'),
    threshold: int(row, 'threshold'),
    legacy: int(row, 'legacy') === 1,
    legacyThresholds: thresholds ? JSON.parse(thresholds) : null,
    legacyEmojis: emojis ? JSON.parse(emojis) : [],
  })
}

/** Keys of every emoji that counts towards this starboard */
export const boardEmojiKeys = (board: Starboard) => new Set([board.emoji, ...board.legacyEmojis].map(emojiKey))

export const starboardsFor = (guildId: string): Starboard[] =>
  db().prepare('SELECT * FROM starboards WHERE guild_id = ? ORDER BY id').all(guildId).map(toStarboard)

const getStarboard = (guildId: string, id: number): Starboard | undefined => {
  const row = db().prepare('SELECT * FROM starboards WHERE guild_id = ? AND id = ?').get(guildId, id)
  return row ? toStarboard(row) : undefined
}

export const createStarboard = (board: Omit<Starboard, 'id'>): number => {
  const result = db().prepare(`
    INSERT INTO starboards (guild_id, channel_id, emoji, threshold, legacy, legacy_thresholds, legacy_emojis)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    board.guildId, board.channelId, board.emoji, board.threshold,
    board.legacy ? 1 : 0, board.legacyThresholds ? JSON.stringify(board.legacyThresholds) : null,
    board.legacyEmojis.length ? JSON.stringify(board.legacyEmojis) : null,
  )
  return Number(result.lastInsertRowid)
}

/** Stores the old db's starboard posts until a legacy starboard claims them */
export const addLegacyPosts = (posts: { messageId: string, postId: string }[]) => {
  const insert = db().prepare('INSERT OR IGNORE INTO legacy_starboard_posts (message_id, post_id) VALUES (?, ?)')
  for (const { messageId, postId } of posts) insert.run(messageId, postId)
}

const findPost = (board: Starboard, messageId: string): string | null => {
  const row = db().prepare('SELECT post_id FROM starboard_posts WHERE starboard_id = ? AND message_id = ?').get(board.id, messageId)
  if (row) return text(row, 'post_id')
  if (!board.legacy) return null

  const legacy = db().prepare('SELECT post_id FROM legacy_starboard_posts WHERE message_id = ?').get(messageId)
  if (!legacy) return null
  const postId = text(legacy, 'post_id')
  db().prepare('DELETE FROM legacy_starboard_posts WHERE message_id = ?').run(messageId)
  savePost(board, messageId, postId)
  return postId
}

const savePost = (board: Starboard, messageId: string, postId: string) => {
  db().prepare('INSERT OR REPLACE INTO starboard_posts (starboard_id, message_id, post_id) VALUES (?, ?, ?)').run(board.id, messageId, postId)
}

const forgetPost = (board: Starboard, messageId: string) => {
  db().prepare('DELETE FROM starboard_posts WHERE starboard_id = ? AND message_id = ?').run(board.id, messageId)
}

/** Finds the threshold that was active for a given message ID based on its embedded unix timestamp. */
const thresholdFor = (board: Starboard, messageId: string) => {
  if (!board.legacyThresholds) return board.threshold
  const id = BigInt(messageId)
  let best: [bigint, number] | null = null
  for (const [cutoff, threshold] of Object.entries(board.legacyThresholds)) {
    const cutoffId = BigInt(cutoff)
    if (id <= cutoffId && (!best || cutoffId < best[0])) best = [cutoffId, threshold]
  }
  return best ? best[1] : board.threshold
}

/**
 * Saves a new threshold for starboard posts going forward.
 * When an increase over the previous value,
 * this saves the old lower value in a map,
 * so that old starboard posts don't get deleted when updated.
 * 
 * When a decrease over the previous value,
 * any previously higher threshold is deleted,
 * so old posts that previously missed the criteria could now show up when updated.
 */
const nextLegacyThresholds = (board: Starboard, threshold: number, cutoff: string) => {
  const entries = Object.entries(board.legacyThresholds ?? {}).filter(([, old]) => old < threshold)
  if (threshold > board.threshold) entries.push([cutoff, board.threshold])
  return entries.length ? Object.fromEntries(entries) : null
}

/** Gets the emoji to display. When using the default this grabs an escalating star emoji. */
const displayEmoji = (board: Starboard, count: number) =>
  board.emoji === DEFAULT_STAR ? ['⭐', '🌟', '💫', '🌠', '✨'][Math.min(4, Math.floor(count / 5))]! : board.emoji

/** Gets the embed color to display. */
const accentColor = (count: number) => {
  const lerp = Math.min(count / 13, 1)
  const green = Math.round(194 * lerp + 253 * (1 - lerp))
  const blue = Math.round(12 * lerp + 247 * (1 - lerp))
  return (255 << 16) + (green << 8) + blue
}

const buildPost = (board: Starboard, message: Message<true>, count: number) => {
  const locales = [message.guild.preferredLocale]
  const embed = new EmbedBuilder()
    .setDescription(message.content || null)
    .setColor(accentColor(count))
    .setTimestamp(message.createdAt)
    .setAuthor({
      name: message.member?.displayName ?? message.author.displayName,
      iconURL: message.author.displayAvatarURL({ extension: 'png' }),
    })
    .setFooter({ text: `#${message.channel.name}` })
  addMediaPreview(embed, message, locales)

  return {
    content: t(locales, 'starboard.post', { emoji: displayEmoji(board, count), count: formatNumber(locales, count), url: message.url }),
    embeds: [embed],
  }
}

/** Counts the users who reacted to the provided message with any of the provided keys, ignoring the author and bots */
const countReactions = async (message: Message, keys: ReadonlySet<string>) => {
  const voters = new Set<string>()
  for (const reaction of message.reactions.cache.values()) {
    if (!keys.has(reactionKey(reaction.emoji))) continue
    for (const type of [ReactionType.Normal, ReactionType.Burst]) {
      let after: string | undefined
      while (true) {
        const page = await reaction.users.fetch({ type, limit: 100, ...(after && { after }) })
        for (const user of page.values()) {
          if (!user.bot && user.id !== message.author.id) voters.add(user.id)
        }
        if (page.size < 100) break
        after = page.lastKey()
      }
    }
  }
  return voters.size
}

const locks = new Map<string, Promise<void>>()

/** Serializes work on one starboard entry so two quick reactions can't double-post */
const withLock = async (key: string, work: () => Promise<void>) => {
  const current = (locks.get(key) ?? Promise.resolve()).then(work)
  const tail = current.catch(() => {})
  locks.set(key, tail)
  try {
    await current
  } finally {
    if (locks.get(key) === tail) locks.delete(key)
  }
}

const isNsfw = (channel: GuildTextBasedChannel): boolean =>
  channel.isThread()
    ? channel.parent?.nsfw ?? false
    : 'nsfw' in channel && channel.nsfw

const isMissing = (error: unknown) =>
  error instanceof DiscordAPIError && error.code === RESTJSONErrorCodes.UnknownMessage

const updateBoard = async (board: Starboard, message: Message<true>, count: number) => {
  const channel = postableChannel(message.guild, board.channelId, [PermissionFlagsBits.EmbedLinks])
  if (!channel || message.channelId === board.channelId) return

  const postId = findPost(board, message.id)
  const qualifies = count >= thresholdFor(board, message.id)

  if (postId) {
    try {
      const post = await channel.messages.fetch(postId)
      if (qualifies) await post.edit(buildPost(board, message, count))
      else {
        await post.delete()
        forgetPost(board, message.id)
      }
      return
    } catch (error) {
      if (!isMissing(error)) throw error
      // someone(?) deleted the post..!
      // anything actually problematic would've had its original deleted too i'd assume,
      //  so probably a mistake or automod or something,
      //  so let's clear the old data and try to post it again
      forgetPost(board, message.id)
    }
  }

  // don't expose age-restricted channels
  if (!qualifies || (isNsfw(message.channel) && !isNsfw(channel))) return
  const post = await channel.send(buildPost(board, message, count))
  savePost(board, message.id, post.id)
}

const onReaction = async (reaction: MessageReaction | PartialMessageReaction) => {
  const guildId = reaction.message.guildId
  if (!guildId) return
  const key = reactionKey(reaction.emoji)
  const boards = starboardsFor(guildId).filter(board => boardEmojiKeys(board).has(key))
  if (boards.length === 0) return

  const message = await reaction.message.fetch().catch(() => null)
  if (!message?.inGuild()) return

  for (const board of boards) {
    const count = await countReactions(message, boardEmojiKeys(board))
    await withLock(`${board.id}:${message.id}`, () => updateBoard(board, message, count))
  }
}

const forgetPosts = (guildId: string, channelId: string, postIds: string[]) => {
  const boards = starboardsFor(guildId).filter(board => board.channelId === channelId)
  if (boards.length === 0) return
  const forget = db().prepare('DELETE FROM starboard_posts WHERE starboard_id = ? AND post_id = ?')
  for (const board of boards) {
    for (const postId of postIds) forget.run(board.id, postId)
  }
}

const removeFromBoards = async (message: Message | PartialMessage, boards: Starboard[]) => {
  const guild = message.guild
  if (!guild) return
  for (const board of boards) {
    await withLock(`${board.id}:${message.id}`, async () => {
      const postId = findPost(board, message.id)
      if (!postId) return
      forgetPost(board, message.id)
      const channel = postableChannel(guild, board.channelId)
      await channel?.messages.delete(postId).catch(() => {})
    })
  }
}

////////////////////
///// COMMANDS /////
////////////////////

const boardLabel = (board: Starboard, channelName: string, locales: MaybeLocales) =>
  t(locales, 'starboard.label', { emoji: board.emoji, channel: `#${channelName}`, threshold: board.threshold })

const autocompleteBoards = async (interaction: AutocompleteInteraction) => {
  if (!interaction.inCachedGuild()) return
  const locales = [interaction.locale, interaction.guildLocale]
  const query = interaction.options.getFocused().toLowerCase()
  const choices = starboardsFor(interaction.guildId)
    .map(board => ({
      name: truncate(boardLabel(board, interaction.guild.channels.cache.get(board.channelId)?.name ?? board.channelId, locales), 100),
      value: board.id,
    }))
    .filter(choice => choice.name.toLowerCase().includes(query))
    .slice(0, 25)
  await interaction.respond(choices)
}

const readEmoji = async (interaction: ChatInputCommandInteraction, fallback?: string) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const raw = interaction.options.getString('emoji')
  if (raw === null) return fallback ?? DEFAULT_STAR
  const emoji = parseEmoji(raw)
  if (!emoji) await interaction.reply({ content: t(locales, 'starboard.invalid_emoji'), flags: MessageFlags.Ephemeral })
  return emoji
}

const readChannel = async (interaction: ChatInputCommandInteraction<'cached'>, required: boolean) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const channel = interaction.options.getChannel('channel', required, [ChannelType.GuildText, ChannelType.GuildAnnouncement])
  if (channel && !postableChannel(interaction.guild, channel.id, [PermissionFlagsBits.EmbedLinks])) {
    await interaction.reply({ content: t(locales, 'setup.channel_unusable', { channel: channel.toString() }), flags: MessageFlags.Ephemeral })
    return undefined
  }
  return channel
}

const duplicateOf = (guildId: string, channelId: string, emoji: string, except?: number) =>
  starboardsFor(guildId).find(board =>
    board.id !== except && board.channelId === channelId && boardEmojiKeys(board).has(emojiKey(emoji)))

const channelOption = (required: boolean) => ({
  type: ApplicationCommandOptionType.Channel as const,
  ...localizedName('command.setup.starboard.option.channel.name'),
  ...localizedDescription('command.setup.starboard.option.channel.description'),
  channel_types: SENDABLE_TEXT_CHANNEL_TYPES,
  required,
})
const emojiOption = {
  type: ApplicationCommandOptionType.String as const,
  ...localizedName('command.setup.starboard.option.emoji.name'),
  ...localizedDescription('command.setup.starboard.option.emoji.description'),
}
const thresholdOption = {
  type: ApplicationCommandOptionType.Integer as const,
  ...localizedName('command.setup.starboard.option.threshold.name'),
  ...localizedDescription('command.setup.starboard.option.threshold.description'),
  min_value: 1,
  max_value: 1000,
}
const boardOption = {
  type: ApplicationCommandOptionType.Integer as const,
  ...localizedName('command.setup.starboard.option.starboard.name'),
  ...localizedDescription('command.setup.starboard.option.starboard.description'),
  required: true,
  autocomplete: true,
}

export const starboardFeature: Feature = {
  setup: [{
    type: ApplicationCommandOptionType.SubcommandGroup,
    ...localizedName('command.setup.starboard.name'),
    ...localizedDescription('command.setup.starboard.description'),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.starboard.add.name'),
        ...localizedDescription('command.setup.starboard.add.description'),
        options: [channelOption(true), emojiOption, thresholdOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.starboard.edit.name'),
        ...localizedDescription('command.setup.starboard.edit.description'),
        options: [boardOption, channelOption(false), emojiOption, thresholdOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.starboard.remove.name'),
        ...localizedDescription('command.setup.starboard.remove.description'),
        options: [boardOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.setup.starboard.list.name'),
        ...localizedDescription('command.setup.starboard.list.description'),
      },
    ],
  }],
  chat: {
    'setup starboard add': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const channel = await readChannel(interaction, true)
      if (!channel) return
      const emoji = await readEmoji(interaction)
      if (!emoji) return
      if (duplicateOf(interaction.guildId, channel.id, emoji)) {
        await interaction.reply({ content: t(locales, 'starboard.duplicate'), flags: MessageFlags.Ephemeral })
        return
      }

      const threshold = interaction.options.getInteger('threshold') ?? DEFAULT_THRESHOLD
      createStarboard({ guildId: interaction.guildId, channelId: channel.id, emoji, threshold, legacy: false, legacyThresholds: null, legacyEmojis: [] })
      await interaction.reply({
        content: t(locales, 'starboard.added', { channel: channel.toString(), emoji, threshold }),
        flags: MessageFlags.Ephemeral,
      })
    },
    'setup starboard edit': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const board = getStarboard(interaction.guildId, interaction.options.getInteger('starboard', true))
      if (!board) {
        await interaction.reply({ content: t(locales, 'starboard.not_found'), flags: MessageFlags.Ephemeral })
        return
      }
      const channel = await readChannel(interaction, false)
      if (channel === undefined) return
      const emoji = await readEmoji(interaction, board.emoji)
      if (!emoji) return

      const channelId = channel?.id ?? board.channelId
      if (duplicateOf(interaction.guildId, channelId, emoji, board.id)) {
        await interaction.reply({ content: t(locales, 'starboard.duplicate'), flags: MessageFlags.Ephemeral })
        return
      }
      const threshold = interaction.options.getInteger('threshold') ?? board.threshold
      // the interaction's snowflake doubles as the cutoff for messages sent before this edit
      const legacyThresholds = nextLegacyThresholds(board, threshold, interaction.id)
      // the old emoji keeps counting so that existing posts still update
      const legacyEmojis = emojiKey(emoji) === emojiKey(board.emoji)
        ? board.legacyEmojis
        : [...board.legacyEmojis.filter(old => emojiKey(old) !== emojiKey(emoji)), board.emoji]

      db().prepare('UPDATE starboards SET channel_id = ?, emoji = ?, threshold = ?, legacy_thresholds = ?, legacy_emojis = ? WHERE id = ?')
        .run(channelId, emoji, threshold, legacyThresholds ? JSON.stringify(legacyThresholds) : null,
          legacyEmojis.length ? JSON.stringify(legacyEmojis) : null, board.id)
      // posts in the old channel can't be edited from the new one
      if (channelId !== board.channelId) db().prepare('DELETE FROM starboard_posts WHERE starboard_id = ?').run(board.id)

      await interaction.reply({
        content: t(locales, 'starboard.edited', { channel: `<#${channelId}>`, emoji, threshold }),
        flags: MessageFlags.Ephemeral,
      })
    },
    'setup starboard remove': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const id = interaction.options.getInteger('starboard', true)
      await interaction.reply({
        content: t(locales, 'starboard.confirm_removal'),
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents([
          new ButtonBuilder().setStyle(ButtonStyle.Danger).setLabel(t(locales, 'common.confirm')).setCustomId(`${NAMESPACE}:confirm_delete:${id}`),
          new ButtonBuilder().setStyle(ButtonStyle.Secondary).setLabel(t(locales, 'common.cancel')).setCustomId(`${NAMESPACE}:cancel_delete:${id}`),
        ])],
        flags: MessageFlags.Ephemeral,
      })
    },
    'setup starboard list': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const boards = starboardsFor(interaction.guildId)
      await interaction.reply({
        content: boards.length
          ? boards.map(board => t(locales, 'starboard.list_item', { emoji: board.emoji, channel: `<#${board.channelId}>`, threshold: board.threshold })).join('\n')
          : t(locales, 'starboard.none'),
        flags: MessageFlags.Ephemeral,
      })
    },
  },
  autocomplete: {
    'setup starboard edit': autocompleteBoards,
    'setup starboard remove': autocompleteBoards,
  },
  components: {
    [NAMESPACE]: async (interaction, [action = '', ...args]) => {
      if (!interaction.inCachedGuild()) return

      const locales = [interaction.locale, interaction.guildLocale]

      // every outcome replaces the prompt, so its buttons can't be pressed twice
      switch (action) {
        case 'confirm_delete':
          if (Temporal.Duration.compare(interaction.message.createdAt.toTemporalInstant().until(Temporal.Now.instant()), Temporal.Duration.from({ hours: 1 })) > -1) {
            await interaction.update({ content: t(locales, 'starboard.expired'), components: [] })
            return
          }
          const id = Number(args[0])
          if (!args.length || !Number.isFinite(id)) {
            await interaction.update({ content: t(locales, 'starboard.not_found'), components: [] })
            return
          }
          // sql auto deletes posts
          const removed = db().prepare('DELETE FROM starboards WHERE guild_id = ? AND id = ?').run(interaction.guildId, id)
          await interaction.update({
            content: t(locales, Number(removed.changes) > 0 ? 'starboard.removed' : 'starboard.not_found'),
            components: [],
          })
          return
        case 'cancel_delete':
          // after a deferred update, the "original" response is the message the button is on
          await interaction.deferUpdate()
          await interaction.deleteReply()
      }
    },
  },
  attach(client) {
    const handle = (reaction: MessageReaction | PartialMessageReaction) => {
      onReaction(reaction).catch(error => console.error('Starboard update failed:', error))
    }
    client.on(Events.MessageReactionAdd, handle)
    client.on(Events.MessageReactionRemove, handle)
    client.on(Events.MessageReactionRemoveAll, message => {
      if (!message.guildId) return
      removeFromBoards(message, starboardsFor(message.guildId)).catch(error => console.error('Starboard clear failed:', error))
    })
    client.on(Events.MessageDelete, message => {
      if (message.guildId) forgetPosts(message.guildId, message.channelId, [message.id])
    })
    client.on(Events.MessageBulkDelete, (messages, channel) => {
      forgetPosts(channel.guildId, channel.id, [...messages.keys()])
    })
    client.on(Events.ChannelDelete, channel => {
      // posts are removed by the cascade
      if (!channel.isDMBased()) db().prepare('DELETE FROM starboards WHERE guild_id = ? AND channel_id = ?').run(channel.guildId, channel.id)
    })
    // the board's other emojis may still hold the post up, so this gets recounted like any other reaction change
    client.on(Events.MessageReactionRemoveEmoji, handle)
  },
  // posts are removed by the cascade
  forgetGuild: guildId => Number(db().prepare('DELETE FROM starboards WHERE guild_id = ?').run(guildId).changes),
}
