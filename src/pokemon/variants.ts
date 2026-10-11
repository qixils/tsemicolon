import type { PokemonEntry } from './dex.js'
import type { Rng } from '../random.js'

export type Gender = 'male' | 'female' | 'none'

/** A specific form of a Pokémon */
export interface Variant {
  gender: Gender
  shiny: boolean
}

/** One in this many encounters is shiny */
export const SHINY_ODDS = 200

export const GENDER_SYMBOLS: Record<Gender, string> = {
  male: '♂',
  female: '♀',
  none: '',
}
export const SHINY_SYMBOL = '✨'

/** Rolls a random compatible gender for this 'mon */
export const rollGender = (entry: PokemonEntry, rng: Rng = Math.random): Gender => {
  if (entry.genderRate < 0) return 'none'
  if (entry.genderRate === 0) return 'male'
  if (entry.genderRate >= 8) return 'female'
  // gender_rate is the chance of being female, in eighths
  return rng() < entry.genderRate / 8 ? 'female' : 'male'
}

/** Rolls a random variant for this 'mon */
export const rollVariant = (entry: PokemonEntry, rng: Rng = Math.random): Variant => ({
  gender: rollGender(entry, rng),
  shiny: entry.hasShiny && rng() < 1 / SHINY_ODDS,
})

/** How many valid variants of this 'mon exist */
export const variantCount = (entry: PokemonEntry) =>
  entry.genderVariants * (entry.hasShiny ? 2 : 1)

/** Gets storage-efficient shorthand for gender */
export const genderToCode = (gender: Gender) => gender.charAt(0)

/** Converts storage-efficient shorthand for gender */
export const genderFromCode = (code: string): Gender =>
  code === 'm' ? 'male' : code === 'f' ? 'female' : 'none'

/** Text representation of the variant i.e. `Attack Deoxys (#10001) ♀ ✨` */
export const describeVariant = (entry: PokemonEntry, variant: Variant) =>
  [
    `${entry.name} (#${entry.id})`,
    GENDER_SYMBOLS[variant.gender],
    variant.shiny ? SHINY_SYMBOL : '',
  ].filter(Boolean).join(' ')
