import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline'
import { IMPORT_MAX_JSON_BYTES, columnNameOf, type ImportSource } from '@shared/import'
import { RpcError } from '@shared/rpc'
import { CsvParser } from './csv'

type Row = (string | null)[]

const SAMPLE_ROWS = 1000

/** Something from a JSON file as the text a column holds. */
function cellOf(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return value ? '1' : '0'
  if (typeof value === 'number' || typeof value === 'bigint') return String(value)
  return JSON.stringify(value)
}

async function* csvRows(path: string, delimiter: string): AsyncGenerator<string[]> {
  const parser = new CsvParser(delimiter)
  let first = true
  for await (const chunk of createReadStream(path, { encoding: 'utf8' })) {
    let text = chunk as string
    // A byte order mark at the start of the file is not part of the first name.
    if (first) {
      first = false
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
    }
    yield* parser.push(text)
  }
  yield* parser.end()
}

async function* objects(
  path: string,
  format: 'json' | 'ndjson',
): AsyncGenerator<Record<string, unknown>> {
  const asObject = (value: unknown, where: string): Record<string, unknown> => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new RpcError('INVALID_INPUT', `${where} is not an object with fields.`)
    }
    return value as Record<string, unknown>
  }
  if (format === 'ndjson') {
    const lines = createInterface({
      input: createReadStream(path, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    })
    let n = 0
    for await (const line of lines) {
      n++
      if (line.trim() === '') continue
      try {
        yield asObject(JSON.parse(line), `Line ${n}`)
      } catch (error) {
        if (error instanceof RpcError) throw error
        throw new RpcError('INVALID_INPUT', `Line ${n} is not valid JSON.`)
      }
    }
    return
  }
  if ((await stat(path)).size > IMPORT_MAX_JSON_BYTES) {
    throw new RpcError(
      'INVALID_INPUT',
      'A JSON file this big can’t be read at once. Use JSON Lines instead, one object per line.',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''))
  } catch {
    throw new RpcError('INVALID_INPUT', 'That file is not valid JSON.')
  }
  if (!Array.isArray(parsed))
    throw new RpcError('INVALID_INPUT', 'The JSON file should hold an array of objects.')
  for (const [i, item] of parsed.entries()) yield asObject(item, `Item ${i + 1}`)
}

export interface Records {
  columns: string[]
  /** Every row of the file, a value per column, read from the start each time it is called. */
  rows(): AsyncGenerator<Row>
}

/** Opens a file for reading: finds its columns from the header, or from the fields of the first objects. */
export async function openRecords(path: string, source: ImportSource): Promise<Records> {
  if (source.format === 'csv' || source.format === 'tsv') {
    const delimiter = source.format === 'tsv' ? '\t' : source.delimiter
    let width = 0
    let names: string[] | null = null
    for await (const row of csvRows(path, delimiter)) {
      width = row.length
      if (source.header) names = row
      break
    }
    if (width === 0) throw new RpcError('INVALID_INPUT', 'That file is empty.')
    const seen = new Set<string>()
    const columns = Array.from({ length: width }, (_, i) => {
      let name = columnNameOf(names?.[i] ?? '', i)
      for (let n = 2; seen.has(name.toLowerCase()); n++)
        name = `${columnNameOf(names?.[i] ?? '', i)}_${n}`
      seen.add(name.toLowerCase())
      return name
    })
    return {
      columns,
      async *rows() {
        let skip = source.header
        for await (const row of csvRows(path, delimiter)) {
          if (skip) {
            skip = false
            continue
          }
          yield columns.map((_, i) => row[i] ?? null)
        }
      },
    }
  }

  // Objects: the columns are the fields of the first rows, in the order they appear.
  const keys: string[] = []
  const known = new Set<string>()
  let looked = 0
  for await (const item of objects(path, source.format)) {
    for (const key of Object.keys(item)) {
      if (!known.has(key)) {
        known.add(key)
        keys.push(key)
      }
    }
    if (++looked >= SAMPLE_ROWS) break
  }
  if (keys.length === 0) throw new RpcError('INVALID_INPUT', 'That file has no rows.')
  const columns = keys.map((key, i) => columnNameOf(key, i))
  return {
    columns,
    async *rows() {
      for await (const item of objects(path, source.format as 'json' | 'ndjson')) {
        yield keys.map((key) => cellOf(item[key]))
      }
    },
  }
}
