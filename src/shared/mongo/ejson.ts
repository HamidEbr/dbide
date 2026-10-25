/**
 * Documents cross the process boundary as canonical Extended JSON: plain JSON in which every BSON type
 * that JSON lacks is wrapped (`{"$oid": "..."}`, `{"$numberLong": "..."}`, `{"$date": ...}`), so no
 * value changes type on the way. This file reads that form and writes it the way people write queries
 * in the shell, so a document shown in the window can be pasted into a script and the other way round.
 */

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export type BsonType =
  | 'objectId'
  | 'string'
  | 'int'
  | 'long'
  | 'double'
  | 'decimal'
  | 'bool'
  | 'date'
  | 'null'
  | 'object'
  | 'array'
  | 'binary'
  | 'uuid'
  | 'regex'
  | 'timestamp'
  | 'minKey'
  | 'maxKey'
  | 'code'
  | 'symbol'
  | 'undefined'
  | 'dbPointer'

export const TYPE_LABELS: Record<BsonType, string> = {
  objectId: 'ObjectId',
  string: 'String',
  int: 'Int32',
  long: 'Int64',
  double: 'Double',
  decimal: 'Decimal128',
  bool: 'Boolean',
  date: 'Date',
  null: 'Null',
  object: 'Object',
  array: 'Array',
  binary: 'Binary',
  uuid: 'UUID',
  regex: 'Regex',
  timestamp: 'Timestamp',
  minKey: 'MinKey',
  maxKey: 'MaxKey',
  code: 'Code',
  symbol: 'Symbol',
  undefined: 'Undefined',
  dbPointer: 'DBPointer',
}

type Obj = { [key: string]: Json }

const isObject = (value: Json): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** The wrapper key of a value such as `{"$oid": "..."}`, when the object is one. */
function wrapperKey(value: Obj): string | null {
  const keys = Object.keys(value)
  const first = keys[0]
  if (first === undefined || !first.startsWith('$')) return null
  if (keys.length === 1) return first
  // `$code` may carry a `$scope`, and a `$date`-less wrapper never has siblings otherwise.
  if (first === '$code' && keys.length === 2 && keys.includes('$scope')) return first
  return null
}

const WRAPPERS = new Set([
  '$oid',
  '$date',
  '$numberInt',
  '$numberLong',
  '$numberDouble',
  '$numberDecimal',
  '$binary',
  '$uuid',
  '$regularExpression',
  '$timestamp',
  '$minKey',
  '$maxKey',
  '$code',
  '$symbol',
  '$undefined',
  '$dbPointer',
])

/** Whether a value is one of the `{"$...": ...}` wrappers, whose insides are not documents. */
export function isWrapper(value: Json): boolean {
  if (!isObject(value)) return false
  const key = wrapperKey(value)
  return key !== null && WRAPPERS.has(key)
}

/** The BSON type of a value in canonical Extended JSON. */
export function typeOf(value: Json): BsonType {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  switch (typeof value) {
    case 'string':
      return 'string'
    case 'boolean':
      return 'bool'
    case 'number':
      // Canonical output has no bare numbers; text that was typed or relaxed can.
      return Number.isInteger(value) ? 'int' : 'double'
    default:
      break
  }
  const key = wrapperKey(value as Obj)
  if (key === null || !WRAPPERS.has(key)) return 'object'
  switch (key) {
    case '$oid':
      return 'objectId'
    case '$date':
      return 'date'
    case '$numberInt':
      return 'int'
    case '$numberLong':
      return 'long'
    case '$numberDouble':
      return 'double'
    case '$numberDecimal':
      return 'decimal'
    case '$uuid':
      return 'uuid'
    case '$binary': {
      const inner = (value as Obj).$binary
      return isObject(inner) && inner.subType === '04' ? 'uuid' : 'binary'
    }
    case '$regularExpression':
      return 'regex'
    case '$timestamp':
      return 'timestamp'
    case '$minKey':
      return 'minKey'
    case '$maxKey':
      return 'maxKey'
    case '$code':
      return 'code'
    case '$symbol':
      return 'symbol'
    case '$undefined':
      return 'undefined'
    default:
      return 'dbPointer'
  }
}

/** Whether a value is a scalar the tree shows on one line (not a document or an array). */
export const isContainer = (value: Json): boolean => {
  const type = typeOf(value)
  return type === 'object' || type === 'array'
}

// ───────────────────────────── reading values ─────────────────────────────

function dateOf(value: Obj): Date | null {
  const raw = value.$date
  let ms: number
  if (typeof raw === 'string') ms = Date.parse(raw)
  else if (typeof raw === 'number') ms = raw
  else if (isObject(raw) && typeof raw.$numberLong === 'string') ms = Number(raw.$numberLong)
  else return null
  const date = new Date(ms)
  return Number.isNaN(date.getTime()) ? null : date
}

