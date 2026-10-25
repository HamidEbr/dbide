export interface MysqlErrorLike {
  code?: string
  errno?: number
  sqlMessage?: string
  message?: string
}

export interface DescribedError {
  code: string | null
  message: string
}

/**
 * Keeps the server's own words and adds what to do about the common failures. The original
 * message always stays, so nobody has to guess what MySQL really said.
 */
export function describeMysqlError(error: unknown): DescribedError {
  const e = (error ?? {}) as MysqlErrorLike
  const server = e.sqlMessage ?? e.message ?? String(error)
  const code = e.code ?? null

  switch (code) {
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_ACCESS_DENIED_NO_PASSWORD_ERROR':
      return { code, message: `${server}. Check the username and password.` }
    case 'ER_DBACCESS_DENIED_ERROR':
      return { code, message: `${server}. This user may not use that database.` }
    case 'ER_BAD_DB_ERROR':
      return { code, message: `${server}. Pick a database that exists.` }
    case 'ER_QUERY_INTERRUPTED':
      return { code, message: 'The query was cancelled.' }
    case 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION':
      return {
        code,
        message: 'This connection is read-only. Unlock writes to run this statement.',
      }
    case 'ER_OPTION_PREVENTS_STATEMENT':
      return { code, message: `${server}. The server itself is read-only.` }
    case 'ER_NOT_SUPPORTED_AUTH_MODE':
      return { code, message: `${server}. The server uses a login method this client can't use.` }
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ECONNRESET':
    case 'EPIPE':
      return { code, message: 'The server closed the connection.' }
    case 'HANDSHAKE_SSL_ERROR':
      return { code, message: `${server}. Check the TLS settings for this connection.` }
    default:
      return { code, message: server }
  }
}

/** Carries the MySQL error code through `new Error(...)` so callers can react to it. */
export class MysqlError extends Error {
  readonly code: string | null

  constructor(error: unknown) {
    const described = describeMysqlError(error)
    super(described.message)
    this.name = 'MysqlError'
    this.code = described.code
  }
}

/** The server is older than the driver can talk to. The message says which versions work. */
export class UnsupportedServerError extends Error {
  readonly code = 'SERVER_TOO_OLD'

  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedServerError'
  }
}

/** Raised for a session that was closed, killed, or lost; the caller should reconnect. */
export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to MySQL was closed. Run again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}
