import { readFileSync } from 'node:fs'
import { crc32, inflateRawSync } from 'node:zlib'
import { wrap, type Check } from './smoke-library'

/**
 * The real app against a real MySQL or MariaDB server (`pnpm smoke:live`). The server is seeded by
 * `scripts/live-smoke.mjs`: a `dbide_live` schema with 50 customers and 300,000 orders whose values
 * follow a formula, so every check can say exactly what a row should hold.
 */

export interface LiveTarget {
  host: string
  port: number
  user: string
  password: string
}

export const liveScript = (target: LiveTarget): string =>
  wrap(
    `
    const q = String.fromCharCode(39)
    const bt = String.fromCharCode(96)
    const section = async (name, work) => {
      try {
        await work()
      } catch (error) {
        check(name + ' did not finish', false, error && error.message)
      }
    }
    const run = async (text, options = {}) => {
      const id = ui.createScript({ connectionId: options.connectionId || 'live-dev', database: options.database === undefined ? 'dbide_live' : options.database, text, name: options.name || 'live', run: true })
      await waitFor(() => scripts()[id] && scripts()[id].run && ['completed', 'error', 'cancelled'].includes(scripts()[id].run.state) || stmt0(id) && stmt0(id).status === 'paused', 'the run', options.timeout || 30000)
      return id
    }
    const done = async (id, timeout = 120000) => waitFor(() => stmt0(id) && ['done', 'error', 'cancelled'].includes(stmt0(id).status), 'the statement to finish', timeout)
    const pad = (n) => String(n).padStart(2, '0')
    const expectedRow = (i) => ({
      id: String(i + 1),
      customer_id: (i % 50) + 1,
      total: (((i * 37) % 100000) / 100).toFixed(2),
      status: ['new', 'paid', 'shipped'][i % 3],
      placed_at: '2026-03-' + pad((i % 28) + 1) + ' ' + pad(i % 24) + ':' + pad(i % 60) + ':00',
      meta: i % 5 === 0 ? null : '{"i": ' + i + '}',
      note: i % 3 === 0 ? null : 'note ' + i,
    })
    const sameAs = (row, i) => {
      const e = expectedRow(i)
      return String(row[0]) === e.id && row[1] === e.customer_id && String(row[2]) === e.total && row[3] === e.status && row[4] === e.placed_at && row[5] === e.meta && row[6] === e.note
    }

    const base = { tls: { enabled: false, allowInvalidCertificates: false }, options: {}, engine: 'mysql', host: ARGS.host, port: ARGS.port, username: ARGS.user }
    await call('connections.save', { config: { ...base, id: 'live-dev', name: 'Live dev', environment: 'dev' }, secrets: { password: ARGS.password } })
    await call('connections.save', { config: { ...base, id: 'live-prod', name: 'Live prod', environment: 'prod' }, secrets: { password: ARGS.password } })

    await section('the server', async () => {
      const dev = await call('sessions.open', { connectionId: 'live-dev' })
      const prod = await call('sessions.open', { connectionId: 'live-prod' })
      out.version = dev.serverVersion
      check('the app connects to a real server and reports its version', !/demo/.test(dev.serverVersion) && /[0-9]+[.][0-9]+/.test(dev.serverVersion) && dev.readOnly === false, dev.serverVersion)
      check('a production connection starts read-only', prod.readOnly === true)
      // MySQL before 5.6.5 has no read-only transactions: the driver guards writes, and says so once.
      const m = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)/.exec(dev.serverVersion) || []
      const weak = !/MariaDB/.test(dev.serverVersion) && (Number(m[1]) < 5 || (Number(m[1]) === 5 && (Number(m[2]) < 6 || (Number(m[2]) === 6 && Number(m[3]) < 5))))
      check('read-only is enforced by the server, or the person is told it is not', prod.readOnlyEnforcedByServer === !weak && (weak ? notice(/can’t enforce read-only itself/) : !notice(/enforce read-only/)), JSON.stringify(prod))
      const wrong = await call('connections.test', { config: { ...base, id: 'bad', name: 'Bad', environment: 'dev' }, secrets: { password: 'wrong-password' } })
      const auth = wrong.find((s) => s.id === 'auth')
      check('a wrong password fails at the login step, with the server’s words', auth && auth.status === 'failed' && /Access denied/i.test(auth.detail || ''), auth && auth.detail)
    })

    await section('the schema tree', async () => {
      const roots = await call('tree.children', { connectionId: 'live-dev', parent: null })
      const labels = roots.map((n) => n.label)
      check('the tree lists the seeded schema among the user schemas, system ones in a group', labels.includes('dbide_live') && labels.includes('System schemas') && !labels.includes('mysql'), labels.join(','))
      const schema = roots.find((n) => n.label === 'dbide_live')
      const groups = await call('tree.children', { connectionId: 'live-dev', parent: schema })
      const tablesGroup = groups.find((n) => n.label === 'Tables')
      const tables = await call('tree.children', { connectionId: 'live-dev', parent: tablesGroup })
      const orders = tables.find((n) => n.label === 'orders')
      check('tables carry an estimate and a size', tables.map((n) => n.label).join(',') === 'customers,nopk,orders' && /rows/.test(orders.detail) && orders.scope === 'dbide_live', tables.map((n) => n.label + ' ' + n.detail).join(' | '))
      const views = await call('tree.children', { connectionId: 'live-dev', parent: groups.find((n) => n.label === 'Views') })
      check('views are listed', views.map((n) => n.label).join(',') === 'paid_orders')
      const parts = await call('tree.children', { connectionId: 'live-dev', parent: orders })
      const columns = parts.filter((n) => n.kind === 'column').map((n) => n.label)
      check('a table shows its columns in order, then indexes and foreign keys', columns.join(',') === 'id,customer_id,total,status,placed_at,meta,note,token' && parts.slice(-2).map((n) => n.label).join(',') === 'Indexes,Foreign keys', columns.join(',') + ' / ' + parts.map((n) => n.label).join(','))
      const fkGroup = parts.find((n) => n.label === 'Foreign keys')
      const fks = await call('tree.children', { connectionId: 'live-dev', parent: fkGroup })
      check('the foreign key names where it points', fks.length === 1 && /fk_orders_customer/.test(fks[0].label) && /customers/.test(fks[0].detail || fks[0].label), JSON.stringify(fks))
      const completion = await call('schema.completion', { connectionId: 'live-dev', database: 'dbide_live' })
      check('autocomplete knows the tables and columns', completion.orders && completion.orders.includes('placed_at') && completion.customers.includes('email'))
      const description = await call('tables.describe', { connectionId: 'live-dev', schema: 'dbide_live', table: 'orders' })
      check('a table description has its key, column definitions, and foreign keys in both directions', description.primaryKey.join() === 'id' && description.columns.find((c) => c.name === 'id').autoIncrement === true && description.columns.find((c) => c.name === 'total').columnType === 'decimal(12,2)' && description.foreignKeys.length === 1 && description.foreignKeys[0].refTable === 'customers', JSON.stringify(description.foreignKeys))
      const customers = await call('tables.describe', { connectionId: 'live-dev', schema: 'dbide_live', table: 'customers' })
      check('and the other side knows who points at it', customers.referencedBy.length === 1 && customers.referencedBy[0].table === 'orders' && customers.referencedBy[0].columns.join() === 'customer_id', JSON.stringify(customers.referencedBy))
    })

    await section('values and types', async () => {
      const id = await run('SELECT * FROM dbide_live.orders ORDER BY id LIMIT 5000;')
      await waitFor(() => stmt0(id).status === 'paused', 'the first page')
      const set = stmt0(id).resultSets[0]
      const types = set.columns.map((c) => c.type).join(',')
      // JSON columns came with MySQL 5.7.8; before that, and on MariaDB, the column holds plain text.
      const v = /^([0-9]+)[.]([0-9]+)[.]([0-9]+)/.exec(out.version) || []
      const hasJson = !/MariaDB/.test(out.version) && (Number(v[1]) > 5 || (Number(v[1]) === 5 && (Number(v[2]) > 7 || (Number(v[2]) === 7 && Number(v[3]) >= 8))))
      check('column types come from the server', hasJson ? types === 'bigint,int,decimal,varchar,datetime,json,text,blob' : /^bigint,int,decimal,varchar,datetime,[a-z]*text,text,blob$/.test(types), types)
      check('plain columns know the table they come from', set.columns.every((c) => c.source && c.source.schema === 'dbide_live' && c.source.table === 'orders'))
      check('the first page is 1,000 rows, then it waits', set.store.length === 1000, set.store.length)
      const row0 = set.store.getRow(0)
      const row1 = set.store.getRow(1)
      check('values are exact: bigint and decimal as text, ints as numbers, dates as text', sameAs(row0, 0) && sameAs(row1, 1) && typeof row1[0] === 'string' && typeof row1[1] === 'number' && typeof row1[2] === 'string', JSON.stringify(row1))
      check('NULL, JSON text, and bytes arrive as they are', row0[5] === null && row0[6] === null && row0[7] instanceof Uint8Array && Array.from(row0[7]).join() === '222,173,190,239' && typeof row1[5] === 'string' && row1[7] === null, JSON.stringify([row0[5], row0[7] && Array.from(row0[7]), row1[5]]))
      ui.loadMore(id, 0, 'all')
      await done(id)
      check('load all streams the rest of 5,000 rows', stmt0(id).resultSets[0].store.length === 5000 && sameAs(stmt0(id).resultSets[0].store.getRow(4999), 4999))
    })

    await section('scripts', async () => {
      const multi = await run('SELECT 1 AS a; SELECT 2 AS b; SELECT COUNT(*) AS n FROM customers;')
      check('a script runs its statements one after another', scripts()[multi].run.statements.length === 3 && scripts()[multi].run.statements.every((s) => s.status === 'done') && String(scripts()[multi].run.statements[2].resultSets[0].store.getRow(0)[0]) === '50')

      const tempOwner = await run('CREATE TEMPORARY TABLE tmp_iso (a INT); INSERT INTO tmp_iso VALUES (1); SELECT * FROM tmp_iso;', { name: 'iso a' })
      const tempOther = await run('SELECT * FROM tmp_iso;', { name: 'iso b' })
      check('a temporary table lives in its own tab’s connection only', scripts()[tempOwner].run.state === 'completed' && scripts()[tempOther].run.state === 'error' && stmt0(tempOther).error.code === 'ER_NO_SUCH_TABLE', stmt0(tempOther).error && stmt0(tempOther).error.code)

      const bad = await run('SELECT * FROM dbide_live.nope;')
      check('an error keeps the server’s code and message', stmt0(bad).error.code === 'ER_NO_SUCH_TABLE' && /nope/.test(stmt0(bad).error.message), JSON.stringify(stmt0(bad).error))
      const syntax = await run('SELEC 1;')
      check('a syntax error says so, and the connection is fine afterwards', stmt0(syntax).error.code === 'ER_PARSE_ERROR' && scripts()[syntax].run.state === 'error')

      const slow = ui.createScript({ connectionId: 'live-dev', text: 'SELECT SLEEP(30);', name: 'slow', run: true })
      await waitFor(() => stmt0(slow) && stmt0(slow).status === 'running', 'the slow statement')
      await sleep(300)
      const started = Date.now()
      ui.cancelRun(slow)
      await waitFor(() => scripts()[slow].run.state === 'cancelled', 'the cancel', 8000)
      check('cancel kills a running statement on the server, and the run says cancelled', Date.now() - started < 4000 && stmt0(slow).status === 'cancelled', (Date.now() - started) + ' ms, ' + stmt0(slow).status)
      keyCode('Enter', mod())
      await waitFor(() => scripts()[slow].run && scripts()[slow].run.state === 'running' || stmt0(slow).status === 'running', 'the rerun')
      ui.cancelRun(slow)
      await waitFor(() => scripts()[slow].run.state === 'cancelled', 'the second cancel', 8000)
      const after = ui.createScript({ connectionId: 'live-dev', text: 'SELECT 1;', name: 'after', run: true })
      await waitFor(() => scripts()[after].run && scripts()[after].run.state === 'completed', 'a run after a cancel')
      check('a cancelled connection is clean for the next statement', true)

      const prodRead = await run('SELECT COUNT(*) FROM dbide_live.customers;', { connectionId: 'live-prod', name: 'prod read' })
      check('a read on a production connection runs', scripts()[prodRead].run.state === 'completed')
      const prodWrite = await run('DELETE FROM dbide_live.nopk WHERE a = 1;', { connectionId: 'live-prod', name: 'prod write' })
      check('a write on a locked production connection is refused before it is sent', stmt0(prodWrite).error.code === 'READ_ONLY')
      const seen = await call('query.run', { runId: 'direct-1', scriptId: 'direct-script-1', connectionId: 'live-prod', database: 'dbide_live', readOnly: true, statements: ['DELETE FROM nopk WHERE a = 1'], pageSize: 10 })
      check('and even sent straight to the server, a production session refuses to write', seen.outcome === 'error')
      const left = await run('SELECT COUNT(*) FROM dbide_live.nopk;', { name: 'nopk count' })
      check('nothing was deleted', String(stmt0(left).resultSets[0].store.getRow(0)[0]) === '3')
    })

    await section('a result of 300,000 rows', async () => {
      const started = Date.now()
      const id = await run('SELECT * FROM dbide_live.orders ORDER BY id;', { name: 'large' })
      await waitFor(() => stmt0(id).status === 'paused', 'the first page')
      const firstPage = Date.now() - started
      ui.loadMore(id, 0, 'all')
      await done(id, 180000)
      const store = stmt0(id).resultSets[0].store
      check('300,000 rows stream from the server: 100,000 stay in the window, 200,000 are held by the core', store.length === 300000 && store.rows.length === 100000 && store.spilled === 200000 && stmt0(id).truncated !== true, store.rows.length + ' + ' + store.spilled + '; first page in ' + firstPage + ' ms, all in ' + (Date.now() - started) + ' ms')
      store.getRow(250000)
      await waitFor(() => store.peekRow(250000), 'the page with row 250,000')
      check('a row the core holds has exactly the values the server sent', sameAs(store.peekRow(250000), 250000))
      store.getRow(299999)
      await waitFor(() => store.peekRow(299999), 'the last page')
      check('and so does the last one', sameAs(store.peekRow(299999), 299999))
      const totals = await store.heldTotals(100000, 299999, [{ index: 0, type: 'bigint' }])
      const expectedSum = (100001 + 300000) * 200000 / 2
      check('statistics over the held rows are exact, from text bigints', totals.numeric === 200000 && totals.sum === expectedSum && totals.min === 100001 && totals.max === 300000, JSON.stringify(totals))
      out.largeId = id
    })

    await section('export', async () => {
      const base = { exportId: 'live', connectionId: 'live-dev', database: 'dbide_live', sql: 'SELECT * FROM dbide_live.orders ORDER BY id' }
      const defaults = { header: true, delimiter: ',', nullText: '', quoteAll: false, bom: false, crlf: false, neutralizeFormulas: false, tableName: 'dbide_live.orders', rowsPerInsert: 100 }
      out.files = {}
      for (const [format, name] of [['csv', 'live.csv'], ['xlsx', 'live.xlsx'], ['json', 'live.json'], ['sql', 'live.sql']]) {
        const started = Date.now()
        const result = await call('export.run', { ...base, format, options: defaults, fileName: name })
        check('exports all 300,000 rows as ' + format, result.status === 'saved' && result.rows === 300000, result.rows + ' rows, ' + result.bytes + ' bytes, ' + (Date.now() - started) + ' ms')
        out.files[name] = result.path
      }
      try {
        await call('export.run', { ...base, sql: 'DELETE FROM dbide_live.nopk', format: 'csv', options: defaults, fileName: 'never.csv' })
        check('only a query that reads can be exported', false)
      } catch (error) {
        check('only a query that reads can be exported', error.code === 'NOT_A_QUERY', error.code)
      }
    })

    await section('following keys and generating statements', async () => {
      const id = await run('SELECT * FROM dbide_live.orders WHERE id <= 20 ORDER BY id;', { name: 'edit' })
      await done(id)
      const icon = await waitFor(() => vis('.grid-head-fk'), 'the foreign key marker')
      check('the foreign key column is marked from what the server says', visAll('.grid-head-fk').length === 1 && icon.dataset.fk === '1')
      await waitFor(() => byText('.workbench-sql:not([hidden]) button', 'Add row'), 'the edit bar')

      down(cell(2, 1))
      down(cell(2, 1), mod())
      const jumped = await waitFor(() => Object.values(scripts()).find((s) => s.text === 'SELECT * FROM ' + bt + 'dbide_live' + bt + '.' + bt + 'customers' + bt + ' WHERE ' + bt + 'id' + bt + ' = 3 LIMIT 1000;'), 'the referenced row to open')
      await waitFor(() => stmt0(jumped.id) && stmt0(jumped.id).status === 'done', 'its result')
      const customer = stmt0(jumped.id).resultSets[0].store.getRow(0)
      check('command-click runs the lookup on the server and finds the customer', stmt0(jumped.id).resultSets[0].store.length === 1 && customer[1] === 'customer 3' && customer[2] === 'c3@example.com', JSON.stringify(customer))

      const customers = await run('SELECT * FROM dbide_live.customers ORDER BY id LIMIT 5;', { name: 'customers' })
      await waitFor(() => vis('.grid-head-fk'), 'the marker on the referenced column')
      down(cell(1, 0))
      await sleep(150)
      ui.commands.execute('grid.findReferencingRows')
      const back = await waitFor(() => Object.values(scripts()).find((s) => s.text.includes('WHERE ' + bt + 'customer_id' + bt + ' = 2')), 'the referencing rows to open')
      await waitFor(() => stmt0(back.id) && ['paused', 'done'].includes(stmt0(back.id).status), 'their result')
      const first = stmt0(back.id).resultSets[0].store.getRow(0)
      check('finding the rows that point at a customer returns that customer’s orders', stmt0(back.id).resultSets[0].store.length === 1000 && stmt0(back.id).resultSets[0].store.getRow(999)[1] === 2 && first[1] === 2, JSON.stringify(first))

      // Generated statements run on the server
      ui.useWorkbench.getState().activate('sql:' + id)
      await sleep(200)
      down(cell(1, 3))
      down(cell(2, 4), { shiftKey: true })
      await sleep(150)
      ui.commands.execute('grid.copySqlUpdate')
      await waitFor(() => notice(/Copied 2 UPDATE statements/), 'the copy')
      const generated = window.__dbide_clipboard
      check('UPDATE statements for the selected cells name the table, columns and key', generated === 'UPDATE ' + bt + 'dbide_live' + bt + '.' + bt + 'orders' + bt + ' SET ' + bt + 'status' + bt + ' = ' + q + 'paid' + q + ', ' + bt + 'placed_at' + bt + ' = ' + q + '2026-03-02 01:01:00' + q + ' WHERE ' + bt + 'id' + bt + ' = 2;' + NL + 'UPDATE ' + bt + 'dbide_live' + bt + '.' + bt + 'orders' + bt + ' SET ' + bt + 'status' + bt + ' = ' + q + 'shipped' + q + ', ' + bt + 'placed_at' + bt + ' = ' + q + '2026-03-03 02:02:00' + q + ' WHERE ' + bt + 'id' + bt + ' = 3;', generated)
      const applied = await run(generated, { name: 'generated' })
      check('and run on the server, each matches exactly the one row it names', scripts()[applied].run.statements.length === 2 && scripts()[applied].run.statements.every((s) => s.status === 'done' && s.ok && s.ok.affectedRows === 1), JSON.stringify(scripts()[applied].run.statements.map((s) => s.ok)))
    })

    await section('editing rows', async () => {
      const id = await run('SELECT * FROM dbide_live.orders WHERE id <= 20 ORDER BY id;', { name: 'edit rows' })
      await done(id)
      await waitFor(() => byText('.workbench-sql:not([hidden]) button', 'Add row'), 'the edit bar')
      const resultId = stmt0(id).resultSets[0].id
      const input = () => vis('.field-editor input')
      dbl(cell(1, 3))
      await waitFor(input, 'the cell editor')
      setValue(input(), 'refunded')
      press(input(), 'Enter')
      await waitFor(() => visAll('.edit-count').length === 1, 'the staged change')
      check('a typed value is staged, not saved', ui.useEdits.getState().sets[resultId] !== undefined)
      keyCode('KeyS', mod())
      await waitFor(() => !ui.useEdits.getState().sets[resultId], 'the commit')
      const check1 = await run('SELECT status FROM dbide_live.orders WHERE id = 2;', { name: 'verify edit' })
      check('the commit shortcut saves it on the server', stmt0(check1).resultSets[0].store.getRow(0)[0] === 'refunded', JSON.stringify(stmt0(check1).resultSets[0].store.getRow(0)))

      // A batch with a delete, an update and an insert, in one transaction
      const batch = { schema: 'dbide_live', table: 'orders', changes: [
        { kind: 'delete', key: { id: '4' } },
        { kind: 'update', key: { id: '3' }, values: { note: 'changed by a batch' } },
        { kind: 'insert', values: { customer_id: 1, total: '9.99', status: 'new', placed_at: '2026-04-01 00:00:00' } },
      ] }
      const applied = await call('edits.apply', { connectionId: 'live-dev', scriptId: id, batch })
      check('a batch applies in one transaction and reports the new key', applied.ok === true && applied.results.length === 3 && applied.results[0].affectedRows === 1 && applied.results[2].insertId === '300001', JSON.stringify(applied))
      const verify = await run('SELECT id, note FROM dbide_live.orders WHERE id IN (3, 4, 300001) ORDER BY id;', { name: 'verify batch' })
      const rows = stmt0(verify).resultSets[0].store.rows.map((r) => String(r[0]) + ':' + r[1])
      check('the server has all three changes', rows.join('|') === '3:changed by a batch|300001:null', rows.join('|'))

      const conflict = await call('edits.apply', { connectionId: 'live-dev', scriptId: id, batch: { schema: 'dbide_live', table: 'orders', changes: [
        { kind: 'update', key: { id: '5' }, values: { note: 'must not stick' } },
        { kind: 'update', key: { id: '99999999' }, values: { note: 'no such row' } },
      ] } })
      check('a change that hits no row fails the whole batch', conflict.ok === false && conflict.failedIndex === 1 && /Nothing was saved/.test(conflict.message), JSON.stringify(conflict))
      const untouched = await run('SELECT note FROM dbide_live.orders WHERE id = 5;', { name: 'verify rollback' })
      check('and the first change was rolled back', stmt0(untouched).resultSets[0].store.getRow(0)[0] === 'note 4', JSON.stringify(stmt0(untouched).resultSets[0].store.getRow(0)))

      const violation = await call('edits.apply', { connectionId: 'live-dev', scriptId: id, batch: { schema: 'dbide_live', table: 'orders', changes: [
        { kind: 'insert', values: { customer_id: 424242, total: '1.00', status: 'new', placed_at: '2026-04-01 00:00:00' } },
      ] } })
      check('a foreign key violation comes back with the server’s code', violation.ok === false && violation.code === 'ER_NO_REFERENCED_ROW_2', JSON.stringify(violation))
    })

    await section('history', async () => {
      const entries = (await call('history.list', { limit: 500 })).entries
      const nope = entries.find((e) => /dbide_live.nope/.test(e.sql))
      const sleep30 = entries.find((e) => /SLEEP\\(30\\)/.test(e.sql) && e.status === 'cancelled')
      check('the history has the failure with its server code, and the cancel', nope && nope.status === 'error' && nope.errorCode === 'ER_NO_SUCH_TABLE' && nope.connectionName === 'Live dev' && sleep30, entries.length + ' entries')
      check('the production read is marked as production', entries.some((e) => e.connectionName === 'Live prod' && e.environment === 'prod' && e.status === 'ok'))
    })
`,
    { ...target },
  )

