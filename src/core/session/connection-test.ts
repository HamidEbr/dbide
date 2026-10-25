import { readFile } from 'node:fs/promises'
import { lookup, resolveSrv } from 'node:dns/promises'
import { connect as tcpConnect, isIP } from 'node:net'
import { connect as tlsConnect, type TLSSocket } from 'node:tls'
import type { ConnectionConfig, ConnectionSecrets, TestStep, TestStepId } from '@shared/connection'
import type { DriverRegistry } from '../drivers/registry'

const STEP_LABELS: Record<TestStepId, string> = {
  ssh: 'SSH tunnel',
  dns: 'Resolve host',
  tcp: 'Open connection',
  tls: 'TLS handshake',
  auth: 'Authenticate',
}

const STEP_ORDER: readonly TestStepId[] = ['ssh', 'dns', 'tcp', 'tls', 'auth']

export interface ConnectionTestOptions {
  drivers: DriverRegistry
  signal?: AbortSignal
  /** Per step. */
  timeoutMs?: number
}

class StepFailure extends Error {}
class StepSkipped extends Error {}

/** Turns Node's network errors into sentences that say what to check next. */
export function explainNetworkError(error: unknown, host: string, port: number): string {
  const code = (error as { code?: string }).code
  const message = error instanceof Error ? error.message : String(error)
  switch (code) {
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return `Couldn't resolve "${host}". Check the spelling and your DNS or VPN.`
    case 'ECONNREFUSED':
      return `${host}:${port} refused the connection. Is the server running, and is the port right?`
    case 'ETIMEDOUT':
    case 'ABORT_TIMEOUT':
      return `No answer from ${host}:${port}. A firewall or a missing VPN or SSH tunnel is the usual cause.`
    case 'ABORTED':
      return 'The test was cancelled.'
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return `${host} is unreachable from this machine. Check your network or VPN.`
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'SELF_SIGNED_CERT_IN_CHAIN':
      return 'The server uses a self-signed certificate. Add its CA, or allow invalid certificates for local use.'
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
      return "The certificate chain can't be verified. Add the issuing CA in the TLS settings."
    case 'CERT_HAS_EXPIRED':
      return "The server's certificate has expired."
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
      return `The certificate isn't valid for "${host}". Connect with the name on the certificate.`
    case 'ERR_SSL_WRONG_VERSION_NUMBER':
      return `${host}:${port} doesn't speak TLS on this port. Turn TLS off, or use the TLS port.`
    default:
      return message
  }
}

async function timed<T>(
  steps: TestStep[],
  id: TestStepId,
  run: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const started = performance.now()
  const record = (status: TestStep['status'], detail?: string): void => {
    steps.push({
      id,
      label: STEP_LABELS[id],
      status,
      durationMs: Math.round(performance.now() - started),
      ...(detail ? { detail } : {}),
    })
  }
  try {
    const value = await run()
    record('ok', typeof value === 'string' ? value : undefined)
    return { ok: true, value }
  } catch (error) {
    if (error instanceof StepSkipped) {
      record('skipped', error.message)
      return { ok: true, value: undefined as T }
    }
    record('failed', error instanceof StepFailure ? error.message : String(error))
    return { ok: false }
  }
}

/** Runs `callback` when the signal aborts, including when it already has. */
function whenAborted(signal: AbortSignal, callback: () => void): void {
  if (signal.aborted) callback()
  else signal.addEventListener('abort', callback, { once: true })
}

/** A timeout and a cancel by the caller look different to the user. */
function abortError(signal: AbortSignal): Error {
  const timedOut = (signal.reason as { name?: string } | undefined)?.name === 'TimeoutError'
  return Object.assign(new Error(timedOut ? 'Timed out' : 'Cancelled'), {
    code: timedOut ? 'ABORT_TIMEOUT' : 'ABORTED',
  })
}

/** The promise's answer, or the signal's abort if that comes first. The work behind the promise is left to finish. */
function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    whenAborted(signal, () => reject(abortError(signal)))
    promise.then(resolve, reject)
  })
}

function stepSignal(options: ConnectionTestOptions): AbortSignal {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000)
  return options.signal ? AbortSignal.any([options.signal, timeout]) : timeout
}

function openSocket(
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<{ close: () => void }> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect({ host, port })
    const fail = (error: unknown): void => {
      socket.destroy()
      reject(error)
    }
    whenAborted(signal, () => fail(abortError(signal)))
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.removeListener('error', fail)
      resolve({ close: () => socket.destroy() })
    })
  })
}

