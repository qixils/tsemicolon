import { readFile, writeFile } from 'node:fs/promises'
import type { Client } from 'discord.js'

/**
 * Migrator for old JSON files from the Python bot.
 * Identified to prevent running again after initial import.
 */
export interface LegacyImporter {

  /** Identifier */
  id: string

  /**
   * Executes the importer.
   * Run on startup once the client is ready.
   * Returns `null` if there was no data found to import
   * otherwise a description of the result of the process.
   */
  run(dir: string, client: Client<true>): Promise<string | null>
}

type ImportLog = Record<string, { at: string, summary: string }>

const importers: LegacyImporter[] = []

export const registerLegacyImporter = (importer: LegacyImporter) => {
  importers.push(importer)
}

export const runLegacyImports = async (dir: string, logPath: string, client: Client<true>) => {
  let log: ImportLog = {}
  try {
    log = JSON.parse((await readFile(logPath)).toString('utf-8'))
  } catch {
    // no imports have ever run
  }

  let changed = false
  for (const importer of importers) {
    if (log[importer.id]) continue

    let summary: string | null
    try {
      summary = await importer.run(dir, client)
    } catch (error) {
      console.error(`Legacy import "${importer.id}" failed:`, error)
      continue
    }
    // nothing to import yet -- leave it pending in case the files show up later
    if (summary === null) continue

    log[importer.id] = { at: new Date().toISOString(), summary }
    changed = true
    console.log(`Legacy import "${importer.id}": ${summary}`)
  }

  if (changed) await writeFile(logPath, JSON.stringify(log, null, 2))
}
