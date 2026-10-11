import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  InteractionContextType,
  MessageFlags,
  TimestampStyles,
  time,
  type ButtonComponent,
  type ButtonInteraction,
  type Client,
} from 'discord.js'
import { int, optionalText, text, withSchema, type Row } from '../db.js'
import { customId, localizedDescription, localizedName, type Feature } from '../feature.js'
import { t, type MaybeLocales } from '../i18n.js'
import { truncate } from '../util/discord.js'
import { parseWhen } from '../util/time.js'

const NAMESPACE = 'remind'
const TICK = 5000

/** recently attempted but failed reminders. just saves performance & ratelimits, not worth saving to db */
const attemptedReminders = new Map<number, number>()
const REATTEMPT_AFTER_MILLIS = 1000 * 60 * 60

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS reminders (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    TEXT    NOT NULL,
    guild_id   TEXT,
    channel_id TEXT,
    -- invoking (announcement) message to link back to
    message_id TEXT,
    -- parent id when using "remind me too", to avoid someone spamming the button 
    parent_id  INTEGER,
    content    TEXT    NOT NULL,
    remind_at  INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    status     TEXT    NOT NULL DEFAULT 'pending', -- pending | sent | cancelled
    hidden     INTEGER NOT NULL DEFAULT 0,
    -- the recipient's locale, for the reminder DM
    locale     TEXT
  );
  CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, remind_at);
  CREATE INDEX IF NOT EXISTS reminders_by_parent ON reminders (parent_id, user_id);
`)

type Status = 'pending' | 'sent' | 'cancelled'

export interface Reminder {
  id: number
  userId: string
  guildId: string | null
  channelId: string | null
  messageId: string | null
  parentId: number | null
  content: string
  remindAt: number
  createdAt: number
  status: Status
  hidden: number
  locale: string | null
}

const toReminder = (row: Row): Reminder => ({
  id: int(row, 'id'),
  userId: text(row, 'user_id'),
  guildId: optionalText(row, 'guild_id'),
  channelId: optionalText(row, 'channel_id'),
  messageId: optionalText(row, 'message_id'),
  parentId: row['parent_id'] === null ? null : int(row, 'parent_id'),
  content: text(row, 'content'),
  remindAt: int(row, 'remind_at'),
  createdAt: int(row, 'created_at'),
  status: text(row, 'status') as Status,
  hidden: int(row, 'hidden'),
  locale: optionalText(row, 'locale'),
})

export const createReminderRow = (reminder: Omit<Reminder, 'id' | 'status'>): number => {
  const result = db().prepare(`
    INSERT INTO reminders (user_id, guild_id, channel_id, message_id, parent_id, content, remind_at, created_at, hidden, locale)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    reminder.userId, reminder.guildId, reminder.channelId, reminder.messageId,
    reminder.parentId, reminder.content, reminder.remindAt, reminder.createdAt,
    reminder.hidden, reminder.locale,
  )
  return Number(result.lastInsertRowid)
}

const getReminder = (id: number): Reminder | undefined => {
  const row = db().prepare('SELECT * FROM reminders WHERE id = ?').get(id)
  return row ? toReminder(row) : undefined
}

/** Finalizes a reminder */
const setStatus = (id: number, status: Exclude<Status, 'pending'>): boolean =>
  Number(db().prepare("UPDATE reminders SET status = ? WHERE id = ? AND status = 'pending'").run(status, id).changes) > 0

const setHidden = (id: number): boolean =>
  Number(db().prepare("UPDATE reminders SET hidden = 1 WHERE id = ?").run(id).changes) > 0

const setMessage = (id: number, messageId: string | null) => {
  db().prepare('UPDATE reminders SET message_id = ? WHERE id = ?').run(messageId, id)
}

const quote = (content: string) => content.split('\n').map(line => `> ${line}`).join('\n')

const when = (at: number) => ({
  relative: time(new Date(at), TimestampStyles.RelativeTime),
  when: time(new Date(at), TimestampStyles.FullDateShortTime),
})

const button = (action: string, id: number, emoji: string, label: string, style = ButtonStyle.Secondary) =>
  new ButtonBuilder().setCustomId(customId(NAMESPACE, action, id)).setEmoji(emoji).setLabel(label).setStyle(style)

const cancelButton = (id: number, locales: MaybeLocales) => button('cancel', id, '🗑️', t(locales, 'remind.button.cancel'))

