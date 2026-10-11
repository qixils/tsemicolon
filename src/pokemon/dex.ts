import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DEX_CACHE_DIR, USER_AGENT } from '../config.js'
import { t, type MaybeLocales, type MessageKey } from '../i18n.js'
import { parseCsv } from './csv.js'

/**
 * REST API doesn't expose useful bulk endpoints so we just grab the source CSVs lol
 */
const CSV_BASE = 'https://raw.githubusercontent.com/PokeAPI/pokeapi/master/data/v2/csv'
const CSV_FILES = [
  'pokemon', 'pokemon_species', 'pokemon_types', 'types', 'pokemon_stats', 'stats',
  'pokemon_species_names', 'pokemon_forms', 'pokemon_form_names',
] as const
type CsvFile = (typeof CSV_FILES)[number]
type CsvRows = Record<string, string>[]

const REFRESH_INTERVAL = 24 * 60 * 60 * 1000
const ENGLISH = '9'
/** "real" pokemon are less than this */
const LAST_SPECIES_ID = 10000

// easter egg
export const MISSINGNO_ID = 0
const MISSINGNO_SPRITE = 'https://archives.bulbagarden.net/media/upload/9/98/Missingno_RB.png'

const STAT_NAMES: Record<string, MessageKey> = {
  'hp': 'pokemon.stat.hp',
  'attack': 'pokemon.stat.attack',
  'defense': 'pokemon.stat.defense',
  'special-attack': 'pokemon.stat.special-attack',
  'special-defense': 'pokemon.stat.special-defense',
  'speed': 'pokemon.stat.speed',
}

export const statName = (name: string, locales: MaybeLocales) => {
  const key = STAT_NAMES[name]
  return key ? t(locales, key) : name
}

export interface StatLine { name: string, value: number }

export interface PokemonEntry {
  id: number
  /** `deoxys-attack` */
  slug: string
  /** `Attack Deoxys` */
  name: string
  types: string[]
  stats: StatLine[]
  /** -1 = genderless, otherwise a numerator over 8 representing percent of female (0 = always male, 8 = always female) */
  genderRate: number
  /** whether this 'mon has separate female sprites */
  hasGenderDifferences: boolean
  /** whether this 'mon has separate gender variants (2) or not (1) */
  genderVariants: number
  /** aka "is not missingno" */
  hasShiny: boolean
  /** custom sprite URL (... for missingno) */
  spriteOverride?: string
}

export interface Dex {
  entries: ReadonlyMap<number, PokemonEntry>
  /** Every catchable ID in ascending order */
  ids: readonly number[]
  /** Total number of every 'mon combination that exists (mons by genders by shinies) */
  totalVariants: number
  get(id: number): PokemonEntry | undefined
  find(query: string): PokemonEntry | undefined
}

const titleCase = (slug: string) =>
  slug.split('-').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')

/** strips markers like `♀` and `-f` */
const normalize = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '')

const genderVariantsFor = (genderRate: number) => (genderRate <= 0 || genderRate >= 8 ? 1 : 2)

const fetchCsv = async (file: CsvFile): Promise<string> => {
  const response = await fetch(`${CSV_BASE}/${file}.csv`, { headers: { 'user-agent': USER_AGENT } })
  if (!response.ok) throw new Error(`${file}.csv: HTTP ${response.status}`)
  return await response.text()
}

/** Returns the cached database copy, or fetches it if stale */
const loadCsv = async (file: CsvFile, force: boolean): Promise<CsvRows> => {
  const path = join(DEX_CACHE_DIR, `${file}.csv`)

  if (!force) {
    try {
      const info = await stat(path)
      if (Date.now() - info.mtimeMs < REFRESH_INTERVAL) {
        return parseCsv((await readFile(path)).toString('utf-8'))
      }
    } catch {
      // not cached yet
    }
  }

  try {
    const text = await fetchCsv(file)
    await writeFile(path, text)
    return parseCsv(text)
  } catch (error) {
    // a stale dex beats no dex
    const cached = await readFile(path).catch(() => null)
    if (!cached) throw error
    console.warn(`Falling back to cached ${file}.csv:`, error)
    return parseCsv(cached.toString('utf-8'))
  }
}

const groupBy = (rows: CsvRows, key: string) => {
  const groups = new Map<string, CsvRows>()
  for (const row of rows) {
    const value = row[key] ?? ''
    const group = groups.get(value)
    if (group) group.push(row)
    else groups.set(value, [row])
  }
  return groups
}

