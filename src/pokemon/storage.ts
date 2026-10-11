import type { DatabaseSync } from 'node:sqlite'
import { getDb } from '../db.js'
import { genderToCode, type Variant } from './variants.js'

export interface LeaderboardRow {
  userId: string
  /** User's last known display name */
  name: string | null
  count: number
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS pokemon_caught (
    user_id    TEXT    NOT NULL,
    pokemon_id INTEGER NOT NULL,
    gender     TEXT    NOT NULL,
    shiny      INTEGER NOT NULL,
    caught_at  INTEGER NOT NULL,
    PRIMARY KEY (user_id, pokemon_id, gender, shiny)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS pokemon_trainers (
    user_id    TEXT PRIMARY KEY,
    name       TEXT,
    last_catch INTEGER
  );
`

const asNumber = (value: unknown) => (typeof value === 'number' ? value : Number(value ?? 0))

/** Every caught (Pokémon, gender, shiny) triple, one row each */
export class PokemonStore {
  private readonly db: DatabaseSync

  constructor(db = getDb()) {
    this.db = db
    this.db.exec(SCHEMA)
  }

  hasCaught(userId: string, pokemonId: number, variant: Variant): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM pokemon_caught WHERE user_id = ? AND pokemon_id = ? AND gender = ? AND shiny = ?')
      .get(userId, pokemonId, genderToCode(variant.gender), variant.shiny ? 1 : 0)
    return row !== undefined
  }

  /** Attempts to catch a Pokémon. Returns false when the user already had this exact variant. */
  addCatch(userId: string, pokemonId: number, variant: Variant, at = Date.now()): boolean {
    const result = this.db
      .prepare('INSERT OR IGNORE INTO pokemon_caught (user_id, pokemon_id, gender, shiny, caught_at) VALUES (?, ?, ?, ?, ?)')
      .run(userId, pokemonId, genderToCode(variant.gender), variant.shiny ? 1 : 0, at)
    return asNumber(result.changes) > 0
  }

  /** Returns how many distinct variants of the given Pokémon the provided user has */
  countAmong(userId: string, pokemonIds: readonly number[]): number {
    if (pokemonIds.length === 0) return 0
    const placeholders = pokemonIds.map(() => '?').join(', ')
    const row = this.db
      .prepare(`SELECT COUNT(*) AS total FROM pokemon_caught WHERE user_id = ? AND pokemon_id IN (${placeholders})`)
      .get(userId, ...pokemonIds)
    return asNumber(row?.['total'])
  }

  /** Returns how many distinct variants of all Pokémon the provided user has */
  countFor(userId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS total FROM pokemon_caught WHERE user_id = ?').get(userId)
    return asNumber(row?.['total'])
  }

  /** Returns every user with a catch, sorted by most */
  leaderboard(): LeaderboardRow[] {
    const rows = this.db.prepare(`
      SELECT pokemon_caught.user_id AS user_id, pokemon_trainers.name AS name, COUNT(*) AS total
      FROM pokemon_caught
      LEFT JOIN pokemon_trainers ON pokemon_trainers.user_id = pokemon_caught.user_id
      GROUP BY pokemon_caught.user_id
      ORDER BY total DESC, pokemon_caught.user_id ASC
    `).all()

    return rows.map(row => ({
      userId: String(row['user_id']),
      name: typeof row['name'] === 'string' ? row['name'] : null,
      count: asNumber(row['total']),
    }))
  }

  /** Caches a user's display name */
  rememberTrainer(userId: string, name: string): void {
    this.db.prepare(`
      INSERT INTO pokemon_trainers (user_id, name) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET name = excluded.name
    `).run(userId, name)
  }

  lastCatchAt(userId: string): number | null {
    const row = this.db.prepare('SELECT last_catch FROM pokemon_trainers WHERE user_id = ?').get(userId)
    const value = row?.['last_catch']
    return value === null || value === undefined ? null : asNumber(value)
  }

  setLastCatchAt(userId: string, at: number): void {
    this.db.prepare(`
      INSERT INTO pokemon_trainers (user_id, last_catch) VALUES (?, ?)
      ON CONFLICT (user_id) DO UPDATE SET last_catch = excluded.last_catch
    `).run(userId, at)
  }

  /** Deletes everything stored about a user. Returns how many rows were removed. */
  forget(userId: string): number {
    return asNumber(this.db.prepare('DELETE FROM pokemon_caught WHERE user_id = ?').run(userId).changes)
      + asNumber(this.db.prepare('DELETE FROM pokemon_trainers WHERE user_id = ?').run(userId).changes)
  }

  /** Bulk legacy import. Returns how many rows were new. */
  addCatches(entries: readonly { userId: string, pokemonId: number, variant: Variant }[]): number {
    const insert = this.db.prepare(
      'INSERT OR IGNORE INTO pokemon_caught (user_id, pokemon_id, gender, shiny, caught_at) VALUES (?, ?, ?, ?, ?)',
    )
    const at = Date.now()
    let added = 0

    this.db.exec('BEGIN')
    try {
      for (const { userId, pokemonId, variant } of entries) {
        const result = insert.run(userId, pokemonId, genderToCode(variant.gender), variant.shiny ? 1 : 0, at)
        added += asNumber(result.changes)
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }

    return added
  }
}

let store: PokemonStore | undefined

export const getStore = (): PokemonStore => (store ??= new PokemonStore())
