import {
  ActionRowBuilder,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  InteractionContextType,
  MessageFlags,
  ModalBuilder,
  PermissionFlagsBits,
  TextInputBuilder,
  TextInputStyle,
  type GuildTextBasedChannel,
  type Message,
  type ModalSubmitInteraction,
  type SendableChannels,
  type User,
} from 'discord.js'
import { text, withSchema } from '../db.js'
import { customId, localizedDescription, localizedName, type Feature } from '../feature.js'
import { t, type MaybeLocales, type MessageKey } from '../i18n.js'
import { CUSTOM_EMOJI, UNICODE_EMOJI_SOURCE, emojiKey } from '../util/emoji.js'
import { boardEmojiKeys, starboardsFor } from './starboard.js'

/** Discord's limit on (unique) reactions per message */
const REACTIONS_PER_MESSAGE = 20
/** If someone requests a shit ton of emojis, we'll allow splitting into this many messages */
const MAX_MESSAGES = 2
const NAMESPACE = 'poll'
const MAX_MESSAGE = 1800
const MAX_SHORTHAND = 200
/** How long a rejected poll can still be reopened with "Edit Poll" */
const DRAFT_LIFETIME = 24 * 60 * 60 * 1000

const db = withSchema('poll', [`
  -- a rejected poll's contents, so "Edit Poll" can reopen the form already filled in
  CREATE TABLE IF NOT EXISTS poll_drafts (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    emojis     TEXT    NOT NULL,
    message    TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
`])

/** 0..10 as keycap emojis */
const keycap = (digit: number) => digit === 10 ? '🔟' : `${digit}️⃣`
/** A..Z as regional indicators */
const letter = (char: string) => String.fromCodePoint(0x1f1e6 + char.toUpperCase().charCodeAt(0) - 65)

const ALIASES: Record<string, string> = {
  y: '✅',
  n: '❌',
  m: '❔',
  '?': '❔',
  '!': '❕',
  ...Object.fromEntries(Array.from({ length: 10 }, (_, digit) => [String(digit), keycap(digit)])),
  ...Object.fromEntries(Array.from({ length: 26 }, (_, i) => {
    const char = String.fromCharCode(65 + i)
    return [char, letter(char)]
  })),
}

const range = (from: number, to: number) => {
  const step = from <= to ? 1 : -1
  return Array.from({ length: Math.abs(to - from) + 1 }, (_, i) => from + i * step)
}

const TOKEN = new RegExp([
  String.raw`(?<numrange>(?<num0>10|\d)\.\.(?<num1>10|\d))`,
  String.raw`(?<alpharange>(?<alpha0>[A-Za-z])\.\.(?<alpha1>[A-Za-z]))`,
  `(?<custom>${CUSTOM_EMOJI.source})`,
  `(?<unicode>${UNICODE_EMOJI_SOURCE})`,
  String.raw`(?<misc>.)`,
].join('|'), 'gsv')

/**
 * Parses shorthand into emojis
 */
export const parseShorthand = (input: string): string[] => {
  const emojis: string[] = []
  for (const match of input.matchAll(TOKEN)) {
    const groups = match.groups ?? {}
    if (groups['numrange']) {
      emojis.push(...range(Number(groups['num0']), Number(groups['num1'])).map(keycap))
    } else if (groups['alpharange']) {
      const from = groups['alpha0']!.toUpperCase().charCodeAt(0)
      const to = groups['alpha1']!.toUpperCase().charCodeAt(0)
      emojis.push(...range(from, to).map(code => letter(String.fromCharCode(code))))
    } else if (groups['custom'] || groups['unicode']) {
      emojis.push(groups['custom'] ?? groups['unicode']!)
    } else if (groups['misc'] && ALIASES[groups['misc']]) {
      emojis.push(ALIASES[groups['misc']]!)
    }
  }
  return emojis
}

const LEADING_EMOJI = new RegExp(`^(?:${CUSTOM_EMOJI.source}|${UNICODE_EMOJI_SOURCE})`, 'v')