const buildDex = (csv: Record<CsvFile, CsvRows>): Dex => {
  const typeNames = new Map(csv.types.map(row => [row['id'] ?? '', titleCase(row['identifier'] ?? '')]))

  const statNames = new Map(
    csv.stats
      .filter(row => row['is_battle_only'] === '0')
      .map(row => {
        const identifier = row['identifier'] ?? ''
        return [row['id'] ?? '', STAT_NAMES[identifier] ? identifier : titleCase(identifier)]
      }),
  )

  const species = new Map(csv.pokemon_species.map(row => [row['id'] ?? '', row]))
  const speciesNames = new Map(
    csv.pokemon_species_names
      .filter(row => row['local_language_id'] === ENGLISH)
      .map(row => [row['pokemon_species_id'] ?? '', row['name'] ?? '']),
  )
  const formNames = new Map(
    csv.pokemon_form_names
      .filter(row => row['local_language_id'] === ENGLISH && row['pokemon_name'])
      .map(row => [row['pokemon_form_id'] ?? '', row['pokemon_name'] ?? '']),
  )

  // a Pokémon can own several forms; the default one supplies its display name
  const formsByPokemon = groupBy(csv.pokemon_forms, 'pokemon_id')
  const typesByPokemon = groupBy(csv.pokemon_types, 'pokemon_id')
  const statsByPokemon = groupBy(csv.pokemon_stats, 'pokemon_id')

  const entries = new Map<number, PokemonEntry>()

  entries.set(MISSINGNO_ID, {
    id: MISSINGNO_ID,
    slug: 'missingno',
    name: 'MissingNo.',
    types: ['Bird', 'Normal'], // TODO
    stats: [],
    genderRate: -1,
    hasGenderDifferences: false,
    genderVariants: 1,
    hasShiny: false,
    spriteOverride: MISSINGNO_SPRITE,
  })

  for (const row of csv.pokemon) {
    const key = row['id'] ?? ''
    const id = Number(key)
    if (!Number.isInteger(id) || id <= 0) continue

    const slug = row['identifier'] || String(id)
    const speciesKey = row['species_id'] ?? ''
    const speciesRow = species.get(speciesKey)

    const forms = formsByPokemon.get(key) ?? []
    const defaultForm = forms.find(form => form['is_default'] === '1') ?? forms[0]
    const formName = defaultForm ? formNames.get(defaultForm['id'] ?? '') : undefined
    const speciesName = speciesNames.get(speciesKey)

    // base species read best by their species name ("Venusaur"),
    // alternate forms by their form name ("Attack Deoxys")
    const name = (id > LAST_SPECIES_ID ? formName ?? speciesName : speciesName ?? formName) ?? titleCase(slug)

    const rawGenderRate = speciesRow ? Number(speciesRow['gender_rate']) : -1
    const genderRate = Number.isFinite(rawGenderRate) ? rawGenderRate : -1

    const types = (typesByPokemon.get(key) ?? [])
      .slice()
      .sort((a, b) => Number(a['slot']) - Number(b['slot']))
      .flatMap(type => typeNames.get(type['type_id'] ?? '') ?? [])

    const stats = (statsByPokemon.get(key) ?? []).flatMap(stat => {
      const name = statNames.get(stat['stat_id'] ?? '')
      return name ? [{ name, value: Number(stat['base_stat']) }] : []
    })

    entries.set(id, {
      id,
      slug,
      name,
      types,
      stats,
      genderRate,
      hasGenderDifferences: speciesRow?.['has_gender_differences'] === '1',
      genderVariants: genderVariantsFor(genderRate),
      hasShiny: true,
    })
  }

  const ids = [...entries.keys()].sort((a, b) => a - b)

  let totalVariants = 0
  for (const entry of entries.values()) {
    totalVariants += entry.genderVariants * (entry.hasShiny ? 2 : 1)
  }

  // lowest ID wins collisions (Nidoran♀ and Nidoran♂ both normalize to "nidoran")
  const byName = new Map<string, number>()
  const index = (key: string, id: number) => {
    const normalized = normalize(key)
    if (normalized && !byName.has(normalized)) byName.set(normalized, id)
  }
  for (const id of ids) {
    const entry = entries.get(id)!
    index(entry.slug, id)
    index(entry.name, id)
  }

  const find = (query: string): PokemonEntry | undefined => {
    const trimmed = query.trim()
    if (/^\d+$/.test(trimmed)) return entries.get(Number(trimmed))

    const normalized = normalize(trimmed)
    if (!normalized) return undefined

    const exact = byName.get(normalized)
    if (exact !== undefined) return entries.get(exact)

    // then a prefix match, then a substring match, preferring the lowest ID
    for (const matches of [
      (name: string) => name.startsWith(normalized),
      (name: string) => name.includes(normalized),
    ]) {
      let best: number | undefined
      for (const [name, id] of byName) {
        if (matches(name) && (best === undefined || id < best)) best = id
      }
      if (best !== undefined) return entries.get(best)
    }
    return undefined
  }

  return { entries, ids, totalVariants, get: id => entries.get(id), find }
}

let current: Dex | undefined
let loading: Promise<Dex> | undefined

const load = async (force: boolean): Promise<Dex> => {
  await mkdir(DEX_CACHE_DIR, { recursive: true })
  const files = await Promise.all(CSV_FILES.map(file => loadCsv(file, force)))
  const csv = Object.fromEntries(CSV_FILES.map((file, i) => [file, files[i] ?? []])) as Record<CsvFile, CsvRows>
  current = buildDex(csv)
  return current
}

/** loads the cached dex or fetches it */
export const getDex = async (): Promise<Dex> => {
  if (current) return current
  loading ??= load(false).finally(() => { loading = undefined })
  return await loading
}

/** loads the dex and refreshes it daily */
export const startDex = async (): Promise<Dex> => {
  const dex = await getDex()
  setInterval(() => {
    load(true).catch(error => console.error('Pokédex refresh failed:', error))
  }, REFRESH_INTERVAL).unref()
  return dex
}
