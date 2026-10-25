import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from './driver'
import {
  createFormatter,
  DEFAULT_EXPORT_OPTIONS,
  exportFileName,
  formatAll,
  type ExportOptions,
} from './export'
import type { Cell } from './query'

const columns: ColumnInfo[] = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar' },
  { name: 'total', type: 'decimal' },
  { name: 'token', type: 'blob' },
]

const rows: Cell[][] = [
  [1, 'Ada', '12.50', new Uint8Array([0xde, 0xad])],
  [2, null, '-3', null],
  [3, 'say "hi", please', '0.00', null],
  [4, '', '7', null],
]

const options = (overrides: Partial<ExportOptions> = {}): ExportOptions => ({
  ...DEFAULT_EXPORT_OPTIONS,
  ...overrides,
})

describe('CSV', () => {
  it('writes a header, quotes what needs it, and keeps NULL apart from an empty string', () => {
    expect(formatAll('csv', columns, rows)).toBe(
      [
        'id,name,total,token',
        '1,Ada,12.50,0xdead',
        '2,,-3,',
        '3,"say ""hi"", please",0.00,',
        '4,"",7,',
        '',
      ].join('\n'),
    )
  })

  it('can leave the header out, use another delimiter, and write NULL as text', () => {
    const text = formatAll(
      'csv',
      columns,
      [rows[1]!, rows[2]!],
      options({ header: false, delimiter: ';', nullText: 'NULL' }),
    )
    expect(text).toBe('2;NULL;-3;NULL\n3;"say ""hi"", please";0.00;NULL\n')
  })

  it('quotes every field on request and ends lines with CRLF when asked', () => {
    const text = formatAll('csv', columns, [rows[0]!], options({ quoteAll: true, crlf: true }))
    expect(text).toBe('"id","name","total","token"\r\n"1","Ada","12.50","0xdead"\r\n')
  })

  it('keeps line breaks inside a quoted field', () => {
    const text = formatAll('csv', [columns[1]!], [['a\nb']], options({ header: false }))
    expect(text).toBe('"a\nb"\n')
  })

  it('adds a byte order mark only when asked', () => {
    expect(formatAll('csv', columns, [], options({ bom: true })).startsWith('﻿')).toBe(true)
    expect(formatAll('csv', columns, []).startsWith('﻿')).toBe(false)
    expect(formatAll('csv', columns, [], options({ bom: true, header: false }))).toBe('﻿')
  })

  it('neutralizes spreadsheet formulas in text but never in numbers', () => {
    const cols: ColumnInfo[] = [
      { name: 'note', type: 'varchar' },
      { name: 'delta', type: 'decimal' },
      { name: 'n', type: 'int' },
    ]
    const data: Cell[][] = [['=1+1', '-5.5', -2]]
    expect(formatAll('csv', cols, data, options({ header: false, neutralizeFormulas: true }))).toBe(
      "'=1+1,-5.5,-2\n",
    )
    expect(formatAll('csv', cols, data, options({ header: false }))).toBe('=1+1,-5.5,-2\n')
    const risky: Cell[][] = [
      ['@SUM(A1)', '+1', 0],
      ['\tx', '-cmd', 0],
    ]
    expect(
      formatAll('csv', cols, risky, options({ header: false, neutralizeFormulas: true })),
    ).toBe("'@SUM(A1),+1,0\n'\tx,-cmd,0\n")
  })
})

describe('TSV', () => {
  it('separates with tabs and quotes a value that contains one', () => {
    const text = formatAll('tsv', [columns[0]!, columns[1]!], [[1, 'a\tb']])
    expect(text).toBe('id\tname\n1\t"a\tb"\n')
  })
})

