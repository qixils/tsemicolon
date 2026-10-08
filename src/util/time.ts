import * as chrono from 'chrono-node'

/**
 * Reads a natural-language time in UTC.
 * Returns null if unknown.
 */
export const parseWhen = (input: string, now = new Date()): Date | null => {
  const reference = { instant: now, timezone: 'UTC' }
  const options = { forwardDate: true }
  // chrono reads most bare durations itself but doesn't understand "in"
  return chrono.parseDate(input, reference, options) ?? chrono.parseDate(`in ${input}`, reference, options)
}
