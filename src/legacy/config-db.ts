import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { ChannelType, SnowflakeUtil, type Client, type Guild } from 'discord.js'
import { getDb, transaction } from '../db.js'
import { addFlair } from '../features/roles.js'
import { addLegacyUnmute } from '../features/moderation.js'
import { createReminderRow } from '../features/reminders.js'
import { addRule, listRules } from '../features/rules.js'
import { DEFAULT_STAR, DEFAULT_THRESHOLD, addLegacyPosts, createStarboard, starboardsFor } from '../features/starboard.js'
import { createSubscription } from '../features/subscriptions.js'
import { registerLegacyImporter } from '../legacy.js'
import { getSetting, setSetting, type SettingKey, type Settings } from '../settings.js'
import { emojiKey } from '../util/emoji.js'
import { PickleObject, pickleId, pickleState, unpickle, type PickleValue } from './pickle.js'

const FILE = 'config.db'

const open = (dir: string) => {
  const path = join(dir, FILE)
  return existsSync(path) ? new DatabaseSync(path, { readOnly: true }) : null
}

const hasTable = (legacy: DatabaseSync, table: string) =>
  legacy.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined

const rows = (legacy: DatabaseSync, sql: string) => {
  const statement = legacy.prepare(sql)
  statement.setReadBigInts(true) // properly load snowflakes
  return statement.all()
}

const id = (value: unknown) => typeof value === 'bigint' || typeof value === 'number' ? String(value) : null
const bytes = (value: unknown) => value instanceof Uint8Array ? value : null

/** registers an importer for a table */
const tableImporter = (importerId: string, table: string, work: (legacy: DatabaseSync, client: Client<true>) => string) => {
  registerLegacyImporter({
    id: importerId,
    run: async (dir, client) => {
      const legacy = open(dir)
      if (!legacy) return null
      try {
        if (!hasTable(legacy, table)) return `no ${table} table`
        return transaction(getDb(), () => work(legacy, client))
      } finally {
        legacy.close()
      }
    },
  })
}

////////////////////
///// SETTINGS /////
////////////////////

/**
 * Migration information for old channel keys.
 * Old key, new setting, old fallback name when no value was explicitly set.
 */
const CHANNELS: [old: string, setting: SettingKey, fallbackName: string][] = [
  ['joins', 'joinlog_channel', 'semicolon_joins'],
  ['messages', 'messagelog_channel', 'semicolon_messages'],
  ['roles', 'rolelog_channel', 'semicolon_roles'],
  ['modmail', 'reports_channel', 'semicolon_modmail'],
]

/** Intentionally removed features that should not be warned about */
const RETIRED = new Set([
  // discord timeouts are simpler and good enough, especially with DMs
  'muted_role',
  // replaced by action command; works even despite blocks, unlike before
  'report_emoji',
  // no more chat commands...
  'prefix',
  // discord automod basically has this builtin now
  'ping_ban_threshold', 'ping_ban_join_bypass', 'ping_ban_creation_bypass',
])

const channelByName = (guild: Guild | undefined, name: string) =>
  guild?.channels.cache.find(channel => channel.type === ChannelType.GuildText && channel.name === name)?.id ?? null

const thresholdsFrom = (value: PickleValue | undefined) => {
  if (!(value instanceof Map)) return null
  const thresholds: Record<string, number> = {}
  for (const [cutoff, threshold] of value) {
    const key = pickleId(cutoff)
    if (key && typeof threshold === 'number') thresholds[key] = threshold
  }
  return Object.keys(thresholds).length ? thresholds : null
}

