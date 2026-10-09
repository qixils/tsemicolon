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

/** Returns a database accessor that runs a setup schema on first use */
export const withSchema = (schema: string) => {
  let ready = false
  return (): DatabaseSync => {
    const database = getDb()
    if (!ready) {
      database.exec(schema)
      ready = true
    }
    return database
  }
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

export type Row = Record<string, SQLOutputValue>

export const text = (row: Row, column: string): string => String(row[column] ?? '')

export const optionalText = (row: Row, column: string): string | null => {
  const value = row[column]
  return value === null || value === undefined ? null : String(value)
}

export const int = (row: Row, column: string): number => Number(row[column] ?? 0)
