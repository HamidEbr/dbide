import { describe, expect, it } from 'vitest'
import { evaluateRun } from './guard'

const dev = { environment: 'dev', writable: true } as const
const prod = { environment: 'prod', writable: true } as const
const prodLocked = { environment: 'prod', writable: false } as const

describe('evaluateRun', () => {
  it('lets reads through everywhere', () => {
    expect(evaluateRun(['SELECT 1'], dev)).toEqual({ action: 'allow' })
    expect(evaluateRun(['SELECT 1', 'SHOW TABLES'], prod)).toEqual({ action: 'allow' })
    expect(evaluateRun(['SELECT 1'], prodLocked)).toEqual({ action: 'allow' })
  })

  it('lets ordinary writes through on dev', () => {
    expect(
      evaluateRun(['INSERT INTO t VALUES (1)', 'UPDATE t SET a = 1 WHERE id = 2'], dev),
    ).toEqual({
      action: 'allow',
    })
  })

  it('blocks writes while the connection is read-only, naming what was blocked', () => {
    const verdict = evaluateRun(['SELECT 1', 'DELETE FROM t WHERE id = 1'], prodLocked)
    expect(verdict.action).toBe('block')
    expect(verdict).toMatchObject({ message: expect.stringContaining('a data change') })
    expect(verdict).toMatchObject({ message: expect.stringContaining('Unlock writes') })
    expect(evaluateRun(['DROP TABLE t'], prodLocked)).toMatchObject({ action: 'block' })
    expect(evaluateRun(['CREATE TABLE t (a INT)'], prodLocked)).toMatchObject({
      message: expect.stringContaining('a schema change'),
    })
  })

  it('still lets session and transaction statements through on a read-only connection', () => {
    expect(evaluateRun(['USE shop', 'SET @a = 1', 'BEGIN', 'COMMIT'], prodLocked)).toEqual({
      action: 'allow',
    })
  })

  it('asks before any write on production, without making the user type anything', () => {
    expect(evaluateRun(['UPDATE t SET a = 1 WHERE id = 2'], prod)).toEqual({
      action: 'confirm',
      reasons: ['This is a prod connection.'],
      typedName: false,
    })
  })

  it('asks before a destructive statement even on dev, and explains why', () => {
    expect(evaluateRun(['DELETE FROM orders'], dev)).toEqual({
      action: 'confirm',
      reasons: ['DELETE without a WHERE clause affects every row.'],
      typedName: false,
    })
  })

  it('makes the user type the name for destructive statements on guarded environments', () => {
    expect(evaluateRun(['DROP TABLE orders'], prod)).toMatchObject({
      action: 'confirm',
      typedName: true,
    })
    expect(
      evaluateRun(['TRUNCATE orders'], { environment: 'staging', writable: true }),
    ).toMatchObject({
      action: 'confirm',
      typedName: true,
    })
  })

  it('lists each distinct reason once', () => {
    const verdict = evaluateRun(['DELETE FROM a', 'DELETE FROM b', 'DROP TABLE c'], dev)
    expect(verdict).toMatchObject({ action: 'confirm' })
    if (verdict.action === 'confirm') expect(verdict.reasons).toHaveLength(2)
  })
})

describe('evaluateRun for MongoDB scripts', () => {
  const mongo = { writable: true, language: 'mongodb' } as const

  it('lets reads through, even on a locked production connection', () => {
    expect(
      evaluateRun(['db.orders.find({})', 'show dbs'], {
        ...mongo,
        environment: 'prod',
        writable: false,
      }),
    ).toEqual({
      action: 'allow',
    })
  })

  it('blocks writes while the connection is locked, in words that fit', () => {
    const verdict = evaluateRun(['db.orders.insertOne({})'], {
      ...mongo,
      environment: 'prod',
      writable: false,
    })
    expect(verdict).toMatchObject({
      action: 'block',
      message: expect.stringContaining('a data change'),
    })
    expect(
      evaluateRun(['db.orders.aggregate([{ $out: "copy" }])'], {
        ...mongo,
        environment: 'prod',
        writable: false,
      }),
    ).toMatchObject({ action: 'block' })
    expect(
      evaluateRun(['db.orders.createIndex({ a: 1 })'], {
        ...mongo,
        environment: 'prod',
        writable: false,
      }),
    ).toMatchObject({
      message: expect.stringContaining('a schema change'),
    })
  })

  it('asks before a delete that matches everything, and says so', () => {
    expect(evaluateRun(['db.orders.deleteMany({})'], { ...mongo, environment: 'dev' })).toEqual({
      action: 'confirm',
      reasons: [expect.stringContaining('removes every document')],
      typedName: false,
    })
    expect(evaluateRun(['db.orders.drop()'], { ...mongo, environment: 'dev' })).toMatchObject({
      action: 'confirm',
    })
    expect(
      evaluateRun(['db.orders.deleteMany({ a: 1 })'], { ...mongo, environment: 'dev' }),
    ).toEqual({
      action: 'allow',
    })
  })

  it('asks before any write on production, and makes the person type for a destructive one', () => {
    expect(evaluateRun(['db.orders.insertOne({})'], { ...mongo, environment: 'prod' })).toEqual({
      action: 'confirm',
      reasons: ['This is a prod connection.'],
      typedName: false,
    })
    expect(
      evaluateRun(['db.orders.deleteMany({})'], { ...mongo, environment: 'prod' }),
    ).toMatchObject({
      action: 'confirm',
      typedName: true,
    })
  })

  it('does not call text that fails to parse a write, so the syntax error is what the person sees', () => {
    expect(
      evaluateRun(['db.orders.find({'], { ...mongo, environment: 'prod', writable: false }),
    ).toEqual({
      action: 'allow',
    })
  })
})
