/**
 * The slice of mongosh that DBIDE runs: one statement of the form `db.orders.find({ ... }).sort({ ... })`,
 * plus `use` and `show`. Arguments are JavaScript values (objects with bare keys, single quotes, regex
 * literals, trailing commas, comments) and the BSON helpers a query needs (`ObjectId("...")`,
 * `ISODate("...")`, `NumberLong("...")`, ...).
 *
 * This is a parser, not a JavaScript engine: variables, functions, loops and `.forEach` are not
 * understood, and the error says so. Everything here is plain TypeScript with no dependencies, so the
 * editor (which statement is under the cursor), the run guard (what a statement does) and the core
 * (which executes it) all read the text the same way.
 */

import type { StatementInfo } from '../sql'

export class MongoSyntaxError extends Error {
  constructor(
    message: string,
    /** Offset in the text of what is wrong. */
    readonly at: number,
  ) {
    super(message)
    this.name = 'MongoSyntaxError'
  }
}

// ───────────────────────────── tokens ─────────────────────────────

export type TokenType = 'name' | 'number' | 'string' | 'regex' | 'punct' | 'end'

export interface Token {
  type: TokenType
  /** The decoded text of a string; the source text of anything else. */
  value: string
  start: number
  end: number
  /** A line break lies between this token and the one before it. */
  newline: boolean
  /** The flags of a regex literal. */
  flags?: string
}

export interface Tokens {
  tokens: Token[]
  /** Set when the text could not be read to the end. `tokens` holds what came before it. */
  error: MongoSyntaxError | null
}

const NAME_START = /[\p{L}_$]/u
const NAME_PART = /[\p{L}\p{N}_$]/u
const PUNCTUATION = '{}[]():,;.+-*/%=!<>?&|'

/** A `/` after one of these starts a regex literal; after a name, number or closing bracket it divides. */
function regexAllowed(previous: Token | undefined): boolean {
  if (!previous) return true
  if (previous.type === 'punct') return !')]}'.includes(previous.value)
  return false
}

function readEscape(text: string, at: number): { value: string; end: number } {
  const c = text[at + 1]
  switch (c) {
    case 'n':
      return { value: '\n', end: at + 2 }
    case 't':
      return { value: '\t', end: at + 2 }
    case 'r':
      return { value: '\r', end: at + 2 }
    case 'b':
      return { value: '\b', end: at + 2 }
    case 'f':
      return { value: '\f', end: at + 2 }
    case 'v':
      return { value: '\v', end: at + 2 }
    case '0':
      return { value: '\0', end: at + 2 }
    case 'x': {
      const hex = text.slice(at + 2, at + 4)
      if (!/^[0-9a-fA-F]{2}$/.test(hex)) throw new MongoSyntaxError('Invalid \\x escape.', at)
      return { value: String.fromCharCode(parseInt(hex, 16)), end: at + 4 }
    }
    case 'u': {
      if (text[at + 2] === '{') {
        const close = text.indexOf('}', at + 3)
        const hex = close === -1 ? '' : text.slice(at + 3, close)
        const code = /^[0-9a-fA-F]{1,6}$/.test(hex) ? parseInt(hex, 16) : NaN
        if (!(code <= 0x10ffff)) throw new MongoSyntaxError('Invalid \\u escape.', at)
        return { value: String.fromCodePoint(code), end: close + 1 }
      }
      const hex = text.slice(at + 2, at + 6)
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new MongoSyntaxError('Invalid \\u escape.', at)
      return { value: String.fromCharCode(parseInt(hex, 16)), end: at + 6 }
    }
    case '\r':
      return { value: '', end: text[at + 2] === '\n' ? at + 3 : at + 2 }
    case '\n':
      return { value: '', end: at + 2 }
    case undefined:
      throw new MongoSyntaxError('The text ends inside a string.', at)
    default:
      return { value: c, end: at + 2 }
  }
}

/**
 * Cuts the text into tokens. Reading stops at the first thing that can't be read (an unterminated
 * string, a stray character) and says what it was, so the editor can still split the text around it.
 */
