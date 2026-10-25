import { describe, expect, it } from 'vitest'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { readZip } from './read-zip'
import { columnLetters, createXlsxWriter } from './xlsx'

const columns: ColumnInfo[] = [
  { name: 'id', type: 'int' },
  { name: 'name', type: 'varchar' },
  { name: 'total', type: 'decimal' },
  { name: 'token', type: 'blob' },
]

function write(
  rows: Cell[][],
  options = { header: true },
  limits: { maxRowsPerSheet?: number } = {},
  cols: readonly ColumnInfo[] = columns,
): Map<string, string> {
  const writer = createXlsxWriter(options, limits)
  const parts = [writer.start(cols)]
  // Two batches, as a driver would deliver them.
  const middle = Math.ceil(rows.length / 2)
  for (const batch of [rows.slice(0, middle), rows.slice(middle)]) {
    if (batch.length > 0) parts.push(writer.rows(batch))
  }
  parts.push(writer.end())
  const files = readZip(Buffer.concat(parts.map((p) => Buffer.from(p))))
  return new Map([...files].map(([name, data]) => [name, data.toString('utf8')]))
}

describe('columnLetters', () => {
  it('counts like a spreadsheet', () => {
    expect([0, 1, 25, 26, 27, 51, 52, 701, 702, 16383].map(columnLetters)).toEqual([
      'A',
      'B',
      'Z',
      'AA',
      'AB',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
      'XFD',
    ])
  })
})

