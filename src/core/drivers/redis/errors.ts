/** A failure talking to Redis, said so a person can act on it. `reply` keeps the server's own words. */
export class RedisFailure extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly reply: string | null = null,
  ) {
    super(message)
    this.name = 'RedisFailure'
  }
}

/** Raised for a session that was closed; the caller should reconnect. */
export class SessionClosedError extends Error {
  readonly code = 'CONNECTION_CLOSED'

  constructor(message = 'The connection to Redis was closed. Open it again to reconnect.') {
    super(message)
    this.name = 'SessionClosedError'
  }
}

const isReplyError = (error: unknown): error is Error =>
  error instanceof Error && error.name === 'ReplyError'

/** What the server said, without the `ERR ` that starts most of its errors. */
const said = (message: string): string => message.replace(/^ERR\s+/, '').replace(/[.\s]+$/, '')

/** Turns anything a Redis client throws into an error that says what to do. Already-described errors pass through. */
export function describeRedisError(error: unknown, where: string): Error {
  if (error instanceof RedisFailure || error instanceof SessionClosedError) return error
  // A client that gave up on several nodes reports them together; the first is the one to show.
  if (error instanceof Error && 'errors' in error && Array.isArray(error.errors)) {
    const [first] = error.errors as unknown[]
    if (first) return describeRedisError(first, where)
  }
  if (isReplyError(error)) return describeReply(error.message)

  const code = (error as { code?: string } | null)?.code
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ECONNREFUSED':
      return new RedisFailure(
        `Nothing answered at ${where}. Check that Redis is running there, and the host and port.`,
        'UNREACHABLE',
      )
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new RedisFailure(
        `Couldn’t resolve the host of ${where}. Check the spelling and your DNS or VPN.`,
        'UNREACHABLE',
      )
    case 'ETIMEDOUT':
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new RedisFailure(
        `No answer from ${where}. A firewall or a missing VPN is the usual cause.`,
        'UNREACHABLE',
      )
    case 'ECONNRESET':
    case 'EPIPE':
      return new RedisFailure(`The connection to ${where} was closed.`, 'CONNECTION_CLOSED')
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'CERT_HAS_EXPIRED':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return new RedisFailure(
        `${message}. Check the TLS settings for this connection (a CA, or allow invalid certificates for local use).`,
        'TLS_ERROR',
      )
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
    case 'EPROTO':
      return new RedisFailure(
        `${where} doesn’t speak TLS on this port. Turn TLS off for this connection, or use the TLS port.`,
        'TLS_ERROR',
      )
  }
  if (/connection is closed/i.test(message)) return new SessionClosedError()
  if (/failed to refresh slots cache/i.test(message)) {
    return new RedisFailure(
      `Couldn’t read the cluster layout from ${where}. Check that it is a cluster node and the other nodes are reachable from here.`,
      'UNREACHABLE',
    )
  }
  if (/all sentinels are unreachable/i.test(message)) {
    return new RedisFailure(
      `No Sentinel answered, so the primary can’t be found. Check the Sentinel addresses and the master name.`,
      'UNREACHABLE',
    )
  }
  if (/max retries per request/i.test(message) || /command timed out/i.test(message)) {
    return new RedisFailure(`${where} didn’t answer in time.`, 'TIMEOUT')
  }
  return error instanceof Error ? error : new Error(message)
}

/** An error reply, with the advice that goes with the common ones. */
function describeReply(reply: string): RedisFailure {
  const prefix = reply.split(' ')[0] ?? ''
  const rest = reply.slice(prefix.length).trim()
  switch (prefix) {
    case 'WRONGTYPE':
      return new RedisFailure(
        'That key holds a different kind of value than this change expects.',
        'WRONG_TYPE',
        reply,
      )
    case 'NOAUTH':
      return new RedisFailure(
        'The server needs a password. Add it in the connection’s settings.',
        'UNAUTHORIZED',
        reply,
      )
    case 'WRONGPASS':
      return new RedisFailure(
        'Redis refused the login. Check the password, and the username: a username is only for servers with ACL users (Redis 6 and newer).',
        'UNAUTHORIZED',
        reply,
      )
    case 'NOPERM':
      return new RedisFailure(
        `This user may not do that (${rest.replace(/[.\s]+$/, '')}). Connect with a user whose ACL allows it.`,
        'FORBIDDEN',
        reply,
      )
    case 'READONLY':
      return new RedisFailure(
        'This server is a read-only replica. Connect to the primary to change data.',
        'REPLICA',
        reply,
      )
    case 'OOM':
      return new RedisFailure(
        'The server is out of memory (its maxmemory limit), so it refuses commands that add data.',
        'OUT_OF_MEMORY',
        reply,
      )
    case 'LOADING':
      return new RedisFailure(
        'The server is still loading its data. Try again in a moment.',
        'LOADING',
        reply,
      )
    case 'CROSSSLOT':
      return new RedisFailure(
        'Those keys live in different cluster slots, so one command can’t use both.',
        'CROSSSLOT',
        reply,
      )
    case 'BUSYKEY':
      return new RedisFailure('A key with that name already exists.', 'EXISTS', reply)
    case 'NOGROUP':
      return new RedisFailure('That consumer group doesn’t exist any more.', 'NOT_FOUND', reply)
    case 'ERR':
      if (/unknown command|unknown subcommand/i.test(rest)) {
        return new RedisFailure(
          `This server doesn’t support that command (${said(reply)}).`,
          'NOT_SUPPORTED',
          reply,
        )
      }
      if (/no such key/i.test(rest)) {
        return new RedisFailure('That key doesn’t exist any more.', 'NOT_FOUND', reply)
      }
      return new RedisFailure(`${said(reply)}.`, 'REDIS_ERROR', reply)
    default:
      return new RedisFailure(reply, 'REDIS_ERROR', reply)
  }
}

/** Whether a server error says it doesn't know the command or option, so an older server needs another way. */
export function isUnsupported(error: unknown): boolean {
  return (
    isReplyError(error) &&
    /unknown command|unknown subcommand|syntax error|wrong number of arguments|unsupported/i.test(
      error.message,
    )
  )
}
