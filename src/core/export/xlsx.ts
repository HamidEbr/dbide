import type { ColumnInfo } from '@shared/driver'
import type { ExportOptions } from '@shared/export'
import type { Cell } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { isNumericType, toHex } from '@shared/value'
import { ZipWriter } from './zip'
import type { ExportWriter } from './writer'

/**
 * An Excel workbook (.xlsx) written as a stream. A workbook is a zip of XML parts; the rows go into
 * one sheet part that is compressed as it is written. A sheet holds at most 1,048,576 rows, so a
 * longer result continues on the next sheet, with the header repeated.
 *
 * Text is written as inline strings, which Excel never treats as a formula, so nothing here needs
 * protecting from `=1+1`. Numbers are written as numbers only while Excel can hold them exactly
 * (15 significant digits); longer ones, such as a big integer or a precise decimal, stay text.
 */

export const MAX_ROWS_PER_SHEET = 1_048_576
export const MAX_COLUMNS = 16_384
/** The most text Excel keeps in one cell. */
const MAX_CELL_CHARS = 32_767
const MAX_SIGNIFICANT_DIGITS = 15

const NAMESPACE = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
const RELATIONSHIPS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'

/** Characters XML can not carry: control characters other than tab, line feed and carriage return. */
// eslint-disable-next-line no-control-regex
const ILLEGAL_XML = /[^\u0009\u000A\u000D -퟿-�\u{10000}-\u{10FFFF}]/gu

const NUMBER = /^-?(0|[1-9]\d*)(\.\d+)?([eE][-+]?\d+)?$/