const importSettings = (legacy: DatabaseSync, client: Client<true>) => {
  const configs = new Map<string, Map<string, PickleValue>>()
  for (const row of rows(legacy, 'SELECT guild, variable, data FROM guild_config')) {
    const guildId = id(row['guild'])
    const data = bytes(row['data'])
    if (!guildId || !data) continue
    let value: PickleValue
    try {
      value = unpickle(data)
    } catch (error) {
      console.warn(`Skipping unreadable ${String(row['variable'])} for guild ${guildId}:`, error)
      continue
    }
    const config = configs.get(guildId) ?? new Map()
    config.set(String(row['variable']), value)
    configs.set(guildId, config)
  }

  let settings = 0
  let starboards = 0
  const retired = new Map<string, number>()

  // servers that only ever relied on the old name-based fallback have no config rows at all
  const guildIds = new Set([...configs.keys(), ...client.guilds.cache.keys()])
  for (const guildId of guildIds) {
    const config = configs.get(guildId) ?? new Map<string, PickleValue>()
    const guild = client.guilds.cache.get(guildId)

    // settings made in the new db before the import take precedence
    const set = <K extends SettingKey>(key: K, value: Settings[K]) => {
      if (getSetting(guildId, key) !== undefined) return
      setSetting(guildId, key, value)
      settings++
    }

    for (const [old, setting, fallbackName] of CHANNELS) {
      const channelId = pickleId(config.get(`${old}_channel`)) ?? channelByName(guild, fallbackName)
      if (channelId) set(setting, channelId)
    }

    // the old default sent name changes to the joins channel, which is already the new fallback
    const nameChannel = pickleId(config.get('name_change_channel'))
    if (nameChannel && nameChannel !== getSetting(guildId, 'joinlog_channel')) set('namelog_channel', nameChannel)

    const ignored = config.get('ignored_messages_log_users')
    if (Array.isArray(ignored)) {
      const users = ignored.map(pickleId).filter((user): user is string => user !== null)
      if (users.length) set('messagelog_ignored', users)
    }

    const joinRole = pickleId(config.get('join_role'))
    if (joinRole) set('join_role', joinRole)

    const misbehavior = config.get('misbehavior_threshold')
    if (typeof misbehavior === 'number' && misbehavior > 0) set('antispam_threshold', misbehavior)

    // every server with a starboard channel had a starboard, configured or not
    const starboardChannel = pickleId(config.get('starboard_channel')) ?? channelByName(guild, 'semicolon_starboard')
    if (starboardChannel) {
      const emojiValue = config.get('starboard_emoji')
      const thresholdValue = config.get('starboard_threshold')
      const emoji = typeof emojiValue === 'string' && emojiValue ? emojiValue : DEFAULT_STAR
      const exists = starboardsFor(guildId).some(board => board.channelId === starboardChannel && emojiKey(board.emoji) === emojiKey(emoji))
      if (!exists) {
        createStarboard({
          guildId,
          channelId: starboardChannel,
          emoji,
          threshold: typeof thresholdValue === 'number' && thresholdValue > 0 ? thresholdValue : DEFAULT_THRESHOLD,
          legacy: true,
          legacyThresholds: thresholdsFrom(config.get('starboard_legacy_thresholds')),
        })
        starboards++
      }
    }

    for (const [variable, value] of config) {
      if (RETIRED.has(variable) && value !== null && !(value instanceof PickleObject)) {
        retired.set(variable, (retired.get(variable) ?? 0) + 1)
      }
    }
  }

  const retiredSummary = [...retired].map(([variable, count]) => `${variable} x${count}`).join(', ')
  return `${settings} settings and ${starboards} starboards across ${guildIds.size} servers`
    + (retiredSummary ? `; not carried over: ${retiredSummary}` : '')
}

/////////////////
///// TABLES ////
/////////////////

const importRules = (legacy: DatabaseSync) => {
  let count = 0
  const guilds = new Set<string>()
  // the old db numbered rules in insertion order
  for (const row of rows(legacy, 'SELECT guild, rule, ping_here FROM rules ORDER BY rowid')) {
    const guildId = id(row['guild'])
    if (!guildId || typeof row['rule'] !== 'string') continue
    // a server that already has rules in the new db keeps them as they are
    if (!guilds.has(guildId) && listRules(guildId).length > 0) continue
    guilds.add(guildId)
    addRule(guildId, row['rule'], Number(row['ping_here']) === 1)
    count++
  }
  return `${count} rules across ${guilds.size} servers`
}

