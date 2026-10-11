import {
  ApplicationCommandOptionType,
  ApplicationCommandType,
  ChannelType,
  EmbedBuilder,
  Events,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  escapeMarkdown,
  type APIAllowedMentions,
  type AutocompleteInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type MessageCreateOptions,
} from 'discord.js'
import { XMLParser } from 'fast-xml-parser'
import { USER_AGENT } from '../config.js'
import { int, optionalText, text, withSchema, type Row } from '../db.js'
import { localizedDescription, localizedName, type Feature } from '../feature.js'
import { t, type MaybeLocales } from '../i18n.js'
import { SENDABLE_TEXT_CHANNEL_TYPES, postableChannel, truncate } from '../util/discord.js'
import typia from 'typia'

const POLL_INTERVAL = 5 * 60 * 1000
const GUILD_LIMIT = 100
const XKCD_FEED = 'https://xkcd.com/rss.xml'
const youtubeFeed = (channelId: string) => `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`
const YOUTUBE_LINK = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/.+/i
const YOUTUBE_CHANNEL_ID = /UC[\w-]{21}[AQgw]/

const db = withSchema(`
  CREATE TABLE IF NOT EXISTS subscriptions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    guild_id     TEXT    NOT NULL,
    channel_id   TEXT    NOT NULL,
    type         TEXT    NOT NULL, -- xkcd | youtube
    key          TEXT,             -- YouTube channel ID
    name         TEXT    NOT NULL,
    ping_role_id TEXT,
    -- publish time of the newest item posted, in ms
    last_item_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS subscriptions_by_guild ON subscriptions (guild_id);
`)

type FeedType = 'xkcd' | 'youtube'

export interface Subscription {
  id: number
  guildId: string
  channelId: string
  type: FeedType
  key: string | null
  name: string
  pingRoleId: string | null
  lastItemAt: number
}

interface FeedItem {
  publishedAt: number
  message: (ping: string | null, locales: MaybeLocales) => MessageCreateOptions
}

const toSubscription = (row: Row): Subscription => ({
  id: int(row, 'id'),
  guildId: text(row, 'guild_id'),
  channelId: text(row, 'channel_id'),
  type: text(row, 'type') as FeedType,
  key: optionalText(row, 'key'),
  name: text(row, 'name'),
  pingRoleId: optionalText(row, 'ping_role_id'),
  lastItemAt: int(row, 'last_item_at'),
})

export const createSubscription = (subscription: Omit<Subscription, 'id'>) => {
  db().prepare(`
    INSERT INTO subscriptions (guild_id, channel_id, type, key, name, ping_role_id, last_item_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(subscription.guildId, subscription.channelId, subscription.type, subscription.key,
    subscription.name, subscription.pingRoleId, subscription.lastItemAt)
}

const subscriptionsFor = (guildId: string) =>
  db().prepare('SELECT * FROM subscriptions WHERE guild_id = ? ORDER BY id').all(guildId).map(toSubscription)

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  isArray: name => name === 'item' || name === 'entry',
})

const fetchText = async (url: string) => {
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(15000) })
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`)
  return await response.text()
}

const decodeEntities = (value: string) => value
  .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const pingContent = (ping: string | null) => ping ? `<@&${ping}>` : undefined
const pingMentions = (ping: string | null): APIAllowedMentions => ({ roles: ping ? [ping] : [], parse: [] as [] })

type XkcdFeed = { rss?: { channel?: { item?: Record<string, string>[] } } }