describe('createXlsxWriter', () => {
  it('writes the parts of a workbook, each well-formed enough to be read back', () => {
    const files = write([[1, 'Ada', '12.50', null]])
    expect([...files.keys()].sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ])
    expect(files.get('xl/workbook.xml')).toContain('<sheet name="Result" sheetId="1" r:id="rId1"/>')
    expect(files.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet1.xml')
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet1.xml"')
    expect(files.get('_rels/.rels')).toContain('Target="xl/workbook.xml"')
    for (const [name, xml] of files) {
      expect(xml.startsWith('<?xml version="1.0"'), name).toBe(true)
    }
  })

  it('writes a bold, frozen header and the rows under it', () => {
    const sheet = write([
      [1, 'Ada', '12.50', new Uint8Array([0xde, 0xad])],
      [2, null, '0.99', null],
    ]).get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('state="frozen"')
    expect(sheet).toContain('<c r="A1" t="inlineStr" s="1"><is><t>id</t></is></c>')
    expect(sheet).toContain(
      '<row r="2"><c r="A2"><v>1</v></c><c r="B2" t="inlineStr"><is><t>Ada</t></is></c><c r="C2"><v>12.50</v></c><c r="D2" t="inlineStr"><is><t>0xdead</t></is></c></row>',
    )
    // NULL is a cell that is not there.
    expect(sheet).toContain('<row r="3"><c r="A3"><v>2</v></c><c r="C3"><v>0.99</v></c></row>')
    expect(sheet.endsWith('</sheetData></worksheet>')).toBe(true)
  })

  it('leaves the header out, and the frozen pane with it, when asked', () => {
    const sheet = write([[1, 'a', '1', null]], { header: false }).get('xl/worksheets/sheet1.xml')!
    expect(sheet).not.toContain('frozen')
    expect(sheet).toContain('<row r="1"><c r="A1"><v>1</v></c>')
    expect(sheet).not.toContain('s="1"')
  })

  it('writes numbers as numbers only while Excel can hold them exactly', () => {
    const cols: ColumnInfo[] = [
      { name: 'a', type: 'bigint' },
      { name: 'b', type: 'decimal' },
      { name: 'c', type: 'varchar' },
      { name: 'd', type: 'int' },
      { name: 'e', type: 'double' },
    ]
    const sheet = write(
      [['9007199254740993', '123456789.123456', '42', '007', 1.5]],
      { header: false },
      {},
      cols,
    ).get('xl/worksheets/sheet1.xml')!
    // 16 digits: text. 15 digits: a number. Text in a text column stays text. Leading zeros stay.
    expect(sheet).toContain('<c r="A1" t="inlineStr"><is><t>9007199254740993</t></is></c>')
    expect(sheet).toContain('<c r="B1"><v>123456789.123456</v></c>')
    expect(sheet).toContain('<c r="C1" t="inlineStr"><is><t>42</t></is></c>')
    expect(sheet).toContain('<c r="D1" t="inlineStr"><is><t>007</t></is></c>')
    expect(sheet).toContain('<c r="E1"><v>1.5</v></c>')
  })

  it('writes booleans, and never a formula: text that looks like one is just text', () => {
    const sheet = write([[true, '=1+1', '1', null]], { header: false }).get(
      'xl/worksheets/sheet1.xml',
    )!
    expect(sheet).toContain('<c r="A1" t="b"><v>1</v></c>')
    expect(sheet).toContain('<c r="B1" t="inlineStr"><is><t>=1+1</t></is></c>')
    expect(sheet).not.toContain('<f>')
  })

  it('escapes XML, drops characters XML can not hold, and keeps spaces and line breaks', () => {
    const sheet = write(
      [['a<b>&"c"', ' padded ', 'line\nbreak\u0001\u0000', null]],
      { header: false },
      {},
      [
        { name: 'x', type: 'text' },
        { name: 'y', type: 'text' },
        { name: 'z', type: 'text' },
        { name: 'w', type: 'text' },
      ],
    ).get('xl/worksheets/sheet1.xml')!
    expect(sheet).toContain('<t>a&lt;b&gt;&amp;"c"</t>')
    expect(sheet).toContain('<t xml:space="preserve"> padded </t>')
    expect(sheet).toContain('<t xml:space="preserve">line\nbreak</t>')
  })

  it('keeps non-Latin text and emoji', () => {
    const sheet = write([['日本語 🎉 ü', null, null, null]], { header: false }).get(
      'xl/worksheets/sheet1.xml',
    )!
    expect(sheet).toContain('日本語 🎉 ü')
  })

  it('cuts a cell to the 32,767 characters Excel keeps', () => {
    const sheet = write([['x'.repeat(40_000), null, null, null]], { header: false }).get(
      'xl/worksheets/sheet1.xml',
    )!
    expect(sheet).toContain(`<t>${'x'.repeat(32_767)}</t>`)
    expect(sheet).not.toContain('x'.repeat(32_768))
  })

  it('continues on a new sheet, with the header again, when a sheet is full', () => {
    const rows: Cell[][] = Array.from({ length: 7 }, (_, i) => [i + 1, `n${i + 1}`, null, null])
    const files = write(rows, { header: true }, { maxRowsPerSheet: 4 })
    const first = files.get('xl/worksheets/sheet1.xml')!
    const second = files.get('xl/worksheets/sheet2.xml')!
    // A header and three rows on each sheet; the last sheet holds the one that is left over.
    expect(first.match(/<row /g)).toHaveLength(4)
    expect(second.match(/<row /g)).toHaveLength(4)
    expect(first).toContain('<v>3</v>')
    expect(first).not.toContain('<v>4</v>')
    expect(second).toContain('<t>id</t>')
    expect(second).toContain('<c r="A2"><v>4</v></c>')
    // Seven rows at three per sheet make three sheets, and the last holds the one left over.
    const third = files.get('xl/worksheets/sheet3.xml')!
    expect(third.match(/<row /g)).toHaveLength(2)
    expect(third).toContain('<c r="A2"><v>7</v></c>')
    expect(files.get('xl/workbook.xml')).toContain(
      '<sheet name="Result 2" sheetId="2" r:id="rId2"/>',
    )
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain('Target="worksheets/sheet2.xml"')
    expect(files.get('xl/_rels/workbook.xml.rels')).toContain(
      'Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles"',
    )
    expect(files.get('[Content_Types].xml')).toContain('/xl/worksheets/sheet2.xml')
  })

  it('writes an empty result as a sheet with just its header', () => {
    const sheet = write([]).get('xl/worksheets/sheet1.xml')!
    expect(sheet.match(/<row /g)).toHaveLength(1)
  })

  it('refuses more columns than a sheet has', () => {
    const wide = Array.from({ length: 16_385 }, (_, i): ColumnInfo => ({
      name: `c${i}`,
      type: 'int',
    }))
    expect(() => createXlsxWriter({ header: true }).start(wide)).toThrow(/at most 16,384 columns/)
  })

  it('handles a big result a batch at a time', () => {
    const writer = createXlsxWriter({ header: true })
    const parts = [writer.start(columns)]
    for (let b = 0; b < 40; b++) {
      parts.push(
        writer.rows(
          Array.from({ length: 500 }, (_, i) => [b * 500 + i, `name ${i}`, '1.50', null]),
        ),
      )
    }
    parts.push(writer.end())
    const sheet = readZip(Buffer.concat(parts.map((p) => Buffer.from(p))))
      .get('xl/worksheets/sheet1.xml')!
      .toString()
    expect(sheet.match(/<row /g)).toHaveLength(20_001)
    expect(sheet).toContain('<row r="20001">')
  })
})
