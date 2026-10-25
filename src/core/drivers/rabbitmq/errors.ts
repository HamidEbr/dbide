/** A failure of a call to the management API, with the broker's own reason when it gave one. */
export class ManagementError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number | null = null,
    /** The broker's `reason`, untouched. */
    readonly reason: string | null = null,
  ) {
    super(message)
    this.name = 'ManagementError'
  }
}

/** Raised for a session that was closed; the caller should reconnect. */
export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to RabbitMQ was closed. Open it again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}

interface BodyLike {
  error?: unknown
  reason?: unknown
}

/** Turns a failed response into a sentence that says what to do about it, keeping the broker's words. */
export function describeResponse(
  status: number,
  body: unknown,
  what: string,
): { message: string; code: string; reason: string | null } {
  const { error, reason } = (typeof body === 'object' && body !== null ? body : {}) as BodyLike
  const said =
    typeof reason === 'string' && reason !== '' ? reason : typeof error === 'string' ? error : null
  switch (status) {
    case 401: {
      // The broker uses 401 both for a login it refused and for an action this login may not take.
      // 3.x and 4.x word a refused login `Not_Authorized` (older ones `Login failed`); a refused action is `Access refused.`.
      const login = said === null || /^(login failed|not_authorized)$/i.test(said.trim())
      return login
        ? {
            code: 'UNAUTHORIZED',
            reason: said,
            message:
              'RabbitMQ refused the login. Check the username and password; the user also needs the management tag to use the management API.',
          }
        : {
            code: 'FORBIDDEN',
            reason: said,
            message: `${said.replace(/[.\s]+$/, '')}. This user may not do that.`,
          }
    }
    case 403:
      return {
        code: 'FORBIDDEN',
        reason: said,
        message: `${said ?? 'Not allowed'}. This user needs the management tag (or monitoring, for reading) and permissions on the vhost.`,
      }
    case 404:
      return {
        code: 'NOT_FOUND',
        reason: said,
        message: `${what} was not found${said && !/not found/i.test(said) ? `: ${said}` : ''}.`,
      }
    case 405:
    case 501:
      return {
        code: 'NOT_SUPPORTED',
        reason: said,
        message: `The broker doesn’t support that here. ${said ?? ''}`.trim(),
      }
    default:
      return {
        code: status === 400 ? 'BAD_REQUEST' : 'BROKER_ERROR',
        reason: said,
        message: said ?? `The broker answered ${status}.`,
      }
  }
}

/** Network failures, said the way a person would check them. */
export function describeNetworkError(error: unknown, url: URL): { message: string; code: string } {
  const code = (error as { code?: string } | null)?.code
  const where = `${url.protocol}//${url.host}`
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ECONNREFUSED':
      return {
        code: 'UNREACHABLE',
        message: `Nothing answered at ${where}. DBIDE talks to RabbitMQ through its management API, which needs the management plugin (rabbitmq-plugins enable rabbitmq_management) and its port (15672) open. Set another address in the connection’s RabbitMQ settings if it is elsewhere.`,
      }
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return {
        code: 'UNREACHABLE',
        message: `Couldn’t resolve “${url.hostname}”. Check the spelling and your DNS or VPN.`,
      }
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return {
        code: 'UNREACHABLE',
        message: `No answer from ${where}. A firewall or a missing VPN is the usual cause.`,
      }
    case 'ECONNRESET':
    case 'EPIPE':
      return { code: 'CONNECTION_CLOSED', message: `The connection to ${where} was closed.` }
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return {
        code: 'TLS_ERROR',
        message: `${message}. Check the TLS settings for this connection (a CA, or allow invalid certificates for local use).`,
      }
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'EPROTO':
      return {
        code: 'TLS_ERROR',
        message: `${where} doesn’t speak ${url.protocol === 'https:' ? 'TLS' : 'plain HTTP'} on this port. Turn TLS ${url.protocol === 'https:' ? 'off' : 'on'}, or set the management address.`,
      }
    default:
      return { code: code ?? 'NETWORK_ERROR', message }
  }
}
