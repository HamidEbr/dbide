import { describe, expect, it } from 'vitest'
import { atLeast, parseServerVersion, unsupportedReason } from './version'

const parse = (text: string) => parseServerVersion(text)!

describe('parseServerVersion', () => {
  it('reads MySQL versions, with or without a suffix', () => {
    expect(parse('5.7.44-log')).toMatchObject({ flavor: 'mysql', major: 5, minor: 7, patch: 44 })
    expect(parse('8.4.13')).toMatchObject({ flavor: 'mysql', major: 8, minor: 4, patch: 13 })
    expect(parse('5.5.62-0ubuntu0.14.04.1')).toMatchObject({ major: 5, minor: 5, patch: 62 })
    expect(parse('8.0.35-27')).toMatchObject({ flavor: 'mysql', major: 8, minor: 0 })
  })

  it('reads MariaDB, including the 5.5.5 prefix its greeting carries', () => {
    expect(parse('11.8.9-MariaDB-ubu2404')).toMatchObject({
      flavor: 'mariadb',
      major: 11,
      minor: 8,
    })
    expect(parse('5.5.5-10.11.6-MariaDB')).toMatchObject({
      flavor: 'mariadb',
      major: 10,
      minor: 11,
      patch: 6,
    })
    expect(parse('5.5.64-MariaDB')).toMatchObject({
      flavor: 'mariadb',
      major: 5,
      minor: 5,
      patch: 64,
    })
  })

  it('has nothing to say about text without a version', () => {
    expect(parseServerVersion('')).toBeNull()
    expect(parseServerVersion('unknown')).toBeNull()
  })

  it('keeps the original text', () => {
    expect(parse('5.7.44-log').text).toBe('5.7.44-log')
  })
})

describe('atLeast', () => {
  it('compares each part in order', () => {
    expect(atLeast(parse('5.7.44'), 5, 7, 8)).toBe(true)
    expect(atLeast(parse('5.7.7'), 5, 7, 8)).toBe(false)
    expect(atLeast(parse('5.6.50'), 5, 7)).toBe(false)
    expect(atLeast(parse('8.0.0'), 5, 7, 44)).toBe(true)
    expect(atLeast(parse('5.5.3'), 5, 5, 3)).toBe(true)
  })
})

describe('unsupportedReason', () => {
  it('accepts every MySQL from 5.5.3 on, and MariaDB of any age', () => {
    for (const text of ['5.5.3', '5.5.62', '5.6.51', '5.7.44', '8.0.46', '8.4.13', '9.1.0']) {
      expect(unsupportedReason(parse(text)), text).toBeNull()
    }
    expect(unsupportedReason(parse('5.5.64-MariaDB'))).toBeNull()
    expect(unsupportedReason(parse('10.3.39-MariaDB'))).toBeNull()
  })

  it('turns away a MySQL too old for utf8mb4, and says which versions work', () => {
    for (const text of ['5.5.2', '5.1.73', '5.0.96', '4.1.22']) {
      expect(unsupportedReason(parse(text)), text).toMatch(/MySQL 5\.5\.3 and newer/)
    }
  })

  it('lets a server through when the version can not be read', () => {
    expect(unsupportedReason(null)).toBeNull()
  })
})
