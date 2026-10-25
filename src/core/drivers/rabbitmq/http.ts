import { Agent as HttpAgent, request as httpRequest, type IncomingMessage } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import { ManagementError, describeNetworkError, describeResponse } from './errors'

const MAX_RESPONSE_BYTES = 64 * 1024 * 1024

export interface ManagementTarget {
  /** Where the API starts, ending in `/`: `http://host:15672/`. Calls go to `<base>api/...`. */
  baseUrl: URL
  username?: string
  password?: string
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
  allowInvalidCertificates?: boolean
}

export interface RequestOptions {
  body?: unknown
  query?: Record<string, string | number | boolean | undefined>
  signal: AbortSignal
  /** What the call is about, for a "was not found" message. */
  what?: string
  /** Answers other than these statuses are errors. Defaults to any 2xx. */
  timeoutMs?: number
}

const abortError = (): Error => new DOMException('The request was cancelled', 'AbortError')

/**
 * A small JSON client for the RabbitMQ management API, on Node's own HTTP: no dependency, TLS options
 * as for the other drivers, and a connection kept open between calls. Every call can be cancelled.
 */
export class ManagementClient {
  private readonly agent: HttpAgent | HttpsAgent
  private readonly secure: boolean
  private closed = false

  constructor(
    private readonly target: ManagementTarget,
    private readonly defaults: { timeoutMs?: number } = {},
  ) {
    this.secure = target.baseUrl.protocol === 'https:'
    this.agent = this.secure
      ? new HttpsAgent({
          keepAlive: true,
          maxSockets: 6,
          rejectUnauthorized: target.allowInvalidCertificates !== true,
          ...(target.ca ? { ca: target.ca } : {}),
          ...(target.cert ? { cert: target.cert } : {}),
          ...(target.key ? { key: target.key } : {}),
        })
      : new HttpAgent({ keepAlive: true, maxSockets: 6 })
  }

  get base(): URL {
    return this.target.baseUrl
  }

  close(): void {
    this.closed = true
    this.agent.destroy()
  }

  get<T>(path: string, options: RequestOptions): Promise<T> {
    return this.request<T>('GET', path, options)
  }

  post<T>(path: string, options: RequestOptions): Promise<T> {
    return this.request<T>('POST', path, options)
  }

  put<T>(path: string, options: RequestOptions): Promise<T> {
    return this.request<T>('PUT', path, options)
  }

  delete<T>(path: string, options: RequestOptions): Promise<T> {
    return this.request<T>('DELETE', path, options)
  }

  private urlFor(path: string, query: RequestOptions['query']): URL {
    const url = new URL(`api/${path}`, this.target.baseUrl)
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value))
    }
    return url
  }

  /** One call. The path is the part after `api/`, with every name already escaped. */
  request<T>(method: string, path: string, options: RequestOptions): Promise<T> {
    const { signal } = options
    return new Promise<T>((resolve, reject) => {
      if (this.closed)
        return reject(
          new ManagementError('The connection to RabbitMQ was closed.', 'CONNECTION_CLOSED'),
        )
      if (signal.aborted) return reject(abortError())

      const url = this.urlFor(path, options.query)
      const body =
        options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body))
      // The purge call offers no JSON and answers 406 to a client that asks for nothing else.
      const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' }
      if (this.target.username !== undefined) {
        const login = `${this.target.username}:${this.target.password ?? ''}`
        headers.Authorization = `Basic ${Buffer.from(login).toString('base64')}`
      }
      if (body) {
        headers['Content-Type'] = 'application/json'
        headers['Content-Length'] = String(body.length)
      }

      const send = this.secure ? httpsRequest : httpRequest
      const req = send(url, { method, headers, agent: this.agent }, (response: IncomingMessage) => {
        const chunks: Buffer[] = []
        let size = 0
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > MAX_RESPONSE_BYTES) {
            req.destroy(
              new ManagementError('The broker’s answer is too large to read.', 'TOO_LARGE'),
            )
            return
          }
          chunks.push(chunk)
        })
        response.on('error', fail)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown
          if (text !== '') {
            try {
              parsed = JSON.parse(text)
            } catch {
              parsed = undefined
              if ((response.statusCode ?? 0) < 400) {
                return fail(
                  new ManagementError(
                    'The broker’s answer was not JSON. Is this the management API?',
                    'BAD_RESPONSE',
                  ),
                )
              }
            }
          }
          const status = response.statusCode ?? 0
          if (status >= 200 && status < 300) return finish(() => resolve(parsed as T))
          const described = describeResponse(status, parsed, options.what ?? 'That')
          finish(() =>
            reject(
              new ManagementError(described.message, described.code, status, described.reason),
            ),
          )
        })
      })

      const timer = setTimeout(
        () => req.destroy(new ManagementError(`No answer from ${url.host} in time.`, 'TIMEOUT')),
        options.timeoutMs ?? this.defaults.timeoutMs ?? 20_000,
      )
      const onAbort = (): void => {
        req.destroy(abortError())
      }
      signal.addEventListener('abort', onAbort, { once: true })

      let done = false
      const finish = (action: () => void): void => {
        if (done) return
        done = true
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        action()
      }
      const fail = (error: unknown): void =>
        finish(() => {
          if (signal.aborted) return reject(abortError())
          if (error instanceof ManagementError) return reject(error)
          const described = describeNetworkError(error, url)
          reject(new ManagementError(described.message, described.code))
        })
      req.on('error', fail)
      req.end(body)
    })
  }
}
