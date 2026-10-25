/**
 * Turns a parsed value (`{ at: { $gte: new Date(Date.now() - 86400000) }, _id: ObjectId("...") }`) into
 * canonical Extended JSON. Every BSON type is built here without a BSON library, so the window checks
 * and previews a document with the very code the core runs, and an `ObjectId("nonsense")` is reported
 * where it is typed rather than after a round trip.
 *
 * Numbers follow the shell: a literal such as `5` is an Int32 when it fits, a number written with a
 * decimal point (`5.0`) is a Double, and anything else wide is a Double. `NumberLong("...")` is the way
 * to write an Int64.
 */

import { isWrapper, numberOf, type Json } from './ejson'
import { MongoSyntaxError, type Expr } from './lang'

const INT32_MIN = -2147483648
const INT32_MAX = 2147483647
const INT64_MIN = -(2n ** 63n)
const INT64_MAX = 2n ** 63n - 1n

const OBJECT_ID = /^[0-9a-fA-F]{24}$/
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$|^[+-]?(?:Infinity|Inf|NaN)$/
const UUID = /^[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}$/

function fail(message: string, at: number): never {
  throw new MongoSyntaxError(message, at)
}

/** What the evaluator holds while it works: JSON in which a bare number is not yet typed. */
type Value = Json

/** A Double the way the BSON library writes it: a whole number keeps its `.0`. */
const double = (n: number): Json => ({
  $numberDouble: Number.isNaN(n)
    ? 'NaN'
    : n === Infinity
      ? 'Infinity'
      : n === -Infinity
        ? '-Infinity'
        : Object.is(n, -0)
          ? '-0.0'
          : /[.eE]/.test(String(n))
            ? String(n)
            : `${n}.0`,
})

const dateOf = (ms: number): Json => ({ $date: { $numberLong: String(ms) } })

