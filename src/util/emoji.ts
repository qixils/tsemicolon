import { PermissionFlagsBits, type TextBasedChannel } from 'discord.js'

/** Emojis the bot can post, as either one emoji or a custom emoji with a standard fallback */
const BOT_EMOJI = {
  // from Bot-Moji: https://discord.gg/SyKBWjP
  success: ['<:greenTick:328630479886614529>', '✅'],
  failure: ['<:redTick:328630479576104963>', '❌'],
  join: ['<:enter:465369329836228618>', '➡️'],
  leave: ['<:quit:465369329324523542>', '🛫'],
  ban: ['<:banned:683597796955258906>', '🔨'],
  unban: ['<:unbanned:683597796980424734>', '🔓'],
  kick: '👢',
  prune: '⚠️',
  newAccount: '🕒',
  timeout: '🔇',
  untimeout: '🔊',
  rename: '🪪',
} as const satisfies Record<string, string | readonly [custom: string, fallback: string]>

/** Gets one of the bot's emojis, falling back to a standard emoji where the bot can't use external ones */
export const botEmoji = (name: keyof typeof BOT_EMOJI, channel: TextBasedChannel): string => {
  const emoji = BOT_EMOJI[name]
  if (typeof emoji === 'string') return emoji
  const [custom, fallback] = emoji
  // external emojis always work in DMs
  if (channel.isDMBased()) return custom
  const me = channel.guild.members.me
  return me && channel.permissionsFor(me).has(PermissionFlagsBits.UseExternalEmojis) ? custom : fallback
}

/** A full custom emoji like `<a:goldfishsourplsjam:952877443457368064>` */
export const CUSTOM_EMOJI = /<(a?):(\w+):(\d+)>/

/** One standard emoji, including lone regional indicators (which aren't RGI by themselves) */
export const UNICODE_EMOJI_SOURCE = String.raw`(?:\p{RGI_Emoji}|[\u{1F1E6}-\u{1F1FF}])️?`

const SINGLE_EMOJI = new RegExp(`^(?:${CUSTOM_EMOJI.source}|${UNICODE_EMOJI_SOURCE})$`, 'v')

/** Returns input trimmed if it is an emoji, otherwise null */
export const parseEmoji = (input: string): string | null => {
  const trimmed = input.trim()
  return SINGLE_EMOJI.test(trimmed) ? trimmed : null
}

/** strips U+fe0f */
const stripVariation = (emoji: string) => emoji.replace(/️/g, '')

/** Identifies an emoji */
export const emojiKey = (emoji: string) => CUSTOM_EMOJI.exec(emoji)?.[3] ?? stripVariation(emoji)

/** Identifies a reaction's emoji */
export const reactionKey = (emoji: { id: string | null, name: string | null }) =>
  emoji.id ?? stripVariation(emoji.name ?? '')
