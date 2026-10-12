import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync, type SQLOutputValue } from 'node:sqlite'
import { DATABASE } from './config.js'

let db: DatabaseSync | undefined

export const getDb = (): DatabaseSync => {
  if (db) return db
  mkdirSync(dirname(DATABASE), { recursive: true })
  db = new DatabaseSync(DATABASE)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  return db
}

export const closeDb = () => {
  db?.close()
  db = undefined
}

export const transaction = <T>(database: DatabaseSync, work: () => T): T => {
  database.exec('BEGIN')
  try {
    const result = work()
    database.exec('COMMIT')
    return result
  } catch (error) {
    database.exec('ROLLBACK')
    throw error
  }
}

/**
 * Runs a series of versioned migrations for a named database accessor and saves the new version to database.
 * Uses transactions to avoid losing data in case of an issue with a migrator.
 * Migrators should not be changed unless to fix such issues.
 */
export const migrate = (database: DatabaseSync, name: string, migrations: readonly string[]) => {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_versions (
      name    TEXT    PRIMARY KEY,
      version INTEGER NOT NULL
    ) WITHOUT ROWID
  `)
  const row = database.prepare('SELECT version FROM schema_versions WHERE name = ?').get(name)
  const current = row ? Number(row['version']) : 0
  if (current > migrations.length) {
    throw new Error(`Database schema "${name}" is at version ${current}, but this build only knows ${migrations.length}`)
  }

  migrations.slice(current).forEach((sql, index) => {
    const version = current + index + 1
    transaction(database, () => {
      database.exec(sql)
      database.prepare(`
        INSERT INTO schema_versions (name, version) VALUES (?, ?)
        ON CONFLICT (name) DO UPDATE SET version = excluded.version
      `).run(name, version)
    })
    console.log(`Migrated "${name}" schema to version ${version}`)
  })
}

const schemas = new Map<string, () => DatabaseSync>()

/**
 * Returns a database accessor that applies `migrations` on first use and to upgrade existing databases.
 * `name` identifies this accessor for versioning, it should not be changed.
 */
export const withSchema = (name: string, migrations: readonly string[]): (() => DatabaseSync) => {
  if (schemas.has(name)) throw new Error(`Duplicate schema "${name}"`)

  let ready = false
  const accessor = (): DatabaseSync => {
    const database = getDb()
    if (!ready) {
      migrate(database, name, migrations)
      ready = true
    }
    return database
  }
  schemas.set(name, accessor)
  return accessor
}

/**
 * Applies the migrations of every schema registered so far.
 */
export const migrateAll = () => {
  for (const accessor of schemas.values()) accessor()
}

export type Row = Record<string, SQLOutputValue>

export const text = (row: Row, column: string): string => String(row[column] ?? '')

export const optionalText = (row: Row, column: string): string | null => {
  const value = row[column]
  return value === null || value === undefined ? null : String(value)
}

export const int = (row: Row, column: string): number => Number(row[column] ?? 0)