export function tokenize(text: string): Tokens {
  const tokens: Token[] = []
  const n = text.length
  let i = 0
  let newline = false

  const push = (token: Omit<Token, 'newline'>): void => {
    tokens.push({ ...token, newline })
    newline = false
  }

  try {
    while (i < n) {
      const c = text[i]!
      if (c === '\n' || c === '\r') {
        newline = true
        i++
      } else if (/\s/.test(c) || c === '﻿') {
        i++
      } else if (c === '/' && text[i + 1] === '/') {
        while (i < n && text[i] !== '\n') i++
      } else if (c === '/' && text[i + 1] === '*') {
        const close = text.indexOf('*/', i + 2)
        if (close === -1) throw new MongoSyntaxError('This comment is never closed.', i)
        if (text.slice(i, close).includes('\n')) newline = true
        i = close + 2
      } else if (c === '"' || c === "'") {
        const start = i
        let value = ''
        i++
        for (;;) {
          if (i >= n || text[i] === '\n') {
            throw new MongoSyntaxError('This string is never closed.', start)
          }
          const d = text[i]!
          if (d === c) {
            i++
            break
          }
          if (d === '\\') {
            const escape = readEscape(text, i)
            value += escape.value
            i = escape.end
          } else {
            value += d
            i++
          }
        }
        push({ type: 'string', value, start, end: i })
      } else if (c === '`') {
        // Only a template without placeholders is a plain string.
        const start = i
        let value = ''
        i++
        for (;;) {
          if (i >= n) throw new MongoSyntaxError('This string is never closed.', start)
          const d = text[i]!
          if (d === '`') {
            i++
            break
          }
          if (d === '$' && text[i + 1] === '{') {
            throw new MongoSyntaxError('Placeholders in template strings are not supported.', i)
          }
          if (d === '\\') {
            const escape = readEscape(text, i)
            value += escape.value
            i = escape.end
          } else {
            value += d
            i++
          }
        }
        push({ type: 'string', value, start, end: i })
      } else if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(text[i + 1] ?? ''))) {
        const start = i
        if (c === '0' && /[xX]/.test(text[i + 1] ?? '')) {
          i += 2
          while (i < n && /[0-9a-fA-F]/.test(text[i]!)) i++
        } else {
          while (i < n && /[0-9]/.test(text[i]!)) i++
          if (text[i] === '.') {
            i++
            while (i < n && /[0-9]/.test(text[i]!)) i++
          }
          if (/[eE]/.test(text[i] ?? '')) {
            let j = i + 1
            if (text[j] === '+' || text[j] === '-') j++
            if (/[0-9]/.test(text[j] ?? '')) {
              while (j < n && /[0-9]/.test(text[j]!)) j++
              i = j
            }
          }
        }
        if (NAME_START.test(text[i] ?? '')) {
          throw new MongoSyntaxError(
            text[i] === 'n'
              ? 'BigInt literals are not supported. Use NumberLong("...") instead.'
              : 'A number can’t be followed by letters.',
            i,
          )
        }
        push({ type: 'number', value: text.slice(start, i), start, end: i })
      } else if (NAME_START.test(c)) {
        const start = i
        i++
        while (i < n && NAME_PART.test(text[i]!)) i++
        push({ type: 'name', value: text.slice(start, i), start, end: i })
      } else if (c === '/' && regexAllowed(tokens[tokens.length - 1])) {
        const start = i
        i++
        let inClass = false
        for (;;) {
          if (i >= n || text[i] === '\n') {
            throw new MongoSyntaxError('This regular expression is never closed.', start)
          }
          const d = text[i]!
          if (d === '\\') i += 2
          else if (d === '[') {
            inClass = true
            i++
          } else if (d === ']') {
            inClass = false
            i++
          } else if (d === '/' && !inClass) break
          else i++
        }
        const pattern = text.slice(start + 1, i)
        i++
        const flagsStart = i
        while (i < n && /[a-z]/.test(text[i]!)) i++
        push({
          type: 'regex',
          value: pattern,
          start,
          end: i,
          flags: text.slice(flagsStart, i),
        })
      } else if (PUNCTUATION.includes(c)) {
        push({ type: 'punct', value: c, start: i, end: i + 1 })
        i++
      } else {
        throw new MongoSyntaxError(`Unexpected character “${c}”.`, i)
      }
    }
  } catch (error) {
    if (error instanceof MongoSyntaxError) return { tokens, error }
    throw error
  }
  return { tokens, error: null }
}

