import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { registerLegacyImporter } from '../legacy.js'
import { getDex } from './dex.js'
import { getStore } from './storage.js'
import { rollGender, type Variant } from './variants.js'

/**
 * The 2nd Pokémon storage. `pokemon.json`, `{ "<user id>": [dex ids] }` (JsonManager)
 */
const JSON_LOCATIONS = ['pokemon.json', join('data', 'pokemon.json')]
/**
 * The 1st Pokémon storage. `pkmn/<user id>.txt`, one dex ID per line
 */
const TXT_LOCATIONS = ['pkmn', 'data/pkmn', '.']
const USER_FILE = /^(\d{17,})\.txt$/

type Dexes = Map<string, Set<number>>

const record = (dexes: Dexes, userId: string, pokemonId: number) => {
  if (!Number.isInteger(pokemonId) || pokemonId < 0) return
  let dex = dexes.get(userId)
  if (!dex) dexes.set(userId, (dex = new Set()))
  dex.add(pokemonId)
}

const readJsonDexes = async (dir: string, dexes: Dexes): Promise<boolean> => {
  for (const location of JSON_LOCATIONS) {
    const raw = await readFile(join(dir, location)).catch(() => null)
    if (!raw) continue

    const parsed: unknown = JSON.parse(raw.toString('utf-8'))
    if (typeof parsed !== 'object' || parsed === null) continue

    for (const [userId, ids] of Object.entries(parsed)) {
      if (!Array.isArray(ids)) continue
      for (const id of ids) record(dexes, userId, Number(id))
    }
    return true
  }
  return false
}

const readTxtDexes = async (dir: string, dexes: Dexes): Promise<boolean> => {
  let found = false

  for (const location of TXT_LOCATIONS) {
    const path = join(dir, location)
    const files = await readdir(path).catch(() => null)
    if (!files) continue

    for (const file of files) {
      const userId = USER_FILE.exec(file)?.[1]
      if (!userId) continue

      const raw = await readFile(join(path, file)).catch(() => null)
      if (!raw) continue

      for (const line of raw.toString('utf-8').split('\n')) {
        const trimmed = line.trim()
        if (trimmed) record(dexes, userId, Number(trimmed))
      }
      found = true
    }
  }

  return found
}

export const registerPokemonImport = () => {
  registerLegacyImporter({
    id: 'pokemon',
    run: async dir => {
      const dexes: Dexes = new Map()
      const fromJson = await readJsonDexes(dir, dexes)
      const fromTxt = await readTxtDexes(dir, dexes)
      if (!fromJson && !fromTxt) return null

      const dex = await getDex()
      const entries: { userId: string, pokemonId: number, variant: Variant }[] = []

      for (const [userId, pokemonIds] of dexes) {
        for (const pokemonId of pokemonIds) {
          const entry = dex.get(pokemonId)
          // IDs the current dex no longer knows about still come across, as genderless
          const gender = entry ? rollGender(entry) : 'none'
          entries.push({ userId, pokemonId, variant: { gender, shiny: false } })
        }
      }

      const added = getStore().addCatches(entries)
      return `${added} new catches across ${dexes.size} trainer(s) from ${[
        fromJson ? 'pokemon.json' : '',
        fromTxt ? 'pkmn/*.txt' : '',
      ].filter(Boolean).join(' + ')}`
    },
  })
}