function escapeXml(text: string): string {
  return text
    .replace(ILLEGAL_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** `A`, `B`, … `Z`, `AA`, … for a zero-based column index. */
export function columnLetters(index: number): string {
  let name = ''
  for (let n = index; n >= 0; n = Math.floor(n / 26) - 1)
    name = String.fromCharCode(65 + (n % 26)) + name
  return name
}

/** The significant digits of a plain number written as text, without the sign, point or exponent. */
function significantDigits(text: string): number {
  const mantissa = text.replace(/^-/, '').split(/[eE]/)[0]!.replace('.', '')
  return mantissa.replace(/^0+/, '').replace(/0+$/, '').length || 1
}

/** The value of a cell as a number Excel can hold, or null when it should be written as text. */
function numberToken(cell: Cell, type: string): string | null {
  if (typeof cell === 'number') return Number.isFinite(cell) ? String(cell) : null
  if (typeof cell !== 'string' || !isNumericType(type) || !NUMBER.test(cell)) return null
  return significantDigits(cell) <= MAX_SIGNIFICANT_DIGITS ? cell : null
}

function cellXml(ref: string, cell: Cell | undefined, type: string): string {
  if (cell === null || cell === undefined) return ''
  if (typeof cell === 'boolean') return `<c r="${ref}" t="b"><v>${cell ? 1 : 0}</v></c>`
  const number = numberToken(cell, type)
  if (number !== null) return `<c r="${ref}"><v>${number}</v></c>`

  let text = cell instanceof Uint8Array ? `0x${toHex(cell)}` : String(cell)
  if (text.length > MAX_CELL_CHARS) text = text.slice(0, MAX_CELL_CHARS)
  const keep = /^\s|\s$|[\r\n]/.test(text) ? ' xml:space="preserve"' : ''
  return `<c r="${ref}" t="inlineStr"><is><t${keep}>${escapeXml(text)}</t></is></c>`
}

const STYLES = `${XML_HEADER}<styleSheet xmlns="${NAMESPACE}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

const sheetName = (index: number): string => (index === 0 ? 'Result' : `Result ${index + 1}`)

function workbookParts(sheets: number): { path: string; xml: string }[] {
  const indexes = Array.from({ length: sheets }, (_, i) => i)
  return [
    {
      path: 'xl/styles.xml',
      xml: STYLES,
    },
    {
      path: 'xl/workbook.xml',
      xml: `${XML_HEADER}<workbook xmlns="${NAMESPACE}" xmlns:r="${RELATIONSHIPS}"><sheets>${indexes
        .map((i) => `<sheet name="${sheetName(i)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join('')}</sheets></workbook>`,
    },
    {
      path: 'xl/_rels/workbook.xml.rels',
      xml: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${indexes
        .map(
          (i) =>
            `<Relationship Id="rId${i + 1}" Type="${RELATIONSHIPS}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
        )
        .join(
          '',
        )}<Relationship Id="rId${sheets + 1}" Type="${RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
    },
    {
      path: '_rels/.rels',
      xml: `${XML_HEADER}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      path: '[Content_Types].xml',
      xml: `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${indexes
        .map(
          (i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
        )
        .join('')}</Types>`,
    },
  ]
}

export function createXlsxWriter(
  options: Pick<ExportOptions, 'header'>,
  limits: { maxRowsPerSheet?: number } = {},
): ExportWriter {
  const maxRows = limits.maxRowsPerSheet ?? MAX_ROWS_PER_SHEET
  const zip = new ZipWriter()
  let columns: readonly ColumnInfo[] = []
  let sheets = 0
  let rowsInSheet = 0

  const columnWidths = (): string =>
    `<cols>${columns
      .map((c, i) => {
        const width = Math.min(40, Math.max(10, Math.ceil(c.name.length * 1.2) + 2))
        return `<col min="${i + 1}" max="${i + 1}" width="${width}" customWidth="1"/>`
      })
      .join('')}</cols>`

  const headerRow = (): string => {
    if (!options.header) return ''
    const cells = columns.map((c, i) => {
      const text = escapeXml(c.name.slice(0, MAX_CELL_CHARS))
      return `<c r="${columnLetters(i)}1" t="inlineStr" s="1"><is><t>${text}</t></is></c>`
    })
    rowsInSheet = 1
    return `<row r="1">${cells.join('')}</row>`
  }

  /** The start of the next sheet part: its XML up to where the rows go, and the header row. */
  const beginSheet = (): Buffer => {
    const index = sheets++
    rowsInSheet = 0
    // The header stays in view while the rows scroll under it.
    const view = options.header
      ? '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>'
      : ''
    const head = `${XML_HEADER}<worksheet xmlns="${NAMESPACE}">${view}<sheetFormatPr defaultRowHeight="15"/>${columnWidths()}<sheetData>`
    return Buffer.concat([
      zip.begin(`xl/worksheets/sheet${index + 1}.xml`),
      zip.append(head + headerRow()),
    ])
  }

  const endSheet = (): Buffer =>
    Buffer.concat([zip.append('</sheetData></worksheet>'), zip.finish()])

  return {
    start(cols) {
      if (cols.length > MAX_COLUMNS) {
        throw new RpcError(
          'XLSX_LIMIT',
          `An Excel sheet holds at most ${MAX_COLUMNS.toLocaleString()} columns, and this result has ${cols.length.toLocaleString()}. Export it as CSV instead.`,
        )
      }
      columns = cols
      return beginSheet()
    },

    rows(rows) {
      const parts: Buffer[] = []
      let xml = ''
      const flush = (): void => {
        if (xml !== '') parts.push(zip.append(xml))
        xml = ''
      }
      for (const row of rows) {
        if (rowsInSheet >= maxRows) {
          flush()
          parts.push(endSheet(), beginSheet())
        }
        rowsInSheet++
        let cells = ''
        for (let c = 0; c < columns.length; c++) {
          cells += cellXml(`${columnLetters(c)}${rowsInSheet}`, row[c], columns[c]!.type)
        }
        xml += `<row r="${rowsInSheet}">${cells}</row>`
      }
      flush()
      return Buffer.concat(parts)
    },

    end() {
      const parts: Buffer[] = [endSheet()]
      for (const part of workbookParts(sheets)) parts.push(zip.addFile(part.path, part.xml))
      parts.push(zip.close())
      return Buffer.concat(parts)
    },
  }
}