// ───────────────────────────── statements ─────────────────────────────

export interface MongoStatement {
  /** The statement without its `;` and without surrounding whitespace or comments. */
  text: string
  /** Offset of the first character of `text`. */
  from: number
  /** Offset just past the last character of `text`. */
  to: number
  /** Offset just past the terminator (or the end of the input for the last statement). */
  end: number
}

const endsExpression = (token: Token): boolean =>
  token.type !== 'punct' || token.value === ')' || token.value === ']' || token.value === '}'

/**
 * Splits a script into statements. A statement ends at a `;`, or at a line break once the expression is
 * complete and the next line starts with a name, so `db.a.find()` followed by `db.b.find()` on the next
 * line is two statements while a line that starts with `.sort(...)` continues the one above it.
 * Brackets, strings and comments never split. Text that can't be read to the end stays in the last
 * statement, so the editor keeps working while someone is half way through typing.
 */
export function splitMongoStatements(text: string): MongoStatement[] {
  const { tokens, error } = tokenize(text)
  const statements: MongoStatement[] = []
  let first: Token | null = null
  let last: Token | null = null
  let depth = 0

  const emit = (end: number): void => {
    if (first && last) {
      statements.push({
        text: text.slice(first.start, last.end),
        from: first.start,
        to: last.end,
        end,
      })
    }
    first = null
    last = null
    depth = 0
  }

  for (const token of tokens) {
    if (token.type === 'punct' && token.value === ';' && depth <= 0) {
      emit(token.end)
      continue
    }
    if (
      first &&
      last &&
      depth <= 0 &&
      token.newline &&
      token.type === 'name' &&
      endsExpression(last)
    ) {
      emit(last.end)
    }
    first ??= token
    last = token
    if (token.type === 'punct') {
      if ('([{'.includes(token.value)) depth++
      else if (')]}'.includes(token.value)) depth--
    }
  }
  // The unreadable tail (an open string, say) belongs to the statement being typed.
  if (error) {
    const tail = text.slice(error.at).trimEnd()
    if (first && last) last = { ...last, end: error.at + tail.length }
    else if (tail !== '') {
      first = {
        type: 'name',
        value: '',
        start: error.at,
        end: error.at + tail.length,
        newline: false,
      }
      last = first
    }
  }
  emit(text.length)
  return statements
}

// ───────────────────────────── syntax tree ─────────────────────────────

interface At {
  /** Offset of the node in the text, for error messages. */
  at: number
}

export type Expr = At &
  (
    | { t: 'object'; props: { key: string; value: Expr }[] }
    | { t: 'array'; items: Expr[] }
    | { t: 'string'; value: string }
    /** `float` is set when the literal is written with a decimal point or an exponent. */
    | { t: 'number'; value: number; float: boolean }
    | { t: 'bool'; value: boolean }
    | { t: 'null' }
    | { t: 'undefined' }
    | { t: 'regex'; pattern: string; flags: string }
    | { t: 'ref'; name: string }
    | { t: 'member'; object: Expr; name: string }
    | { t: 'index'; object: Expr; index: Expr }
    | { t: 'call'; callee: Expr; args: Expr[]; isNew: boolean }
    | { t: 'unary'; op: '-' | '+'; operand: Expr }
    | { t: 'binary'; op: '+' | '-' | '*' | '/' | '%'; left: Expr; right: Expr }
  )

class Parser {
  private index = 0

  constructor(
    private readonly tokens: Token[],
    private readonly text: string,
    private readonly error: MongoSyntaxError | null,
  ) {}

  get position(): number {
    return this.tokens[this.index]?.start ?? this.text.length
  }

  peek(offset = 0): Token | undefined {
    return this.tokens[this.index + offset]
  }

