/** deterministic `Math.random` replacement */
export type Rng = () => number

/** 32-bit FNV-1a hashes arbitrary text into a seed */
const hashSeed = (seed: string): number => {
  let hash = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** mulberry32 */
export const seededRng = (...seed: (string | number)[]): Rng => {
  let state = hashSeed(seed.join(':'))
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const randomItem = <T>(items: readonly T[], rng: Rng = Math.random): T => {
  const item = items[Math.floor(rng() * items.length)]
  if (item === undefined) throw new Error('Cannot pick from an empty list')
  return item
}
