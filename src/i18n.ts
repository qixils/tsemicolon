import messages from './locales/en-US.json' with { type: 'json' }

export type MessageKey = keyof typeof messages
type Template = string | Partial<Record<Intl.LDMLPluralRule, string>>
export type Vars = Record<string, string | number | bigint>

type Locale = 'en-US'
export const DEFAULT_LOCALE = 'en-US' satisfies Locale

const tables: Record<Locale, Record<MessageKey, Template>> = {
  'en-US': messages,
}

const allPlurals = Object.fromEntries(
  Object.keys(tables).map(locale => [locale, new Intl.PluralRules(locale)])
) as Record<Locale, Intl.PluralRules>

type MaybeLocale = string | null | undefined

/**
 * Looks up a message and fills in its `{placeholders}`.
 * Plural messages pick their form from `vars.count`.
 */
export const t = (locales: MaybeLocale | MaybeLocale[], key: MessageKey, vars: Vars = {}): string => {
  if (!locales) locales = []
  else if (typeof locales === 'string') locales = [locales]
  const mapped = locales.flatMap(item => {
    if (!item) return []
    if (item in tables) return [item as Locale]

    const lang = item.split('-')[0]
    if (!lang) return []

    return (Object.keys(tables) as Locale[]).filter(loc => loc.split('-')[0] === lang)
  })
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
  Object.fromEntries((Object.keys(tables) as Locale[]).map(locale => [locale, t([locale], key, vars)]))

/** Formats a number for display, e.g. `1,234`. */
export const formatNumber = (locales: MaybeLocale[], value: number) =>
  value.toLocaleString([...locales.filter((locale): locale is string => !!locale), DEFAULT_LOCALE])
