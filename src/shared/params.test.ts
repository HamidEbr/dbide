import { describe, expect, it } from 'vitest'
import { findParameters, substituteParameters } from './params'

describe('findParameters', () => {
  it('finds names once, in order, outside strings, comments and quoted names', () => {
    expect(
      findParameters([
        "SELECT * FROM t WHERE id = :id AND name = ':notthis' -- :nor this\n AND `x:y` = :since OR id = :id",
        'SELECT :since, :until',
      ]),
    ).toEqual(['id', 'since', 'until'])
  })

  it('leaves casts and assignments alone', () => {
    expect(findParameters(['SELECT a::int, b::text FROM t WHERE c = :c'], 'postgresql')).toEqual([
      'c',
    ])
    expect(findParameters(['SET @a := 1; SELECT 12:30'])).toEqual([])
    expect(findParameters(['SELECT 1'])).toEqual([])
  })
})

describe('substituteParameters', () => {
  it('writes each value as a literal of its kind, every time the name appears', () => {
    const result = substituteParameters(
      [
        'SELECT * FROM t WHERE id = :id AND name = :name AND x IS NOT DISTINCT FROM :none OR id = :id',
      ],
      {
        id: { kind: 'number', value: ' 42 ' },
        name: { kind: 'text', value: "O'Neil" },
        none: { kind: 'null', value: '' },
      },
    )
    expect(result).toEqual({
      ok: true,
      statements: [
        "SELECT * FROM t WHERE id = 42 AND name = 'O''Neil' AND x IS NOT DISTINCT FROM NULL OR id = 42",
      ],
    })
  })

  it('writes text the way each server reads it', () => {
    const one = { a: { kind: 'text' as const, value: 'x\\y' } }
    expect(substituteParameters(['SELECT :a'], one, 'mysql')).toEqual({
      ok: true,
      statements: ["SELECT 'x\\\\y'"],
    })
    expect(substituteParameters(['SELECT :a'], one, 'postgresql')).toEqual({
      ok: true,
      statements: ["SELECT 'x\\y'"],
    })
    expect(substituteParameters(['SELECT :a'], one, 'mssql')).toEqual({
      ok: true,
      statements: ["SELECT N'x\\y'"],
    })
  })

  it('refuses a number that is not one, and a name with no value', () => {
    expect(
      substituteParameters(['SELECT :n'], { n: { kind: 'number', value: '1; DROP TABLE t' } }),
    ).toMatchObject({
      ok: false,
      message: ':n should be a number.',
    })
    expect(substituteParameters(['SELECT :n'], {})).toMatchObject({
      ok: false,
      message: 'Give a value for :n.',
    })
  })
})
