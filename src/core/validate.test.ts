import { describe, expect, it } from 'vitest'
import { newConnectionDraft } from '@shared/connection'
import {
  validateConnectionConfig,
  validateEditBatch,
  validateSecrets,
  validateSettingsPatch,
} from './validate'

const valid = () => ({ ...newConnectionDraft('redis', 'id-1'), name: 'Cache' })

describe('validateConnectionConfig', () => {
  it('accepts a well-formed connection', () => {
    expect(validateConnectionConfig(valid())).toMatchObject({
      id: 'id-1',
      engine: 'redis',
      port: 6379,
    })
  })

  it('trims name and host', () => {
    const config = validateConnectionConfig({ ...valid(), name: '  Cache ', host: ' h ' })
    expect(config).toMatchObject({ name: 'Cache', host: 'h' })
  })

  it('drops fields it does not know', () => {
    const config = validateConnectionConfig({ ...valid(), password: 'leak', extra: 1 })
    expect(config).not.toHaveProperty('password')
    expect(config).not.toHaveProperty('extra')
  })

  it.each([
    ['empty name', { name: '   ' }],
    ['unknown engine', { engine: 'postgres' }],
    ['unknown environment', { environment: 'qa' }],
    ['empty host', { host: '' }],
    ['port zero', { port: 0 }],
    ['port too large', { port: 70000 }],
    ['fractional port', { port: 1.5 }],
    ['string port', { port: '6379' }],
    ['missing tls', { tls: undefined }],
    ['non-text option', { options: { a: 1 } }],
  ])('rejects %s', (_label, patch) => {
    expect(() => validateConnectionConfig({ ...valid(), ...patch })).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects non-objects', () => {
    expect(() => validateConnectionConfig(null)).toThrow()
    expect(() => validateConnectionConfig('x')).toThrow()
    expect(() => validateConnectionConfig([])).toThrow()
  })

  it('validates an SSH block when present', () => {
    const ssh = { enabled: true, host: 'bastion', port: 22, username: 'me', auth: 'agent' }
    expect(validateConnectionConfig({ ...valid(), ssh }).ssh).toMatchObject(ssh)
    expect(() =>
      validateConnectionConfig({ ...valid(), ssh: { ...ssh, auth: 'telepathy' } }),
    ).toThrow()
  })
})

describe('validateSecrets', () => {
  it('treats missing secrets as empty', () => {
    expect(validateSecrets(undefined)).toEqual({})
    expect(validateSecrets(null)).toEqual({})
  })

  it('keeps only known secret names', () => {
    expect(validateSecrets({ password: 'p', other: 'x' })).toEqual({ password: 'p' })
  })

  it('rejects non-text secrets', () => {
    expect(() => validateSecrets({ password: 5 })).toThrow()
  })
})

describe('validateSettingsPatch', () => {
  it('accepts known settings', () => {
    expect(
      validateSettingsPatch({ theme: 'dark', density: 'compact', navigatorOpen: false }),
    ).toEqual({
      theme: 'dark',
      density: 'compact',
      navigatorOpen: false,
    })
  })

  it('rejects unknown keys and bad values', () => {
    expect(() => validateSettingsPatch({ colour: 'red' })).toThrow(/Unknown setting/)
    expect(() => validateSettingsPatch({ theme: 'neon' })).toThrow()
    expect(() => validateSettingsPatch({ inspectorOpen: 'yes' })).toThrow()
  })
})

describe('validateEditBatch', () => {
  const ok = {
    schema: 'shop',
    table: 'orders',
    changes: [
      {
        kind: 'update',
        key: { id: 1 },
        values: { note: 'x', blob: new Uint8Array([1]), gone: null },
      },
      { kind: 'delete', key: { id: 2 } },
      { kind: 'insert', values: {} },
    ],
  }

  it('accepts updates, deletes, and inserts, including an insert of pure defaults', () => {
    expect(validateEditBatch(ok).changes.map((c) => c.kind)).toEqual(['update', 'delete', 'insert'])
  })

  it.each([
    ['no changes', { ...ok, changes: [] }],
    ['no table', { ...ok, table: '' }],
    ['an unknown kind', { ...ok, changes: [{ kind: 'truncate' }] }],
    [
      'an update without a key',
      { ...ok, changes: [{ kind: 'update', key: {}, values: { a: 1 } }] },
    ],
    [
      'an update without values',
      { ...ok, changes: [{ kind: 'update', key: { id: 1 }, values: {} }] },
    ],
    ['a delete without a key', { ...ok, changes: [{ kind: 'delete', key: {} }] }],
    ['an object value', { ...ok, changes: [{ kind: 'delete', key: { id: { $ne: 1 } } }] }],
    ['a non-finite number', { ...ok, changes: [{ kind: 'insert', values: { a: Number.NaN } }] }],
    ['an empty column name', { ...ok, changes: [{ kind: 'insert', values: { '': 1 } }] }],
    ['a changes list that is not a list', { ...ok, changes: 'all' }],
  ])('rejects %s', (_label, input) => {
    expect(() => validateEditBatch(input)).toThrow(
      expect.objectContaining({ code: 'INVALID_INPUT' }),
    )
  })

  it('rejects too many changes at once', () => {
    const changes = Array.from({ length: 5001 }, (_, i) => ({ kind: 'delete', key: { id: i } }))
    expect(() => validateEditBatch({ ...ok, changes })).toThrow(/Too many/)
  })

  it('drops fields it does not know', () => {
    const batch = validateEditBatch({
      ...ok,
      extra: 1,
      changes: [{ kind: 'delete', key: { id: 1 }, where: '1=1' }],
    })
    expect(batch).not.toHaveProperty('extra')
    expect(batch.changes[0]).toEqual({ kind: 'delete', key: { id: 1 } })
  })
})
