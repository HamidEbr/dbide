import { wrap } from './smoke-library'

/**
 * The real app against a real MongoDB server (`pnpm smoke:mongo`). `scripts/mongo-smoke.mjs` seeds a
 * `dbide_mongo_live` database with 2,000 orders whose values follow a formula, so every check can say
 * exactly what a document should hold, then boots the built app and drives it the way a person would:
 * the tree, queries, the table and tree views, the inspector, editing, saving, cancelling and locks.
 */

export interface MongoTarget {
  host: string
  port: number
  username?: string
  password?: string
  options?: Record<string, string>
}

export const mongoScript = (target: MongoTarget): string =>
  wrap(
    `
    const q = String.fromCharCode(39)
    const section = async (name, work) => {
      try {
        await work()
      } catch (error) {
        check(name + ' did not finish', false, error && error.message)
      }
    }
    const finished = (id) => stmt0(id) && ['done', 'error', 'cancelled', 'paused'].includes(stmt0(id).status)
    const run = async (text, options = {}) => {
      const id = ui.createScript({ connectionId: options.connectionId || 'mongo-dev', database: options.database === undefined ? 'dbide_mongo_live' : options.database, text, name: options.name || 'mongo', run: true })
      await waitFor(() => finished(id) || (scripts()[id] && scripts()[id].run && scripts()[id].run.state === 'error'), 'the run', options.timeout || 30000)
      return id
    }
    const docs = (id, set = 0) => {
      const store = stmt0(id).resultSets[set].store
      const out = []
      for (let i = 0; i < store.length; i++) out.push(JSON.parse(store.getRow(i)[0]))
      return out
    }
    const num = (value) => Number((value && (value.$numberInt || value.$numberLong || value.$numberDouble)) || value)
    const orderOf = (i) => ({
      customer: (i % 50) + 1,
      status: ['new', 'paid', 'shipped'][i % 3],
      total: ((i * 37) % 100000) / 100 + 0.5,
      note: i % 3 === 0 ? undefined : 'note ' + i,
    })
    const gridCell = (r, c) => vis('.doc-table [data-r="' + r + '"][data-c="' + c + '"]')
    /** Only the columns on screen are drawn, so a column off to the right is scrolled to first. */
    const cellAt = async (r, c) => {
      const grid = vis('.doc-table')
      for (const left of [0, 300, 600, 900, 1200, 1500, 1800, 2100]) {
        if (gridCell(r, c)) break
        grid.scrollLeft = left
        await sleep(60)
      }
      const found = gridCell(r, c)
      return found
    }
    const columnNames = async () => {
      const grid = vis('.doc-table')
      const names = []
      for (const left of [0, 300, 600, 900, 1200, 1500, 1800, 2100]) {
        grid.scrollLeft = left
        await sleep(60)
        for (const el of visAll('.doc-table .grid-head-name')) if (!names.includes(el.textContent)) names.push(el.textContent)
      }
      grid.scrollLeft = 0
      await sleep(60)
      return names
    }
    /** Asks the main process for a picture, when the run was started to take them. */
    const shot = async (name) => {
      document.title = 'SHOT:' + name
      await sleep(500)
      document.title = 'DBIDE'
    }
    const barText = () => vis('.doc-result .edit-bar').textContent
    const gutter = (r) => visAll('.doc-table .grid-row')[r] && visAll('.doc-table .grid-row')[r].querySelector('.grid-gutter')
    const radio = (label) => byText('.workbench-sql:not([hidden]) .doc-result .segmented button', label)

    const base = { tls: { enabled: false, allowInvalidCertificates: false }, options: ARGS.options || {}, engine: 'mongodb', host: ARGS.host, port: ARGS.port, ...(ARGS.username ? { username: ARGS.username } : {}) }
    const secrets = ARGS.password ? { password: ARGS.password } : {}
    await call('connections.save', { config: { ...base, id: 'mongo-dev', name: 'Mongo dev', environment: 'dev' }, secrets })
    await call('connections.save', { config: { ...base, id: 'mongo-prod', name: 'Mongo prod', environment: 'prod' }, secrets })

    await section('the server', async () => {
      const dev = await call('sessions.open', { connectionId: 'mongo-dev' })
      const prod = await call('sessions.open', { connectionId: 'mongo-prod' })
      out.version = dev.serverVersion
      check('the app connects to a real server and reports its version', /^[0-9]+[.][0-9]+/.test(dev.serverVersion) && dev.readOnly === false, JSON.stringify(dev))
      check('a production connection starts read-only, and the person is told MongoDB can not enforce that', prod.readOnly === true && prod.readOnlyEnforcedByServer === false && notice(/can.t hold a connection read-only/), JSON.stringify(prod))
      const steps = await call('connections.test', { config: { ...base, id: 'probe', name: 'Probe', environment: 'dev' }, secrets })
      check('the connection test passes every step against the real server', steps.every((s) => s.status === 'ok' || s.status === 'skipped') && steps.find((s) => s.id === 'auth').status === 'ok', JSON.stringify(steps.map((s) => s.id + ':' + s.status)))
      const unreachable = await call('connections.test', { config: { ...base, id: 'probe2', name: 'Probe', environment: 'dev', port: 1, options: {} }, secrets })
      check('an unreachable server fails at the connection step', unreachable.find((s) => s.id === 'tcp').status === 'failed', JSON.stringify(unreachable.map((s) => s.id + ':' + s.status)))
    })

    await section('the tree', async () => {
      const roots = await call('tree.children', { connectionId: 'mongo-dev', parent: null })
      const db = roots.find((n) => n.label === 'dbide_mongo_live')
      check('the tree lists the seeded database, with the system databases in a group', db && db.kind === 'database' && roots.some((n) => n.label === 'System databases') && !roots.some((n) => n.label === 'admin'), roots.map((n) => n.label).join(','))
      const collections = await call('tree.children', { connectionId: 'mongo-dev', parent: db })
      const orders = collections.find((n) => n.label === 'orders')
      check('collections carry their document counts and a view is marked', orders && orders.kind === 'collection' && orders.detail === '2.0K' && collections.some((n) => n.label === 'paid_orders' && n.kind === 'view'), collections.map((n) => n.label + ' ' + n.detail).join(' | '))
      const indexes = await call('tree.children', { connectionId: 'mongo-dev', parent: orders })
      check('a collection lists its indexes', indexes.map((n) => n.label).sort().join(',') === '_id_,status_1', indexes.map((n) => n.label).join(','))
      const completion = await call('schema.completion', { connectionId: 'mongo-dev', database: 'dbide_mongo_live' })
      const fields = await call('schema.fields', { connectionId: 'mongo-dev', database: 'dbide_mongo_live', collection: 'orders' })
      check('autocomplete knows the collections and the fields of one', Object.keys(completion).includes('orders') && fields.includes('status') && fields.includes('meta.nested.ok'), fields.join(','))
    })

    await section('a query and its documents', async () => {
      const id = await run('db.orders.find({}).sort({ _id: 1 })', { name: 'orders' })
      await waitFor(() => stmt0(id).status === 'paused', 'the first page')
      const set = stmt0(id).resultSets[0]
      check('the result is documents in one column, tied to their collection', set.columns.length === 1 && set.columns[0].type === 'document' && set.columns[0].source && set.columns[0].source.table === 'orders' && set.columns[0].source.schema === 'dbide_mongo_live', JSON.stringify(set.columns))
      check('the first page is 1,000 documents, then it waits', set.store.length === 1000)
      const first = JSON.parse(set.store.getRow(0)[0])
      const second = JSON.parse(set.store.getRow(1)[0])
      check('values keep their BSON types', first._id.$numberInt === '1' && typeof first.status === 'string' && first.placed.$date && Array.isArray(first.tags) && second.meta.i && second.total.$numberDouble !== undefined, JSON.stringify(second))
      await waitFor(() => gridCell(0, 0), 'the table', 6000)
      const names = await columnNames()
      check('the table view is drawn with one column per field, _id first', names.join(',') === '_id,customer,status,total,placed,tags,meta,note', names.join(','))
      const shown = []
      for (const c of [2, 5, 6, 0, 7]) shown.push((await cellAt(1, c)).textContent)
      check('a row shows its values: text as is, containers by size, ids plain', shown.slice(0, 4).join('|') === 'paid|[ 2 items ]|{ 2 fields }|2', shown.join(' | '))
      check('a field a document does not have is left empty', (await cellAt(0, 7)).textContent === '' && shown[4] === 'note 1')
      vis('.doc-table').scrollLeft = 0
      await sleep(60)
      check('the summary counts documents, not rows', /1,000 documents loaded/.test(vis('.result-summary').textContent), vis('.result-summary').textContent)
      check('there is no SQL export for documents', !byText('.workbench-sql:not([hidden]) .result-summary button', 'Export'))

      await shot('1-table')
      down(gridCell(1, 2))
      const inspector = await waitFor(() => document.querySelector('.doc-inspector .doc-json'), 'the document in the inspector')
      await shot('2-table-inspector')
      check('selecting a document shows it in the inspector, as text for the shell', /status: "paid"/.test(inspector.textContent) && /customer: 2/.test(inspector.textContent) && /placed: ISODate\\("2026-03-02T01:01:00.000Z"\\)/.test(inspector.textContent), inspector.textContent.slice(0, 200))
      check('and says which document it is', /Document 2 of 1,000/.test(document.querySelector('.doc-inspector-title').textContent))

      radio('Tree').click()
      await waitFor(() => vis('.doc-tree'), 'the tree view')
      await sleep(200)
      check('the tree view lists the documents, the first one open', visAll('.doc-row-head').length > 5 && visAll('.doc-row-field').length >= 7, visAll('.doc-row-head').length + ' docs, ' + visAll('.doc-row-field').length + ' fields')
      const nested = visAll('.doc-row-field').find((r) => r.textContent.startsWith('meta'))
      check('a field shows its value and its type', nested && /2 fields/.test(nested.textContent) && /Object/.test(nested.textContent), nested && nested.textContent)
      nested.querySelector('.doc-chevron').click()
      await waitFor(() => visAll('.doc-row-field').some((r) => r.textContent.startsWith('nested')), 'the nested document to open')
      check('nested documents open in place', true)
      await shot('3-tree')
      radio('Table').click()
      await waitFor(() => vis('.doc-table'), 'the table again')

      ui.loadMore(id, 0, 'all')
      await waitFor(() => stmt0(id).status === 'done', 'every document', 60000)
      check('load all streams every document', stmt0(id).resultSets[0].store.length === 2000)
      const last = JSON.parse(stmt0(id).resultSets[0].store.getRow(1999)[0])
      check('the last one is the one the formula says', num(last._id) === 2000 && last.status === orderOf(1999).status && num(last.customer) === orderOf(1999).customer, JSON.stringify(last))
    })

    await section('editing a document', async () => {
      const id = await run('db.orders.find({ _id: { $lte: 5 } }).sort({ _id: 1 })', { name: 'edit' })
      await waitFor(() => vis('.doc-table [data-r="0"]'), 'the table')
      check('a plain find can be edited and says how', /Double-click a cell/.test(vis('.doc-result .edit-bar').textContent) && !/Read-only result/.test(vis('.doc-result .edit-bar').textContent), vis('.doc-result .edit-bar').textContent)

      dbl(gridCell(1, 2))
      const input = await waitFor(() => vis('.doc-cell-editor input'), 'the cell editor')
      check('a cell opens as text in the shell notation, strings with their quotes', input.value === '"paid"', input.value)
      setValue(input, '"shipped by smoke"')
      press(input, 'Enter')
      await waitFor(() => ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], 'the staged change')
      await waitFor(() => !vis('.doc-cell-editor'), 'the editor to close')
      check('the edit is staged, not saved, and the cell shows it marked', gridCell(1, 2).textContent === 'shipped by smoke' && gridCell(1, 2).classList.contains('cell-changed') && /1 unsaved change/.test(vis('.doc-result .edit-bar').textContent), gridCell(1, 2).textContent)
      const stored = await run('db.orders.find({ _id: 2 })', { name: 'check' })
      check('nothing reached the server yet', docs(stored)[0].status === 'paid')
      ui.useWorkbench.getState().activate('sql:' + id)
      await sleep(200)

      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Review commands').click()
      const preview = await waitFor(() => vis('.edit-preview'), 'the review')
      await shot('4-staged-review')
      check('the review shows the command that will run', /db[.]orders[.]updateOne[(][{] _id: 2 [}], [{] [$]set: [{] status: "shipped by smoke" [}] [}][)]/.test(preview.textContent), preview.textContent)

      // A cell that can not be edited
      dbl(gridCell(1, 0))
      await sleep(100)
      check('the _id of a document can not be edited', !vis('.doc-cell-editor') && notice(/_id of a document can.t be changed/))

      // A value that does not read
      dbl(gridCell(2, 1))
      const bad = await waitFor(() => vis('.doc-cell-editor input'), 'the second editor')
      setValue(bad, 'ObjectId(' + q + 'nope' + q + ')')
      press(bad, 'Enter')
      await waitFor(() => vis('.doc-cell-error'), 'the error')
      check('a value that does not read says why and stays open', /24 hexadecimal/.test(vis('.doc-cell-error').textContent) && vis('.doc-cell-editor input'))
      press(vis('.doc-cell-editor input'), 'Escape')
      await waitFor(() => !vis('.doc-cell-editor'), 'the editor to close')

      // Through the inspector, with the whole document as text
      down(gridCell(3, 2))
      await waitFor(() => document.querySelector('.doc-inspector .doc-json') && /Document 4/.test(document.querySelector('.doc-inspector-title').textContent), 'the fourth document')
      byText('.doc-inspector-bar button', 'Edit').click()
      const editor = await waitFor(() => document.querySelector('.doc-editor .cm-content'), 'the document editor')
      await sleep(200)
      await shot('5-edit-document')
      editor.focus()
      document.execCommand('selectAll')
      document.execCommand('insertText', false, '{ _id: 4, customer: 99, status: "paid", flag: true, nested: { a: 1 } }')
      await waitFor(() => /Changes: /.test(document.querySelector('.doc-editor-status').textContent), 'the summary of changes')
      check('the editor says which fields the edit changes', /customer/.test(document.querySelector('.doc-editor-status').textContent) && /flag/.test(document.querySelector('.doc-editor-status').textContent) && /total/.test(document.querySelector('.doc-editor-status').textContent), document.querySelector('.doc-editor-status').textContent)
      byText('.doc-editor-actions button', 'Stage change').click()
      await waitFor(() => /2 unsaved changes/.test(vis('.doc-result .edit-bar').textContent), 'the second staged change')
      check('staging an edit keeps it with the others', true)

      // Mark one for deletion, then change our mind
      down(gutter(4))
      await sleep(150)
      press(vis('.doc-table'), 'Delete')
      await waitFor(() => vis('.doc-table .row-deleted'), 'the row marked for deletion')
      check('Delete marks the document, which is struck through, and counts as a change', /3 unsaved changes/.test(barText()), barText() + ' ' + JSON.stringify(Object.values(ui.useDocumentEdits.getState().byOwner).map((e) => ({ updates: Object.keys(e.updates), deletes: Object.keys(e.deletes) }))))
      await sleep(100)
      press(vis('.doc-table'), 'Delete')
      await waitFor(() => !vis('.doc-table .row-deleted'), 'the mark to go')
      check('Delete again takes the mark back', /2 unsaved changes/.test(barText()), barText())

      // Save
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Save').click()
      await waitFor(() => !ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], 'the save', 15000)
      check('Save applies every staged change and clears them', !notice(/rolled back|failed/i))
      const after = docs(await run('db.orders.find({ _id: { $in: [2, 4] } }).sort({ _id: 1 })', { name: 'after' }))
      check('the server holds the cell edit, and the rest of that document is untouched', after[0].status === 'shipped by smoke' && num(after[0].customer) === 2 && num(after[0].total) === orderOf(1).total && after[0].meta.i && after[0].tags.length === 2 && after[0].note === 'note 1', JSON.stringify(after[0]))
      check('the edited text replaced the other document: its new fields are there and the ones it left out are gone', after[1].flag === true && num(after[1].customer) === 99 && after[1].nested.a && after[1].total === undefined && after[1].meta === undefined && after[1].placed === undefined, JSON.stringify(after[1]))
      ui.useWorkbench.getState().activate('sql:' + id)
      check('the rows on screen were refreshed from what the server stored', await waitFor(() => gridCell(1, 2) && gridCell(1, 2).textContent === 'shipped by smoke' && gridCell(3, 1).textContent === '99', 'the rows to refresh', 6000))

      // A new document
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Add document').click()
      const draft = await waitFor(() => document.querySelector('.doc-editor .cm-content'), 'the editor for the new document')
      draft.focus()
      document.execCommand('selectAll')
      document.execCommand('insertText', false, '{ _id: 9001, status: "made by smoke", customer: 1 }')
      await sleep(100)
      byText('.doc-editor-actions button', 'Stage change').click()
      await waitFor(() => /1 unsaved change/.test(vis('.doc-result .edit-bar').textContent), 'the staged insert')
      check('a new document appears as the last row, marked new', visAll('.doc-table .row-new').length === 1)
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Save').click()
      await waitFor(() => !ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], 'the insert to save', 15000)
      const made = docs(await run('db.orders.find({ _id: 9001 })', { name: 'made' }))
      check('the new document is saved', made.length === 1 && made[0].status === 'made by smoke')
      ui.useWorkbench.getState().activate('sql:' + id)
      await waitFor(() => visAll('.doc-table .grid-row').length === 6, 'the saved document to be a row')
      check('and it stays in the table as an ordinary row', !visAll('.doc-table .row-new').length)

      // Delete it again, saved
      down(gutter(5))
      await sleep(150)
      press(vis('.doc-table'), 'Delete')
      await waitFor(() => vis('.doc-table .row-deleted'), 'the row marked')
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Save').click()
      await waitFor(() => !ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], 'the delete to save', 15000)
      const gone = docs(await run('db.orders.countDocuments({ _id: 9001 })', { name: 'gone' }))
      check('a saved delete removes the document, and its row leaves the table', num(gone[0]) === 0)
      ui.useWorkbench.getState().activate('sql:' + id)
      check('the row is gone from the table', await waitFor(() => stmt0(id).resultSets[0].store.length === 5, 'the row to leave', 6000))

      // Someone else changed the document first
      dbl(gridCell(0, 2))
      const racing = await waitFor(() => vis('.doc-cell-editor input'), 'the editor for the race')
      setValue(racing, '"edited"')
      press(racing, 'Enter')
      await waitFor(() => /1 unsaved change/.test(vis('.doc-result .edit-bar').textContent), 'the staged edit')
      await call('connections.get', { id: 'mongo-dev' })
      await run('db.orders.deleteOne({ _id: 1 })', { name: 'removed elsewhere' })
      ui.useWorkbench.getState().activate('sql:' + id)
      await sleep(250)
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Save').click()
      await waitFor(() => vis('.edit-error'), 'the error', 10000)
      check('saving a document that was removed meanwhile says so, and keeps the edit', /no longer exists/.test(vis('.edit-error').textContent) && ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], vis('.edit-error').textContent)
      byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Discard').click()
      await waitFor(() => !ui.useDocumentEdits.getState().byOwner[stmt0(id).resultSets[0].id], 'the discard')
      check('Discard drops what was staged', true)
    })

    await section('what can not be edited', async () => {
      const aggregated = await run('db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])', { name: 'aggregate' })
      await waitFor(() => vis('.doc-table [data-r="0"]'), 'the aggregation table')
      await shot('6-aggregate-readonly')
      check('an aggregation is read-only, and says why', /Read-only result/.test(barText()) && (await columnNames()).join(',') === '_id,n', barText())
      // The orders were seeded 667 new, 667 paid, 666 shipped. The edits above moved one paid order to
      // another status, turned one new order paid, and one new order was deleted.
      const groups = Object.fromEntries(docs(aggregated).map((d) => [d._id, num(d.n)]))
      check('and its groups are right', JSON.stringify(groups) === JSON.stringify({ new: 665, paid: 667, shipped: 666, 'shipped by smoke': 1 }), JSON.stringify(groups))

      const counted = await run('db.orders.countDocuments({ status: "paid" })', { name: 'count' })
      await waitFor(() => vis('.doc-table [data-r="0"]'), 'the count')
      check('a count is a single value in a column of its own', (await columnNames()).join(',') === 'value' && gridCell(0, 0).textContent === '667', gridCell(0, 0) && gridCell(0, 0).textContent)

      const unlocked = await run('db.orders.find({ _id: 3 })', { name: 'locked', connectionId: 'mongo-prod' })
      await waitFor(() => vis('.doc-table [data-r="0"]'), 'the prod table')
      check('a production result is locked and offers to unlock', /Editing is locked/.test(vis('.doc-result .edit-bar').textContent) && byText('.workbench-sql:not([hidden]) .doc-result .edit-bar button', 'Unlock'))
    })

    await section('errors, cancel and locks', async () => {
      const syntax = await run('db.orders.find({ a: ObjectId(' + q + 'zz' + q + ') })', { name: 'syntax' })
      await shot('7-syntax-error')
      check('a value that can not be built is reported with its place, before anything is sent', stmt0(syntax).status === 'error' && stmt0(syntax).error.code === 'SYNTAX_ERROR' && /24 hexadecimal.*line 1, column/.test(stmt0(syntax).error.message), JSON.stringify(stmt0(syntax).error))
      const refused = await run('db.orders.find({ $badOperator: 1 })', { name: 'refused' })
      check('the server’s own words come through for a query it refuses', stmt0(refused).status === 'error' && /unknown top level operator/i.test(stmt0(refused).error.message), JSON.stringify(stmt0(refused).error))
      const loops = await run('db.orders.find().forEach(printjson)', { name: 'loop' })
      check('what the shell does but DBIDE does not is named', stmt0(loops).error.code === 'NOT_SUPPORTED' && /loop/.test(stmt0(loops).error.message), JSON.stringify(stmt0(loops).error))

      const blocked = await run('db.orders.deleteMany({})', { name: 'blocked', connectionId: 'mongo-prod' })
      check('a write on a locked production connection is stopped before it is sent', stmt0(blocked).status === 'error' && stmt0(blocked).error.code === 'READ_ONLY' && /read-only/.test(stmt0(blocked).error.message), JSON.stringify(stmt0(blocked).error))
      const stillThere = docs(await run('db.orders.countDocuments({})', { name: 'still there' }))
      check('and nothing was deleted', num(stillThere[0]) === 1999, JSON.stringify(stillThere))

      const slow = ui.createScript({ connectionId: 'mongo-dev', database: 'dbide_mongo_live', text: 'db.orders.find({ $where: "sleep(30000) || true" })', name: 'slow', run: true })
      await waitFor(() => stmt0(slow) && stmt0(slow).status === 'running', 'the slow query')
      await sleep(400)
      const started = Date.now()
      ui.cancelRun(slow)
      await waitFor(() => scripts()[slow].run.state === 'cancelled', 'the cancel', 8000)
      check('cancel stops a query that is still running on the server', Date.now() - started < 4000 && stmt0(slow).status === 'cancelled', (Date.now() - started) + ' ms')
      const after = await run('db.orders.countDocuments({})', { name: 'after cancel' })
      check('the script’s connection works again straight away', stmt0(after).status === 'done')

      const two = await run('use dbide_mongo_live' + NL + 'db.orders.countDocuments({ status: "new" })' + NL + 'show collections', { name: 'several', database: null })
      const statements = scripts()[two].run.statements
      check('a script runs its statements in turn, and use switches database', statements.length === 3 && statements.every((s) => s.status === 'done') && statements[0].ok && /dbide_mongo_live/.test(statements[0].ok.message), statements.map((s) => s.status).join(','))
    })

    await section('the script file and its editor', async () => {
      const id = ui.createScript({ connectionId: 'mongo-dev', database: 'dbide_mongo_live', text: 'db.orders.find({})', name: 'Mongo report' })
      await waitFor(async () => (await call('scripts.list', undefined)).some((s) => s.id === id), 'the file to be created')
      const info = (await call('scripts.list', undefined)).find((s) => s.id === id)
      check('a MongoDB script is a .mongodb file', info.language === 'mongodb' && info.name === 'Mongo report', JSON.stringify(info))
      check('its tab shows the extension', /[.]mongodb/.test(vis('.script-name').textContent), vis('.script-name').textContent)
      check('the toolbar has no SQL formatter for it', !vis('[aria-label="Format SQL"]'))

      await typeInEditor('db.orders.find({ a: ObjectId(' + q + 'nope' + q + ') })')
      await waitFor(() => vis('.cm-lintRange-error'), 'the editor to mark the mistake', 6000)
      await shot('8-editor-lint')
      check('the editor marks a mistake as it is typed', true)
      await typeInEditor('db.orders.countDocuments({ status: "new" })')
      await waitFor(() => !vis('.cm-lintRange-error'), 'the mark to go', 6000)
      keyCode('Enter', mod())
      await waitFor(() => finished(id), 'the run from the keyboard')
      check('Run from the keyboard runs the statement under the cursor', stmt0(id).status === 'done' && num(docs(id)[0]) === 665, JSON.stringify(docs(id)))
      await waitFor(async () => (await call('scripts.history', { id })).some((r) => r.label === 'run'), 'local history')
      check('running keeps the text in local history, as for SQL', true)
      const hist = (await call('history.list', { limit: 500 })).entries
      check('the statements are in the query history, in the language they were written', hist.some((e) => e.sql === 'db.orders.countDocuments({ status: "new" })' && e.status === 'ok'), hist.length)
    })

    await section('the connection form', async () => {
      ui.useWorkbench.getState().openTab({ id: 'edit:mongo-dev', kind: 'connection-editor', connectionId: 'mongo-dev' })
      await waitFor(() => all('h2').some((h) => h.textContent === 'MongoDB'), 'the MongoDB section')
      await shot('9-connection-form')
      check('a MongoDB connection has its own settings in the form', all('label').some((l) => /Authentication database/.test(l.textContent)) && all('label').some((l) => /Replica set/.test(l.textContent)) && all('label').some((l) => /mongodb[+]srv/.test(l.textContent)))
      ui.useWorkbench.getState().closeTab('edit:mongo-dev')
    })
  `,
    target as unknown as Record<string, unknown>,
  )