const controls = (id: number, hidden: boolean, locales: MaybeLocales, publicLocales: MaybeLocales = locales) => [
  new ActionRowBuilder<ButtonBuilder>().addComponents(hidden
    ? [cancelButton(id, locales)]
    : [
        button('join', id, '🖐️', t(publicLocales, 'remind.button.join'), ButtonStyle.Primary),
        cancelButton(id, locales),
        button('hide', id, '🙈', t(locales, 'remind.button.hide')),
      ]),
]

/** Returns the message's buttons with the one that was just clicked disabled */
const disableClicked = (interaction: ButtonInteraction) => {
  const buttons = interaction.message.components
    .flatMap(row => row.type === ComponentType.ActionRow ? row.components : [])
    .filter((component): component is ButtonComponent => component.type === ComponentType.Button)
    .map(button => ButtonBuilder.from(button).setDisabled(button.disabled || button.customId === interaction.customId))
  return buttons.length ? [new ActionRowBuilder<ButtonBuilder>().addComponents(buttons)] : []
}

const announcement = (reminder: Reminder, locales: MaybeLocales) =>
  t(locales, 'remind.set', { user: `<@${reminder.userId}>`, ...when(reminder.remindAt), text: quote(reminder.content) })

const onButton = async (interaction: ButtonInteraction, action: string, reminder: Reminder) => {
  const locales = [interaction.locale, interaction.guildLocale]
  const isOwner = interaction.user.id === reminder.userId
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral })

  switch (action) {
    case 'join': {
      if (isOwner) return ephemeral(t(locales, 'remind.join.own'))
      // if (reminder.status === 'cancelled') return ephemeral(t(locales, 'remind.join.cancelled'))
      if (reminder.remindAt <= Date.now()) return ephemeral(t(locales, 'remind.join.passed'))

      const existing = db().prepare("SELECT id FROM reminders WHERE parent_id = ? AND user_id = ? AND status = 'pending'")
        .get(reminder.id, interaction.user.id)
      if (existing) return ephemeral(t(locales, 'remind.join.already', when(reminder.remindAt)))

      const id = createReminderRow({
        userId: interaction.user.id,
        guildId: reminder.guildId,
        channelId: reminder.channelId,
        messageId: reminder.messageId,
        parentId: reminder.id,
        content: reminder.content,
        remindAt: reminder.remindAt,
        createdAt: Date.now(),
        hidden: 1, // just to avoid publicly spamming a bunch of joined reminders all at once if everyone is lacking DM access lol
        locale: interaction.locale,
      })
      await interaction.reply({
        content: t(locales, 'remind.join.done', { ...when(reminder.remindAt), text: quote(reminder.content) }),
        components: controls(id, true, locales),
        flags: MessageFlags.Ephemeral,
      })
      return
    }

    case 'cancel': {
      if (!isOwner) return ephemeral(t(locales, 'remind.owner_only'))
      if (!setStatus(reminder.id, 'cancelled')) {
        return ephemeral(t(locales, reminder.status === 'sent' ? 'remind.already_sent' : 'remind.already_cancelled'))
      }
      // the original message stays as-is (it may be public), only the owner hears about the cancellation
      await interaction.update({ components: disableClicked(interaction) })
      await interaction.followUp({
        content: t(locales, 'remind.cancelled', { text: quote(reminder.content) }),
        ...(interaction.inGuild() && { flags: MessageFlags.Ephemeral }),
      })
      return
    }

    case 'hide': {
      if (!isOwner) return ephemeral(t(locales, 'remind.owner_only'))
      // after a deferred update, the "original" response is the message the button is on
      await interaction.deferUpdate()
      await interaction.deleteReply().catch(() => interaction.message.delete())
      setHidden(reminder.id) // TODO: verify that this shows what one might expect
      const pending = reminder.status === 'pending'
      await interaction.followUp({
        content: pending ? announcement(reminder, locales) : t(locales, 'remind.hidden'),
        components: pending ? controls(reminder.id, true, locales) : [],
        flags: MessageFlags.Ephemeral,
      })
      return
    }
  }
}

const jumpLink = (reminder: Reminder) =>
  reminder.channelId && reminder.messageId
    ? `https://discord.com/channels/${reminder.guildId ?? '@me'}/${reminder.channelId}/${reminder.messageId}`
    : null

