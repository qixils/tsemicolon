import {
  ActionRowBuilder,
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ApplicationIntegrationType,
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

/** if we fail to DM a user then we retry after this time */
const REATTEMPT_AFTER_MILLIS = 24 * 60 * 60 * 1000
/** if we fail to DM a user this many times we give up */
const MAX_ATTEMPTS = 30
/** hidden reminders posted in a channel are deleted if their owner doesn't view them within this time */
const UNVIEWED_LIFETIME_MILLIS = REATTEMPT_AFTER_MILLIS * MAX_ATTEMPTS

const db = withSchema('reminders', [`
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
    -- pending | cancelled (so others can still join) | sent (until its owner views it)
    status     TEXT    NOT NULL DEFAULT 'pending',
    -- private reminders have no public announcement to join from, and their content is only shown to their owner
    hidden     INTEGER NOT NULL DEFAULT 0,
    -- the recipient's locale, for the reminder DM
    locale     TEXT,
    -- failed delivery attempts, and when to try again
    attempts   INTEGER NOT NULL DEFAULT 0,
    retry_at   INTEGER
  );
  CREATE INDEX IF NOT EXISTS reminders_due ON reminders (status, COALESCE(retry_at, remind_at));
  CREATE INDEX IF NOT EXISTS reminders_by_parent ON reminders (parent_id, user_id);
`])

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

const deleteReminder = (id: number): boolean =>
  Number(db().prepare('DELETE FROM reminders WHERE id = ?').run(id).changes) > 0

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
      // others can still join a public reminder, so it's kept until it would've gone off
      const joinable = !reminder.hidden && reminder.messageId !== null
      const cancelled = joinable
        ? setStatus(reminder.id, 'cancelled')
        : Number(db().prepare("DELETE FROM reminders WHERE id = ? AND status = 'pending'").run(reminder.id).changes) > 0
      if (!cancelled) {
        return ephemeral(t(locales, reminder.status === 'sent' ? 'remind.already_sent' : 'remind.already_cancelled'))
      }
      // the original message stays as-is (it may be public), only the owner hears about the cancellation
      await interaction.update({ components: disableClicked(interaction) })
      await interaction.followUp({
        content: t(locales, 'remind.cancelled', { text: quote(reminder.content) }),
        ...(interaction.context !== InteractionContextType.BotDM && { flags: MessageFlags.Ephemeral }),
      })
      return
    }

    case 'hide': {
      if (!isOwner) return ephemeral(t(locales, 'remind.owner_only'))
      return hide(interaction, reminder.id, reminder)
    }

    case 'show': {
      if (!isOwner) return ephemeral(t(locales, 'remind.owner_only'));
      await interaction.update({ components: disableClicked(interaction) })
      await interaction.followUp({ content: delivery(reminder, locales), flags: MessageFlags.Ephemeral })
      // it's been seen now, so it can be deleted
      deleteReminder(reminder.id)
      return
    }
  }
}

/** Deletes a reminder's public announcement. `reminder` is undefined if it was already deleted. */
const hide = async (interaction: ButtonInteraction, id: number, reminder?: Reminder) => {
  const locales = [interaction.locale, interaction.guildLocale]
  // after a deferred update, the "original" response is the message the button is on
  await interaction.deferUpdate()
  await interaction.deleteReply().catch(() => interaction.message.delete())
  // the announcement is gone, so neither this reminder nor any joined ones should link back to it
  db().prepare('UPDATE reminders SET message_id = NULL, hidden = 1 WHERE id = ? OR parent_id = ?').run(id, id)
  // nobody can join it anymore, so a cancelled one isn't needed
  if (reminder?.status === 'cancelled') deleteReminder(id)
  const pending = reminder?.status === 'pending' ? reminder : null
  await interaction.followUp({
    content: pending ? announcement(pending, locales) : t(locales, 'remind.hidden'),
    components: pending ? controls(id, true, locales) : [],
    flags: MessageFlags.Ephemeral,
  })
}

const jumpLink = (reminder: Reminder) =>
  reminder.channelId && reminder.messageId
    ? `https://discord.com/channels/${reminder.guildId ?? '@me'}/${reminder.channelId}/${reminder.messageId}`
    : null

/** The message reminding the user */
const delivery = (reminder: Reminder, locales: MaybeLocales) => {
  const link = jumpLink(reminder)
  return [
    t(locales, 'remind.delivery', { created: time(new Date(reminder.createdAt), TimestampStyles.RelativeTime), text: quote(reminder.content) }),
    ...(link ? [link] : []),
  ].join('\n')
}