const fetchXkcd = async (): Promise<FeedItem[]> => {
  const feed = typia.assert<XkcdFeed>(xml.parse(await fetchText(XKCD_FEED)))
  return (feed.rss?.channel?.item ?? []).map(item => {
    const summary = item['description'] ?? ''
    const image = /src="([^"]+)"/.exec(summary)?.[1]
    const alt = /title="([^"]*)"/.exec(summary)?.[1]
    const publishedAt = Date.parse(item['pubDate'] ?? '')
    return {
      publishedAt,
      message: ping => {
        const embed = new EmbedBuilder()
          // translation not needed for specific website name, especially considering it's an english comic
          .setTitle(truncate(`xkcd: ${escapeMarkdown(item['title'] ?? '')}`, 256))
          .setURL(item['link'] ?? null)
          .setTimestamp(publishedAt)
        if (image) embed.setImage(decodeEntities(image) + '?uncache=pls')
        if (alt) embed.setFooter({ text: truncate(decodeEntities(alt), 2048) })
        const content = pingContent(ping)
        return { ...(content && { content }), embeds: [embed], allowedMentions: pingMentions(ping) }
      },
    }
  })
}

type AtomLink = { rel?: string, href?: string }
type YouTubeFeed = {
    feed?: { title?: string, entry?: { published?: string, link?: AtomLink | AtomLink[] }[] }
  }

const fetchYoutube = async (channelId: string) => {
  const feed = typia.assert<YouTubeFeed>(xml.parse(await fetchText(youtubeFeed(channelId))))
  const items: FeedItem[] = (feed.feed?.entry ?? []).map(entry => {
    const links = Array.isArray(entry.link) ? entry.link : entry.link ? [entry.link] : []
    const link = (links.find(link => link.rel === 'alternate') ?? links[0])?.href ?? ''
    return {
      publishedAt: Date.parse(entry.published ?? ''),
      message: ping => ({ content: [pingContent(ping), link].filter(Boolean).join(' '), allowedMentions: pingMentions(ping) }),
    }
  })
  return { title: feed.feed?.title ?? null, items }
}

/** Posts new content sorted by oldest */
const deliver = async (client: Client, subscription: Subscription, items: FeedItem[]) => {
  const guild = client.guilds.cache.get(subscription.guildId)
  const channel = guild ? postableChannel(guild, subscription.channelId, [PermissionFlagsBits.EmbedLinks]) : null
  if (!channel) return
  const locales = [guild?.preferredLocale]

  const sorted = items.filter(item => Number.isFinite(item.publishedAt)).sort((a, b) => b.publishedAt - a.publishedAt)
  const fresh = sorted.filter(item => item.publishedAt > subscription.lastItemAt)
  if (fresh.length === 0) return
  // the whole feed being new means some were probably missed
  if (fresh.length === sorted.length && sorted.length > 1) {
    await channel.send({ content: t(locales, 'subscribe.too_many') })
  }

  let pingRole = subscription.pingRoleId
  for (const item of fresh.reverse()) {
    const message = await channel.send(item.message(pingRole, locales))
    if (channel.type === ChannelType.GuildAnnouncement) await message.crosspost().catch(() => {});

    db().prepare('UPDATE subscriptions SET last_item_at = ? WHERE id = ?').run(item.publishedAt, subscription.id)

    // avoid spamming pings
    pingRole = null
  }
}

const poll = async (client: Client) => {
  const all = db().prepare('SELECT * FROM subscriptions').all().map(toSubscription)
  const byFeed = new Map<string, Subscription[]>()
  for (const subscription of all) {
    const feed = subscription.type === 'youtube' ? `youtube:${subscription.key}` : subscription.type
    byFeed.set(feed, [...byFeed.get(feed) ?? [], subscription])
  }

  for (const [feed, subscriptions] of byFeed) {
    try {
      const [type, ...args] = feed.split(':')
      let items: FeedItem[]
      switch (type) {
        case 'xkcd':
          items = await fetchXkcd()
          break
        case 'youtube':
          items = (await fetchYoutube(args.join(':'))).items
          break
        default:
          throw new Error(`Unknown feed ${feed}`)
      }
      await Promise.allSettled(subscriptions.map(subscription => deliver(client, subscription, items)))
    } catch (error) {
      console.warn(`Failed to process subscription feed ${feed}:`, error)
    }
  }
}