  atEnd(): boolean {
    return this.index >= this.tokens.length
  }

  next(): Token {
    const token = this.tokens[this.index]
    if (!token) {
      throw this.error ?? new MongoSyntaxError('The statement ends too soon.', this.text.length)
    }
    this.index++
    return token
  }

  isPunct(value: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token?.type === 'punct' && token.value === value
  }

  isName(value: string, offset = 0): boolean {
    const token = this.peek(offset)
    return token?.type === 'name' && token.value === value
  }

  accept(value: string): boolean {
    if (!this.isPunct(value)) return false
    this.index++
    return true
  }

  expect(value: string, what = `“${value}”`): Token {
    const token = this.peek()
    if (token?.type === 'punct' && token.value === value) return this.next()
    if (!token)
      throw (
        this.error ?? new MongoSyntaxError(`Expected ${what}, but the text ends.`, this.text.length)
      )
    throw new MongoSyntaxError(
      `Expected ${what}, found “${this.text.slice(token.start, token.end)}”.`,
      token.start,
    )
  }

  /** Throws the tokenizer's error if the tokens ran out because of it. */
  failIfUnreadable(): void {
    if (this.error && this.atEnd()) throw this.error
  }

  expression(): Expr {
    return this.additive()
  }

  private additive(): Expr {
    let left = this.multiplicative()
    while (this.isPunct('+') || this.isPunct('-')) {
      const op = this.next().value as '+' | '-'
      left = { t: 'binary', op, left, right: this.multiplicative(), at: left.at }
    }
    return left
  }

  private multiplicative(): Expr {
    let left = this.unary()
    while (this.isPunct('*') || this.isPunct('/') || this.isPunct('%')) {
      const op = this.next().value as '*' | '/' | '%'
      left = { t: 'binary', op, left, right: this.unary(), at: left.at }
    }
    return left
  }

  private unary(): Expr {
    if (this.isPunct('-') || this.isPunct('+')) {
      const token = this.next()
      return { t: 'unary', op: token.value as '-' | '+', operand: this.unary(), at: token.start }
    }
    return this.postfix()
  }

  private postfix(): Expr {
    let expr = this.primary()
    for (;;) {
      if (this.isPunct('.')) {
        this.next()
        const name = this.next()
        if (name.type !== 'name') {
          throw new MongoSyntaxError('Expected a name after the dot.', name.start)
        }
        expr = { t: 'member', object: expr, name: name.value, at: expr.at }
      } else if (this.isPunct('[')) {
        this.next()
        const index = this.expression()
        this.expect(']')
        expr = { t: 'index', object: expr, index, at: expr.at }
      } else if (this.isPunct('(')) {
        expr = { t: 'call', callee: expr, args: this.args(), isNew: false, at: expr.at }
      } else {
        return expr
      }
    }
  }

  private args(): Expr[] {
    this.expect('(')
    const args: Expr[] = []
    while (!this.isPunct(')')) {
      args.push(this.expression())
      if (!this.accept(',')) break
    }
    this.expect(')')
    return args
  }

  private primary(): Expr {
    const token = this.next()
    const at = token.start
    switch (token.type) {
      case 'number': {
        const value =
          token.value.startsWith('0x') || token.value.startsWith('0X')
            ? parseInt(token.value, 16)
            : Number(token.value)
        return {
          t: 'number',
          value,
          float: /[.eE]/.test(token.value) && !/^0[xX]/.test(token.value),
          at,
        }
      }
      case 'string':
        return { t: 'string', value: token.value, at }
      case 'regex':
        return { t: 'regex', pattern: token.value, flags: token.flags ?? '', at }
      case 'name':
        return this.nameValue(token)
      default:
        break
    }

    if (token.value === '{') return this.object(at)
    if (token.value === '[') {
      const items: Expr[] = []
      while (!this.isPunct(']')) {
        items.push(this.expression())
        if (!this.accept(',')) break
      }
      this.expect(']')
      return { t: 'array', items, at }
    }
    if (token.value === '(') {
      const inner = this.expression()
      this.expect(')')
      return inner
    }
    throw new MongoSyntaxError(`Unexpected “${token.value}”.`, token.start)
  }