/** The literal emoji (no shorthands) each line of `text` starts with (skips lines without) */
export const parseLines = (text: string): string[] =>
  text.split('\n').flatMap(line => LEADING_EMOJI.exec(line.trimStart())?.[0] ?? [])

const canPoll = (channel: GuildTextBasedChannel): channel is GuildTextBasedChannel & SendableChannels => {
  const me = channel.guild.members.me
  if (!me || !channel.isSendable()) return false
  const send = channel.isThread() ? PermissionFlagsBits.SendMessagesInThreads : PermissionFlagsBits.SendMessages
  return channel.permissionsFor(me).has([
    PermissionFlagsBits.ViewChannel, send, PermissionFlagsBits.AddReactions, PermissionFlagsBits.ReadMessageHistory,
  ])
}

interface Draft {
  emojis: string
  message: string
}

const pruneDrafts = () => {
  db().prepare('DELETE FROM poll_drafts WHERE created_at < ?').run(Date.now() - DRAFT_LIFETIME)
}

/** Saves (or updates) a rejected poll, returning its ID */
const saveDraft = (existingId: number, userId: string, draft: Draft): number => {
  pruneDrafts()
  const updated = db().prepare('UPDATE poll_drafts SET emojis = ?, message = ?, created_at = ? WHERE id = ? AND user_id = ?')
    .run(draft.emojis, draft.message, Date.now(), existingId, userId)
  if (Number(updated.changes) > 0) return existingId
  const inserted = db().prepare('INSERT INTO poll_drafts (user_id, emojis, message, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, draft.emojis, draft.message, Date.now())
  return Number(inserted.lastInsertRowid)
}

const loadDraft = (id: number, userId: string): Draft | null => {
  const row = db().prepare('SELECT emojis, message FROM poll_drafts WHERE id = ? AND user_id = ? AND created_at >= ?')
    .get(id, userId, Date.now() - DRAFT_LIFETIME)
  return row ? { emojis: text(row, 'emojis'), message: text(row, 'message') } : null
}

const deleteDraft = (id: number) => {
  db().prepare('DELETE FROM poll_drafts WHERE id = ?').run(id)
}

/** The poll form; `draftId` 0 means a fresh one */
const pollModal = (draftId = 0, draft?: Draft, locales: MaybeLocales = []) => {
  const emojis = new TextInputBuilder()
    .setCustomId('emojis')
    .setLabel(t(locales, 'poll.modal.emojis.label'))
    .setPlaceholder(t(locales, 'poll.modal.emojis.placeholder'))
    .setStyle(TextInputStyle.Short)
    .setMaxLength(MAX_SHORTHAND)
    .setRequired(false)
  const message = new TextInputBuilder()
    .setCustomId('message')
    .setLabel(t(locales, 'poll.modal.message.label'))
    .setPlaceholder(t(locales, 'poll.modal.message.placeholder'))
    .setStyle(TextInputStyle.Paragraph)
    .setMinLength(1)
    .setMaxLength(MAX_MESSAGE)
    .setRequired(true)
  // an empty value isn't allowed, so blank fields are just left unset
  if (draft?.emojis) emojis.setValue(draft.emojis)
  if (draft?.message) message.setValue(draft.message)

  return new ModalBuilder()
    .setCustomId(customId(NAMESPACE, 'submit', draftId))
    .setTitle(t(locales, 'poll.modal.title'))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(emojis),
      new ActionRowBuilder<TextInputBuilder>().addComponents(message),
    )
}

/** Extracts emojis from a draft */
const emojisFor = (guildId: string, { emojis, message }: Draft) => {
  const parsed = !emojis ? parseLines(message) : parseShorthand(emojis)
  // starboard emojis would let a poll star itself
  const reserved = new Set(starboardsFor(guildId).flatMap(board => [...boardEmojiKeys(board)]))
  return [...new Map(parsed
    .filter(emoji => !reserved.has(emojiKey(emoji)))
    .map(emoji => [emojiKey(emoji), emoji])).values()]
}