/** The mini zip reader the smoke test uses to read back an .xlsx. */
function unzip(file: Buffer): Map<string, string> {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const count = file.readUInt16LE(end + 10)
  let at = file.readUInt32LE(end + 16)
  const parts = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const crc = file.readUInt32LE(at + 16)
    const compressed = file.readUInt32LE(at + 20)
    const nameLength = file.readUInt16LE(at + 28)
    const extra = file.readUInt16LE(at + 30) + file.readUInt16LE(at + 32)
    const offset = file.readUInt32LE(at + 42)
    const name = file.subarray(at + 46, at + 46 + nameLength).toString('utf8')
    at += 46 + nameLength + extra
    const start = offset + 30 + file.readUInt16LE(offset + 26) + file.readUInt16LE(offset + 28)
    const data = inflateRawSync(file.subarray(start, start + compressed))
    if (crc32(data) !== crc) throw new Error(`${name} does not match its checksum`)
    parts.set(name, data.toString('utf8'))
  }
  return parts
}

/** Reads what the live export wrote, the way another program would. */
export function verifyLiveFiles(files: Record<string, string>): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  }
  const text = (name: string): string => {
    const path = files[name]
    if (!path) return ''
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return ''
    }
  }

  const csv = text('live.csv').split('\n')
  check(
    'csv: a header, 300,000 rows, and each row as the server holds it',
    csv.length === 300_002 &&
      csv[0] === 'id,customer_id,total,status,placed_at,meta,note,token' &&
      csv[1] === '1,1,0.00,new,2026-03-01 00:00:00,,,0xdeadbeef' &&
      csv[2] === '2,2,0.37,paid,2026-03-02 01:01:00,"{""i"": 1}",note 1,' &&
      csv[300_000] ===
        '300000,50,' +
          (((299_999 * 37) % 100_000) / 100).toFixed(2) +
          ',shipped,2026-03-' +
          String((299_999 % 28) + 1).padStart(2, '0') +
          ' ' +
          String(299_999 % 24).padStart(2, '0') +
          ':' +
          String(299_999 % 60).padStart(2, '0') +
          ':00,"{""i"": 299999}",note 299999,',
    `${csv.length} lines; ${csv[1]}`,
  )

  try {
    const sheet = unzip(readFileSyncSafe(files['live.xlsx'])).get('xl/worksheets/sheet1.xml') ?? ''
    check(
      'xlsx: 300,001 rows, bigint ids and decimals as exact numbers, the blob as hex text',
      (sheet.match(/<row /g) ?? []).length === 300_001 &&
        sheet.includes('<c r="A2"><v>1</v></c>') &&
        sheet.includes('<c r="C3"><v>0.37</v></c>') &&
        sheet.includes('<c r="H2" t="inlineStr"><is><t>0xdeadbeef</t></is></c>'),
      sheet.slice(0, 300),
    )
  } catch (error) {
    check('xlsx: the file reads back', false, String(error))
  }

  try {
    const json = JSON.parse(text('live.json')) as Record<string, unknown>[]
    check(
      'json: 300,000 objects, NULL as null, ids and decimals as exact numbers',
      json.length === 300_000 &&
        json[0]!.note === null &&
        json[1]!.id === 2 &&
        json[1]!.total === 0.37 &&
        json[299_999]!.id === 300_000,
      JSON.stringify(json[1]),
    )
  } catch (error) {
    check('json: the file reads back', false, String(error))
  }

  const sql = text('live.sql')
  check(
    'sql: INSERT statements of 100 rows, names quoted, bytes as hex, NULL as NULL',
    sql.startsWith(
      "INSERT INTO `dbide_live`.`orders` (`id`, `customer_id`, `total`, `status`, `placed_at`, `meta`, `note`, `token`) VALUES\n  (1, 1, 0.00, 'new', '2026-03-01 00:00:00', NULL, NULL, 0xdeadbeef),",
    ) && sql.split('INSERT INTO ').length - 1 === 3000,
    sql.slice(0, 200),
  )
  return checks
}

function readFileSyncSafe(path: string | undefined): Buffer {
  if (!path) throw new Error('no file')
  return readFileSync(path)
}
