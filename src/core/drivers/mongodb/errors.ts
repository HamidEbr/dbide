import { MongoServerSelectionError } from 'mongodb'
import { plainNumber } from './bson'
import { MongoSyntaxError, lineAndColumn } from '@shared/mongo/lang'

/** The oldest wire version the driver speaks, and the server release it belongs to. */
const WIRE_VERSIONS: Record<number, string> = {
  0: '2.4',
  1: '2.6',
  2: '2.6',
  3: '3.0',
  4: '3.2',
  5: '3.4',
  6: '3.6',
  7: '4.0',
  8: '4.2',
  9: '4.4',
}

const NAMES: Record<number, string> = {
  11000: 'DuplicateKey',
  11001: 'DuplicateKey',
  12582: 'DuplicateKey',
  13: 'Unauthorized',
  18: 'AuthenticationFailed',
  43: 'CursorNotFound',
  50: 'MaxTimeMSExpired',
  121: 'DocumentValidationFailure',
  11601: 'Interrupted',
}

interface MongoErrorLike {
  code?: number | string | object
  codeName?: string
  errmsg?: string
  message?: string
  name?: string
  errInfo?: unknown
}

export interface DescribedError {
  code: string | null
  message: string
}

const NETWORK_ERRORS = new Set([
  'MongoNetworkError',
  'MongoNetworkTimeoutError',
  'MongoNotConnectedError',
])

/**
 * Keeps the server's own words and adds what to do about the common failures. The original message
 * always stays, so nobody has to guess what MongoDB really said.
 */
export function describeMongoError(error: unknown): DescribedError {
  const e = (error ?? {}) as MongoErrorLike
  const server = e.errmsg ?? e.message ?? String(error)
  // The server's sentences end in a full stop already; what is added after them must not double it.
  const said = server.replace(/[.\s]+$/, '')
  // Replies are read without promoting values, so a server error's number can be a BSON Int32 object.
  const number =
    typeof e.code === 'number' || (typeof e.code === 'object' && e.code !== null)
      ? plainNumber(e.code)
      : undefined
  // Write errors carry a number and no name; the ones people meet get their names back.
  const named = number === undefined ? undefined : NAMES[number]
  const codeName = typeof e.codeName === 'string' ? e.codeName : (named ?? null)
  const code = codeName ?? (e.code === undefined ? null : String(number ?? e.code))

  const tooOld = /reports maximum wire version (\d+)/.exec(server)
  if (tooOld) {
    const version = WIRE_VERSIONS[Number(tooOld[1])] ?? `wire version ${tooOld[1]}`
    return {
      code: 'SERVER_TOO_OLD',
      message: `This MongoDB server is version ${version}. DBIDE needs MongoDB 4.4 or newer.`,
    }
  }

  switch (code) {
    case 'AuthenticationFailed':
    case '18':
      return {
        code: 'AuthenticationFailed',
        message: `${said}. Check the username and password, and that the login is checked in the right database (authSource).`,
      }
    case 'Unauthorized':
    case '13':
      return {
        code: 'Unauthorized',
        message: `${said}. This user does not have the role for that.`,
      }
    case 'MaxTimeMSExpired':
    case '50':
      return { code: 'MaxTimeMSExpired', message: 'The operation ran out of time (maxTimeMS).' }
    case 'Interrupted':
    case 'InterruptedAtShutdown':
    case 'InterruptedDueToReplStateChange':
    case '11601':
      return { code: 'Interrupted', message: 'The operation was cancelled.' }
    case 'CursorNotFound':
    case '43':
      return {
        code: 'CursorNotFound',
        message:
          'The server closed this cursor, which it does after ten minutes without use. Run the query again.',
      }
    case 'DocumentValidationFailure':
    case '121': {
      const details = e.errInfo === undefined ? '' : ` ${JSON.stringify(e.errInfo).slice(0, 800)}`
      return {
        code: 'DocumentValidationFailure',
        message: `${said}. The collection’s validation rules refused the document.${details}`,
      }
    }
  }

  if (error instanceof MongoServerSelectionError) {
    const first = server.split('\n')[0]!
    const replicaSet = /ReplicaSet|replica set/i.test(`${server} ${String(e.name)}`)
    return {
      code: 'CONNECTION_CLOSED',
      message: `Couldn’t reach a MongoDB server. ${first}${
        replicaSet || /ENOTFOUND|ECONNREFUSED/.test(server)
          ? ' If this is a replica set, the members may advertise host names this machine can’t reach; turn on “Direct connection” for the connection.'
          : ''
      }`,
    }
  }
  if (NETWORK_ERRORS.has(String(e.name))) {
    return { code: 'CONNECTION_CLOSED', message: `The connection to MongoDB was lost. ${server}` }
  }
  if (/ERR_SSL|certificate|self.signed|SSL routines/i.test(server)) {
    return {
      code: code ?? 'TLS_ERROR',
      message: `${said}. Check the TLS settings for this connection.`,
    }
  }
  return { code, message: server }
}

/** Carries the MongoDB error code through `new Error(...)` so callers can react to it. */
export class MongoError extends Error {
  readonly code: string | null

  constructor(error: unknown) {
    const described = describeMongoError(error)
    super(described.message)
    this.name = 'MongoError'
    this.code = described.code
  }
}

/** A statement that can't be run as typed: a syntax error, or something the shell would accept and DBIDE does not. */
export class ShellError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
    this.name = 'ShellError'
  }
}

/** A syntax error with the place it happened, so the message can be found in the text. */
export function syntaxError(error: unknown, text: string): Error {
  if (error instanceof MongoSyntaxError) {
    const { line, column } = lineAndColumn(text, error.at)
    return new ShellError(`${error.message} (line ${line}, column ${column})`, 'SYNTAX_ERROR')
  }
  return error instanceof Error ? error : new Error(String(error))
}

/** Raised for a session that was closed; the caller should reconnect. */
export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to MongoDB was closed. Run again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}