async function handshakeTls(
  config: ConnectionConfig,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<string> {
  const [ca, cert, key] = await Promise.all([
    config.tls.caPath ? readFile(config.tls.caPath) : undefined,
    config.tls.certPath ? readFile(config.tls.certPath) : undefined,
    config.tls.keyPath ? readFile(config.tls.keyPath) : undefined,
  ])
  return new Promise((resolve, reject) => {
    const socket: TLSSocket = tlsConnect({
      host,
      port,
      ...(isIP(host) ? {} : { servername: host }),
      rejectUnauthorized: !config.tls.allowInvalidCertificates,
      ...(ca ? { ca } : {}),
      ...(cert ? { cert } : {}),
      ...(key ? { key } : {}),
    })
    const fail = (error: unknown): void => {
      socket.destroy()
      reject(error)
    }
    whenAborted(signal, () => fail(abortError(signal)))
    socket.once('error', fail)
    socket.once('secureConnect', () => {
      const certificate = socket.getPeerCertificate()
      const subject = certificate.subject?.CN ?? 'unknown subject'
      const verified = socket.authorized ? '' : ' (certificate not verified)'
      const detail = `${socket.getProtocol() ?? 'TLS'}, ${subject}, expires ${certificate.valid_to}${verified}`
      socket.destroy()
      resolve(detail)
    })
  })
}

/**
 * Walks DNS → TCP → TLS → auth and reports each step, so a failure names the layer that broke
 * instead of one opaque "connection failed". After the first failure the remaining steps are
 * reported as skipped.
 */
export async function testConnection(
  config: ConnectionConfig,
  secrets: ConnectionSecrets,
  options: ConnectionTestOptions,
): Promise<TestStep[]> {
  const steps: TestStep[] = []
  const driver = options.drivers.get(config.engine)
  const probe = driver.testEndpoint?.(config)
  let host = probe?.host ?? config.host
  let port = probe?.port ?? config.port
  const tlsOn = probe?.tls ?? config.tls.enabled

  const sshEnabled = config.ssh?.enabled === true
  if (sshEnabled) {
    // The tunnel itself lands later in M0; fail clearly instead of testing the wrong path.
    steps.push({
      id: 'ssh',
      label: STEP_LABELS.ssh,
      status: 'failed',
      durationMs: 0,
      detail: 'SSH tunnels are not available yet. Turn the tunnel off to test a direct connection.',
    })
  } else {
    const dns = await timed(steps, 'dns', async () => {
      if (isIP(host)) throw new StepSkipped('Host is an IP address, nothing to resolve')
      const signal = stepSignal(options)
      // A resolver that never answers must not hold the test for as long as the system would wait.
      const explain = (error: unknown): StepFailure =>
        new StepFailure(
          (error as { code?: string } | null)?.code === 'ABORT_TIMEOUT'
            ? `DNS didn’t answer for “${host}” in time. Check your network, DNS or VPN.`
            : explainNetworkError(error, host, port),
        )
      if (config.options.srv === 'true') {
        const records = await untilAborted(resolveSrv(`_mongodb._tcp.${host}`), signal).catch(
          (error: unknown) => {
            throw explain(error)
          },
        )
        const first = records[0]
        if (!first) throw new StepFailure(`No SRV records for _mongodb._tcp.${host}`)
        host = first.name
        port = first.port
        return `${records.length} SRV record(s), first: ${host}:${port}`
      }
      const addresses = await untilAborted(lookup(host, { all: true }), signal).catch(
        (error: unknown) => {
          throw explain(error)
        },
      )
      return addresses.map((a) => a.address).join(', ')
    })

    if (dns.ok) {
      const tcp = await timed(steps, 'tcp', async () => {
        const socket = await openSocket(host, port, stepSignal(options)).catch((error: unknown) => {
          throw new StepFailure(explainNetworkError(error, host, port))
        })
        socket.close()
        return `Reached ${host}:${port}`
      })

      if (tcp.ok) {
        await timed(steps, 'tls', async () => {
          if (!tlsOn) throw new StepSkipped('TLS is off for this connection')
          if (driver.descriptor.tlsMode === 'upgrade') {
            throw new StepSkipped(
              `${driver.descriptor.displayName} negotiates TLS during login, so it is checked with authentication`,
            )
          }
          return handshakeTls(config, host, port, stepSignal(options)).catch((error: unknown) => {
            throw new StepFailure(explainNetworkError(error, host, port))
          })
        })
      }
    }
  }

  const failed = steps.some((step) => step.status === 'failed')
  if (failed) {
    steps.push({
      id: 'auth',
      label: STEP_LABELS.auth,
      status: 'skipped',
      durationMs: 0,
      detail: 'Skipped because an earlier step failed',
    })
  } else {
    await timed(steps, 'auth', async () => {
      if (!driver.descriptor.implemented) {
        throw new StepSkipped(
          `Login check arrives with the ${driver.descriptor.displayName} driver`,
        )
      }
      const session = await driver
        .connect({ config, secrets, endpoint: { host, port }, signal: stepSignal(options) })
        .catch((error: unknown) => {
          throw new StepFailure(error instanceof Error ? error.message : String(error))
        })
      try {
        await session.ping()
      } finally {
        await session.close()
      }
      return 'Logged in'
    })
  }

  // Stable order for the UI regardless of which steps ran.
  const order = (id: TestStepId): number => STEP_ORDER.indexOf(id)
  const backfilled: TestStep[] = []
  for (const id of STEP_ORDER) {
    const step = steps.find((s) => s.id === id)
    if (step) backfilled.push(step)
    else if (id !== 'ssh') {
      backfilled.push({
        id,
        label: STEP_LABELS[id],
        status: 'skipped',
        durationMs: 0,
        detail: 'Skipped because an earlier step failed',
      })
    }
  }
  return backfilled.sort((a, b) => order(a.id) - order(b.id))
}
