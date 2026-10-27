import {
  buildEditStatements,
  type EditBatch,
  type EditResult,
  type TableColumn,
  type TableDescription,
} from '@shared/edit'
import type {
  ColumnInfo,
  ConnectContext,
  Driver,
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SchemaDetail,
  SchemaTable,
  TableColumns,
  SessionInfo,
  TreeNode,
} from '@shared/driver'
import { mysqlDescriptor } from '../mysql/driver'
import { treeChildren, type MetaQuery } from '../mysql/tree'

/**
 * A stand-in for the MySQL driver that needs no server. It serves a small made-up schema and
 * generates rows on demand, so the app can be exercised end to end: tree, streaming, paging,
 * cancel, errors, row editing. Turned on with `DBIDE_DEMO_ENGINE=1` (the smoke test does this).
 * It is not a MySQL emulator and says nothing about how mysql2 behaves on the wire.
 */

const column = (table: string, name: string, type: string, nullable: boolean): ColumnInfo => ({
  name,
  type,
  nullable,
  table,
  source: { schema: 'shop', table, column: name },
})

const ORDER_COLUMNS: ColumnInfo[] = [
  column('orders', 'id', 'int', false),
  column('orders', 'customer', 'varchar', false),
  column('orders', 'total', 'decimal', false),
  column('orders', 'created_at', 'datetime', false),
  column('orders', 'meta', 'json', true),
  column('orders', 'note', 'text', true),
  column('orders', 'token', 'blob', true),
]

/** `customers` has no primary key, so it shows how a read-only result explains itself. */
const CUSTOMER_COLUMNS: ColumnInfo[] = [
  column('customers', 'id', 'int', false),
  column('customers', 'name', 'varchar', false),
  column('customers', 'email', 'varchar', false),
]

/** A result with 300 columns, to try a grid that has to draw only the ones on screen. */
const WIDE_COLUMNS: ColumnInfo[] = Array.from({ length: 300 }, (_, i) =>
  column('wide', `c${i + 1}`, 'int', false),
)
const wideRow = (i: number): unknown[] => WIDE_COLUMNS.map((_, c) => (i + 1) * 1000 + c + 1)

function orderRow(i: number): unknown[] {
  const day = String((i % 28) + 1).padStart(2, '0')
  return [
    i + 1,
    `customer-${i % 977}`,
    ((i * 37) % 100000) / 100 + '',
    `2026-03-${day} ${String(i % 24).padStart(2, '0')}:15:00`,
    i % 5 === 0 ? null : `{"source":"app","items":${(i % 7) + 1}}`,
    i % 3 === 0 ? null : i % 11 === 0 ? '' : `Order note ${i}`,
    i % 4 === 0 ? new Uint8Array([i & 255, (i >> 8) & 255, 0xde, 0xad]) : null,
  ]
}

const customerRow = (i: number): unknown[] => [
  i + 1,
  `Customer ${i + 1}`,
  `customer${i + 1}@example.com`,
]

const tableColumn = (name: string, type: string, columnType: string, extra = {}): TableColumn => ({
  name,
  type,
  columnType,
  nullable: false,
  autoIncrement: false,
  generated: false,
  ...extra,
})

const DESCRIPTIONS: Record<string, TableDescription> = {
  orders: {
    schema: 'shop',
    table: 'orders',
    primaryKey: ['id'],
    columns: [
      tableColumn('id', 'int', 'int unsigned', { autoIncrement: true }),
      tableColumn('customer', 'varchar', 'varchar(120)'),
      tableColumn('total', 'decimal', 'decimal(12,2)'),
      tableColumn('created_at', 'datetime', 'datetime'),
      tableColumn('meta', 'json', 'json', { nullable: true }),
      tableColumn('note', 'text', 'text', { nullable: true }),
      tableColumn('token', 'blob', 'blob', { nullable: true }),
    ],
    foreignKeys: [
      {
        name: 'fk_orders_customer',
        columns: ['customer'],
        refSchema: 'shop',
        refTable: 'customers',
        refColumns: ['name'],
      },
    ],
    referencedBy: [],
  },
  wide: {
    schema: 'shop',
    table: 'wide',
    primaryKey: ['c1'],
    columns: WIDE_COLUMNS.map((c) => tableColumn(c.name, 'int', 'int')),
    foreignKeys: [],
    referencedBy: [],
  },
  customers: {
    schema: 'shop',
    table: 'customers',
    primaryKey: [],
    columns: [
      tableColumn('id', 'int', 'int'),
      tableColumn('name', 'varchar', 'varchar(120)'),
      tableColumn('email', 'varchar', 'varchar(120)'),
    ],
    foreignKeys: [],
    referencedBy: [
      {
        name: 'fk_orders_customer',
        schema: 'shop',
        table: 'orders',
        columns: ['customer'],
        refColumns: ['name'],
      },
    ],
  },
}