const importFlairs = (legacy: DatabaseSync) => {
  let count = 0
  for (const row of rows(legacy, 'SELECT guild, flair_id, description FROM flairs')) {
    const guildId = id(row['guild'])
    const roleId = id(row['flair_id'])
    if (!guildId || !roleId) continue
    if (addFlair(guildId, roleId, typeof row['description'] === 'string' ? row['description'] : null)) count++
  }
  return `${count} flairs`
}

const importStarboardPosts = (legacy: DatabaseSync) => {
  const posts = rows(legacy, 'SELECT starred_message_id, starboard_message_id FROM starboard').flatMap(row => {
    const messageId = id(row['starred_message_id'])
    const postId = id(row['starboard_message_id'])
    return messageId && postId ? [{ messageId, postId }] : []
  })
  addLegacyPosts(posts)
  return `${posts.length} starboard posts`
}

const importSubscriptions = (legacy: DatabaseSync) => {
  let count = 0
  for (const row of rows(legacy, 'SELECT guild, channel, subscription_type, subscription_key, last_item_date, data FROM subscriptions')) {
    const guildId = id(row['guild'])
    const channelId = id(row['channel'])
    const type = row['subscription_type']
    if (!guildId || !channelId || (type !== 'xkcd' && type !== 'youtube')) continue

    const data = bytes(row['data'])
    const state = data ? pickleState(unpickle(data)) : new Map()
    const name = state.get('name')
    createSubscription({
      guildId,
      channelId,
      type,
      key: typeof row['subscription_key'] === 'string' ? row['subscription_key'] : null,
      name: typeof name === 'string' ? name : type,
      pingRoleId: pickleId(state.get('ping_role')),
      // the old bot stored seconds
      lastItemAt: Math.round(Number(row['last_item_date']) * 1000),
    })
    count++
  }
  return `${count} subscriptions`
}

const importTasks = (legacy: DatabaseSync) => {
  let reminders = 0
  let unmutes = 0
  let skipped = 0

  // can't believe i wrote this like this LOL
  for (const row of rows(legacy, 'SELECT run_at, func, args FROM tasks')) {
    const func = bytes(row['func'])
    const argBytes = bytes(row['args'])
    const runAt = Number(row['run_at']) * 1000
    const target = func ? unpickle(func) : null
    const args = argBytes ? unpickle(argBytes) : []
    const path = target && typeof target === 'object' && 'path' in target ? target.path : null
    if (!Array.isArray(args)) { skipped++; continue }

    if (path === 'cogs.utils.time.remind') {
      const [userId, messageId, content] = [pickleId(args[0]), pickleId(args[1]), args[2]]
      if (!userId || typeof content !== 'string') { skipped++; continue }
      createReminderRow({
        userId,
        guildId: null,
        channelId: null,
        messageId: null,
        parentId: null,
        content,
        remindAt: runAt,
        createdAt: messageId ? SnowflakeUtil.timestampFrom(messageId) : runAt,
        hidden: 1,
      })
      reminders++
    } else if (path === 'cogs.utils.time.unmute') {
      const [userId, guildId, roleId] = args.slice(0, 3).map(pickleId)
      if (!userId || !guildId || !roleId) { skipped++; continue }
      addLegacyUnmute({ guildId, userId, roleId, runAt })
      unmutes++
    } else {
      skipped++
    }
  }
  return `${reminders} reminders and ${unmutes} pending unmutes` + (skipped ? `; ${skipped} unrecognized tasks skipped` : '')
}

export const registerConfigImports = () => {
  tableImporter('config:settings', 'guild_config', importSettings)
  tableImporter('config:rules', 'rules', importRules)
  tableImporter('config:flairs', 'flairs', importFlairs)
  tableImporter('config:starboard-posts', 'starboard', importStarboardPosts)
  tableImporter('config:subscriptions', 'subscriptions', importSubscriptions)
  tableImporter('config:tasks', 'tasks', importTasks)
}