const deliver = async (client: Client, reminder: Reminder): Promise<boolean> => {
  const guild = reminder.guildId ? client.guilds.cache.get(reminder.guildId) : undefined
  const locales = [reminder.locale, guild?.preferredLocale]
  const link = jumpLink(reminder)
  const content = [
    t(locales, 'remind.delivery', { created: time(new Date(reminder.createdAt), TimestampStyles.RelativeTime), text: quote(reminder.content) }),
    ...(link ? [link] : []),
  ].join('\n')

  try {
    const user = await client.users.fetch(reminder.userId)
    const sent = await user.send({ content })
    if (sent) {
      setStatus(reminder.id, 'sent')
      return true
    }
  } catch {
  }

  // DMs closed, we can fall back to the channel it was set in?

  if (!reminder.channelId) return false
  if (reminder.hidden) return false

  const channel = await client.channels.fetch(reminder.channelId).catch(() => null)
  if (!channel?.isSendable()) return false

  const sent = await channel.send({ content: `<@${reminder.userId}> ${content}`, allowedMentions: { users: [reminder.userId] } })
  if (sent) {
    setStatus(reminder.id, 'sent')
    return true
  }

  return false
}

let ticking = false
const tick = async (client: Client) => {
  // we utilize a loop like this because you can't schedule functions longer than ~a month (2^32 millis) in JS
  if (ticking) return
  ticking = true
  try {
    const now = Date.now()

    for (const [reminder, failed] of [...attemptedReminders.entries()]) {
      if ((failed + REATTEMPT_AFTER_MILLIS) > now) continue
      attemptedReminders.delete(reminder)
    }

    const due = db().prepare("SELECT * FROM reminders WHERE status = 'pending' AND remind_at <= ? ORDER BY remind_at LIMIT 50")
      .all(now).map(toReminder)
    for (const reminder of due) {
      if (attemptedReminders.has(reminder.id)) continue
      await deliver(client, reminder)
        .then(result => { if (!result) throw new Error("Failed to send DM") })
        .catch(error => {
          attemptedReminders.set(reminder.id, now)
          console.error(`Failed to deliver reminder ${reminder.id}:`, error)
        })
    }
  } finally {
    ticking = false
  }
}

export const remindersFeature: Feature = {
  commands: [{
    ...localizedName('command.remind.name'),
    ...localizedDescription('command.remind.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM],
    options: [
      {
        type: ApplicationCommandOptionType.String,
        ...localizedName('command.remind.option.when.name'),
        ...localizedDescription('command.remind.option.when.description'),
        required: true,
        max_length: 100,
      },
      {
        type: ApplicationCommandOptionType.String,
        ...localizedName('command.remind.option.reminder.name'),
        ...localizedDescription('command.remind.option.reminder.description'),
        required: true,
        max_length: 1500,
      },
      {
        type: ApplicationCommandOptionType.Boolean,
        ...localizedName('command.remind.option.hidden.name'),
        ...localizedDescription('command.remind.option.hidden.description'),
      },
    ],
  }],
  chat: {
    remind: async interaction => {
      const locales = [interaction.locale, interaction.guildLocale]
      const input = interaction.options.getString('when', true)
      const content = interaction.options.getString('reminder', true)

      const _hidden = interaction.options.getBoolean('hidden') ?? false
      const ephemeral = _hidden && interaction.inGuild()
      const unjoinable = _hidden || !interaction.inGuild()

      const at = parseWhen(input)
      if (!at) {
        await interaction.reply({ content: t(locales, 'remind.unparseable', { input: truncate(input, 100) }), flags: MessageFlags.Ephemeral })
        return
      }
      if (at.getTime() <= Date.now()) {
        await interaction.reply({ content: t(locales, 'remind.in_past', when(at.getTime())), flags: MessageFlags.Ephemeral })
        return
      }

      const reminder: Omit<Reminder, 'id' | 'status'> = {
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        messageId: null,
        parentId: null,
        content,
        remindAt: at.getTime(),
        createdAt: Date.now(),
        hidden: ephemeral ? 1 : 0,
        locale: interaction.locale,
      }
      const id = createReminderRow(reminder)

      const response = await interaction.reply({
        content: announcement({ ...reminder, id, status: 'pending' }, locales),
        components: controls(id, unjoinable, locales, [interaction.guildLocale]),
        withResponse: true,
        ...(ephemeral && { flags: MessageFlags.Ephemeral }),
      })
      if (!ephemeral && response.resource?.message) setMessage(id, response.resource.message.id)
    },
  },
  components: {
    [NAMESPACE]: async (interaction, [action = '', id = '']) => {
      if (!interaction.isButton()) return
      const reminder = getReminder(Number(id))
      if (!reminder) {
        await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'remind.not_found'), flags: MessageFlags.Ephemeral })
        return
      }
      await onButton(interaction, action, reminder)
    },
  },
  attach(client) {
    setInterval(() => {
      if (client.isReady()) tick(client).catch(error => console.error('Reminder tick failed:', error))
    }, TICK).unref()
  },
}
