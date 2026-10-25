import { readFile } from 'node:fs/promises'
import type { ConnectionConfig } from '@shared/connection'
import { DEFAULT_SEPARATOR } from '@shared/redis/types'

export type RedisMode = 'standalone' | 'sentinel' | 'cluster'

export interface HostPort {
  host: string
  port: number
}

/** How a saved connection reaches Redis, from its host, port and options. */
export interface RedisSetup {
  mode: RedisMode
  /** The database a standalone or Sentinel connection opens in. A cluster has only database 0. */
  db: number
  /** What splits a key into folders in the tree. */
  separator: string
  /** Sentinel: the name of the primary the sentinels watch. */
  master: string
  /** Sentinel: more sentinels besides the connection's own host and port. */
  sentinels: HostPort[]
}

/** `host:port, host:port` as a list. An address without a port gets the default one. */
export function parseHostList(text: string, defaultPort: number): HostPort[] {
  const out: HostPort[] = []
  for (const part of text.split(/[\s,]+/)) {
    if (!part) continue
    const bracketed = /^\[(.+)](?::(\d+))?$/.exec(part)
    if (bracketed) {
      out.push({ host: bracketed[1]!, port: bracketed[2] ? Number(bracketed[2]) : defaultPort })
      continue
    }
    const at = part.lastIndexOf(':')
    // More than one colon and no brackets is a bare IPv6 address.
    if (at > 0 && part.indexOf(':') === at && /^\d+$/.test(part.slice(at + 1))) {
      out.push({ host: part.slice(0, at), port: Number(part.slice(at + 1)) })
    } else {
      out.push({ host: part, port: defaultPort })
    }
  }
  return out
}

/** A database index, or 0 when the field is empty or isn't a whole number. */
export function dbIndex(database: string | undefined): number {
  const n = Number((database ?? '').trim())
  return Number.isInteger(n) && n >= 0 ? n : 0
}

export function redisSetup(config: ConnectionConfig): RedisSetup {
  const mode = config.options.mode
  return {
    mode: mode === 'sentinel' || mode === 'cluster' ? mode : 'standalone',
    db: mode === 'cluster' ? 0 : dbIndex(config.database),
    // `folders: off` keeps every key at the top level, with no separator at all.
    separator:
      config.options.folders === 'off' ? '' : config.options.separator || DEFAULT_SEPARATOR,
    master: config.options.master?.trim() || 'mymaster',
    sentinels: parseHostList(config.options.sentinels ?? '', 26379),
  }
}

export interface TlsFiles {
  ca?: Buffer
  cert?: Buffer
  key?: Buffer
}

export async function readTlsFiles(config: ConnectionConfig): Promise<TlsFiles> {
  if (!config.tls.enabled) return {}
  const [ca, cert, key] = await Promise.all([
    config.tls.caPath ? readFile(config.tls.caPath) : undefined,
    config.tls.certPath ? readFile(config.tls.certPath) : undefined,
    config.tls.keyPath ? readFile(config.tls.keyPath) : undefined,
  ])
  return { ...(ca ? { ca } : {}), ...(cert ? { cert } : {}), ...(key ? { key } : {}) }
}

const isIp = (host: string): boolean => /^[\d.]+$/.test(host) || host.includes(':')

/** The TLS options of the client, or undefined for a connection without TLS. */
export function tlsOptions(config: ConnectionConfig, files: TlsFiles, endpointHost: string) {
  if (!config.tls.enabled) return undefined
  // Through an SSH tunnel the client dials 127.0.0.1, but the certificate is for the real host.
  const servername = endpointHost !== config.host && !isIp(config.host) ? config.host : undefined
  return {
    ...files,
    rejectUnauthorized: !config.tls.allowInvalidCertificates,
    ...(servername ? { servername } : {}),
  }
}
