import type { KeyspaceEntry, RedisInfo } from '@shared/redis/types'

/** INFO's text as sections of name and value. */
export function parseInfo(text: string): Record<string, Record<string, string>> {
  const sections: Record<string, Record<string, string>> = {}
  let current = 'default'
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '') continue
    if (line.startsWith('#')) {
      current = line.slice(1).trim().toLowerCase()
      sections[current] ??= {}
      continue
    }
    const at = line.indexOf(':')
    if (at <= 0) continue
    ;(sections[current] ??= {})[line.slice(0, at)] = line.slice(at + 1)
  }
  return sections
}

const find = (
  sections: Record<string, Record<string, string>>,
  name: string,
): string | undefined => {
  for (const section of Object.values(sections)) if (name in section) return section[name]
  return undefined
}
const number = (sections: Record<string, Record<string, string>>, name: string): number => {
  const n = Number(find(sections, name))
  return Number.isFinite(n) ? n : 0
}
const maybe = (sections: Record<string, Record<string, string>>, name: string): number | null => {
  const n = Number(find(sections, name))
  return find(sections, name) !== undefined && Number.isFinite(n) ? n : null
}

/** The server's numbers, ready for the dashboard. */
export function toInfo(
  sections: Record<string, Record<string, string>>,
  databases: number | null,
): RedisInfo {
  const keyspace: KeyspaceEntry[] = []
  for (const [name, value] of Object.entries(sections.keyspace ?? {})) {
    const db = /^db(\d+)$/.exec(name)
    if (!db) continue
    const fields = Object.fromEntries(
      value.split(',').map((part) => part.split('=') as [string, string]),
    )
    keyspace.push({
      db: Number(db[1]),
      keys: Number(fields.keys ?? 0),
      expires: Number(fields.expires ?? 0),
    })
  }
  keyspace.sort((a, b) => a.db - b.db)

  const hits = number(sections, 'keyspace_hits')
  const misses = number(sections, 'keyspace_misses')
  const valkey = find(sections, 'valkey_version')
  const dragonfly = find(sections, 'dragonfly_version')
  return {
    flavor: valkey ? 'Valkey' : dragonfly ? 'Dragonfly' : 'Redis',
    version: valkey ?? dragonfly ?? find(sections, 'redis_version') ?? 'unknown',
    mode: find(sections, 'redis_mode') ?? 'standalone',
    role: find(sections, 'role') ?? 'master',
    os: find(sections, 'os') ?? null,
    uptimeSeconds: number(sections, 'uptime_in_seconds'),
    connectedClients: number(sections, 'connected_clients'),
    blockedClients: number(sections, 'blocked_clients'),
    usedMemory: number(sections, 'used_memory'),
    usedMemoryPeak: number(sections, 'used_memory_peak'),
    maxMemory: number(sections, 'maxmemory'),
    usedMemoryRss: maybe(sections, 'used_memory_rss'),
    fragmentationRatio: maybe(sections, 'mem_fragmentation_ratio'),
    opsPerSec: number(sections, 'instantaneous_ops_per_sec'),
    totalCommands: number(sections, 'total_commands_processed'),
    keyspaceHits: hits,
    keyspaceMisses: misses,
    evictedKeys: number(sections, 'evicted_keys'),
    expiredKeys: number(sections, 'expired_keys'),
    inputKbps: number(sections, 'instantaneous_input_kbps'),
    outputKbps: number(sections, 'instantaneous_output_kbps'),
    keyspace,
    databases,
    replication: {
      role: find(sections, 'role') ?? 'master',
      connectedReplicas: number(sections, 'connected_slaves'),
      masterHost: find(sections, 'master_host') ?? null,
    },
    sections,
  }
}