/** Posts the poll as its own message and reacts to it, returning how many emojis couldn't be added */
const postPoll = async (channel: GuildTextBasedChannel & SendableChannels, author: User, emojis: string[], content: string, locales: MaybeLocales) => {
  // the content is user-written, so nobody gets pinged by a poll
  let message: Message = await channel.send({
    content: t(locales, 'poll.message', { user: author.toString(), content }),
  })

  let added = 0
  let failed = 0
  let messages = 1
  for (const emoji of emojis) {
    if (added === REACTIONS_PER_MESSAGE) {
      if (messages === MAX_MESSAGES) break
      message = await channel.send({ content: '** **' })
      messages++
      added = 0
    }
    // one at a time, so the reactions land in order
    try {
      await message.react(emoji)
      added++
    } catch {
      // probably a custom emoji from a server the bot isn't in
      failed++
    }
  }
  return failed
}

const submitPoll = async (interaction: ModalSubmitInteraction<'cached'>, draftId: number) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const draft: Draft = {
    emojis: interaction.fields.getTextInputValue('emojis').trim(),
    message: interaction.fields.getTextInputValue('message'),
  }

  // keep what they typed so they can fix their mistake
  const reject = async (key: MessageKey) => {
    const id = saveDraft(draftId, interaction.user.id, draft)
    const edit = new ButtonBuilder()
      .setCustomId(customId(NAMESPACE, 'edit', id))
      .setLabel(t(locales, 'poll.edit'))
      .setStyle(ButtonStyle.Primary)
    const reply = { content: t(locales, key), components: [new ActionRowBuilder<ButtonBuilder>().addComponents(edit)] }
    if (interaction.isFromMessage()) await interaction.update(reply)
    else await interaction.reply({ ...reply, flags: MessageFlags.Ephemeral })
  }

  const channel = interaction.channel
  if (!channel || !canPoll(channel)) return reject('poll.no_permission')
  const emojis = emojisFor(interaction.guildId, draft)
  if (emojis.length === 0) return reject('poll.no_emojis')

  // resubmitted from an "Edit Poll" message: replace that message rather than adding another
  if (interaction.isFromMessage()) await interaction.deferUpdate()
  else await interaction.deferReply({ flags: MessageFlags.Ephemeral })

  const failed = await postPoll(channel, interaction.user, emojis, draft.message, [interaction.guildLocale])
  if (draftId) deleteDraft(draftId)

  if (failed > 0) await interaction.editReply({ content: t(locales, 'poll.some_failed', { count: failed }), components: [] })
  else await interaction.deleteReply()
}

export const pollFeature: Feature = {
  commands: [{
    ...localizedName('command.poll.name'),
    ...localizedDescription('command.poll.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
  }],
  chat: {
    poll: async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      // say so now, before they've typed anything
      if (!interaction.channel || !canPoll(interaction.channel)) {
        await interaction.reply({ content: t(locales, 'poll.no_permission'), flags: MessageFlags.Ephemeral })
        return
      }
      await interaction.showModal(pollModal(0, undefined, locales))
    },
  },
  components: {
    [NAMESPACE]: async (interaction, [action, id = '0']) => {
      if (action !== 'edit') return
      const locales = [interaction.locale, interaction.guildLocale]
      const draft = loadDraft(Number(id), interaction.user.id)
      if (!draft) {
        await interaction.update({ content: t(locales, 'poll.draft_expired'), components: [] })
        return
      }
      await interaction.showModal(pollModal(Number(id), draft, locales))
    },
  },
  modals: {
    [NAMESPACE]: async (interaction, [action, id = '0']) => {
      if (action !== 'submit' || !interaction.inCachedGuild()) return
      await submitPoll(interaction, Number(id))
    },
  },
  attach() {
    // drafts hold what users wrote, so don't keep them past their lifetime just because nobody has saved another
    setInterval(pruneDrafts, 60 * 60 * 1000).unref()
  },
  forgetUser: userId => Number(db().prepare('DELETE FROM poll_drafts WHERE user_id = ?').run(userId).changes),
}