/** fetches a youtube channe's ID and name */
const resolveYoutubeChannel = async (url: string) => {
  let channelId = YOUTUBE_CHANNEL_ID.exec(url)?.[0] ?? null
  if (!channelId) {
    const page = await fetchText(url).catch(() => '')
    // helpfully the page just has its RSS link in it so we can just grab it lol
    channelId = /xml\?channel_id=(UC[\w-]{21}[AQgw])/.exec(page)?.[1] ?? null
  }
  if (!channelId) return null
  const { title } = await fetchYoutube(channelId).catch(() => ({ title: null }))
  return { channelId, name: title ?? channelId }
}

const autocompleteSubscriptions = async (interaction: AutocompleteInteraction) => {
  if (!interaction.inCachedGuild()) return
  const locales = [interaction.locale, interaction.guildLocale]
  const query = interaction.options.getFocused().toLowerCase()
  await interaction.respond(subscriptionsFor(interaction.guildId)
    .map(subscription => ({
      name: truncate(t(locales, 'subscribe.choice', {
        name: subscription.name,
        channel: interaction.guild.channels.cache.get(subscription.channelId)?.name ?? subscription.channelId,
      }), 100),
      value: subscription.id,
    }))
    .filter(choice => choice.name.toLowerCase().includes(query))
    .slice(0, 25))
}

const subscribe = async (interaction: ChatInputCommandInteraction, type: FeedType) => {
  if (!interaction.inCachedGuild()) return
  const locales = [interaction.locale, interaction.guildLocale]
  const channel = interaction.options.getChannel('channel', true, [ChannelType.GuildText, ChannelType.GuildAnnouncement])
  const role = interaction.options.getRole('ping_role')

  if (!postableChannel(interaction.guild, channel.id, [PermissionFlagsBits.EmbedLinks])) {
    await interaction.reply({ content: t(locales, 'setup.channel_unusable', { channel: channel.toString() }), flags: MessageFlags.Ephemeral })
    return
  }
  const existing = subscriptionsFor(interaction.guildId)
  if (existing.length >= GUILD_LIMIT) {
    await interaction.reply({ content: t(locales, 'subscribe.limit', { count: GUILD_LIMIT }), flags: MessageFlags.Ephemeral })
    return
  }

  let key: string | null = null
  let name = 'xkcd'
  if (type === 'youtube') {
    const url = interaction.options.getString('url', true).trim()
    if (!YOUTUBE_LINK.test(url) && !YOUTUBE_CHANNEL_ID.test(url)) {
      await interaction.reply({ content: t(locales, 'subscribe.youtube.invalid_link'), flags: MessageFlags.Ephemeral })
      return
    }
    await interaction.deferReply({ flags: MessageFlags.Ephemeral })
    const resolved = await resolveYoutubeChannel(url)
    if (!resolved) {
      await interaction.editReply({ content: t(locales, 'subscribe.youtube.not_found') })
      return
    }
    key = resolved.channelId
    name = resolved.name
  }

  if (existing.some(subscription => subscription.channelId === channel.id && subscription.type === type && subscription.key === key)) {
    const content = t(locales, 'subscribe.exists', { channel: channel.toString() })
    if (interaction.deferred) await interaction.editReply({ content })
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral })
    return
  }

  createSubscription({
    guildId: interaction.guildId,
    channelId: channel.id,
    type,
    key,
    name,
    pingRoleId: role?.id ?? null,
    // only things published from now on
    lastItemAt: Date.now(),
  })

  const content = type === 'xkcd'
    ? t(locales, 'subscribe.xkcd.done', { channel: channel.toString() })
    : t(locales, 'subscribe.youtube.done', { name: escapeMarkdown(name), channel: channel.toString() })
  if (interaction.deferred) await interaction.editReply({ content })
  else await interaction.reply({ content, flags: MessageFlags.Ephemeral })
}

