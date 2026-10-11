import { join } from 'node:path'

/** Path for writing files */
export const DATA_DIR = process.env.DATA_DIR ?? 'data'

/** Path to data from the old bot */
export const LEGACY_DATA_DIR = 'legacy_data'
/** Path to log for successfully imported data */
export const LEGACY_IMPORT_LOG = join(DATA_DIR, 'legacy_imports.json')

/** Database path */
export const DATABASE = join(DATA_DIR, 'semicolon.db')

/** Pokemon cropped sprites path */
export const SPRITE_CACHE_DIR = join(DATA_DIR, 'sprite_cache')
/** Raw PokéAPI CSVs path */
export const DEX_CACHE_DIR = join(DATA_DIR, 'pokeapi_csv')

/** Allowed access to secret administrator DMs */
export const OWNER_ID = process.env.OWNER_ID

export const USER_AGENT = 'semicolon (Discord bot)'
