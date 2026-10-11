import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ChannelType, Events, type Client, type Message, type TextBasedChannel } from 'discord.js'
import { OWNER_ID } from '../config.js'
import type { Feature } from '../feature.js'
import { t } from '../i18n.js'
import { chunkLines, parseSnowflake } from '../util/discord.js'
import { botEmoji } from '../util/emoji.js'

const run = promisify(execFile)
/** whether to spawn npm in a shell (required on windows) */
const SHELL = process.platform === 'win32'

interface StepResult { ok: boolean, output: string }

const step = async (command: string, args: string[]): Promise<StepResult> => {
  try {
    const { stdout, stderr } = await run(command, args, { shell: SHELL, timeout: 5 * 60 * 1000, maxBuffer: 10 * 1024 * 1024 })
    return { ok: true, output: [stdout, stderr].join('\n').trim() }
  } catch (error) {
    const failure = error as { stdout?: string, stderr?: string, message?: string }
    return { ok: false, output: [failure.stdout, failure.stderr || failure.message].filter(Boolean).join('\n').trim() }
  }
}

const block = (channel: TextBasedChannel, label: string, result: StepResult) =>
  `**${label}** ${botEmoji(result.ok ? 'success' : 'failure', channel)}\n\`\`\`\n${result.output.slice(-1500) || ' '}\n\`\`\``

/**
 * pulls, installs dependencies, and rebuilds
 */
const update = async (message: Message) => {
  if (message.channel.isSendable()) await message.channel.sendTyping().catch(() => {})
  const before = (await step('git', ['rev-parse', 'HEAD'])).output
  const pull = await step('git', ['pull', '--ff-only'])
  const reports = [block(message.channel, 'git pull', pull)]

  if (pull.ok) {
    const changed = (await step('git', ['diff', '--name-only', before, 'HEAD'])).output.split('\n')
    let installed: StepResult | null = null
    if (changed.some(file => file === 'package-lock.json' || file === 'package.json')) {
      installed = await step('npm', ['ci'])
      reports.push(block(message.channel, 'npm ci', installed))
    }
    if (installed?.ok !== false) reports.push(block(message.channel, 'npm run build', await step('npm', ['run', 'build'])))
    reports.push(t([], installed ? 'owner.update_needed_deps' : 'owner.update'))
  }

  for (const content of chunkLines(reports.join('\n'))) {
    await message.reply({ content })
  }
}

/** function to gracefully exit the bot's process */
export type Shutdown = (reason: string) => Promise<void>

/** functions to delete stored data, returning how many records were removed */
export interface Forget {
  guild(guildId: string, client: Client): Promise<number>
  user(userId: string, client: Client): Promise<number>
}

export const ownerFeature = (shutdown: Shutdown, forget: Forget): Feature => ({
  attach(client) {
    client.on(Events.MessageCreate, async message => {
      if (!OWNER_ID) return
      if (message.channel.type !== ChannelType.DM || message.author.id !== OWNER_ID) return
      const [command = '', arg = ''] = message.content.trim().toLowerCase().split(/\s+/)
      try {
        if (command === 'logout') {
          await message.reply({ content: t([], 'owner.logout') })
          await shutdown('logout command invoked')
        } else if (command === 'update') {
          await update(message)
        } else if (command === 'forget-guild' || command === 'forget-user') {
          // data deletion requests
          const id = parseSnowflake(arg)
          if (!id) {
            await message.reply({ content: t([], 'owner.forget.invalid_id') })
            return
          }
          const count = command === 'forget-guild' ? await forget.guild(id, message.client) : await forget.user(id, message.client)
          await message.reply({ content: t([], 'owner.forget.done', { count, id }) })
        } else if (command === 'help') {
          await message.reply({ content: '`logout`, `update`, `forget-guild <id>`, `forget-user <id>`' })
        }
      } catch (error) {
        console.error(`Owner command "${command}" failed:`, error)
      }
    })
  },
})
