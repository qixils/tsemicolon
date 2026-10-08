import { USER_AGENT } from '../config.js'
import typia from 'typia'

/** PluralKit proxied message */
export interface ProxiedMessage {
  /** ID of the new webhook message */
  id: string
  /** ID of the original deleted message */
  original: string
}

/**
 * PluralKit's record of a message, if it proxied it.
 * Lookups by either ID work.
 */
export const lookupPluralKit = async (messageId: string): Promise<ProxiedMessage | null> => {
  try {
    const response = await fetch(`https://api.pluralkit.me/v2/messages/${messageId}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) return null
    const body = await response.json()
    return typia.assert<ProxiedMessage>(body)
  } catch {
    return null
  }
}

/** Whether PluralKit deleted this message in order to repost it under a proxy */
export const isPluralKitOriginal = async (messageId: string) =>
  (await lookupPluralKit(messageId))?.original === messageId