describe('JSON', () => {
  it('writes an array of objects with numbers as numbers and exact decimals intact', () => {
    const text = formatAll('json', columns, rows.slice(0, 2))
    expect(text).toBe(
      [
        '[',
        '  {"id":1,"name":"Ada","total":12.50,"token":"0xdead"},',
        '  {"id":2,"name":null,"total":-3,"token":null}',
        ']',
        '',
      ].join('\n'),
    )
    expect(JSON.parse(text)).toHaveLength(2)
  })

  it('writes an empty array for no rows', () => {
    expect(formatAll('json', columns, [])).toBe('[]\n')
  })

  it('keeps big integers exact and quotes numbers that are not valid JSON', () => {
    const cols: ColumnInfo[] = [
      { name: 'big', type: 'bigint' },
      { name: 'zero', type: 'int' },
    ]
    const text = formatAll('json', cols, [['9007199254740993', '007']])
    expect(text).toContain('"big":9007199254740993')
    expect(text).toContain('"zero":"007"')
    expect(() => JSON.parse(text)).not.toThrow()
  })

  it('gives repeated column names distinct keys', () => {
    const cols: ColumnInfo[] = [
      { name: 'id', type: 'int' },
      { name: 'id', type: 'int' },
    ]
    expect(JSON.parse(formatAll('json', cols, [[1, 2]]))).toEqual([{ id: 1, id_2: 2 }])
  })

  it('escapes control characters and quotes', () => {
    const text = formatAll('json', [columns[1]!], [['a"b\n\u0001']])
    expect(JSON.parse(text)).toEqual([{ name: 'a"b\n\u0001' }])
  })
})

describe('JSON Lines', () => {
  it('writes one object per line', () => {
    const lines = formatAll('ndjson', columns, rows.slice(0, 2)).trimEnd().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!)).toEqual({ id: 2, name: null, total: -3, token: null })
  })
})

describe('SQL', () => {
  it('writes one statement per row, quoting names and escaping values', () => {
    const text = formatAll(
      'sql',
      columns,
      [rows[0]!, [2, "O'Brien", '3', null]],
      options({ tableName: 'shop.orders', rowsPerInsert: 1 }),
    )
    expect(text).toBe(
      [
        "INSERT INTO `shop`.`orders` (`id`, `name`, `total`, `token`) VALUES (1, 'Ada', 12.50, 0xdead);",
        "INSERT INTO `shop`.`orders` (`id`, `name`, `total`, `token`) VALUES (2, 'O''Brien', 3, NULL);",
        '',
      ].join('\n'),
    )
  })

  it('groups rows into multi-row statements and flushes the last, smaller one', () => {
    const cols: ColumnInfo[] = [{ name: 'n', type: 'int' }]
    const data: Cell[][] = [[1], [2], [3]]
    const text = formatAll('sql', cols, data, options({ tableName: 't', rowsPerInsert: 2 }))
    expect(text).toBe(
      'INSERT INTO `t` (`n`) VALUES\n  (1),\n  (2);\nINSERT INTO `t` (`n`) VALUES (3);\n',
    )
  })

  it('writes nothing for no rows', () => {
    expect(formatAll('sql', columns, [])).toBe('')
  })

  it('escapes a backtick in a name', () => {
    const text = formatAll(
      'sql',
      [{ name: 'a`b', type: 'int' }],
      [[1]],
      options({ tableName: 'x' }),
    )
    expect(text).toContain('`a``b`')
  })
})

describe('Markdown', () => {
  it('writes a table and escapes pipes and line breaks', () => {
    const text = formatAll(
      'markdown',
      [columns[0]!, columns[1]!],
      [
        [1, 'a|b\nc'],
        [2, null],
      ],
    )
    expect(text).toBe('| id | name |\n| --- | --- |\n| 1 | a\\|b c |\n| 2 | NULL |\n')
  })
})

describe('streaming', () => {
  it('produces the same text piece by piece as all at once', () => {
    for (const format of ['csv', 'tsv', 'json', 'ndjson', 'sql', 'markdown'] as const) {
      const formatter = createFormatter(format)
      const pieces = [
        formatter.start(columns),
        ...rows.map((r) => formatter.row(r)),
        formatter.end(),
      ]
      expect(pieces.join('')).toBe(formatAll(format, columns, rows))
    }
  })
})

describe('exportFileName', () => {
  const day = new Date('2026-03-01T12:00:00Z')

  it('adds the date and the extension of the format', () => {
    expect(exportFileName('orders', 'csv', day)).toBe('orders-2026-03-01.csv')
    expect(exportFileName('orders', 'ndjson', day)).toBe('orders-2026-03-01.ndjson')
    expect(exportFileName('orders', 'markdown', day)).toBe('orders-2026-03-01.md')
  })

  it('removes characters a file name can not hold, and falls back to "result"', () => {
    expect(exportFileName('a/b:c*', 'json', day)).toBe('a_b_c_-2026-03-01.json')
    expect(exportFileName('  ', 'csv', day)).toBe('result-2026-03-01.csv')
    expect(exportFileName('..hidden', 'csv', day)).toBe('hidden-2026-03-01.csv')
  })
})