const deliver = async (client: Client, reminder: Reminder): Promise<boolean> => {
  const guild = reminder.guildId ? client.guilds.cache.get(reminder.guildId) : undefined
  const locales = [reminder.locale, guild?.preferredLocale]
  const content = delivery(reminder, locales)

  try {
    const user = await client.users.fetch(reminder.userId)
    const sent = await user.send({ content })
    if (sent) {
      deleteReminder(reminder.id)
      return true
    }
  } catch {
  }

  // DMs closed, we can fall back to the channel it was set in

  if (!reminder.channelId) return false

  const channel = await client.channels.fetch(reminder.channelId).catch(() => null)
  if (!channel?.isSendable()) return false

  const mention = `<@${reminder.userId}>`
  const allowedMentions = { users: [reminder.userId] }
  // hidden reminders only announce that they're due, the owner can reveal the content to themself
  const sent = await channel.send(reminder.hidden
    ? {
        content: t(locales, 'remind.delivery_hidden', { user: mention }),
        components: [new ActionRowBuilder<ButtonBuilder>().addComponents(button('show', reminder.id, '👀', t(locales, 'remind.button.show')))],
        allowedMentions,
      }
    : { content: `${mention} ${content}`, allowedMentions })
  if (sent) {
    // hidden reminders are kept until their owner clicks to view them
    if (reminder.hidden) setStatus(reminder.id, 'sent')
    else deleteReminder(reminder.id)
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
    // clear elapsed cancelled reminders (they were only kept so others could join them, which they no longer can)
    db().prepare("DELETE FROM reminders WHERE status = 'cancelled' AND remind_at <= ?").run(now)
    // also clear reminders we tried to publicly tag them about but they didnt look at for a month
    db().prepare("DELETE FROM reminders WHERE status = 'sent' AND COALESCE(retry_at, remind_at) <= ?").run(now - UNVIEWED_LIFETIME_MILLIS)
    const due = db().prepare(`
      SELECT * FROM reminders WHERE status = 'pending' AND COALESCE(retry_at, remind_at) <= ?
      ORDER BY COALESCE(retry_at, remind_at) LIMIT 50
    `).all(now)
    for (const row of due) {
      const reminder = toReminder(row)
      const delivered = await deliver(client, reminder).catch(error => {
        console.error(`Failed to deliver reminder ${reminder.id}:`, error)
        return false
      })
      if (delivered) continue

      const attempts = int(row, 'attempts') + 1
      if (attempts >= MAX_ATTEMPTS) {
        deleteReminder(reminder.id)
        console.warn(`Gave up on reminder ${reminder.id} after ${attempts} failed deliveries`)
      } else {
        db().prepare('UPDATE reminders SET attempts = ?, retry_at = ? WHERE id = ?').run(attempts, now + REATTEMPT_AFTER_MILLIS, reminder.id)
      }
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
    integration_types: [ApplicationIntegrationType.GuildInstall, ApplicationIntegrationType.UserInstall],
    contexts: [InteractionContextType.Guild, InteractionContextType.BotDM, InteractionContextType.PrivateChannel],
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
      // keep the message private if they requested it and they're not in our private DMs
      const ephemeral = _hidden && interaction.context !== InteractionContextType.BotDM
      // if we don't know what this server is or it's not a server then we can't DM them so they can't join
      // (they also can't join if this is hidden)
      const unjoinable = _hidden || !interaction.inCachedGuild()

      const at = parseWhen(input, locales)
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
        hidden: unjoinable ? 1 : 0,
        locale: interaction.locale,
      }
      const id = createReminderRow(reminder)

      const response = await interaction.reply({
        content: announcement({ ...reminder, id, status: 'pending' }, locales),
        components: controls(id, unjoinable, locales, [interaction.guildLocale]),
        withResponse: true,
        ...(ephemeral && { flags: MessageFlags.Ephemeral }),
      })
      // double check that this message was actually visible (it might not be if a server disables external apps)
      const message = response.resource?.message
      if (message && !message.flags.has(MessageFlags.Ephemeral)) setMessage(id, message.id)
    },
  },
  components: {
    [NAMESPACE]: async (interaction, [action = '', id = '']) => {
      if (!interaction.isButton()) return
      const reminder = getReminder(Number(id))
      if (reminder) {
        return await onButton(interaction, action, reminder)
      }
      // finished reminders are deleted, but whoever set one may still want its announcement gone
      if (action === 'hide' && interaction.message.interactionMetadata?.user.id === interaction.user.id) {
        return await hide(interaction, Number(id))
      }
      await interaction.reply({ content: t([interaction.locale, interaction.guildLocale], 'remind.not_found'), flags: MessageFlags.Ephemeral })
    },
  },
  attach(client) {
    setInterval(() => {
      if (client.isReady()) tick(client).catch(error => console.error('Reminder tick failed:', error))
    }, TICK).unref()
  },
  forgetUser: userId => Number(db().prepare('DELETE FROM reminders WHERE user_id = ?').run(userId).changes),
}