const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new DOMException('The query was cancelled', 'AbortError'))
      },
      { once: true },
    )
  })

/** Answers the information_schema queries the real tree makes, from a tiny fixed schema. */
const meta: MetaQuery = (sql) => {
  if (sql.includes('FROM information_schema.SCHEMATA')) {
    return Promise.resolve([['analytics'], ['information_schema'], ['mysql'], ['shop']])
  }
  if (sql.includes('COUNT(*)')) return Promise.resolve([[3, 1, 1, 0, 0]])
  if (sql.includes("TABLE_TYPE = 'BASE TABLE'")) {
    return Promise.resolve([
      ['customers', '9800', '1310720', '262144'],
      ['orders', '2400000', '188743680', '52428800'],
      ['products', '420', '65536', '16384'],
    ])
  }
  if (sql.includes("TABLE_TYPE = 'VIEW'")) return Promise.resolve([['open_orders']])
  if (sql.includes('FROM information_schema.ROUTINES'))
    return Promise.resolve([['recalc', 'PROCEDURE']])
  if (sql.includes('information_schema.COLUMNS')) {
    return Promise.resolve([
      ['id', 'int unsigned', 'NO', 'PRI', 'auto_increment'],
      ['customer', 'varchar(120)', 'NO', 'MUL', ''],
      ['total', 'decimal(12,2)', 'NO', '', ''],
      ['created_at', 'datetime', 'NO', '', ''],
      ['meta', 'json', 'YES', '', ''],
    ])
  }
  if (sql.includes('information_schema.STATISTICS')) {
    return Promise.resolve([
      ['PRIMARY', 0, 'id'],
      ['by_customer', 1, 'customer'],
    ])
  }
  if (sql.includes('KEY_COLUMN_USAGE')) {
    return Promise.resolve([['fk_orders_customer', 'customer', 'shop', 'customers', 'name']])
  }
  return Promise.resolve([])
}

class DemoSession implements DriverSession {
  private state: SessionInfo

  constructor(readOnly: boolean) {
    this.state = { serverVersion: '8.4.0-demo', currentDatabase: null, readOnly }
  }

  get info(): SessionInfo {
    return this.state
  }

  ping(): Promise<void> {
    return Promise.resolve()
  }

  children(parent: TreeNode | null): Promise<TreeNode[]> {
    return treeChildren(meta, parent)
  }

  completionSchema(): Promise<Record<string, string[]>> {
    return Promise.resolve({
      orders: ORDER_COLUMNS.map((c) => c.name),
      customers: ['id', 'name', 'email'],
      products: ['id', 'sku', 'title'],
    })
  }

  databaseNames(): Promise<string[]> {
    return Promise.resolve(['analytics', 'information_schema', 'mysql', 'shop'])
  }

  private demoTables(): SchemaTable[] {
    const columns = (list: ColumnInfo[]): SchemaTable['columns'] =>
      list.map((c) => ({
        name: c.name,
        type: c.type,
        nullable: c.nullable === true,
        key: c.name === 'id' ? 'PRI' : '',
        comment: '',
      }))
    return [
      {
        name: 'customers',
        view: false,
        comment: 'People who buy things',
        columns: columns(CUSTOMER_COLUMNS),
      },
      { name: 'orders', view: false, comment: '', columns: columns(ORDER_COLUMNS) },
      {
        name: 'products',
        view: false,
        comment: '',
        columns: columns([
          column('products', 'id', 'int', false),
          column('products', 'sku', 'varchar', false),
          column('products', 'title', 'varchar', false),
        ]),
      },
      { name: 'open_orders', view: true, comment: '', columns: columns(ORDER_COLUMNS.slice(0, 3)) },
    ]
  }

  schemaDetail(database: string): Promise<SchemaDetail> {
    if (database !== 'shop') return Promise.resolve({ database, tables: [], foreignKeys: [] })
    return Promise.resolve({
      database,
      tables: this.demoTables().map((t) => ({ ...t, comment: '', columns: [] })),
      foreignKeys: [],
    })
  }

  tableColumns(database: string, names: string[]): Promise<TableColumns> {
    if (database !== 'shop') return Promise.resolve({ tables: [], foreignKeys: [] })
    return Promise.resolve({
      tables: this.demoTables().filter((t) => names.includes(t.name)),
      foreignKeys: names.includes('orders')
        ? [
            {
              table: 'orders',
              column: 'customer',
              refSchema: 'shop',
              refTable: 'customers',
              refColumn: 'name',
            },
          ]
        : [],
    })
  }

  describeTable(schema: string, table: string): Promise<TableDescription> {
    const description = DESCRIPTIONS[table]
    if (!description || schema !== 'shop') {
      return Promise.reject(new Error(`Table ${schema}.${table} was not found.`))
    }
    return Promise.resolve(description)
  }

