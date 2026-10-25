import type { HostApi } from '@shared/api'
import type { RpcClient } from '@shared/rpc'

/** Secrets live in the main process (OS keychain). The core only ever asks for them by key. */
export interface SecretsClient {
  available(): Promise<boolean>
  get(key: string): Promise<string | null>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

export function createHostSecrets(host: Promise<RpcClient<HostApi>>): SecretsClient {
  return {
    available: async () => (await host).call('secrets.available', undefined),
    get: async (key) => (await host).call('secrets.get', { key }),
    set: async (key, value) => (await host).call('secrets.set', { key, value }),
    delete: async (key) => (await host).call('secrets.delete', { key }),
  }
}

/** In-memory implementation for tests. */
export function createMemorySecrets(initial: Record<string, string> = {}): SecretsClient {
  const store = new Map(Object.entries(initial))
  return {
    available: () => Promise.resolve(true),
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value)
      return Promise.resolve()
    },
    delete: (key) => {
      store.delete(key)
      return Promise.resolve()
    },
  }
}
