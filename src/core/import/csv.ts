/**
 * A CSV reader that takes the file a piece at a time, so a file of any size can be read without holding it. A field
 * in quotes may hold the delimiter, line breaks and `""` for a quote; a row ends at `\n`, `\r\n` or `\r`.
 */
export class CsvParser {
  private row: string[] = []
  private field = ''
  private quoted = false
  /** A quote was just seen inside a quoted field: it ends the field, or it is the first half of `""`. */
  private quoteSeen = false
  /** A `\r` was just seen outside quotes, so a `\n` right after belongs to the same line break. */
  private afterCarriage = false
  /** The row has something in it, so a line break ends it rather than being a blank line. */
  private started = false

  constructor(private readonly delimiter: string) {}

  private endRow(rows: string[][]): void {
    this.row.push(this.field)
    rows.push(this.row)
    this.row = []
    this.field = ''
    this.started = false
  }

  /** The rows completed by this piece of the file. */
  push(chunk: string): string[][] {
    const rows: string[][] = []
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!
      if (this.afterCarriage) {
        this.afterCarriage = false
        if (ch === '\n') continue
      }
      if (this.quoted) {
        if (this.quoteSeen) {
          this.quoteSeen = false
          if (ch === '"') {
            this.field += '"'
            continue
          }
          this.quoted = false
          // Falls through: this character comes after the closing quote.
        } else if (ch === '"') {
          this.quoteSeen = true
          continue
        } else {
          this.field += ch
          continue
        }
      }
      if (ch === '"' && this.field === '') {
        this.quoted = true
        this.started = true
      } else if (ch === this.delimiter) {
        this.row.push(this.field)
        this.field = ''
        this.started = true
      } else if (ch === '\n' || ch === '\r') {
        if (ch === '\r') this.afterCarriage = true
        if (this.started || this.field !== '' || this.row.length > 0) this.endRow(rows)
      } else {
        this.field += ch
        this.started = true
      }
    }
    return rows
  }

  /** The last row, when the file does not end in a line break. */
  end(): string[][] {
    const rows: string[][] = []
    if (this.quoteSeen) this.quoted = false
    if (this.started || this.field !== '' || this.row.length > 0) this.endRow(rows)
    return rows
  }
}
