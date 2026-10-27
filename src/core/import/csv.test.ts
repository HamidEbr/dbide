import { describe, expect, it } from 'vitest'
import { CsvParser } from './csv'

const parse = (text: string, delimiter = ',', size = 1000): string[][] => {
  const parser = new CsvParser(delimiter)
  const rows: string[][] = []
  for (let i = 0; i < text.length; i += size) rows.push(...parser.push(text.slice(i, i + size)))
  rows.push(...parser.end())
  return rows
}

describe('CsvParser', () => {
  it('reads rows, with any kind of line break and a last row without one', () => {
    expect(parse('a,b\n1,2\r\n3,4\r5,6')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
      ['5', '6'],
    ])
  })

  it('reads quoted fields with delimiters, line breaks and doubled quotes', () => {
    expect(parse('"a,b","line\nbreak","say ""hi"""\nx,"",y')).toEqual([
      ['a,b', 'line\nbreak', 'say "hi"'],
      ['x', '', 'y'],
    ])
  })

  it('gives the same rows however the file is cut into pieces', () => {
    const text = 'id,name\r\n1,"A ""q"" b"\r\n2,"multi\r\nline"\r\n3,\r\n'
    for (const size of [1, 2, 3, 5, 100]) expect(parse(text, ',', size)).toEqual(parse(text))
    expect(parse(text)).toEqual([
      ['id', 'name'],
      ['1', 'A "q" b'],
      ['2', 'multi\r\nline'],
      ['3', ''],
    ])
  })

  it('uses the delimiter it is given, skips blank lines, and keeps empty fields', () => {
    expect(parse('a;b;\n\n;;\n', ';')).toEqual([
      ['a', 'b', ''],
      ['', '', ''],
    ])
  })
})
