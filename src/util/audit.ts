import { setTimeout as sleep } from 'node:timers/promises'
import { PermissionFlagsBits, type AuditLogEvent, type Guild, type GuildAuditLogsEntry } from 'discord.js'

/** Audit log entries take a moment to show up */
const SETTLE_DELAY = 1500
/** How long to cache results for */
const REUSE_WINDOW = 2000

interface CacheObj<T extends AuditLogEvent = AuditLogEvent> {
  at: number
  entries: Promise<GuildAuditLogsEntry<T>[]>
}

// TODO: cleanup cache task?
const cache = new Map<string, CacheObj>()

/**
 * Fetches audit log entries of one type created within `maxAge` ms.
 * Returns an empty array if the audit log can't be accessed.
 */
export const recentAuditEntries = async <T extends AuditLogEvent>(guild: Guild, type: T, maxAge: number): Promise<GuildAuditLogsEntry<T>[]> => {
  if (!guild.members.me?.permissions.has(PermissionFlagsBits.ViewAuditLog)) return []
  await sleep(SETTLE_DELAY)

  const key = `${guild.id}:${type}`
  let cached = cache.get(key) as CacheObj<T> | undefined
  if (!cached || Date.now() - cached.at > REUSE_WINDOW) {
    cached = {
      at: Date.now(),
      entries: guild.fetchAuditLogs<T>({ type, limit: 50 })
        .then(logs => [...logs.entries.values()] as GuildAuditLogsEntry<T>[])
        .catch(() => []),
    }
    cache.set(key, cached)
  }

  const entries = await cached.entries
  return entries.filter(entry => Date.now() - entry.createdTimestamp <= maxAge)
}
