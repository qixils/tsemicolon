import { setTimeout as sleep } from 'node:timers/promises'
import { PermissionFlagsBits, type AuditLogEvent, type Guild, type GuildAuditLogsEntry } from 'discord.js'

/** Audit log entries take a moment to show up */
const SETTLE_DELAY = 1500
/** How long to cache results for */
const REUSE_WINDOW = 2000

// TODO: cleanup cache task?
const cache = new Map<string, { at: number, entries: Promise<GuildAuditLogsEntry[]> }>()

/**
 * Fetches audit log entries of one type created within `maxAge` ms.
 * Returns an empty array if the audit log can't be accessed.
 */
export const recentAuditEntries = async (guild: Guild, type: AuditLogEvent, maxAge: number): Promise<GuildAuditLogsEntry[]> => {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return []
  await sleep(SETTLE_DELAY)

  const key = `${guild.id}:${type}`
  let cached = cache.get(key)
  if (!cached || Date.now() - cached.at > REUSE_WINDOW) {
    cached = {
      at: Date.now(),
      entries: guild.fetchAuditLogs({ type, limit: 50 })
        .then(logs => [...logs.entries.values()])
        .catch(() => []),
    }
    cache.set(key, cached)
  }

  const entries = await cached.entries
  return entries.filter(entry => Date.now() - entry.createdTimestamp <= maxAge)
}
