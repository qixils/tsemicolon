import { join } from 'node:path'

/** Folder for writing files */
export const DATA_DIR = process.env.DATA_DIR ?? 'data'

/** Where {@link ./legacy.ts} looks for data dumped by the old bot */
export const LEGACY_DATA_DIR = process.env.LEGACY_DATA_DIR ?? 'legacy_data'

/** Records which legacy imports have been applied */
export const LEGACY_IMPORT_LOG = join(DATA_DIR, 'legacy_imports.json')

/** Database */
export const DATABASE = join(DATA_DIR, 'semicolon.db')
/** Pokemon cropped sprites */
export const SPRITE_CACHE_DIR = join(DATA_DIR, 'sprite_cache')
/** Raw PokéAPI CSVs */
export const DEX_CACHE_DIR = join(DATA_DIR, 'pokeapi_csv')

/** Allowed access to secret administrator DMs */
export const OWNER_ID = process.env.OWNER_ID ?? '140564059417346049'

export const USER_AGENT = 'tsemicolon (Discord bot)'
