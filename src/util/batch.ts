import { setTimeout as sleep } from 'node:timers/promises'
import type { GuildTextBasedChannel } from 'discord.js'
import { chunkLines } from './discord.js'

/** hook to provide extra log lines at posting of batch */
export interface BatchHook {
  /** unique key identifies this hook so multiple of the same function don't run at once */
  key: string
  run(): Promise<string | null>
}

interface Batch {
  lines: string[]
  hooks: Map<string, BatchHook['run']>
}

const BATCH_FOR_MILLIS = 1000
const batches = new Map<string, Batch>()

/** Posts a log line, merging with others sent shortly before */
export const postBatched = async (channel: GuildTextBasedChannel, line: string, hook?: BatchHook) => {
  const existing = batches.get(channel.id)
  if (existing) {
    existing.lines.push(line)
    if (hook && !existing.hooks.has(hook.key)) existing.hooks.set(hook.key, hook.run)
    return
  }

  const batch: Batch = { lines: [line], hooks: new Map(hook ? [[hook.key, hook.run]] : []) }
  batches.set(channel.id, batch)
  await sleep(BATCH_FOR_MILLIS)

  const leading: string[] = []
  for (const run of batch.hooks.values()) {
    const result = await run().catch(() => null)
    if (result) leading.push(result)
  }
  batches.delete(channel.id)

  for (const content of chunkLines([...leading, ...batch.lines].join('\n'))) {
    await channel.send({ content })
  }
}