  private nameValue(token: Token): Expr {
    const at = token.start
    switch (token.value) {
      case 'true':
        return { t: 'bool', value: true, at }
      case 'false':
        return { t: 'bool', value: false, at }
      case 'null':
        return { t: 'null', at }
      case 'undefined':
        return { t: 'undefined', at }
      case 'NaN':
        return { t: 'number', value: NaN, float: true, at }
      case 'Infinity':
        return { t: 'number', value: Infinity, float: true, at }
      case 'new': {
        const callee = this.next()
        if (callee.type !== 'name') {
          throw new MongoSyntaxError('Expected a name after “new”.', callee.start)
        }
        const args = this.isPunct('(') ? this.args() : []
        return {
          t: 'call',
          callee: { t: 'ref', name: callee.value, at: callee.start },
          args,
          isNew: true,
          at,
        }
      }
      case 'var':
      case 'let':
      case 'const':
        throw new MongoSyntaxError(
          'Variables are not supported. Write the value inline, or run one statement at a time.',
          at,
        )
      case 'function':
        throw new MongoSyntaxError('Functions are not supported.', at)
      default:
        return { t: 'ref', name: token.value, at }
    }
  }

  private object(at: number): Expr {
    const props: { key: string; value: Expr }[] = []
    while (!this.isPunct('}')) {
      const key = this.next()
      let name: string
      if (key.type === 'name' || key.type === 'string') name = key.value
      else if (key.type === 'number') name = String(Number(key.value))
      else throw new MongoSyntaxError('Expected a field name.', key.start)
      if (!this.isPunct(':')) {
        const found = this.peek()
        throw new MongoSyntaxError(
          found?.type === 'punct' && (found.value === ',' || found.value === '}')
            ? `“${name}” needs a value. Write ${name}: <value>.`
            : `Expected “:” after the field name “${name}”.`,
          found?.start ?? this.text.length,
        )
      }
      this.next()
      props.push({ key: name, value: this.expression() })
      if (!this.accept(',')) break
    }
    this.expect('}')
    return { t: 'object', props, at }
  }
}

// ───────────────────────────── commands ─────────────────────────────

/** A call made on the cursor a query returned: `.sort({ a: 1 })`, `.limit(10)`. */
export interface Modifier {
  name: string
  args: Expr[]
  at: number
}

export type MongoCommand =
  | { kind: 'use'; database: string }
  | { kind: 'show'; what: 'databases' | 'collections' }
  | {
      kind: 'collection'
      /** Set by `db.getSiblingDB("other")`. */
      database: string | null
      collection: string
      method: string
      args: Expr[]
      modifiers: Modifier[]
      /** The verbosity of `db.c.explain("executionStats").find()`. Null when the query isn't explained. */
      explain: string | null
      at: number
    }
  | {
      kind: 'database'
      database: string | null
      method: string
      args: Expr[]
      modifiers: Modifier[]
      at: number
    }

interface Step {
  kind: 'member' | 'index' | 'call'
  name?: string
  args?: Expr[]
  at: number
}

function flatten(expr: Expr): { root: Expr; steps: Step[] } {
  const steps: Step[] = []
  let current = expr
  for (;;) {
    if (current.t === 'member') {
      steps.unshift({ kind: 'member', name: current.name, at: current.at })
      current = current.object
    } else if (current.t === 'index') {
      if (current.index.t !== 'string') {
        throw new MongoSyntaxError(
          'Name the collection with a string: db["orders"].',
          current.index.at,
        )
      }
      steps.unshift({ kind: 'index', name: current.index.value, at: current.at })
      current = current.object
    } else if (current.t === 'call' && !current.isNew) {
      steps.unshift({ kind: 'call', args: current.args, at: current.at })
      current = current.callee
    } else {
      return { root: current, steps }
    }
  }
}

function stringArgument(args: Expr[], method: string): string {
  const first = args[0]
  if (first?.t !== 'string') {
    throw new MongoSyntaxError(`${method}() takes a name in quotes.`, first?.at ?? 0)
  }
  return first.value
}

