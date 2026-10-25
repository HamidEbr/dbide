import type { ConnectionConfig } from '@shared/connection'

/**
 * Where the management API of a broker is. A saved connection holds the AMQP address (`amqp://host:5672`),
 * and the API is a different port (15672, or 15671 over TLS) unless the connection says otherwise: a full
 * address in `managementUrl` (for a broker behind a proxy, or at a path), or just `managementPort`.
 */
export function managementBase(config: Pick<ConnectionConfig, 'host' | 'tls' | 'options'>): URL {
  const explicit = config.options.managementUrl?.trim()
  if (explicit) {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(explicit) ? explicit : `http://${explicit}`)
    if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
    // Credentials belong in the form's own fields, not in an address that is shown and saved in plain text.
    url.username = ''
    url.password = ''
    return url
  }
  const secure = config.tls.enabled
  const port = Number(config.options.managementPort) || (secure ? 15671 : 15672)
  const host =
    config.host.includes(':') && !config.host.startsWith('[') ? `[${config.host}]` : config.host
  return new URL(`${secure ? 'https' : 'http'}://${host}:${port}/`)
}

/** One part of an API path, with `/` and every other special character escaped. */
export const segment = (name: string): string => encodeURIComponent(name)

/** The default exchange has no name, so the API calls it `amq.default`. */
export const exchangeSegment = (name: string): string =>
  name === '' ? 'amq.default' : segment(name)
