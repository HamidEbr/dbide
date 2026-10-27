/** What PostgreSQL's driver puts on an error: the SQLSTATE code and the server's own message. */
interface PgErrorLike {
  code?: string
  message?: string
  detail?: string
  hint?: string
}

export interface DescribedError {
  code: string | null
  message: string
}

/** Keeps the server's words and adds what to do about the common failures. */
export function describePgError(error: unknown): DescribedError {
  const e = (error ?? {}) as PgErrorLike
  const server = e.message ?? String(error)
  const code = e.code ?? null
  const detail = [e.detail, e.hint].filter(Boolean).join(' ')
  const full = detail ? `${server}. ${detail}` : server
  switch (code) {
    case '28P01':
    case '28000':
      return { code, message: `${server}. Check the username and password.` }
    case '3D000':
      return { code, message: `${server}. Pick a database that exists.` }
    case '57014':
      return { code, message: 'The query was cancelled.' }
    case '25006':
      return { code, message: 'This connection is read-only. Unlock writes to run this statement.' }
    case 'ECONNRESET':
    case 'EPIPE':
      return { code, message: 'The server closed the connection.' }
    default:
      return { code, message: full }
  }
}

export class PgError extends Error {
  readonly code: string | null

  constructor(error: unknown) {
    const described = describePgError(error)
    super(described.message)
    this.name = 'PgError'
    this.code = described.code
  }
}

export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to PostgreSQL was closed. Run again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}