function interpret(expr: Expr): MongoCommand {
  const { root, steps } = flatten(expr)
  if (root.t !== 'ref') {
    throw new MongoSyntaxError('Start with db, as in db.orders.find({}).', root.at)
  }
  if (root.name !== 'db') {
    throw new MongoSyntaxError(
      root.name === 'rs' || root.name === 'sh'
        ? `${root.name}.* helpers are not supported. Use db.runCommand({ ... }) instead.`
        : `Unknown name “${root.name}”. Statements start with db, as in db.orders.find({}).`,
      root.at,
    )
  }

  let database: string | null = null
  const path: string[] = []
  let i = 0

  for (;;) {
    const step = steps[i]
    if (!step) {
      if (path.length === 0 && database === null) {
        return {
          kind: 'database',
          database,
          method: 'getName',
          args: [],
          modifiers: [],
          at: root.at,
        }
      }
      throw new MongoSyntaxError(
        path.length > 0
          ? `Call a method on ${path.join('.')}, as in db.${path.join('.')}.find({}).`
          : 'Name a collection, as in db.orders.find({}).',
        expr.at,
      )
    }
    if (step.kind === 'call') {
      throw new MongoSyntaxError('Name a collection or a method before the parentheses.', step.at)
    }
    const name = step.name!
    if (steps[i + 1]?.kind !== 'call') {
      path.push(name)
      i++
      continue
    }
    const args = steps[i + 1]!.args!
    if (path.length === 0 && step.kind === 'member') {
      if (name === 'getSiblingDB') {
        database = stringArgument(args, 'getSiblingDB')
        i += 2
        continue
      }
      if (name === 'getCollection') {
        path.push(stringArgument(args, 'getCollection'))
        i += 2
        continue
      }
      const modifiers = readModifiers(steps, i + 2)
      return { kind: 'database', database, method: name, args, modifiers, at: step.at }
    }
    if (path.length === 0) {
      throw new MongoSyntaxError('Name a collection before the method.', step.at)
    }

    let method = name
    let methodArgs = args
    let explain: string | null = null
    let next = i + 2
    // db.orders.explain("executionStats").find({ ... }) explains the query that follows.
    if (
      method === 'explain' &&
      steps[next]?.kind === 'member' &&
      steps[next + 1]?.kind === 'call'
    ) {
      const verbosity = args[0]
      explain = verbosity?.t === 'string' ? verbosity.value : 'queryPlanner'
      method = steps[next]!.name!
      methodArgs = steps[next + 1]!.args!
      next += 2
    }
    return {
      kind: 'collection',
      database,
      collection: path.join('.'),
      method,
      args: methodArgs,
      modifiers: readModifiers(steps, next),
      explain,
      at: step.at,
    }
  }
}

function readModifiers(steps: Step[], from: number): Modifier[] {
  const modifiers: Modifier[] = []
  for (let i = from; i < steps.length; i += 2) {
    const member = steps[i]!
    const call = steps[i + 1]
    if (member.kind !== 'member' || call?.kind !== 'call') {
      throw new MongoSyntaxError('Expected a method call such as .sort({ a: 1 }).', member.at)
    }
    modifiers.push({ name: member.name!, args: call.args!, at: member.at })
  }
  return modifiers
}