  /**
   * Pretends to apply the batch. A value of `__conflict__` stands for a row that changed under the
   * editor, so the failure path can be tried. Everything else succeeds, with sequential insert ids.
   */
  applyEdits(batch: EditBatch): Promise<EditResult> {
    if (this.state.readOnly) {
      return Promise.resolve({
        ok: false,
        failedIndex: 0,
        code: 'READ_ONLY',
        message: 'This connection is read-only.',
      })
    }
    buildEditStatements(batch, {})
    const results: { affectedRows: number; insertId: string | null }[] = []
    let inserted = 0
    for (const [index, change] of batch.changes.entries()) {
      const values = change.kind === 'delete' ? {} : change.values
      if (Object.values(values).includes('__conflict__')) {
        return Promise.resolve({
          ok: false,
          failedIndex: index,
          code: 'ROW_COUNT',
          message:
            'That row no longer exists, or its key changed since it was loaded. Nothing was saved.',
        })
      }
      results.push({
        affectedRows: 1,
        insertId: change.kind === 'insert' ? String(10_000 + ++inserted) : null,
      })
    }
    return Promise.resolve({ ok: true, results })
  }

  setReadOnly(readOnly: boolean): Promise<void> {
    this.state = { ...this.state, readOnly }
    return Promise.resolve()
  }

  async *execute(request: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    signal.throwIfAborted()
    const sql = request.text.trim().replace(/;$/, '')
    if (request.target) this.state = { ...this.state, currentDatabase: request.target }

    const sleepFor = /^select\s+sleep\((\d+)\)/i.exec(sql)
    if (sleepFor) {
      yield { kind: 'columns', columns: [{ name: 'sleep', type: 'int' }] }
      await sleep(Number(sleepFor[1]) * 1000, signal)
      yield { kind: 'rows', rows: [[0]] }
      return
    }

    if (/^(insert|update|delete|create|drop|alter|truncate)\b/i.test(sql)) {
      if (this.state.readOnly) {
        throw Object.assign(
          new Error('This connection is read-only. Unlock writes to run this statement.'),
          { code: 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' },
        )
      }
      yield {
        kind: 'ok',
        affectedRows: 3,
        insertId: '1042',
        message: 'Rows matched: 3  Changed: 3  Warnings: 0',
        warnings: 0,
      }
      return
    }

    if (/\bbad\b/i.test(sql)) {
      throw Object.assign(new Error("Table 'shop.bad' doesn't exist"), { code: 'ER_NO_SUCH_TABLE' })
    }

    const big = /^select\s+n\s+from\s+big/i.test(sql)
    // A result that arrives slowly, so a long export can be watched and cancelled.
    const slow = /^select\s+n\s+from\s+slow_big/i.test(sql)
    const limit = /\blimit\s+(\d+)/i.exec(sql)
    const total = slow ? 100_000 : big ? 1_500_000 : limit ? Number(limit[1]) : 25
    const joined = /\bjoin\b/i.test(sql)
    const customers = /\bfrom\s+(`?\w+`?\.)?`?customers\b/i.test(sql)
    const wide = /\bfrom\s+(`?\w+`?\.)?`?wide\b/i.test(sql)

    let columns: ColumnInfo[]
    let makeRow: (i: number) => unknown[]
    if (big || slow) {
      columns = [{ name: 'n', type: 'int' }]
      makeRow = (i) => [i + 1]
    } else if (joined) {
      // Columns from two tables: a result that can be read but not edited.
      columns = [ORDER_COLUMNS[0]!, CUSTOMER_COLUMNS[1]!]
      makeRow = (i) => [i + 1, `Customer ${i + 1}`]
    } else if (wide) {
      columns = WIDE_COLUMNS
      makeRow = wideRow
    } else if (customers) {
      columns = CUSTOMER_COLUMNS
      makeRow = customerRow
    } else if (/^select\s+1\b/i.test(sql)) {
      // A computed column with no table behind it.
      columns = [{ name: '1', type: 'int' }]
      makeRow = () => [1]
    } else {
      columns = ORDER_COLUMNS
      makeRow = orderRow
    }
    yield { kind: 'columns', columns }

    for (let start = 0; start < total; start += 500) {
      signal.throwIfAborted()
      const rows: unknown[][] = []
      for (let i = start; i < Math.min(total, start + 500); i++) rows.push(makeRow(i))
      yield { kind: 'rows', rows }
      if (slow) await sleep(15, signal)
      // Let the event loop breathe so a cancel can get through.
      if (start % 50_000 === 0) await new Promise((resolve) => setImmediate(resolve))
    }
  }

  close(): Promise<void> {
    return Promise.resolve()
  }
}

export const demoDriver: Driver = {
  descriptor: mysqlDescriptor,
  connect: (context: ConnectContext) => Promise.resolve(new DemoSession(context.readOnly === true)),
}
