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