/** `use shop`, `show dbs`, or a `db.…` call. Exactly one statement; a trailing `;` is fine. */
export function parseMongoStatement(text: string): MongoCommand {
  const { tokens, error } = tokenize(text)
  const parser = new Parser(tokens, text, error)
  if (parser.atEnd()) {
    throw error ?? new MongoSyntaxError('There is nothing to run.', 0)
  }

  let command: MongoCommand
  if (parser.isName('use') && parser.peek(1)?.type !== 'punct' && parser.peek(1)) {
    parser.next()
    const name = parser.next()
    if (name.type !== 'name' && name.type !== 'string') {
      throw new MongoSyntaxError('Name the database to use.', name.start)
    }
    command = { kind: 'use', database: name.value }
  } else if (parser.isName('show') && parser.peek(1)?.type === 'name') {
    parser.next()
    const what = parser.next()
    const lower = what.value.toLowerCase()
    if (lower === 'dbs' || lower === 'databases') command = { kind: 'show', what: 'databases' }
    else if (lower === 'collections' || lower === 'tables') {
      command = { kind: 'show', what: 'collections' }
    } else {
      throw new MongoSyntaxError(
        `show ${what.value} is not supported. Try show dbs or show collections.`,
        what.start,
      )
    }
  } else {
    command = interpret(parser.expression())
  }

  parser.accept(';')
  if (!parser.atEnd()) {
    const extra = parser.peek()!
    throw new MongoSyntaxError(
      extra.newline
        ? 'Run one statement at a time. Put each statement on its own line, ending the one above with “;”.'
        : `Unexpected “${text.slice(extra.start, extra.end)}”.`,
      extra.start,
    )
  }
  parser.failIfUnreadable()
  return command
}

/**
 * One value written the way a query writes it: a document, an array, a number, `ObjectId("...")`.
 * For the editors, which take a value rather than a whole statement. A trailing `;` is fine.
 */
export function parseMongoValue(text: string): Expr {
  const { tokens, error } = tokenize(text)
  const parser = new Parser(tokens, text, error)
  if (parser.atEnd()) throw error ?? new MongoSyntaxError('Write a value.', 0)
  const value = parser.expression()
  parser.accept(';')
  if (!parser.atEnd()) {
    const extra = parser.peek()!
    throw new MongoSyntaxError(`Unexpected “${text.slice(extra.start, extra.end)}”.`, extra.start)
  }
  parser.failIfUnreadable()
  return value
}

/** The line and column (both from 1) of an offset, for error messages. */
export function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)))
  const line = before.split('\n').length
  return { line, column: before.length - before.lastIndexOf('\n') }
}

// ───────────────────────────── what a command does ─────────────────────────────

const READ_METHODS = new Set([
  'find',
  'findOne',
  'aggregate',
  'countDocuments',
  'estimatedDocumentCount',
  'count',
  'distinct',
  'getIndexes',
  'stats',
  'dataSize',
  'storageSize',
  'totalSize',
  'totalIndexSize',
  'isCapped',
  'validate',
])

const WRITE_METHODS = new Set([
  'insertOne',
  'insertMany',
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
  'bulkWrite',
])

const DDL_METHODS = new Set([
  'createIndex',
  'createIndexes',
  'dropIndex',
  'dropIndexes',
  'renameCollection',
])

const FILTERED_WRITES = new Set([
  'updateOne',
  'updateMany',
  'replaceOne',
  'deleteOne',
  'deleteMany',
  'findOneAndUpdate',
  'findOneAndReplace',
  'findOneAndDelete',
])

const READ_DB_METHODS = new Set([
  'getName',
  'getCollectionNames',
  'getCollectionInfos',
  'listCollections',
  'stats',
  'version',
  'serverStatus',
  'serverBuildInfo',
  'hostInfo',
  'currentOp',
  'getProfilingStatus',
  'hello',
  'isMaster',
  'listCommands',
])

const READ_COMMANDS = new Set(
  [
    'ping',
    'hello',
    'isMaster',
    'buildInfo',
    'serverStatus',
    'hostInfo',
    'dbStats',
    'collStats',
    'listCollections',
    'listDatabases',
    'listIndexes',
    'count',
    'distinct',
    'find',
    'explain',
    'connectionStatus',
    'getParameter',
    'getCmdLineOpts',
    'top',
    'validate',
    'whatsmyuri',
    'features',
    'usersInfo',
    'rolesInfo',
    'getLog',
    'replSetGetStatus',
    'replSetGetConfig',
    'listCommands',
    'currentOp',
  ].map((name) => name.toLowerCase()),
)

const DESTRUCTIVE_COMMANDS: Record<string, string> = {
  drop: 'drop permanently removes the collection.',
  dropdatabase: 'dropDatabase permanently removes the database.',
  dropindexes: 'dropIndexes removes indexes.',
  dropallusersfromdatabase: 'dropAllUsersFromDatabase removes every user of the database.',
  dropuser: 'dropUser removes the user.',
  droprole: 'dropRole removes the role.',
}

