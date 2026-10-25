import { describe, expect, it } from 'vitest'
import {
  validateEdit,
  validateExec,
  validateMemory,
  validateRedisKey,
  validateRedisTarget,
  validateScan,
  validateTask,
  validateValueRequest,
} from './validate-redis'

const bad = (run: () => unknown): void => {
  expect(run).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }))
}

describe('Redis requests', () => {
  it('needs a connection and a database that is a small whole number', () => {
    expect(validateRedisTarget({ connectionId: 'c', db: 3 })).toEqual({ connectionId: 'c', db: 3 })
    bad(() => validateRedisTarget(null))
    bad(() => validateRedisTarget({ connectionId: '', db: 0 }))
    bad(() => validateRedisTarget({ connectionId: 'c', db: -1 }))
    bad(() => validateRedisTarget({ connectionId: 'c', db: 1.5 }))
    bad(() => validateRedisTarget({ connectionId: 'c', db: 70_000 }))
    bad(() => validateRedisKey({ connectionId: 'c', db: 0, key: '' }))
  })

  it('reads a scan, with defaults', () => {
    expect(
      validateScan({ connectionId: 'c', db: 0, pattern: '*', cursor: null, limit: 50 }),
    ).toEqual({
      connectionId: 'c',
      db: 0,
      pattern: '*',
      cursor: null,
      limit: 50,
    })
    expect(validateScan({ connectionId: 'c', db: 0, type: 'hash' })).toMatchObject({
      pattern: '',
      type: 'hash',
      cursor: null,
      limit: 200,
    })
    bad(() => validateScan({ connectionId: 'c', db: 0, limit: 0 }))
    bad(() => validateScan({ connectionId: 'c', db: 0, limit: 6000 }))
    bad(() => validateScan({ connectionId: 'c', db: 0, cursor: 5 }))
    bad(() => validateScan({ connectionId: 'c', db: 0, pattern: 'x'.repeat(20_000) }))
  })

  it('reads a value request, and bounds what it asks for', () => {
    const { request } = validateValueRequest({
      connectionId: 'c',
      db: 0,
      key: 'k',
      type: 'hash',
      match: 'a*',
    })
    expect(request).toMatchObject({ key: 'k', type: 'hash', count: 100, match: 'a*', cursor: null })
    bad(() =>
      validateValueRequest({ connectionId: 'c', db: 0, key: 'k', type: 'hash', count: 5000 }),
    )
    bad(() => validateValueRequest({ connectionId: 'c', db: 0, key: 'k' }))
  })

  it('limits the keys asked about in one call', () => {
    expect(validateMemory({ connectionId: 'c', db: 0, keys: ['a'] }).keys).toEqual(['a'])
    bad(() => validateMemory({ connectionId: 'c', db: 0, keys: [] }))
    bad(() => validateMemory({ connectionId: 'c', db: 0, keys: Array(501).fill('k') }))
  })

  it('needs a task id for a long task', () => {
    expect(
      validateTask({ connectionId: 'c', db: 0, pattern: 'a*', taskId: 't', writable: true }),
    ).toMatchObject({
      taskId: 't',
      writable: true,
    })
    bad(() => validateTask({ connectionId: 'c', db: 0, pattern: 'a*' }))
  })

  it('reads every kind of change, and refuses what it does not know', () => {
    expect(validateEdit({ op: 'string.set', value: '' })).toEqual({ op: 'string.set', value: '' })
    expect(validateEdit({ op: 'hash.set', field: 'f', value: 'v' })).toMatchObject({
      op: 'hash.set',
    })
    expect(validateEdit({ op: 'list.push', side: 'head', values: ['a'] })).toMatchObject({
      side: 'head',
    })
    expect(validateEdit({ op: 'zset.add', member: 'm', score: -Infinity })).toMatchObject({
      score: -Infinity,
    })
    expect(validateEdit({ op: 'stream.add', id: null, fields: [['a', 'b']] })).toMatchObject({
      id: null,
    })
    expect(validateEdit({ op: 'stream.add', id: '5-*', fields: [['a', 'b']] })).toMatchObject({
      id: '5-*',
    })
    expect(validateEdit({ op: 'ttl.set', ttlMs: 1000 })).toEqual({ op: 'ttl.set', ttlMs: 1000 })
    expect(
      validateEdit({ op: 'key.copy', newKey: 'n', overwrite: false, toDb: null }),
    ).toMatchObject({ toDb: null })
    expect(validateEdit({ op: 'key.delete' })).toEqual({ op: 'key.delete' })
    expect(validateEdit({ op: 'key.create', value: { type: 'set', member: 'a' } })).toMatchObject({
      op: 'key.create',
    })
    bad(() => validateEdit({ op: 'flush' }))
    bad(() => validateEdit(null))
    bad(() => validateEdit({ op: 'hash.set', field: '', value: 'v' }))
    bad(() => validateEdit({ op: 'hash.delete', fields: [] }))
    bad(() => validateEdit({ op: 'list.push', side: 'middle', values: ['a'] }))
    bad(() => validateEdit({ op: 'list.set', index: -1, value: 'a' }))
    bad(() => validateEdit({ op: 'zset.add', member: 'm', score: NaN }))
    bad(() => validateEdit({ op: 'ttl.set', ttlMs: 0 }))
    bad(() => validateEdit({ op: 'stream.delete', ids: ['x'] }))
    bad(() => validateEdit({ op: 'stream.add', id: 'x', fields: [['a', 'b']] }))
    bad(() => validateEdit({ op: 'stream.add', id: null, fields: [['a']] }))
    bad(() => validateEdit({ op: 'key.rename', newKey: 'n' }))
    bad(() => validateEdit({ op: 'key.create', value: { type: 'bitmap' } }))
    bad(() => validateEdit({ op: 'string.set', value: 5 }))
  })

  it('needs a console, a lock state and a line', () => {
    expect(
      validateExec({ connectionId: 'c', consoleId: 'x', writable: false, line: 'GET a' }),
    ).toMatchObject({
      writable: false,
    })
    bad(() => validateExec({ connectionId: 'c', consoleId: 'x', line: 'GET a' }))
    bad(() => validateExec({ connectionId: 'c', consoleId: 'x', writable: true, line: 5 }))
  })
})
