import { access, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PNG } from 'pngjs'
import { SPRITE_CACHE_DIR, USER_AGENT } from '../config.js'
import type { PokemonEntry } from './dex.js'
import type { Variant } from './variants.js'

const SPRITE_BASE = 'https://raw.githubusercontent.com/PokeAPI/sprites/master/sprites/pokemon'
/** nearest neighbor upscale factor */
const UPSCALE = 3

export interface Sprite {
  path: string
  /** filename to hand Discord, referenced as `attachment://<name>` */
  name: string
}

/** How long until a sprite that couldn't be found is looked for again */
const RETRY_MISSING_MILLIS = 60 * 60 * 1000

/** when we last looked for and failed to find each sprite */
const missing = new Map<string, number>()
const inFlight = new Map<string, Promise<Sprite | null>>()

const usesFemaleSprite = (entry: PokemonEntry, variant: Variant) =>
  variant.gender === 'female' && entry.hasGenderDifferences

const cacheName = (entry: PokemonEntry, variant: Variant) => {
  const suffix = [variant.shiny ? 'shiny' : '', usesFemaleSprite(entry, variant) ? 'female' : '']
  return `poke${[entry.id, ...suffix.filter(Boolean)].join('-')}.png`
}

/** possible URLs for the sprite sorted by specificity */
const spriteUrls = (entry: PokemonEntry, variant: Variant): string[] => {
  if (entry.spriteOverride) return [entry.spriteOverride]

  const female = usesFemaleSprite(entry, variant)
  const urls = [
    ...(variant.shiny && female ? [`${SPRITE_BASE}/shiny/female/${entry.id}.png`] : []),
    ...(variant.shiny ? [`${SPRITE_BASE}/shiny/${entry.id}.png`] : []),
    ...(female ? [`${SPRITE_BASE}/female/${entry.id}.png`] : []),
    `${SPRITE_BASE}/${entry.id}.png`,
  ]
  return [...new Set(urls)]
}

/** bounding box of every non-transparent pixel, or null if the sprite is empty */
const opaqueBounds = (png: PNG) => {
  let minX = png.width
  let minY = png.height
  let maxX = -1
  let maxY = -1

  for (let y = 0; y < png.height; y++) {
    for (let x = 0; x < png.width; x++) {
      if (png.data[(y * png.width + x) * 4 + 3] === 0) continue
      if (x < minX) minX = x
      if (x > maxX) maxX = x
      if (y < minY) minY = y
      if (y > maxY) maxY = y
    }
  }

  if (maxX < 0) return null
  return { minX, minY, width: maxX - minX + 1, height: maxY - minY + 1 }
}

/** crops the transparent border & upscales with nearest-neighbour */
const processSprite = (data: Buffer): Buffer => {
  const source = PNG.sync.read(data)
  const bounds = opaqueBounds(source) ?? { minX: 0, minY: 0, width: source.width, height: source.height }

  const output = new PNG({ width: bounds.width * UPSCALE, height: bounds.height * UPSCALE })
  for (let y = 0; y < output.height; y++) {
    const sourceY = bounds.minY + Math.floor(y / UPSCALE)
    for (let x = 0; x < output.width; x++) {
      const sourceX = bounds.minX + Math.floor(x / UPSCALE)
      const from = (sourceY * source.width + sourceX) * 4
      output.data.set(source.data.subarray(from, from + 4), (y * output.width + x) * 4)
    }
  }

  return PNG.sync.write(output)
}

const download = async (urls: string[]): Promise<Buffer | null> => {
  for (const url of urls) {
    try {
      const response = await fetch(url, { headers: { 'user-agent': USER_AGENT } })
      if (!response.ok) continue
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      console.warn(`Failed to fetch sprite ${url}:`, error)
    }
  }
  return null
}

/**
 * Fetches the cropped, upscaled sprite for a variant, downloading and caching it on first use.
 * Returns null when no sprite exists for this Pokémon.
 */
export const getSprite = async (entry: PokemonEntry, variant: Variant): Promise<Sprite | null> => {
  const name = cacheName(entry, variant)
  const missedAt = missing.get(name)
  if (missedAt !== undefined) {
    if (Date.now() - missedAt < RETRY_MISSING_MILLIS) return null
    missing.delete(name)
  }

  const path = join(SPRITE_CACHE_DIR, name)
  if (await access(path).then(() => true, () => false)) return { path, name }

  const pending = inFlight.get(name)
  if (pending) return await pending

  const work = (async (): Promise<Sprite | null> => {
    const raw = await download(spriteUrls(entry, variant))
    if (!raw) {
      missing.set(name, Date.now())
      return null
    }
    try {
      await mkdir(SPRITE_CACHE_DIR, { recursive: true })
      await writeFile(path, processSprite(raw))
      return { path, name }
    } catch (error) {
      console.error(`Failed to process sprite for ${entry.slug}:`, error)
      return null
    }
  })().finally(() => inFlight.delete(name))

  inFlight.set(name, work)
  return await work
}