function uuidOf(value: Obj): string | null {
  if (typeof value.$uuid === 'string') return value.$uuid
  const inner = value.$binary
  if (!isObject(inner) || typeof inner.base64 !== 'string' || inner.subType !== '04') return null
  const hex = base64ToHex(inner.base64)
  if (hex.length !== 32) return null
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function base64ToHex(base64: string): string {
  try {
    const binary = atob(base64)
    let hex = ''
    for (let i = 0; i < binary.length; i++)
      hex += binary.charCodeAt(i).toString(16).padStart(2, '0')
    return hex
  } catch {
    return ''
  }
}

/** The number a value holds, when it is one a person could sort or sum. */
export function numberOf(value: Json): number | null {
  if (typeof value === 'number') return value
  if (!isObject(value)) return null
  const raw = value.$numberInt ?? value.$numberLong ?? value.$numberDouble
  if (typeof raw !== 'string') return null
  const number = Number(raw)
  return Number.isNaN(number) && raw !== 'NaN' ? null : number
}

/** An ISO time for a date value, or null when it is not one or is out of range. */
export function isoOf(value: Json): string | null {
  if (!isObject(value) || !('$date' in value)) return null
  return dateOf(value)?.toISOString() ?? null
}

// ───────────────────────────── writing values ─────────────────────────────

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/

const quoteKey = (key: string): string => (IDENTIFIER.test(key) ? key : JSON.stringify(key))

function formatDouble(raw: string): string {
  if (raw === 'NaN' || raw === 'Infinity' || raw === '-Infinity') return raw
  // A whole double needs its decimal point, or reading it back would make an Int32 of it.
  return /[.eE]/.test(raw) ? raw : `${raw}.0`
}

function formatRegex(pattern: string, options: string): string {
  return `/${pattern.replace(/(^|[^\\])\//g, '$1\\/')}/${options}`
}

/** One scalar or wrapped value in the shell's notation, or null for a plain object or array. */
function formatWrapped(value: Json): string | null {
  if (!isObject(value)) return null
  const key = wrapperKey(value)
  if (key === null || !WRAPPERS.has(key)) return null
  switch (key) {
    case '$oid':
      return `ObjectId(${JSON.stringify(value.$oid)})`
    case '$date': {
      const date = dateOf(value)
      if (date) return `ISODate(${JSON.stringify(date.toISOString())})`
      const raw = value.$date
      const ms = isObject(raw) ? raw.$numberLong : raw
      return `new Date(${typeof ms === 'string' ? ms : JSON.stringify(ms)})`
    }
    case '$numberInt':
      return String(value.$numberInt)
    case '$numberLong':
      return `NumberLong(${JSON.stringify(value.$numberLong)})`
    case '$numberDouble':
      return formatDouble(String(value.$numberDouble))
    case '$numberDecimal':
      return `NumberDecimal(${JSON.stringify(value.$numberDecimal)})`
    case '$uuid':
      return `UUID(${JSON.stringify(value.$uuid)})`
    case '$binary': {
      const uuid = uuidOf(value)
      if (uuid) return `UUID(${JSON.stringify(uuid)})`
      const inner = value.$binary
      if (!isObject(inner)) return null
      const subType = parseInt(String(inner.subType ?? '00'), 16) || 0
      return `BinData(${subType}, ${JSON.stringify(inner.base64)})`
    }
    case '$regularExpression': {
      const inner = value.$regularExpression
      if (!isObject(inner)) return null
      return formatRegex(String(inner.pattern ?? ''), String(inner.options ?? ''))
    }
    case '$timestamp': {
      const inner = value.$timestamp
      if (!isObject(inner)) return null
      return `Timestamp(${Number(inner.t)}, ${Number(inner.i)})`
    }
    case '$minKey':
      return 'MinKey()'
    case '$maxKey':
      return 'MaxKey()'
    case '$code':
      return `Code(${JSON.stringify(value.$code)})`
    case '$symbol':
      return `Symbol(${JSON.stringify(value.$symbol)})`
    case '$undefined':
      return 'undefined'
    default:
      return null
  }
}

export interface FormatOptions {
  /** Spaces per level, or false for a single line. */
  indent: number | false
}

/**
 * The value as a person writes it in the shell: `{ _id: ObjectId("..."), at: ISODate("..."), n: 5 }`.
 * With an indent the text spreads over lines, as the editor and the JSON view show it.
 */
export function formatShell(value: Json, options: FormatOptions = { indent: false }): string {
  const { indent } = options
  const render = (item: Json, level: number): string => {
    const wrapped = formatWrapped(item)
    if (wrapped !== null) return wrapped
    if (item === null) return 'null'
    if (typeof item === 'string') return JSON.stringify(item)
    if (typeof item === 'number')
      return Number.isInteger(item) ? String(item) : formatDouble(String(item))
    if (typeof item === 'boolean') return String(item)

    const entries: [string | null, Json][] = Array.isArray(item)
      ? item.map((v): [null, Json] => [null, v])
      : Object.entries(item)
    const [open, close] = Array.isArray(item) ? ['[', ']'] : ['{', '}']
    if (entries.length === 0) return `${open}${close}`

    const part = ([key, v]: [string | null, Json], inner: number): string =>
      `${key === null ? '' : `${quoteKey(key)}: `}${render(v, inner)}`
    if (indent === false)
      return `${open} ${entries.map((e) => part(e, level + 1)).join(', ')} ${close}`
    const pad = ' '.repeat(indent * (level + 1))
    const end = ' '.repeat(indent * level)
    return `${open}\n${entries.map((e) => `${pad}${part(e, level + 1)}`).join(',\n')}\n${end}${close}`
  }
  return render(value, 0)
}

/**
 * The same value as relaxed Extended JSON text: numbers are plain, which is what other tools and
 * `mongoimport` expect. Whole values keep their wrappers where JSON has no equivalent.
 */
export function formatRelaxedJson(value: Json, indent: number | false = 2): string {
  const relax = (item: Json): Json => {
    if (Array.isArray(item)) return item.map(relax)
    if (!isObject(item)) return item
    const key = wrapperKey(item)
    if (key === '$numberInt') return Number(item.$numberInt)
    if (key === '$numberDouble') {
      const raw = String(item.$numberDouble)
      const number = Number(raw)
      return Number.isFinite(number) && !Object.is(number, -0) ? number : item
    }
    if (key === '$numberLong') {
      const number = Number(item.$numberLong)
      return Number.isSafeInteger(number) ? number : item
    }
    if (key === '$date') {
      const iso = isoOf(item)
      return iso && Number(iso.slice(0, 4)) >= 1970 && Number(iso.slice(0, 4)) <= 9999
        ? { $date: iso }
        : item
    }
    if (key !== null && WRAPPERS.has(key)) return item
    return Object.fromEntries(Object.entries(item).map(([k, v]) => [k, relax(v)]))
  }
  return JSON.stringify(relax(value), null, indent === false ? undefined : indent)
}

// ───────────────────────────── showing values in a grid ─────────────────────────────

/** What a cell of the table shows: short, on one line, and honest about what is inside. */
export function formatCell(value: Json): string {
  if (value === null) return 'null'
  if (typeof value === 'string') return value
  if (typeof value === 'boolean') return String(value)
  if (typeof value === 'number') return String(value)
  if (Array.isArray(value)) return `[ ${value.length} ${value.length === 1 ? 'item' : 'items'} ]`

  const type = typeOf(value)
  if (type === 'object') {
    const count = Object.keys(value).length
    return `{ ${count} ${count === 1 ? 'field' : 'fields'} }`
  }
  const wrapped = value as Obj
  switch (type) {
    case 'objectId':
      return String(wrapped.$oid)
    case 'date':
      return isoOf(value) ?? formatShell(value)
    case 'int':
      return String(wrapped.$numberInt)
    case 'long':
      return String(wrapped.$numberLong)
    case 'double':
      return formatDouble(String(wrapped.$numberDouble))
    case 'decimal':
      return String(wrapped.$numberDecimal)
    case 'uuid':
      return uuidOf(wrapped) ?? formatShell(value)
    case 'undefined':
      return 'undefined'
    default:
      return formatShell(value)
  }
}

/** Parses a cell's text back into Extended JSON, or null when it isn't valid JSON. */
export function parseJson(text: string): Json | undefined {
  try {
    return JSON.parse(text) as Json
  } catch {
    return undefined
  }
}

/** The `_id` of a document, if it has one. */
export function idOf(document: Json): Json | undefined {
  return isObject(document) && '_id' in document ? document._id : undefined
}

/** Looks a dotted path up inside a document: `address.city`, `items.0.sku`. */
export function getPath(document: Json, path: string): Json | undefined {
  let current: Json | undefined = document
  for (const part of path.split('.')) {
    if (current === undefined) return undefined
    if (Array.isArray(current)) {
      const index = Number(part)
      current = Number.isInteger(index) ? current[index] : undefined
    } else if (isObject(current) && !wrapperKey(current)) {
      current = current[part]
    } else {
      return undefined
    }
  }
  return current
}
