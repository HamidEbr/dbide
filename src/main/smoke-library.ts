import { existsSync, readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { crc32, inflateRawSync } from 'node:zlib'

/**
 * Smoke checks for scripts-as-files, local history, query history and export. Page scripts drive
 * the real UI and core; between them the main process plays the part of other programs: it edits
 * and deletes script files behind the app's back, and reads what an export wrote to disk.
 */

export interface Check {
  name: string
  ok: boolean
  detail?: string
}

/** Everything a page script needs. No backticks and no dollar-braces: it lives in a template string. */
const HELPERS = `
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ui = window.__dbide_ui
  const call = window.__dbide_call
  const scripts = () => ui.useScripts.getState().scripts
  const waitFor = async (fn, label, ms = 15000) => {
    const started = Date.now()
    for (;;) {
      const value = await fn()
      if (value) return value
      if (Date.now() - started > ms) throw new Error('timed out waiting for ' + label)
      await sleep(25)
    }
  }
  const vis = (selector) => document.querySelector('.workbench-sql:not([hidden]) ' + selector)
  const visAll = (selector) => [...document.querySelectorAll('.workbench-sql:not([hidden]) ' + selector)]
  const all = (selector) => [...document.querySelectorAll(selector)]
  const byText = (selector, text) => all(selector).find((el) => el.textContent.trim().startsWith(text))
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (el, key, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  const keyCode = (code, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init }))
  const mod = () => (window.dbide.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true })
  const NL = String.fromCharCode(10)
  const sidebar = async (name) => {
    byText('.sidebar-tab', name).click()
    await sleep(150)
  }
  const notice = (pattern) => all('.notice').some((n) => pattern.test(n.textContent))
  /** Types into the editor of the front tab the way a keyboard would. */
  const typeInEditor = async (text) => {
    const content = await waitFor(() => vis('.cm-content'), 'the editor')
    content.focus()
    document.execCommand('selectAll')
    document.execCommand('insertText', false, text)
    await sleep(50)
  }
  const closeAllSqlTabs = async () => {
    for (const tab of ui.useWorkbench.getState().tabs.filter((t) => t.kind === 'sql')) ui.useWorkbench.getState().closeTab(tab.id)
    await waitFor(() => Object.keys(scripts()).length === 0, 'all scripts closed')
  }
  const stmt0 = (id) => scripts()[id] && scripts()[id].run && scripts()[id].run.statements[0]
  const cell = (r, c) => vis('[data-r="' + r + '"][data-c="' + c + '"]')
  const down = (el, init = {}) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...init }))
  const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const runQuery = async (text, name) => {
    const id = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text, name, run: true })
    await waitFor(() => stmt0(id) && (stmt0(id).status === 'done' || stmt0(id).status === 'paused'), 'the result')
    await waitFor(() => vis('.grid-row'), 'the grid')
    return id
  }
  const readScript = async (id) => {
    try {
      return (await call('scripts.read', { id })).content
    } catch (error) {
      return null
    }
  }
`

export const wrap = (body: string, args: Record<string, unknown> = {}): string => `
(async () => {
  ${HELPERS}
  const ARGS = ${JSON.stringify(args)}
  const out = {}
  try {
    ${body}
  } catch (error) {
    check('workflow did not finish', false, error && error.message)
  }
  return { checks, out }
})()
`

/** Part 1: scripts are files. A script is created, typed into, run, closed, reopened and renamed. */
export const FILES_1 = wrap(`
    await closeAllSqlTabs()
    out.scriptsDir = (await call('app.info', undefined)).scriptsDir

    const id = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT 1;', name: 'Monthly report' })
    out.id = id
    await waitFor(async () => (await call('scripts.list', undefined)).some((s) => s.id === id), 'the file to be created')
    const created = (await call('scripts.list', undefined)).find((s) => s.id === id)
    check('a new script gets a .sql file named after it', created && created.name === 'Monthly report' && created.size === 9 && created.connectionId === 'sql-dev' && created.database === 'shop', JSON.stringify(created))
    check('its tab carries the script name, with the connection beside it', all('.tab').some((t) => t.querySelector('.tab-title') && t.querySelector('.tab-title').textContent === 'Monthly report' && t.querySelector('.tab-sub') && t.querySelector('.tab-sub').textContent === 'SQL dev'))

    await typeInEditor('SELECT 42;')
    await waitFor(async () => (await readScript(id)) === 'SELECT 42;', 'typing to be saved to the file', 6000)
    check('typing in the editor is saved to the file by itself', true)
    check('the toolbar says it is saved', (await waitFor(() => vis('.save-state'), 'save state')).textContent === 'Saved')

    keyCode('Enter', mod())
    await waitFor(() => scripts()[id].run && scripts()[id].run.state === 'completed', 'the run')
    await waitFor(async () => (await call('scripts.history', { id })).some((r) => r.label === 'run'), 'the run to be kept')
    check('running keeps the text that ran in local history', true)

    ui.useWorkbench.getState().closeTab('sql:' + id)
    check('closing the tab removes it at once', await waitFor(() => !scripts()[id], 'the tab to close'))
    check('closing a tab keeps the script, text and all', (await readScript(id)) === 'SELECT 42;')
    await ui.openSavedScript(id)
    check('opening it again brings the text back', scripts()[id] && scripts()[id].text === 'SELECT 42;' && scripts()[id].connectionId === 'sql-dev' && scripts()[id].database === 'shop')

    // Rename from the toolbar, like a person would
    vis('.script-name').click()
    const nameInput = await waitFor(() => vis('.script-name-input'), 'the name field')
    setValue(nameInput, 'Quarterly')
    press(nameInput, 'Enter')
    await waitFor(() => scripts()[id].name === 'Quarterly', 'the rename')
    check('renaming from the toolbar renames the file and the tab', all('.tab-title').some((t) => t.textContent === 'Quarterly'))

    // The scripts list
    await sidebar('Scripts')
    const row = await waitFor(() => document.querySelector('.script-row[data-script="' + id + '"]'), 'the script in the list')
    check('the Scripts list shows it, with its connection and that it is open', row.textContent.includes('Quarterly') && row.textContent.includes('SQL dev') && row.querySelector('.script-open-dot'), row.textContent)

    // Tabs are remembered
    await waitFor(async () => { const s = (await call('scripts.list', undefined)).find((x) => x.id === id); return s && s.openOrder === 0 && s.active }, 'the open tab to be remembered')
    check('which tabs are open, and which is in front, is remembered', true)

    // A script whose file is deleted behind the app's back
    const keep = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT "precious";', name: 'Recoverable' })
    out.keep = keep
    await waitFor(async () => (await readScript(keep)) === 'SELECT "precious";', 'the second script to be saved')
    ui.useWorkbench.getState().closeTab('sql:' + keep)
    await waitFor(() => !scripts()[keep], 'the second tab to close')
    await sleep(300)
    await ui.openSavedScript(id)
`)

/** Part 2, after the main process edited and deleted files: outside edits, local history, delete, import. */
export const files2 = (args: { id: string; keep: string }): string =>
  wrap(
    `
    const id = ARGS.id
    const keep = ARGS.keep
    await sidebar('Connections')

    // The file was changed by another program while the script was open.
    await ui.openSavedScript(id)
    await typeInEditor('SELECT 43;')
    await waitFor(() => notice(/outside DBIDE/), 'the notice about the outside edit', 8000)
    check('saving over a file that was edited elsewhere says so', true)
    const versions = await call('scripts.history', { id })
    const outside = versions.find((r) => r.label === 'external')
    check('the version from the other program is kept in local history', outside && (await call('scripts.revision', { id, revisionId: outside.id })) === 'SELECT "edited elsewhere";')
    check('and the new text is what is on disk', (await readScript(id)) === 'SELECT 43;')

    // Local history in the UI
    ui.useDialogs.getState().openLocalHistory(id)
    await waitFor(() => all('.local-history .lh-item').length >= 3, 'the versions list')
    const labels = all('.local-history .lh-item .pill').map((p) => p.textContent)
    check('the dialog lists the versions with why each was kept', labels.includes('Run') && labels.includes('Changed outside DBIDE') && labels.includes('Created'), labels.join(', '))
    const runItem = all('.local-history .lh-item').find((i) => i.textContent.includes('Run'))
    runItem.click()
    await waitFor(() => all('.local-history .diff-line').length > 0, 'a diff')
    const diffText = all('.local-history .diff-line').map((l) => l.className.replace('diff-line ', '') + ':' + l.querySelector('.diff-text').textContent).join('|')
    check('selecting a version shows what differs from the text now', diffText.includes('diff-del:SELECT 42;') && diffText.includes('diff-add:SELECT 43;'), diffText)
    byText('.local-history .segmented button', 'Version before').click()
    await sleep(300)
    check('it can compare with the version before instead', all('.local-history .lh-legend')[0].textContent.includes('before'))
    byText('.local-history button', 'Restore this version').click()
    await waitFor(() => !document.querySelector('.local-history'), 'the dialog to close')
    await waitFor(() => scripts()[id].text === 'SELECT 42;', 'the restored text in the editor', 4000)
    check('restoring puts that version in the editor', true)
    await waitFor(async () => (await readScript(id)) === 'SELECT 42;', 'the restored text in the file', 6000)
    const after = await call('scripts.history', { id })
    const before = after.find((r) => r.label === 'restore')
    check('what was replaced is kept first, so restoring loses nothing', before && (await call('scripts.revision', { id, revisionId: before.id })) === 'SELECT 43;')

    // A deleted file comes back from history
    await sidebar('Scripts')
    byText('.script-row', 'Recoverable').click()
    await waitFor(() => scripts()[keep], 'the recovered script to open')
    check('a script whose file was deleted outside the app is restored from local history', scripts()[keep].text === 'SELECT "precious";' && notice(/Restored from Local History/), scripts()[keep].text)

    // Import: two usable files and one that is not text
    const imported = await call('scripts.import', undefined)
    check('importing copies usable files in and reports the one that is not text', imported.imported.length === 2 && imported.failed.length === 1 && imported.failed[0].name === 'broken.sql' && /UTF-8/.test(imported.failed[0].message), JSON.stringify(imported))
    await waitFor(() => all('.script-row').some((r) => r.textContent.includes('legacy-report')), 'imported scripts in the list')
    const legacy = all('.script-row').find((r) => r.textContent.includes('legacy-report'))
    check('an imported script has no connection until it is opened', legacy.textContent.includes('No connection'))
    // With no connection in front and none selected, there is nothing to guess from.
    ui.useWorkbench.getState().activate('welcome')
    ui.useTree.getState().select(null)
    byText('.script-row', 'legacy-report').click()
    await sleep(300)
    check('opening it without a connection selected explains what to do', notice(/has no connection/))
    ui.useTree.getState().select('sql-dev')
    byText('.script-row', 'legacy-report').click()
    const legacyId = imported.imported.find((s) => s.name === 'legacy-report').id
    await waitFor(() => scripts()[legacyId], 'the imported script to open')
    check('with a connection selected it opens on that connection and keeps it', scripts()[legacyId].connectionId === 'sql-dev' && scripts()[legacyId].text === 'SELECT ' + String.fromCharCode(39) + 'imported' + String.fromCharCode(39) + ' AS source;' + NL)
    await waitFor(async () => (await call('scripts.list', undefined)).find((s) => s.id === legacyId).connectionId === 'sql-dev', 'the connection to be remembered')
    out.legacyId = legacyId

    // Moving a script to another connection from its toolbar
    const connectionSelect = vis('.sql-connection')
    check('a script can be moved to another connection from its toolbar', connectionSelect && connectionSelect.value === 'sql-dev')
    const chooser = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')
    chooser.set.call(connectionSelect, 'sql-prod')
    connectionSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await waitFor(() => scripts()[legacyId].connectionId === 'sql-prod', 'the move')
    check('it starts locked, like any prod script, and its tab follows', scripts()[legacyId].writable === false && ui.useWorkbench.getState().tabs.find((t) => t.scriptId === legacyId).connectionId === 'sql-prod')

    // Delete from the list, with a question first
    const doomed = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT "gone";', name: 'Doomed' })
    await waitFor(async () => (await readScript(doomed)) === 'SELECT "gone";', 'the doomed script to be saved')
    await sidebar('Scripts')
    const doomedRow = await waitFor(() => byText('.script-row', 'Doomed'), 'the script in the list')
    doomedRow.querySelector('[aria-label="Delete Doomed"]').click()
    await waitFor(() => document.querySelector('.script-row-confirm'), 'the question')
    check('deleting asks first', document.querySelector('.script-row-confirm').textContent.includes('Doomed'))
    byText('.script-row-confirm button', 'Delete').click()
    await waitFor(() => !scripts()[doomed], 'its tab to close')
    await waitFor(async () => !(await call('scripts.list', undefined)).some((s) => s.id === doomed), 'it to leave the list')
    check('deleting closes its tab and removes it from the list', true)
    await sleep(1200)
    check('a deleted script does not come back by being saved again', !(await call('scripts.list', undefined)).some((s) => s.id === doomed))
`,
    args,
  )

/** Query history, from the core and from the sidebar. */
export const HISTORY_1 = wrap(`
    await sidebar('Connections')
    const page = await call('history.list', { limit: 500 })
    const entries = page.entries
    check('statements that ran are in the history, newest first', entries.length > 10 && entries.every((e, i) => i === 0 || entries[i - 1].id > e.id), entries.length)
    const bad = entries.find((e) => e.sql.includes('FROM bad'))
    check('a failure is kept with its code, message and connection', bad && bad.status === 'error' && bad.errorCode === 'ER_NO_SUCH_TABLE' && /doesn/.test(bad.errorMessage) && bad.connectionName === 'SQL dev' && bad.environment === 'dev', JSON.stringify(bad))
    const paged = entries.find((e) => e.sql.includes('LIMIT 5000'))
    check('a result that waited for more rows is recorded at its first page, once', paged && paged.status === 'ok' && paged.rows === 1000 && entries.filter((e) => e.sql.includes('LIMIT 5000')).length === 1, JSON.stringify(paged))
    const slow = entries.find((e) => e.sql.includes('SLEEP(30)'))
    check('a cancelled statement is recorded as cancelled', slow && slow.status === 'cancelled')
    const write = entries.find((e) => e.sql.includes('INSERT INTO t'))
    check('a write records the rows it changed', write && write.affected === 3 && write.rows === null, JSON.stringify(write))
    const prod = entries.find((e) => e.connectionName === 'SQL prod' && e.sql.includes('LIMIT 10'))
    check('the environment is kept, so a production query is recognizable later', prod && prod.environment === 'prod' && prod.database === 'shop')
    check('what was never sent is not recorded', !entries.some((e) => e.sql.includes('DELETE FROM orders')))

    // The History view
    await sidebar('History')
    await waitFor(() => all('.history-item').length > 5, 'the history list')
    check('the History view lists them, grouped by day', all('.history-day')[0].textContent === 'Today')
    const search = document.querySelector('[aria-label="Search history"]')
    setValue(search, 'FROM bad')
    await waitFor(() => all('.history-item').length === 1, 'the search to narrow the list')
    check('searching narrows the list to statements that contain the text', all('.history-item')[0].textContent.includes('FROM bad'))
    all('.history-item')[0].click()
    await waitFor(() => document.querySelector('.history-error'), 'the error text')
    check('opening an entry shows its full statement and its error', /doesn/.test(document.querySelector('.history-error').textContent) && document.querySelector('.history-detail pre').textContent.includes('FROM bad'))

    document.querySelector('[aria-label="Open in a new script"]').click()
    const reused = await waitFor(() => Object.values(scripts()).find((s) => s.text.includes('FROM bad')), 'the reused statement to open')
    check('a statement can be opened in a new script on its own connection', reused.connectionId === 'sql-dev' && reused.database === null && reused.run === null)

    setValue(search, '')
    await waitFor(() => all('.history-item').length > 5, 'the full list again')
    byText('.history-filters .segmented button', 'Errors').click()
    await waitFor(() => all('.history-item').length > 0 && all('.history-item').every((i) => i.classList.contains('status-error')), 'only failures')
    check('the Errors filter keeps only failed statements', true)
    byText('.history-filters .segmented button', 'All').click()
    await waitFor(() => all('.history-item').some((i) => !i.classList.contains('status-error')), 'all entries again')

    // Turning it off
    const before = (await call('history.list', { limit: 500 })).entries.length
    await call('settings.set', { recordHistory: false })
    const quiet = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT 7001;', run: true })
    await waitFor(() => scripts()[quiet].run && scripts()[quiet].run.state === 'completed', 'a run with history off')
    await sleep(600)
    check('nothing is recorded while history is off', (await call('history.list', { limit: 500 })).entries.length === before)
    await call('settings.set', { recordHistory: true })
    const loud = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT 7002;', run: true })
    await waitFor(async () => (await call('history.list', { search: '7002' })).entries.length === 1, 'the entry once it is on again')
    check('and it records again once it is turned back on', true)
    await waitFor(() => all('.history-item').some((i) => i.textContent.includes('7002')), 'the list to update by itself', 4000)
    check('the open History view updates by itself', true)

    // Removing
    const target = (await call('history.list', { search: '7002' })).entries[0]
    await call('history.delete', { id: target.id })
    check('one entry can be removed', (await call('history.list', { search: '7002' })).entries.length === 0)
`)

/** Export: formats, no row limit, only reads, cancel. */
export const EXPORT_1 = wrap(`
    await sidebar('Connections')
    const orders = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 2500;', run: true })
    await waitFor(() => scripts()[orders].run && scripts()[orders].run.statements[0].status === 'paused', 'the first page')
    const exportButton = () => byText('.workbench-sql:not([hidden]) .result-summary button', 'Export')
    check('a result offers Export, which says every row is written', exportButton() && !exportButton().disabled)
    exportButton().click()
    await waitFor(() => document.querySelector('.dialog-export'), 'the export dialog')
    check('the dialog shows the query that will run again', document.querySelector('.dialog-export .export-sql').textContent.includes('shop.orders'))
    const labels = all('.dialog-export .check').map((c) => c.textContent)
    check('CSV has its options', labels.some((l) => l.includes('Column names')) && labels.some((l) => l.includes('Excel')) && labels.some((l) => l.includes('formulas')))
    byText('.dialog-export .check', 'Excel').querySelector('input').click()
    const nullText = [...document.querySelectorAll('.dialog-export input.mono')].find((i) => i.placeholder === '(empty)')
    setValue(nullText, 'NULL')
    byText('.dialog-export footer button', 'Export').click()
    await waitFor(() => document.querySelector('.export-done'), 'the export to finish', 30000)
    const doneText = document.querySelector('.export-done').textContent
    check('it writes all 2,500 rows, not only the 1,000 that were loaded', doneText.includes('2,500'), doneText)
    out.csvPath = document.querySelector('.export-path').textContent
    byText('.export-done button', 'Done').click()
    await waitFor(() => !document.querySelector('.dialog-export'), 'the dialog to close')

    const conn = { connectionId: 'sql-dev', database: 'shop' }
    const sql = 'SELECT id, customer, total, meta, note, token FROM shop.orders LIMIT 40'
    const base = { exportId: 'smoke', ...conn, sql }
    const defaults = { header: true, delimiter: ',', nullText: '', quoteAll: false, bom: false, crlf: false, neutralizeFormulas: false, tableName: 'shop.orders', rowsPerInsert: 100 }
    out.files = {}
    for (const [format, name, options] of [
      ['json', 'matrix.json', {}],
      ['ndjson', 'matrix.ndjson', {}],
      ['tsv', 'matrix.tsv', {}],
      ['markdown', 'matrix.md', {}],
      ['xlsx', 'matrix.xlsx', {}],
      ['sql', 'matrix.sql', { rowsPerInsert: 10 }],
      ['csv', 'matrix-semicolon.csv', { delimiter: ';', header: false, quoteAll: true, crlf: true }],
    ]) {
      const result = await call('export.run', { ...base, format, options: { ...defaults, ...options }, fileName: name })
      check('exports ' + format + ' with 40 rows', result.status === 'saved' && result.rows === 40 && result.bytes > 100, JSON.stringify(result))
      out.files[name] = result.path
    }

    const started = Date.now()
    const huge = await call('export.run', { ...base, sql: 'SELECT n FROM big', format: 'csv', options: defaults, fileName: 'huge.csv' })
    check('an export has no row limit: 1,500,000 rows, past the 1,000,000 a grid holds', huge.status === 'saved' && huge.rows === 1500000, huge.rows + ' rows in ' + (Date.now() - started) + ' ms')
    out.files['huge.csv'] = huge.path

    // A sheet holds 1,048,576 rows, so 1,500,000 rows continue on a second sheet.
    const hugeStarted = Date.now()
    const hugeXlsx = await call('export.run', { ...base, sql: 'SELECT n FROM big', format: 'xlsx', options: defaults, fileName: 'huge.xlsx' })
    check('an Excel export carries on to a second sheet when the first is full', hugeXlsx.status === 'saved' && hugeXlsx.rows === 1500000, hugeXlsx.rows + ' rows in ' + (Date.now() - hugeStarted) + ' ms, ' + hugeXlsx.bytes + ' bytes')
    out.files['huge.xlsx'] = hugeXlsx.path

    for (const bad of ['DELETE FROM orders', 'UPDATE orders SET a = 1', 'SELECT 1 INTO OUTFILE ' + String.fromCharCode(39) + '/tmp/x' + String.fromCharCode(39), 'CALL purge()']) {
      try {
        await call('export.run', { ...base, sql: bad, format: 'csv', options: defaults, fileName: 'never.csv' })
        check('only queries that read can be exported: ' + bad, false)
      } catch (error) {
        check('only queries that read can be exported: ' + bad, error.code === 'NOT_A_QUERY', error.code)
      }
    }
    try {
      await call('export.run', { ...base, format: 'csv', options: { ...defaults, delimiter: 'x' }, fileName: 'never.csv' })
      check('bad options are refused', false)
    } catch (error) {
      check('bad options are refused', error.code === 'INVALID_INPUT', error.code)
    }

    // Cancel part-way through a slow export
    const slow = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT n FROM slow_big;', run: true })
    await waitFor(() => scripts()[slow].run && scripts()[slow].run.statements[0].status === 'paused', 'the slow result')
    exportButton().click()
    await waitFor(() => document.querySelector('.dialog-export'), 'the second export dialog')
    byText('.dialog-export footer button', 'Export').click()
    await waitFor(() => /[1-9][0-9,]* rows/.test((document.querySelector('.export-progress') || {}).textContent || ''), 'the export to make progress', 20000)
    check('progress shows rows and size while it runs', /rows ·/.test(document.querySelector('.export-progress').textContent), document.querySelector('.export-progress').textContent)
    byText('.dialog-export footer button', 'Cancel export').click()
    await waitFor(() => byText('.dialog-export footer button', 'Export'), 'the dialog to return to its options', 10000)
    check('cancelling stops the export and says nothing was written', notice(/Nothing was written/))
    document.querySelector('.dialog-export').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await waitFor(() => !document.querySelector('.dialog-export'), 'the dialog to close')

    // A whole table, from the tree
    const BT = String.fromCharCode(96)
    const roots = await call('tree.children', { connectionId: 'sql-dev', parent: null })
    const shop = roots.find((n) => n.label === 'shop')
    const groups = await call('tree.children', { connectionId: 'sql-dev', parent: shop })
    const tables = groups.find((g) => /tables/i.test(g.label))
    ui.useTree.getState().expand('sql-dev', null)
    await sleep(150)
    ui.useTree.getState().expand('sql-dev', shop)
    await sleep(150)
    ui.useTree.getState().expand('sql-dev', tables)
    const exportOrders = await waitFor(() => document.querySelector('[aria-label="Export orders to a file"]'), 'the Export button on the orders table')
    check('a table in the tree offers Export', true)
    const viewRows = all('.tree-row').filter((r) => /open_orders/.test(r.textContent))
    exportOrders.click()
    await waitFor(() => document.querySelector('.dialog-export .export-columns'), 'the table export dialog')
    check('the dialog is about the table, and shows the SELECT it will run', /Export orders/.test(document.querySelector('#export-title').textContent) && document.querySelector('.dialog-export .export-sql').textContent.includes('FROM ' + BT + 'shop' + BT + '.' + BT + 'orders' + BT + ''), document.querySelector('.dialog-export .export-sql').textContent)
    const columnChecks = () => all('.dialog-export .export-columns .check')
    check('it lists the table’s columns, all ticked', columnChecks().length === 7 && columnChecks().every((c) => c.querySelector('input').checked), columnChecks().length)
    byText('.dialog-export .export-columns .check', 'note').querySelector('input').click()
    await waitFor(() => !document.querySelector('.dialog-export .export-sql').textContent.includes('SELECT *'), 'the SELECT to name its columns')
    check('leaving a column out names the others', !document.querySelector('.dialog-export .export-sql').textContent.includes('' + BT + 'note' + BT + '') && document.querySelector('.dialog-export .export-sql').textContent.includes('' + BT + 'customer' + BT + ''))
    const limitInput = [...document.querySelectorAll('.dialog-export input.mono')].find((i) => i.placeholder === 'all')
    setValue(limitInput, '5')
    const whereInput = [...document.querySelectorAll('.dialog-export .export-grid input.mono')].find((i) => i.placeholder !== 'all' && i.placeholder !== '(empty)')
    setValue(whereInput, "customer = 'x'")
    await waitFor(() => /LIMIT 5/.test(document.querySelector('.dialog-export .export-sql').textContent), 'the LIMIT')
    check('a condition and a limit go into the SELECT', document.querySelector('.dialog-export .export-sql').textContent.includes('WHERE (' + NL + 'customer = ' + String.fromCharCode(39) + 'x' + String.fromCharCode(39) + NL + ')') && /LIMIT 5/.test(document.querySelector('.dialog-export .export-sql').textContent))
    byText('.dialog-export .check', 'Compress with gzip').querySelector('input').click()
    byText('.dialog-export footer button', 'Export').click()
    await waitFor(() => document.querySelector('.export-done'), 'the table export to finish', 30000)
    check('the export writes the 5 rows to a .gz file', document.querySelector('.export-done').textContent.includes('5 rows') && /[.]csv[.]gz$/.test(document.querySelector('.export-path').textContent), document.querySelector('.export-done').textContent)
    out.gzPath = document.querySelector('.export-path').textContent
    byText('.export-done button', 'Done').click()
    await waitFor(() => !document.querySelector('.dialog-export'), 'the dialog to close')
    await call('export.run', { exportId: 'bad-table', connectionId: 'sql-dev', database: 'shop', sql: 'SELECT * FROM ' + BT + 'shop' + BT + '.' + BT + 'orders' + BT + NL + 'WHERE (' + NL + '1=1); DROP TABLE orders; --' + NL + ')', format: 'csv', options: { header: true, delimiter: ',', nullText: '', quoteAll: false, bom: false, crlf: false, neutralizeFormulas: false, tableName: 't', rowsPerInsert: 100 }, fileName: 'never.csv' }).then(
      () => check('a condition that adds a second statement is refused', false),
      (error) => check('a condition that adds a second statement is refused', error.code === 'INVALID_INPUT' || error.code === 'NOT_A_QUERY', error.code),
    )
`)

/** Autocomplete in the real editor: tables, databases, columns by alias, joins from foreign keys, and DDL refreshing it. */
export const COMPLETION_1 = wrap(`
    await closeAllSqlTabs()
    await sidebar('Connections')
    const id = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: '', name: 'completion' })
    await waitFor(() => vis('.cm-content'), 'the editor')
    await waitFor(async () => (await call('schema.detail', { connectionId: 'sql-dev', database: 'shop' })).tables.length > 0, 'the schema')
    const popup = () => [...document.querySelectorAll('.cm-tooltip-autocomplete li')].map((li) => li.textContent)
    const typeAndWait = async (text, expected) => {
      await typeInEditor(text)
      await waitFor(() => popup().some((t) => t.includes(expected)), 'a suggestion containing ' + expected, 8000)
      return popup()
    }

    const tables = await typeAndWait('SELECT * FROM or', 'orders')
    check('typing after FROM suggests the tables of the database', tables.some((t) => t.includes('orders')) && tables.some((t) => t.includes('open_orders')), tables.join(' | '))
    check('a view is marked as one, and a table says what it is', tables.some((t) => t.includes('open_orders') && t.includes('view')) && tables.some((t) => t.includes('orders') && t.includes('table')), tables.join(' | '))

    const databases = await typeAndWait('USE sh', 'shop')
    check('after USE it suggests databases, not tables', databases.some((t) => t.includes('shop')) && !databases.some((t) => t.includes('orders')), databases.join(' | '))

    const aliased = await typeAndWait('SELECT * FROM orders o JOIN customers c ON o.id = c.id WHERE c.na', 'name')
    check('a column is suggested for the alias before the dot, from that table only', aliased.some((t) => t.includes('name')) && !aliased.some((t) => t.includes('total')), aliased.join(' | '))

    // The editor text is replaced whole here, where a person types a letter at a time: close the last popup first.
    press(vis('.cm-content'), 'Escape')
    await sleep(300)
    await typeAndWait('SELECT * FROM orders o JOIN customers c ON o', 'o.customer = c.name')
    check('after ON it suggests the join a foreign key makes', popup().some((t) => t.includes('o.customer = c.name') && t.includes('foreign key')), popup().join(' | '))

    // A statement that changes the schema makes autocomplete read it again.
    const before = (await call('schema.detail', { connectionId: 'sql-dev', database: 'shop' })).tables.length
    check('the core serves the database’s tables, columns and foreign keys', before === 4, before)
    const detail = await call('schema.detail', { connectionId: 'sql-dev', database: 'shop' })
    const orders = detail.tables.find((t) => t.name === 'orders')
    check('with types and keys', orders.columns.find((c) => c.name === 'id').key === 'PRI' && orders.columns.find((c) => c.name === 'customer').type === 'varchar' && detail.foreignKeys.length === 1, JSON.stringify(detail.foreignKeys))
    const names = await call('schema.databases', { connectionId: 'sql-dev' })
    check('and the databases the login can see', names.includes('shop') && names.includes('analytics'), names.join(','))
`)

/** A result with 300 columns: only the ones on screen are drawn, and the rest are one key away. */
export const GRID_WIDE = wrap(`
    await sidebar('Connections')
    const id = await runQuery('SELECT * FROM shop.wide;', 'wide')
    const heads = () => visAll('.grid-head').length
    check('a 300-column result draws only the columns on screen', heads() > 3 && heads() < 60, heads() + ' of 300 drawn')
    check('but the grid still knows it has them all', vis('.grid').getAttribute('aria-colcount') === '300')
    check('every drawn row has the same few cells', visAll('.grid-row').every((row) => row.querySelectorAll('.grid-cell').length === heads()))
    check('the first columns are the ones that are drawn', cell(0, 0) && cell(0, 0).textContent === '1001' && !cell(0, 250))

    down(cell(0, 0))
    press(vis('.grid'), 'End')
    await waitFor(() => cell(0, 299), 'the last column to be drawn')
    check('End goes to the last column and draws it', cell(0, 299).textContent === '1300' && heads() < 60 && !cell(0, 0), heads() + ' drawn; last = ' + cell(0, 299).textContent)
    check('its header is drawn too, in the right place', vis('.grid-head[aria-colindex="300"]') && vis('.grid-head[aria-colindex="300"]').textContent.includes('c300'))

    press(vis('.grid'), 'Home')
    await waitFor(() => cell(0, 0), 'the first column again')
    check('Home comes back', cell(0, 0).textContent === '1001' && !cell(0, 299))

    // Scrolling by hand
    vis('.grid').scrollLeft = 12000
    const middle = await waitFor(() => { const c = visAll('.grid-row')[0].querySelector('.grid-cell'); return c && Number(c.dataset.c) > 60 ? Number(c.dataset.c) : 0 }, 'the middle columns')
    check('scrolling sideways draws the columns that come into view', heads() < 60 && !cell(0, 0), 'first drawn column ' + middle)
    check('a drawn cell shows its own value, wherever it is', visAll('.grid-row')[0].querySelector('.grid-cell').textContent === String(1000 + Number(visAll('.grid-row')[0].querySelector('.grid-cell').dataset.c) + 1))
`)

/** The commit shortcut: Save commits the staged row changes, and does nothing when there are none. */
export const GRID_COMMIT = wrap(`
    await waitFor(() => all('.notice').length === 0, 'earlier notices to go', 8000)
    const id = await runQuery('SELECT * FROM shop.orders LIMIT 20;', 'commit')
    await waitFor(() => byText('.workbench-sql:not([hidden]) button', 'Add row'), 'the edit bar')
    const resultId = stmt0(id).resultSets[0].id
    const input = () => vis('.field-editor input')

    keyCode('KeyS', mod())
    await sleep(200)
    check('the commit shortcut does nothing while nothing is staged', !notice(/Saved/) && !ui.useEdits.getState().sets[resultId])

    dbl(cell(1, 1))
    await waitFor(input, 'the cell editor')
    setValue(input(), 'Via the shortcut')
    press(input(), 'Enter')
    await waitFor(() => visAll('.edit-count').length === 1, 'the staged change')
    check('a change is staged, not saved', cell(1, 1).textContent === 'Via the shortcut' && ui.useEdits.getState().sets[resultId] !== undefined)
    check('the commit button says what the shortcut is', /S/.test(byText('.workbench-sql:not([hidden]) button', 'Commit').title))

    keyCode('KeyS', mod())
    await waitFor(() => !ui.useEdits.getState().sets[resultId], 'the commit')
    check('the commit shortcut saves it in one go, from anywhere', visAll('.edit-count').length === 0 && notice(/Saved 1 change/), 'notice shown')
    check('and the saved value is in the grid', stmt0(id).resultSets[0].store.getRow(1)[1] === 'Via the shortcut')
`)

/** Generating UPDATE and DELETE statements from selected rows: the result is read from the clipboard. */
export const GRID_GENERATE = wrap(`
    const id = await runQuery('SELECT * FROM shop.orders LIMIT 20;', 'generate')
    await waitFor(() => byText('.workbench-sql:not([hidden]) button', 'Add row'), 'the edit bar')
    down(cell(1, 1))
    down(cell(2, 2), { shiftKey: true })
    await sleep(100)
    check('two rows and two columns are selected', visAll('.grid-cell.selected').length === 4)
    ui.commands.execute('grid.copySqlUpdate')
    await waitFor(() => notice(/Copied 2 UPDATE statements/), 'the notice')
    check('a notice says what was copied', true)
    const q = String.fromCharCode(39)
    check('the UPDATE statements are copied, one per row, by primary key', window.__dbide_clipboard === 'UPDATE \`shop\`.\`orders\` SET \`customer\` = ' + q + 'customer-1' + q + ', \`total\` = 0.37 WHERE \`id\` = 2;' + NL + 'UPDATE \`shop\`.\`orders\` SET \`customer\` = ' + q + 'customer-2' + q + ', \`total\` = 0.74 WHERE \`id\` = 3;', window.__dbide_clipboard)
`)
export const GRID_GENERATE_DELETE = wrap(`
    ui.commands.execute('grid.copySqlDelete')
    await waitFor(() => notice(/Copied 2 DELETE statements/), 'the notice')
    check('DELETE statements are copied for the same rows, by primary key', window.__dbide_clipboard === 'DELETE FROM \`shop\`.\`orders\` WHERE \`id\` = 2;' + NL + 'DELETE FROM \`shop\`.\`orders\` WHERE \`id\` = 3;', window.__dbide_clipboard)

    // A table without a primary key has nothing to address its rows by.
    const noKey = await runQuery('SELECT * FROM shop.customers LIMIT 5;', 'no key')
    await waitFor(() => /no primary key/.test((vis('.edit-bar-quiet') || {}).textContent || ''), 'the reason')
    down(cell(1, 1))
    await sleep(150)
    ui.commands.execute('grid.copySqlDelete')
    await waitFor(() => notice(/Can.t write DELETE statements. .*no primary key/), 'the explanation')
    check('without a primary key it says why instead of writing a statement that could hit other rows', true)
`)

/** Foreign keys: a marker on the column, a link from the cell, and the way back. */
export const GRID_LINKS = wrap(`
    const id = await runQuery('SELECT * FROM shop.orders LIMIT 20;', 'links')
    const icon = await waitFor(() => vis('.grid-head-fk'), 'the foreign key marker')
    check('a foreign key column is marked in its header, and only that one', visAll('.grid-head-fk').length === 1 && icon.dataset.fk === '1')

    down(cell(2, 1))
    await waitFor(() => vis('.grid-fk-hint'), 'the hint')
    check('selecting its cell says where it leads', /customers.name/.test(vis('.grid-fk-hint').textContent) && /click/.test(vis('.grid-fk-hint').textContent), vis('.grid-fk-hint').textContent)

    const before = Object.keys(scripts()).length
    down(cell(2, 1), mod())
    const jumped = await waitFor(() => Object.values(scripts()).find((s) => s.name === 'customers'), 'the referenced rows to open')
    check('command-click opens the referenced row in a new script that runs at once', jumped.text === 'SELECT * FROM \`shop\`.\`customers\` WHERE \`name\` = ' + String.fromCharCode(39) + 'customer-2' + String.fromCharCode(39) + ' LIMIT 1000;' && jumped.database === 'shop' && jumped.connectionId === 'sql-dev' && Object.keys(scripts()).length === before + 1, jumped.text)
    await waitFor(() => jumped.run || scripts()[jumped.id].run, 'it to run')

    // From the other side: which rows point at this one
    const customers = await runQuery('SELECT * FROM shop.customers LIMIT 5;', 'customers list')
    await waitFor(() => vis('.grid-head-fk'), 'the marker on the referenced column')
    check('the column other tables point at is marked too', visAll('.grid-head-fk').length === 1 && vis('.grid-head-fk').dataset.fk === '1')
    down(cell(1, 1))
    ui.commands.execute('grid.findReferencingRows')
    const back = await waitFor(() => Object.values(scripts()).find((s) => s.name === 'orders' && s.text.includes('WHERE')), 'the referencing rows to open')
    check('finding the rows that point at a row opens them, matching on the other table’s column', back.text === 'SELECT * FROM \`shop\`.\`orders\` WHERE \`customer\` = ' + String.fromCharCode(39) + 'Customer 2' + String.fromCharCode(39) + ' LIMIT 1000;', back.text)

    // The shortcut does the same as the click
    const again = await runQuery('SELECT * FROM shop.orders LIMIT 20;', 'links again')
    await waitFor(() => vis('.grid-head-fk'), 'the marker again')
    down(cell(3, 1))
    const lookups = () => Object.values(scripts()).filter((s) => s.text.includes('WHERE \`name\`')).length
    const count = lookups()
    keyCode('KeyJ', { ...mod(), altKey: true })
    await waitFor(() => lookups() === count + 1, 'the shortcut to open it')
    check('the keyboard shortcut follows the key too', true)
`)

/** The navigator filter reaches into what is loaded. */
export const TREE_FILTER = wrap(`
    await sidebar('Connections')
    ui.useTree.getState().reset('sql-dev')
    ui.useTree.getState().expand('sql-dev', null)
    const branch = (key) => ui.useTree.getState().branches[key]
    await waitFor(() => branch('sql-dev') && branch('sql-dev').status === 'loaded', 'the schemas')
    const shop = branch('sql-dev').nodes.find((n) => n.label === 'shop')
    ui.useTree.getState().expand('sql-dev', shop)
    await waitFor(() => branch('sql-dev|' + shop.id) && branch('sql-dev|' + shop.id).status === 'loaded', 'the groups')
    const tablesGroup = branch('sql-dev|' + shop.id).nodes.find((n) => n.label === 'Tables')
    ui.useTree.getState().expand('sql-dev', tablesGroup)
    await waitFor(() => branch('sql-dev|' + tablesGroup.id) && branch('sql-dev|' + tablesGroup.id).status === 'loaded', 'the tables')
    await sleep(150)

    const labels = () => all('.tree-row .tree-label').map((l) => l.textContent)
    const filter = document.querySelector('[aria-label="Filter connections and loaded objects"]')
    check('without a filter the tables are all listed', labels().includes('orders') && labels().includes('customers') && labels().includes('products'), labels().join(','))

    setValue(filter, 'cust')
    await waitFor(() => !labels().includes('orders'), 'the list to narrow')
    check('a filter keeps the tables that match, and the way to them', labels().join(',') === 'SQL dev,shop,Tables,customers', labels().join(','))
    check('and says only what is loaded is searched', /loaded/.test(document.querySelector('.tree-filter-note').textContent))

    setValue(filter, 'sql prod')
    await waitFor(() => labels().length === 1, 'only the other connection')
    check('a filter can find a connection by name', labels().join(',') === 'SQL prod', labels().join(','))

    setValue(filter, 'zzzz')
    await waitFor(() => /Nothing matches/.test(document.querySelector('.navigator').textContent), 'the message')
    check('nothing matching says so, and what to do about it', /open a schema/.test(document.querySelector('.navigator').textContent))

    setValue(filter, '')
    await waitFor(() => labels().includes('orders') && labels().includes('SQL prod'), 'the full list again')
    check('clearing the filter brings everything back', labels().includes('products'))
    ui.useTree.getState().reset('sql-dev')
`)

/** A result of 300,000 rows: the window keeps 100,000 and the core holds the rest on disk. */
export const LARGE_RESULT = wrap(`
    const started = Date.now()
    const id = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 300000;', name: 'large', run: true })
    await waitFor(() => stmt0(id) && stmt0(id).status === 'paused', 'the first page')
    ui.loadMore(id, 0, 'all')
    await waitFor(() => stmt0(id).status === 'done', 'every row', 120000)
    const set = stmt0(id).resultSets[0]
    const store = set.store
    check('300,000 rows arrive: the window keeps 100,000 and the core holds the other 200,000', store.length === 300000 && store.rows.length === 100000 && store.spilled === 200000, store.rows.length + ' here, ' + store.spilled + ' held, in ' + (Date.now() - started) + ' ms')

    check('a row the core holds is not here until it is asked for', store.peekRow(150000) === undefined)
    store.getRow(150000)
    await waitFor(() => store.peekRow(150000), 'the page with that row')
    check('asking fetches its page, and the row has the right value', store.peekRow(150000)[0] === 150001 && store.peekRow(150999)[0] === 151000 && store.peekRow(149999) === undefined, JSON.stringify(store.peekRow(150000)))
    const held = store.peekRow(150000)
    check('rows the core holds keep every kind of value: NULL, text, and bytes', held[4] === null && held[1] === 'customer-' + (150000 % 977) && held[6] instanceof Uint8Array && held[6][0] === 240 && held[6][2] === 0xde && held[6].length === 4, JSON.stringify(held))
    store.getRow(150003)
    check('a row with a JSON value and no bytes comes back whole', store.peekRow(150003)[4] === '{"source":"app","items":' + ((150003 % 7) + 1) + '}' && store.peekRow(150003)[6] === null)

    // Scrolling the real grid to rows the window never held
    await waitFor(() => vis('.grid-row'), 'the grid')
    const rowHeight = visAll('.grid-row')[0].getBoundingClientRect().height
    vis('.grid').scrollTop = 250000 * rowHeight
    const far = await waitFor(() => cell(250005, 0) && cell(250005, 0).textContent === '250006' ? cell(250005, 0) : null, 'rows at 250,000', 15000)
    check('scrolling the grid to a row the core holds shows that row', far.textContent === '250006' && !vis('.grid-row-pending'), far.textContent)

    await waitFor(() => /read-only/i.test((vis('.edit-bar-quiet') || {}).textContent || ''), 'the reason')
    check('a result this big is read-only, and says so', /100,000/.test(vis('.edit-bar-quiet').textContent) && /Large result/.test(vis('.result-summary').textContent), vis('.edit-bar-quiet').textContent)

    // Selection statistics reach into the rows the core holds
    down(cell(250005, 0))
    vis('.grid').scrollTop = 100000 * rowHeight
    await waitFor(() => cell(100003, 0), 'rows at 100,000')
    down(cell(100003, 0), { shiftKey: true })
    await waitFor(() => /Σ 26,251,/.test((vis('.grid-footer') || {}).textContent || ''), 'the statistics for 150,003 rows', 15000)
    const footer = vis('.grid-footer').textContent
    // The ids 100,004 to 250,006 add up to 26,251,275,015.
    const rowsInSelection = 250005 - 100003 + 1
    const expectedSum = (100004 + 250006) * rowsInSelection / 2
    check('selection statistics add up the rows the core holds too, exactly', footer.includes('Σ ' + expectedSum.toLocaleString('en-US')) && footer.includes(rowsInSelection.toLocaleString('en-US') + ' numbers') && !/partial/.test(footer), footer)

    // Copying rows the core holds
    vis('.grid').scrollTop = 280000 * rowHeight
    await waitFor(() => cell(280004, 0), 'rows at 280,000')
    down(cell(280000, 0))
    down(cell(280004, 0), { shiftKey: true })
    await sleep(150)
    ui.commands.execute('grid.copyCsv')
    await waitFor(() => notice(/Copied 5 cells/), 'the copy')
    check('copying rows the core holds fetches them and keeps their order', window.__dbide_clipboard === ['id', '280001', '280002', '280003', '280004', '280005'].join(NL), window.__dbide_clipboard)

    // Too many rows to put on a clipboard
    press(vis('.grid'), 'a', mod())
    await sleep(150)
    ui.commands.execute('grid.copyCsv')
    await waitFor(() => notice(/Copy is limited to 250,000/), 'the limit')
    check('copying 300,000 rows says to export instead of freezing', true)

    // Running again lets go of what was held
    const oldKey = set.id
    check('the core holds the rows under the result id', (await call('results.fetch', { key: oldKey, from: 0, count: 1 }))[0][0] === 100001)
    keyCode('Enter', mod())
    await waitFor(() => stmt0(id).resultSets[0] && stmt0(id).resultSets[0].id !== oldKey && stmt0(id).status === 'paused', 'the second run')
    check('running the script again lets go of the rows the first run held', (await call('results.fetch', { key: oldKey, from: 0, count: 1 })).length === 0)

    // So does closing it
    ui.loadMore(id, 0, 'all')
    await waitFor(() => stmt0(id).status === 'done', 'the second result', 120000)
    const newKey = stmt0(id).resultSets[0].id
    check('the second result is held too', (await call('results.fetch', { key: newKey, from: 0, count: 1 })).length === 1)
    ui.useWorkbench.getState().closeTab('sql:' + id)
    await waitFor(async () => (await call('results.fetch', { key: newKey, from: 0, count: 1 })).length === 0, 'the rows to be let go')
    check('closing the tab lets go of what it held', true)

    // A million rows up to the cap, with nothing but a count to show for most of them
    const capStarted = Date.now()
    const cap = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT n FROM big;', name: 'cap', run: true })
    await waitFor(() => stmt0(cap) && stmt0(cap).status === 'paused', 'the first page of the big one')
    ui.loadMore(cap, 0, 'all')
    await waitFor(() => stmt0(cap).status === 'done', 'a million rows', 120000)
    const capStore = stmt0(cap).resultSets[0].store
    check('a result past the cap holds a million rows without the window keeping more than 100,000', stmt0(cap).truncated === true && capStore.length === 1000000 && capStore.rows.length === 100000, capStore.rows.length + ' here in ' + (Date.now() - capStarted) + ' ms')
    ui.useWorkbench.getState().closeTab('sql:' + cap)
`)

/** What the first launch leaves behind, so a second launch can show it comes back. */
export const LEAVE_STATE = wrap(`
    await closeAllSqlTabs()
    const a = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT ' + String.fromCharCode(34) + 'a' + String.fromCharCode(34) + ';', name: 'Restart A' })
    const b = ui.createScript({ connectionId: 'sql-prod', text: 'SELECT ' + String.fromCharCode(34) + 'b' + String.fromCharCode(34) + ';' + NL + 'SELECT 2;', name: 'Restart B' })
    await waitFor(async () => (await readScript(a)) === 'SELECT ' + String.fromCharCode(34) + 'a' + String.fromCharCode(34) + ';' && (await readScript(b)).includes('SELECT 2;'), 'both scripts to be saved')
    ui.useWorkbench.getState().activate('sql:' + a)
    await typeInEditor('SELECT ' + String.fromCharCode(34) + 'a edited' + String.fromCharCode(34) + ';')
    await waitFor(async () => (await readScript(a)).includes('a edited'), 'the edit to be saved', 6000)
    ui.useWorkbench.getState().activate('sql:' + b)
    await waitFor(async () => {
      const list = await call('scripts.list', undefined)
      const open = list.filter((s) => s.openOrder !== null)
      return open.length === 2 && open.find((s) => s.id === b).active
    }, 'the tabs to be remembered')
    check('two tabs are open and the second is in front', true)
    out.a = a
    out.b = b
`)

/** Second launch: everything the first one left comes back by itself. */
export const RESTART = wrap(`
    await waitFor(() => document.documentElement.dataset.boot === 'ready', 'the app to boot', 20000)
    const tabs = all('.tabs .tab')
    const titles = tabs.map((t) => (t.querySelector('.tab-title') || {}).textContent)
    check('the tabs that were open come back, in order', titles.join(',') === 'Welcome,Restart A,Restart B', titles.join(','))
    const front = tabs.find((t) => t.getAttribute('aria-selected') === 'true')
    check('the tab that was in front is in front', front && front.querySelector('.tab-title').textContent === 'Restart B')
    const open = Object.values(scripts())
    const a = open.find((s) => s.name === 'Restart A')
    const b = open.find((s) => s.name === 'Restart B')
    check('their text is back, including what was typed last', a && a.text.includes('a edited') && b && b.text.includes('SELECT 2;'), a && a.text)
    check('each is on its own connection and database', a.connectionId === 'sql-dev' && a.database === 'shop' && b.connectionId === 'sql-prod')
    check('a production script starts locked again, whatever it was before', b.writable === false)
    await sidebar('History')
    await waitFor(() => all('.history-item').length > 5, 'history from the last launch')
    check('query history survives a restart', true)
    await sidebar('Scripts')
    await waitFor(() => all('.script-row').length > 3, 'the library')
    check('the script library survives a restart', all('.script-row').some((r) => r.textContent.includes('Quarterly')))
    const editorText = (vis('.cm-content') || {}).textContent
    check('the editor of the front tab shows the restored text', editorText && editorText.includes('SELECT 2;'), editorText)
    await call('scripts.setOpen', { ids: [], active: null })
`)

/** The parts of a zip file by name, checked against their checksums, the way another program reads it. */
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

function lines(text: string): string[] {
  return text.split('\n')
}

export interface LibraryDirs {
  /** The scripts folder inside the app's data directory. */
  scriptsDir: string
  /** Where dialogs answer from; exports land here. */
  filesDir: string
}

/** Other programs, as far as a script file is concerned: edit one and delete another. */
export function touchFilesBehindTheAppsBack(scriptsDir: string): void {
  writeFileSync(join(scriptsDir, 'Quarterly.sql'), 'SELECT "edited elsewhere";')
  rmSync(join(scriptsDir, 'Recoverable.sql'), { force: true })
}

/** Reads what the app wrote to disk and checks it, the way another program would see it. */
export function verifyFiles(
  dirs: LibraryDirs,
  out: { files?: Record<string, string>; csvPath?: string },
): Check[] {
  const checks: Check[] = []
  const check = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, ...(detail === undefined ? {} : { detail }) })
  }
  /** A file that is missing reads as a clear failure instead of stopping every check after it. */
  const read = (path: string): string => {
    try {
      return readFileSync(path, 'utf8')
    } catch {
      return `<missing ${path}>`
    }
  }
  const files = out.files ?? {}

  // Scripts on disk
  const scripts = readdirSync(dirs.scriptsDir)
  check(
    'on disk: scripts are plain .sql files named after the script',
    scripts.includes('Quarterly.sql') && !scripts.includes('Monthly report.sql'),
    scripts.join(', '),
  )
  check(
    'on disk: the restored text is in the file',
    read(join(dirs.scriptsDir, 'Quarterly.sql')) === 'SELECT 42;',
  )
  check(
    'on disk: the file that was deleted is back, with its text',
    existsSync(join(dirs.scriptsDir, 'Recoverable.sql')) &&
      read(join(dirs.scriptsDir, 'Recoverable.sql')) === 'SELECT "precious";',
  )
  check('on disk: a deleted script is gone', !scripts.includes('Doomed.sql'))
  check(
    'on disk: an imported file keeps its Windows line endings, and the original is untouched',
    read(join(dirs.scriptsDir, 'legacy-report.sql')) === "SELECT 'imported' AS source;\r\n" &&
      read(join(dirs.filesDir, 'import', 'legacy-report.sql')) ===
        "SELECT 'imported' AS source;\r\n",
  )
  check(
    'on disk: no temporary files are left in the scripts folder',
    !scripts.some((name) => name.endsWith('.tmp')),
    scripts.join(', '),
  )

  // CSV from the dialog: BOM, header, NULL text
  if (out.csvPath) {
    const raw = readFileSync(out.csvPath)
    check(
      'csv: Excel-friendly means a UTF-8 byte order mark',
      raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf,
    )
    const rows = lines(raw.toString('utf8').slice(1))
    check(
      'csv: a header, 2,500 rows, and a final line break',
      rows[0] === 'id,customer,total,created_at,meta,note,token' &&
        rows.length === 2502 &&
        rows[2501] === '',
      `${rows.length} lines; ${rows[0]}`,
    )
    check(
      'csv: NULL is written as chosen, binary as hex',
      rows[1] === '1,customer-0,0,2026-03-01 00:15:00,NULL,NULL,0x0000dead',
      rows[1],
    )
    check(
      'csv: JSON values are quoted with their quotes doubled',
      rows[2] ===
        '2,customer-1,0.37,2026-03-02 01:15:00,"{""source"":""app"",""items"":2}",Order note 1,NULL',
      rows[2],
    )
  }

  const json = files['matrix.json']
  if (json) {
    const parsed = (JSON.parse(read(json)) ?? []) as Record<string, unknown>[]
    check(
      'json: one object per row, numbers as numbers, NULL as null',
      parsed.length === 40 &&
        parsed[0]!.id === 1 &&
        parsed[1]!.total === 0.37 &&
        parsed[0]!.meta === null &&
        parsed[0]!.token === '0x0000dead',
      JSON.stringify(parsed[0]),
    )
  }
  const ndjson = files['matrix.ndjson']
  if (ndjson) {
    const rows = lines(read(ndjson)).filter(Boolean)
    check(
      'ndjson: one valid object per line',
      rows.length === 40 && rows.every((row) => typeof JSON.parse(row) === 'object'),
    )
  }
  const tsv = files['matrix.tsv']
  if (tsv) {
    const rows = lines(read(tsv))
    check(
      'tsv: tab separated with a header',
      rows[0] === 'id\tcustomer\ttotal\tcreated_at\tmeta\tnote\ttoken' &&
        rows[1]!.split('\t').length === 7,
      rows[0],
    )
  }
  const markdown = files['matrix.md']
  if (markdown) {
    const rows = lines(read(markdown)).filter(Boolean)
    check(
      'markdown: a header, a divider and 40 rows',
      rows.length === 42 && rows[0]!.startsWith('| id |') && rows[1]!.startsWith('| ---'),
    )
  }
  const sql = files['matrix.sql']
  if (sql) {
    const text = read(sql)
    const statements = text.split('INSERT INTO ').length - 1
    check(
      'sql: INSERT statements with 10 rows each, names quoted',
      statements === 4 &&
        text.startsWith(
          'INSERT INTO `shop`.`orders` (`id`, `customer`, `total`, `created_at`, `meta`, `note`, `token`) VALUES\n',
        ),
      `${statements} statements`,
    )
  }
  const xlsx = files['matrix.xlsx']
  if (xlsx) {
    try {
      const parts = unzip(readFileSync(xlsx))
      const sheet = parts.get('xl/worksheets/sheet1.xml') ?? ''
      check(
        'xlsx: a zip with a workbook, a sheet and styles, every part matching its checksum',
        ['xl/workbook.xml', 'xl/styles.xml', '[Content_Types].xml', '_rels/.rels'].every((name) =>
          parts.has(name),
        ) && sheet !== '',
        [...parts.keys()].join(', '),
      )
      check(
        'xlsx: a header and 40 rows, numbers as numbers, NULL as an empty cell',
        (sheet.match(/<row /g) ?? []).length === 41 &&
          sheet.includes('<c r="A1" t="inlineStr" s="1"><is><t>id</t></is></c>') &&
          sheet.includes('<c r="A2"><v>1</v></c>') &&
          sheet.includes('<c r="C3"><v>0.37</v></c>') &&
          !sheet.includes('<c r="E2"'),
        sheet.slice(0, 400),
      )
    } catch (error) {
      check('xlsx: the file reads back', false, String(error))
    }
  }
  const hugeXlsx = files['huge.xlsx']
  if (hugeXlsx) {
    try {
      const parts = unzip(readFileSync(hugeXlsx))
      const first = parts.get('xl/worksheets/sheet1.xml') ?? ''
      const second = parts.get('xl/worksheets/sheet2.xml') ?? ''
      const rowsOf = (xml: string): number => xml.split('<row ').length - 1
      check(
        'xlsx: 1,500,000 rows fill one sheet of 1,048,576 rows and carry on in a second, each with its header',
        rowsOf(first) === 1_048_576 &&
          rowsOf(second) === 1 + (1_500_000 - 1_048_575) &&
          second.includes('<c r="A1" t="inlineStr" s="1"><is><t>n</t></is></c>') &&
          second.includes('<c r="A451426"><v>1500000</v></c>'),
        `${rowsOf(first)} + ${rowsOf(second)} rows`,
      )
    } catch (error) {
      check('xlsx: the big file reads back', false, String(error))
    }
  }
  const semicolon = files['matrix-semicolon.csv']
  if (semicolon) {
    const text = read(semicolon)
    check(
      'csv: another separator, no header, every value quoted, Windows line endings',
      text.startsWith('"1";"customer-0";"0";') && text.split('\r\n').length === 41,
      text.slice(0, 60),
    )
  }
  const huge = files['huge.csv']
  if (huge) {
    const text = read(huge)
    const count = text.split('\n').length - 1
    check(
      'huge: 1,500,001 lines (header and every row), the last one complete',
      count === 1_500_001 && text.endsWith('\n1500000\n'),
      `${count} lines, ${(text.length / 1e6).toFixed(1)} MB`,
    )
  }

  const left = readdirSync(dirs.filesDir)
  check(
    'a cancelled export leaves nothing behind',
    !left.some((name) => name.endsWith('.part')) &&
      !left.some((name) => name.startsWith('result-')),
    left.join(', '),
  )
  check('refused exports wrote nothing', !left.includes('never.csv'))
  return checks
}
