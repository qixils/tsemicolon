import messages from './locales/en-US.json' with { type: 'json' }

export type MessageKey = keyof typeof messages
type Template = string | Partial<Record<Intl.LDMLPluralRule, string>>
export type Vars = Record<string, string | number | bigint>

export type Locale = 'en-US'
export const DEFAULT_LOCALE = 'en-US' satisfies Locale

const tables: Record<Locale, Record<MessageKey, Template>> = {
  'en-US': messages,
}

const allLocales = Object.keys(tables) as Readonly<Locale[]>

const allPlurals = Object.fromEntries(
  allLocales.map(locale => [locale, new Intl.PluralRules(locale)])
) as Record<Locale, Intl.PluralRules>

type MaybeLocale = string | null | undefined
export type MaybeLocales = MaybeLocale | MaybeLocale[]

const verifyLocales = (locales: MaybeLocales): Locale[] => {
  if (!locales) locales = []
  else if (typeof locales === 'string') locales = [locales]

  return locales.flatMap(item => {
    if (!item) return []
    if (item in tables) return [item as Locale]

    const lang = item.split('-')[0]
    if (!lang) return []

    return allLocales.filter(loc => loc.split('-')[0] === lang)
  })
}

/**
 * Looks up a message and fills in its `{placeholders}`.
 * Plural messages pick their form from `vars.count`.
 */
export const t = (locales: MaybeLocales, key: MessageKey, vars: Vars = {}): string => {
  const mapped = verifyLocales(locales)
  const locale = mapped.find(lang => tables[lang][key]) ?? DEFAULT_LOCALE
  const entry = tables[locale][key]
  const template = typeof entry === 'string'
    ? entry
    : entry[allPlurals[locale].select(Number(vars['count'] ?? 0))] ?? entry.other ?? key

  return template.replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = vars[name]
    return value === undefined ? match : String(value)
  })
}

/** Returns every translation for the provided key */
export const tAll = (key: MessageKey, vars: Vars = {}): Partial<Record<Locale, string>> =>
  Object.fromEntries(allLocales.map(locale => [locale, t([locale], key, vars)]))

/** Returns a non-empty array of all valid input locales with the default */
export const resolveLocales = (locales: MaybeLocales): Locale[] => [...verifyLocales(locales), DEFAULT_LOCALE]

/** Formats a number for display, e.g. `1,234`. */
export const formatNumber = (locales: MaybeLocales, value: number, options?: Intl.NumberFormatOptions) =>
  // we use resolveLocales so that we don't localize numbers into languages the bot doesn't support
  // as it is my understanding that say, german folk generally find it confusing to have english text with german numbers
  value.toLocaleString(resolveLocales(locales), options)