const isEmptyFilter = (arg: Expr | undefined): boolean =>
  arg === undefined ||
  arg.t === 'undefined' ||
  arg.t === 'null' ||
  (arg.t === 'object' && arg.props.length === 0)

/** Whether an aggregation pipeline ends by writing (`$out`, `$merge`). */
export function pipelineWrites(pipeline: Expr | undefined): boolean {
  if (pipeline?.t !== 'array') return false
  return pipeline.items.some(
    (stage) =>
      stage.t === 'object' && stage.props.some((p) => p.key === '$out' || p.key === '$merge'),
  )
}

function classifyRunCommand(args: Expr[]): StatementInfo {
  const first = args[0]
  let name: string | null = null
  if (first?.t === 'string') name = first.value
  else if (first?.t === 'object' && first.props[0]) name = first.props[0].key
  if (!name) return { kind: 'admin', destructive: false }

  const lower = name.toLowerCase()
  const destructive = DESTRUCTIVE_COMMANDS[lower]
  if (destructive) return { kind: 'ddl', destructive: true, reason: destructive }
  if (lower === 'aggregate' && first?.t === 'object') {
    const pipeline = first.props.find((p) => p.key === 'pipeline')?.value
    return { kind: pipelineWrites(pipeline) ? 'write' : 'read', destructive: false }
  }
  return { kind: READ_COMMANDS.has(lower) ? 'read' : 'admin', destructive: false }
}

/** What a parsed command does, for the run guard and for the read-only check in the driver. */
export function classifyCommand(command: MongoCommand): StatementInfo {
  if (command.kind === 'use') return { kind: 'session', destructive: false }
  if (command.kind === 'show') return { kind: 'read', destructive: false }

  const { method } = command
  if (command.kind === 'database') {
    if (method === 'runCommand' || method === 'adminCommand')
      return classifyRunCommand(command.args)
    if (method === 'dropDatabase') {
      return {
        kind: 'ddl',
        destructive: true,
        reason: 'dropDatabase permanently removes the database.',
      }
    }
    if (method === 'createCollection' || method === 'createView') {
      return { kind: 'ddl', destructive: false }
    }
    if (READ_DB_METHODS.has(method)) return { kind: 'read', destructive: false }
    return { kind: 'unknown', destructive: false }
  }

  if (command.explain !== null) return { kind: 'read', destructive: false }
  if (method === 'aggregate') {
    return { kind: pipelineWrites(command.args[0]) ? 'write' : 'read', destructive: false }
  }
  if (READ_METHODS.has(method)) return { kind: 'read', destructive: false }
  if (method === 'drop') {
    return { kind: 'ddl', destructive: true, reason: 'drop() permanently removes the collection.' }
  }
  if (DDL_METHODS.has(method)) return { kind: 'ddl', destructive: false }
  if (WRITE_METHODS.has(method)) {
    if (FILTERED_WRITES.has(method) && isEmptyFilter(command.args[0])) {
      const many = method.endsWith('Many')
      return {
        kind: 'write',
        destructive: true,
        reason: many
          ? `${method} with an empty filter ${method.startsWith('delete') ? 'removes' : 'changes'} every document in the collection.`
          : `${method} with an empty filter ${method.startsWith('delete') || method.endsWith('Delete') ? 'removes' : 'changes'} whichever document comes first.`,
      }
    }
    return { kind: 'write', destructive: false }
  }
  return { kind: 'unknown', destructive: false }
}

/**
 * What a statement does. Text that doesn't parse is reported as a read: the core refuses to run it, so
 * it can't change anything, and the message that matters is the syntax error, not a read-only warning.
 */
export function classifyMongo(text: string): StatementInfo {
  try {
    return classifyCommand(parseMongoStatement(text))
  } catch (error) {
    if (error instanceof MongoSyntaxError) return { kind: 'read', destructive: false }
    throw error
  }
}
