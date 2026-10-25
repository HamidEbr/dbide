import { describe, expect, it } from 'vitest'
import { emptyTls } from '@shared/connection'
import { exchangeSegment, managementBase, segment } from './url'

const config = (
  overrides: { host?: string; tls?: boolean; options?: Record<string, string> } = {},
) => ({
  host: overrides.host ?? 'mq.internal',
  tls: { ...emptyTls(), enabled: overrides.tls === true },
  options: overrides.options ?? {},
})

describe('managementBase', () => {
  it('is the management port on the same host, plain or over TLS', () => {
    expect(managementBase(config()).href).toBe('http://mq.internal:15672/')
    expect(managementBase(config({ tls: true })).href).toBe('https://mq.internal:15671/')
  })

  it('takes another port, or a whole address when the broker is behind a proxy', () => {
    expect(managementBase(config({ options: { managementPort: '8080' } })).href).toBe(
      'http://mq.internal:8080/',
    )
    expect(
      managementBase(config({ options: { managementUrl: 'https://rabbit.corp/mq' } })).href,
    ).toBe('https://rabbit.corp/mq/')
    expect(managementBase(config({ options: { managementUrl: 'rabbit.corp:15672' } })).href).toBe(
      'http://rabbit.corp:15672/',
    )
    expect(managementBase(config({ options: { managementUrl: '  ' } })).href).toBe(
      'http://mq.internal:15672/',
    )
  })

  it('never keeps a login written into the address', () => {
    const url = managementBase(
      config({ options: { managementUrl: 'https://user:secret@rabbit.corp/' } }),
    )
    expect(url.href).toBe('https://rabbit.corp/')
  })

  it('brackets an IPv6 host', () => {
    expect(managementBase(config({ host: '::1' })).href).toBe('http://[::1]:15672/')
  })
})

describe('path segments', () => {
  it('escape the slash that is the name of the default vhost, and everything else odd', () => {
    expect(segment('/')).toBe('%2F')
    expect(segment('a b/c#d')).toBe('a%20b%2Fc%23d')
  })

  it('call the nameless default exchange amq.default', () => {
    expect(exchangeSegment('')).toBe('amq.default')
    expect(exchangeSegment('orders')).toBe('orders')
  })
})