const channelOption = {
  type: ApplicationCommandOptionType.Channel as const,
  ...localizedName('command.subscribe.option.channel.name'),
  ...localizedDescription('command.subscribe.option.channel.description'),
  channel_types: SENDABLE_TEXT_CHANNEL_TYPES,
  required: true,
}
const pingOption = {
  type: ApplicationCommandOptionType.Role as const,
  ...localizedName('command.subscribe.option.ping_role.name'),
  ...localizedDescription('command.subscribe.option.ping_role.description'),
}

export const subscriptionsFeature: Feature = {
  commands: [{
    ...localizedName('command.subscribe.name'),
    ...localizedDescription('command.subscribe.description'),
    type: ApplicationCommandType.ChatInput,
    contexts: [InteractionContextType.Guild],
    default_member_permissions: PermissionFlagsBits.ManageGuild.toString(),
    options: [
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.subscribe.xkcd.name'),
        ...localizedDescription('command.subscribe.xkcd.description'),
        options: [channelOption, pingOption],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.subscribe.youtube.name'),
        ...localizedDescription('command.subscribe.youtube.description'),
        options: [
          channelOption,
          { type: ApplicationCommandOptionType.String, ...localizedName('command.subscribe.youtube.option.url.name'), ...localizedDescription('command.subscribe.youtube.option.url.description'), required: true },
          pingOption,
        ],
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.subscribe.list.name'),
        ...localizedDescription('command.subscribe.list.description'),
      },
      {
        type: ApplicationCommandOptionType.Subcommand,
        ...localizedName('command.subscribe.remove.name'),
        ...localizedDescription('command.subscribe.remove.description'),
        options: [{
          type: ApplicationCommandOptionType.Integer,
          ...localizedName('command.subscribe.remove.option.subscription.name'),
          ...localizedDescription('command.subscribe.remove.option.subscription.description'),
          required: true,
          autocomplete: true,
        }],
      },
    ],
  }],
  chat: {
    'subscribe xkcd': async interaction => subscribe(interaction, 'xkcd'),
    'subscribe youtube': async interaction => subscribe(interaction, 'youtube'),
    'subscribe list': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const subscriptions = subscriptionsFor(interaction.guildId)
      const embed = new EmbedBuilder()
        .setTitle(t(locales, 'subscribe.list.title'))
        .setDescription(subscriptions.length
          ? subscriptions.map(subscription => t(locales, subscription.pingRoleId ? 'subscribe.list.item_ping' : 'subscribe.list.item', {
              name: escapeMarkdown(subscription.name),
              channel: `<#${subscription.channelId}>`,
              role: `<@&${subscription.pingRoleId}>`,
            })).join('\n')
          : t(locales, 'subscribe.list.none'))
      await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral })
    },
    'subscribe remove': async interaction => {
      if (!interaction.inCachedGuild()) return
      const locales = [interaction.locale, interaction.guildLocale]
      const id = interaction.options.getInteger('subscription', true)
      const removed = Number(db().prepare('DELETE FROM subscriptions WHERE id = ? AND guild_id = ?').run(id, interaction.guildId).changes) > 0
      await interaction.reply({ content: t(locales, removed ? 'subscribe.removed' : 'subscribe.not_found'), flags: MessageFlags.Ephemeral })
    },
  },
  autocomplete: {
    'subscribe remove': autocompleteSubscriptions,
  },
  attach(client) {
    const run = () => {
      if (client.isReady()) poll(client).catch(error => console.error('Subscription poll failed:', error))
    }
    setInterval(run, POLL_INTERVAL).unref()

    client.on(Events.ChannelDelete, channel => {
      if (!channel.isDMBased()) db().prepare('DELETE FROM subscriptions WHERE guild_id = ? AND channel_id = ?').run(channel.guildId, channel.id)
    })
    client.on(Events.GuildRoleDelete, role => {
      db().prepare('UPDATE subscriptions SET ping_role_id = NULL WHERE guild_id = ? AND ping_role_id = ?').run(role.guild.id, role.id)
    })
  },
  forgetGuild: guildId => Number(db().prepare('DELETE FROM subscriptions WHERE guild_id = ?').run(guildId).changes),
}
