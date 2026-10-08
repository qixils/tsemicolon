/**
 * parse pokeapi csvs
 */
export const parseCsv = (text: string): Record<string, string>[] => {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else quoted = false
      } else field += char
      continue
    }

    switch (char) {
      case '"': quoted = true; break
      case ',': row.push(field); field = ''; break
      case '\r': break
      case '\n': row.push(field); rows.push(row); row = []; field = ''; break
      default: field += char
    }
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row) }

  const headers = rows.shift()
  if (!headers) return []

  return rows.map(cells => {
    const record: Record<string, string> = {}
    for (let i = 0; i < headers.length; i++) record[headers[i]!] = cells[i] ?? ''
    return record
  })
}