/** Gives every bare number its BSON type. Wrapped values are already typed and are left alone. */
function finalize(value: Value): Json {
  if (typeof value === 'number') {
    if (
      Number.isInteger(value) &&
      !Object.is(value, -0) &&
      value >= INT32_MIN &&
      value <= INT32_MAX
    ) {
      return { $numberInt: String(value) }
    }
    return double(value)
  }
  if (Array.isArray(value)) return value.map(finalize)
  if (value !== null && typeof value === 'object') {
    if (isWrapper(value)) return value
    const out: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: finalize(item),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return value
}

let counter = Math.floor(Math.random() * 0xffffff)

/** A new ObjectId: four bytes of time, five of randomness, three of counter. */
function newObjectId(): string {
  const bytes = new Uint8Array(12)
  const seconds = Math.floor(Date.now() / 1000)
  bytes[0] = (seconds >>> 24) & 0xff
  bytes[1] = (seconds >>> 16) & 0xff
  bytes[2] = (seconds >>> 8) & 0xff
  bytes[3] = seconds & 0xff
  crypto.getRandomValues(bytes.subarray(4, 9))
  counter = (counter + 1) & 0xffffff
  bytes[9] = (counter >>> 16) & 0xff
  bytes[10] = (counter >>> 8) & 0xff
  bytes[11] = counter & 0xff
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function newUuid(): string {
  return crypto.randomUUID()
}

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function hexToBytes(hex: string, at: number): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) fail('That is not hexadecimal text.', at)
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

// ───────────────────────────── arguments ─────────────────────────────

/** A number from an argument: a bare number or any of the numeric wrappers. */
function numberArg(value: Value | undefined, what: string, at: number): number {
  const number = value === undefined ? null : numberOf(value)
  if (number === null) fail(`${what} needs a number.`, at)
  return number
}

function stringArg(value: Value | undefined, what: string, at: number): string {
  if (typeof value !== 'string') fail(`${what} needs text in quotes.`, at)
  return value
}

function dateValue(value: Value): number | null {
  if (value !== null && typeof value === 'object' && !Array.isArray(value) && '$date' in value) {
    const raw = value.$date
    const ms =
      typeof raw === 'number'
        ? raw
        : raw !== null && typeof raw === 'object' && !Array.isArray(raw)
          ? Number(raw.$numberLong)
          : typeof raw === 'string'
            ? Date.parse(raw)
            : NaN
    return Number.isNaN(ms) ? null : ms
  }
  return null
}

function makeDate(args: Value[], at: number): Json {
  if (args.length === 0) return dateOf(Date.now())
  const first = args[0]!
  if (args.length === 1) {
    const existing = dateValue(first)
    if (existing !== null) return dateOf(existing)
    if (typeof first === 'string') {
      const ms = Date.parse(first)
      if (Number.isNaN(ms))
        fail(`“${first}” is not a date. Try ISODate("2024-05-17T09:30:00Z").`, at)
      return dateOf(ms)
    }
    const ms = numberArg(first, 'A date', at)
    if (Number.isNaN(new Date(ms).getTime())) fail('That number is not a valid date.', at)
    return dateOf(ms)
  }
  const [y, m, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args.map((a) => numberArg(a, 'A date', at))
  const made = new Date(y!, m!, d, h, mi, s, ms).getTime()
  if (Number.isNaN(made)) fail('Those numbers are not a valid date.', at)
  return dateOf(made)
}

function makeLong(args: Value[], at: number): Json {
  const first = args[0]
  if (typeof first === 'string') {
    if (!/^[+-]?\d+$/.test(first.trim())) fail(`“${first}” is not a whole number.`, at)
    const value = BigInt(first.trim())
    if (value < INT64_MIN || value > INT64_MAX)
      fail(`${first} does not fit in a 64-bit integer.`, at)
    return { $numberLong: value.toString() }
  }
  const number = numberArg(first, 'NumberLong', at)
  if (!Number.isSafeInteger(number)) {
    fail('Write a number this large as text: NumberLong("9007199254740993").', at)
  }
  return { $numberLong: String(number) }
}

function makeInt(args: Value[], at: number): Json {
  const first = args[0]
  const number = typeof first === 'string' ? Number(first) : numberArg(first, 'NumberInt', at)
  if (!Number.isInteger(number) || number < INT32_MIN || number > INT32_MAX) {
    fail('NumberInt takes a whole number between -2147483648 and 2147483647.', at)
  }
  return { $numberInt: String(number) }
}

function makeDecimal(args: Value[], at: number): Json {
  const first = args[0]
  const text =
    typeof first === 'string' ? first.trim() : String(numberArg(first, 'NumberDecimal', at))
  if (!DECIMAL.test(text)) fail(`“${text}” is not a decimal number.`, at)
  return { $numberDecimal: text }
}

function makeObjectId(args: Value[], at: number): Json {
  if (args.length === 0) return { $oid: newObjectId() }
  const first = args[0]
  if (typeof first !== 'string' || !OBJECT_ID.test(first)) {
    fail(
      `ObjectId takes 24 hexadecimal characters, such as ObjectId("507f1f77bcf86cd799439011").`,
      at,
    )
  }
  return { $oid: first.toLowerCase() }
}

function makeUuid(args: Value[], at: number): Json {
  const text = args.length === 0 ? newUuid() : stringArg(args[0], 'UUID', at)
  if (!UUID.test(text))
    fail(`“${text}” is not a UUID. Expected 8-4-4-4-12 hexadecimal characters.`, at)
  const bytes = hexToBytes(text.replace(/-/g, ''), at)
  return { $binary: { base64: toBase64(bytes), subType: '04' } }
}

function makeBinary(args: Value[], at: number): Json {
  const subType = numberArg(args[0], 'BinData', at)
  const data = stringArg(args[1], 'BinData', at)
  if (!Number.isInteger(subType) || subType < 0 || subType > 255) {
    fail('BinData’s first argument is the subtype, a number from 0 to 255.', at)
  }
  try {
    atob(data)
  } catch {
    fail('BinData’s second argument must be base64 text.', at)
  }
  return { $binary: { base64: data, subType: subType.toString(16).padStart(2, '0') } }
}

function makeTimestamp(args: Value[], at: number): Json {
  let t: number
  let i: number
  const first = args[0]
  if (first !== null && typeof first === 'object' && !Array.isArray(first) && !isWrapper(first)) {
    t = numberArg(first.t, 'Timestamp', at)
    i = numberArg(first.i, 'Timestamp', at)
  } else {
    t = numberArg(first, 'Timestamp', at)
    i = numberArg(args[1], 'Timestamp', at)
  }
  if (!Number.isInteger(t) || !Number.isInteger(i) || t < 0 || i < 0) {
    fail('Timestamp takes two whole numbers: seconds and an increment.', at)
  }
  return { $timestamp: { t, i } }
}

function regexOptions(flags: string): string {
  // BSON has i, l, m, s, u and x. JavaScript's g, y and d mean nothing to the server.
  return [...new Set(flags)]
    .filter((flag) => 'ilmsux'.includes(flag))
    .sort()
    .join('')
}

const FUNCTIONS: Record<string, (args: Value[], at: number, isNew: boolean) => Value> = {
  ObjectId: (args, at) => makeObjectId(args, at),
  ISODate: (args, at) => makeDate(args, at),
  Date: (args, at, isNew) => (isNew ? makeDate(args, at) : new Date().toString()),
  NumberLong: (args, at) => makeLong(args, at),
  Long: (args, at) => makeLong(args, at),
  NumberInt: (args, at) => makeInt(args, at),
  Int32: (args, at) => makeInt(args, at),
  Double: (args, at) => double(numberArg(args[0], 'Double', at)),
  NumberDecimal: (args, at) => makeDecimal(args, at),
  Decimal128: (args, at) => makeDecimal(args, at),
  Timestamp: (args, at) => makeTimestamp(args, at),
  UUID: (args, at) => makeUuid(args, at),
  BinData: (args, at) => makeBinary(args, at),
  HexData: (args, at) => {
    const subType = numberArg(args[0], 'HexData', at)
    const bytes = hexToBytes(stringArg(args[1], 'HexData', at), at)
    return { $binary: { base64: toBase64(bytes), subType: subType.toString(16).padStart(2, '0') } }
  },
  MinKey: () => ({ $minKey: 1 }),
  MaxKey: () => ({ $maxKey: 1 }),
  Code: (args, at) => ({ $code: stringArg(args[0], 'Code', at) }),
  RegExp: (args, at) => ({
    $regularExpression: {
      pattern: stringArg(args[0], 'RegExp', at),
      options: regexOptions(args[1] === undefined ? '' : stringArg(args[1], 'RegExp', at)),
    },
  }),
  String: (args) => {
    const first = args[0]
    if (first === undefined) return ''
    if (typeof first === 'string') return first
    const number = numberOf(first)
    return number !== null ? String(number) : JSON.stringify(first)
  },
  Number: (args, at) => {
    const first = args[0]
    return typeof first === 'string' ? Number(first) : numberArg(first, 'Number', at)
  },
  parseInt: (args, at) =>
    parseInt(
      String(args[0] ?? ''),
      args[1] === undefined ? 10 : numberArg(args[1], 'parseInt', at),
    ),
  parseFloat: (args) => parseFloat(String(args[0] ?? '')),
  Boolean: (args) => Boolean(args[0]),
}

const MATH: Record<string, (...numbers: number[]) => number> = {
  floor: Math.floor,
  ceil: Math.ceil,
  round: Math.round,
  trunc: Math.trunc,
  abs: Math.abs,
  sqrt: Math.sqrt,
  pow: Math.pow,
  min: Math.min,
  max: Math.max,
}

const CONSTANTS: Record<string, Record<string, number>> = {
  Math: { PI: Math.PI, E: Math.E },
  Number: {
    MAX_SAFE_INTEGER: Number.MAX_SAFE_INTEGER,
    MIN_SAFE_INTEGER: Number.MIN_SAFE_INTEGER,
    EPSILON: Number.EPSILON,
  },
}

// ───────────────────────────── evaluation ─────────────────────────────

function asArithmetic(value: Value, at: number): number | string {
  if (typeof value === 'string') return value
  const ms = dateValue(value)
  if (ms !== null) return ms
  const number = numberOf(value)
  if (number === null) fail('Arithmetic works on numbers, text and dates only.', at)
  return number
}

function instanceCall(target: Value, name: string, at: number): Value {
  if (target !== null && typeof target === 'object' && !Array.isArray(target)) {
    if ('$oid' in target) {
      if (name === 'toHexString') return String(target.$oid)
      if (name === 'getTimestamp')
        return dateOf(parseInt(String(target.$oid).slice(0, 8), 16) * 1000)
    }
    const ms = dateValue(target)
    if (ms !== null) {
      if (name === 'getTime' || name === 'valueOf') return ms
      if (name === 'toISOString') return new Date(ms).toISOString()
    }
  }
  return fail(`${name}() is not supported here.`, at)
}

function value(expr: Expr): Value {
  switch (expr.t) {
    case 'string':
    case 'bool':
      return expr.value
    case 'null':
    case 'undefined':
      return null
    case 'number':
      return expr.float ? double(expr.value) : expr.value
    case 'regex':
      return {
        $regularExpression: { pattern: expr.pattern, options: regexOptions(expr.flags) },
      }
    case 'array':
      return expr.items.map(value)
    case 'object': {
      const out: { [key: string]: Json } = {}
      for (const prop of expr.props) {
        Object.defineProperty(out, prop.key, {
          value: value(prop.value),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }
      return out
    }
    case 'ref':
      if (expr.name in FUNCTIONS) {
        return fail(`${expr.name} is a function. Call it, as in ${expr.name}(...).`, expr.at)
      }
      return fail(
        `Unknown name “${expr.name}”. Variables are not supported; write the value inline.`,
        expr.at,
      )
    case 'member': {
      const owner = expr.object.t === 'ref' ? expr.object.name : null
      const constant = owner ? CONSTANTS[owner]?.[expr.name] : undefined
      if (constant !== undefined) return constant
      return fail('Reading a property is not supported here.', expr.at)
    }
    case 'index':
      return fail('Indexing is not supported here.', expr.at)
    case 'unary': {
      const operand = asArithmetic(value(expr.operand), expr.at)
      if (typeof operand !== 'number') fail('A minus sign needs a number.', expr.at)
      return expr.op === '-' ? -operand : operand
    }
    case 'binary': {
      const left = asArithmetic(value(expr.left), expr.at)
      const right = asArithmetic(value(expr.right), expr.at)
      if (expr.op === '+' && (typeof left === 'string' || typeof right === 'string')) {
        return `${left}${right}`
      }
      if (typeof left !== 'number' || typeof right !== 'number') {
        return fail(`“${expr.op}” needs numbers on both sides.`, expr.at)
      }
      switch (expr.op) {
        case '+':
          return left + right
        case '-':
          return left - right
        case '*':
          return left * right
        case '/':
          return left / right
        default:
          return left % right
      }
    }
    case 'call': {
      const callee = expr.callee
      const args = expr.args.map(value)
      if (callee.t === 'ref') {
        const fn = FUNCTIONS[callee.name]
        if (!fn) {
          return fail(
            `${callee.name}() is not supported. Variables and functions are not available in scripts.`,
            callee.at,
          )
        }
        return fn(args, expr.at, expr.isNew)
      }
      if (callee.t === 'member' && callee.object.t === 'ref') {
        const owner = callee.object.name
        if (owner === 'Date' && callee.name === 'now') return Date.now()
        if (owner === 'Date' && callee.name === 'parse') {
          return Date.parse(stringArg(args[0], 'Date.parse', expr.at))
        }
        if (owner === 'Date' && callee.name === 'UTC') {
          const [y, m = 0, d = 1, h = 0, mi = 0, s = 0, ms = 0] = args.map((a) =>
            numberArg(a, 'Date.UTC', expr.at),
          )
          return Date.UTC(y!, m, d, h, mi, s, ms)
        }
        if (owner === 'Math' && MATH[callee.name]) {
          return MATH[callee.name]!(
            ...args.map((a) => numberArg(a, `Math.${callee.name}`, expr.at)),
          )
        }
        if (owner === 'ObjectId' && callee.name === 'createFromHexString') {
          return makeObjectId(args, expr.at)
        }
        if (owner === 'UUID' && callee.name === 'generate') return makeUuid([], expr.at)
      }
      if (callee.t === 'member') return instanceCall(value(callee.object), callee.name, expr.at)
      return fail('That call is not supported.', expr.at)
    }
  }
}

/** The value as canonical Extended JSON. Throws a `MongoSyntaxError` that says where it went wrong. */
export function evaluate(expr: Expr): Json {
  return finalize(value(expr))
}
