interface MssqlErrorLike {
  code?: string
  number?: number
  message?: string
  originalError?: { message?: string; info?: { number?: number } }
}

export interface DescribedError {
  code: string | null
  message: string
}

export function describeMssqlError(error: unknown): DescribedError {
  const e = (error ?? {}) as MssqlErrorLike
  const server = e.originalError?.message ?? e.message ?? String(error)
  const number = e.number ?? e.originalError?.info?.number
  const code = number ? `MSSQL_${number}` : (e.code ?? null)
  switch (e.code) {
    case 'ELOGIN':
      return {
        code: e.code,
        message: `${server}. Check the username, the password and the database.`,
      }
    case 'ETIMEOUT':
    case 'ESOCKET':
      return { code: e.code, message: `${server}. The server could not be reached from here.` }
    case 'ECANCEL':
      return { code: e.code, message: 'The query was cancelled.' }
    default:
      return { code, message: server }
  }
}

export class MssqlError extends Error {
  readonly code: string | null

  constructor(error: unknown) {
    const described = describeMssqlError(error)
    super(described.message)
    this.name = 'MssqlError'
    this.code = described.code
  }
}

export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to SQL Server was closed. Run again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}
