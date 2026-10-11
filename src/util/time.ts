import * as chrono from 'chrono-node'
import { isSupportedLocale, type MaybeLocales } from '../i18n.js'

/* english chronos */
const ENGLISH = new Set([chrono.casual, chrono.en.GB])

/** mapping of discord locales to corresponding chrono parser */
const parsers: Record<string, chrono.Chrono> = {
  'en-GB': chrono.en.GB,
  'zh-CN': chrono.zh.hans.casual,
  'zh-TW': chrono.zh.hant.casual,
  en: chrono.casual,
  de: chrono.de.casual,
  es: chrono.es.casual,
  fi: chrono.fi.casual,
  fr: chrono.fr.casual,
  it: chrono.it.casual,
  ja: chrono.ja.casual,
  nl: chrono.nl.casual,
  pt: chrono.pt.casual,
  ru: chrono.ru.casual,
  sv: chrono.sv.casual,
  uk: chrono.uk.casual,
  vi: chrono.vi.casual,
}

const parserFor = (locales: MaybeLocales): chrono.Chrono => {
  for (const locale of typeof locales === 'string' ? [locales] : locales ?? []) {
    if (!locale || !isSupportedLocale(locale)) continue
    const parser = parsers[locale] ?? parsers[locale.split('-')[0]!]
    if (parser) return parser
  }
  return chrono.casual
}

/**
 * Reads a natural-language time in UTC.
 * Returns null if unknown.
 */
export const parseWhen = (input: string, locales: MaybeLocales = [], now = new Date()): Date | null => {
  const reference = { instant: now, timezone: 'UTC' }
  const options = { forwardDate: true }
  const parser = parserFor(locales)
  return parser.parseDate(input, reference, options)
    // chrono reads most bare durations itself but its english doesn't understand them without "in"
    ?? (ENGLISH.has(parser) ? parser.parseDate(`in ${input}`, reference, options) : null)
}
