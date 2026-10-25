import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { app, type BrowserWindow } from 'electron'
import { liveScript, verifyLiveFiles } from './smoke-live'
import { mongoScript, type MongoTarget } from './smoke-mongo'
import { rabbitScript, type RabbitTarget } from './smoke-rabbit'
import { redisScript, type RedisTarget } from './smoke-redis'
import { startFakeRedis, type FakeRedis } from '../core/drivers/redis/fake-redis'
import { startFakeBroker, type FakeBroker } from '../core/drivers/rabbitmq/fake-broker'
import {
  EXPORT_1,
  FILES_1,
  GRID_COMMIT,
  GRID_GENERATE,
  GRID_GENERATE_DELETE,
  GRID_LINKS,
  GRID_WIDE,
  LARGE_RESULT,
  TREE_FILTER,
  files2,
  HISTORY_1,
  LEAVE_STATE,
  RESTART,
  touchFilesBehindTheAppsBack,
  verifyFiles,
} from './smoke-library'

/**
 * End-to-end smoke test, run with `pnpm smoke`. It boots the real app and drives the whole
 * vertical slice from inside the renderer: MessagePort → core process → SQLite → secrets in
 * the main process → network probes. Exits non-zero on the first broken link, so CI can
 * gate on "the app starts and its processes can talk to each other" on every OS.
 */

interface Check {
  name: string
  ok: boolean
  detail?: string
}

const PAGE_SCRIPT = (port: number, closedPort: number): string => `
(async () => {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) })
  const call = window.__dbide_call
  const deadline = Date.now() + 20000
  while (document.documentElement.dataset.boot !== 'ready') {
    if (Date.now() > deadline) return { checks: [{ name: 'renderer booted', ok: false, detail: document.documentElement.dataset.boot }] }
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  check('renderer booted', true)
  check('app shell rendered', document.querySelector('[data-testid="app-shell"]'))

  const info = await call('app.info', undefined)
  check('core answers app.info', info.sqlite && info.node, JSON.stringify(info))

  const settings = await call('settings.set', { density: 'compact' })
  check('settings persist', settings.density === 'compact')
  await call('settings.set', { density: 'default' })

  const base = {
    id: 'smoke-1', name: 'Smoke Redis', engine: 'redis', environment: 'dev',
    host: '127.0.0.1', port: ${port}, tls: { enabled: false, allowInvalidCertificates: false }, options: {},
  }
  await call('connections.save', { config: base, secrets: { password: 'hunter2' } })
  const list = await call('connections.list', undefined)
  check('connection saved and listed', list.some((c) => c.id === 'smoke-1'))
  const stored = await call('connections.get', { id: 'smoke-1' })
  check('password stored through main process', stored && stored.hasPassword === true)
  check('password is not in the config', stored && !JSON.stringify(stored.config).includes('hunter2'))

  const ok = await call('connections.test', { config: base })
  const tcp = ok.find((s) => s.id === 'tcp')
  check('test: tcp reaches the local server', tcp && tcp.status === 'ok', tcp && tcp.detail)

  const refused = await call('connections.test', { config: { ...base, port: ${closedPort} } })
  const refusedTcp = refused.find((s) => s.id === 'tcp')
  check('test: closed port fails at tcp', refusedTcp && refusedTcp.status === 'failed', refusedTcp && refusedTcp.detail)
  check('test: later steps are skipped', refused.filter((s) => s.id === 'tls' || s.id === 'auth').every((s) => s.status === 'skipped'))

  try {
    await call('connections.save', { config: { ...base, port: 0 } })
    check('invalid input is rejected', false)
  } catch (error) {
    check('invalid input is rejected', error && error.code === 'INVALID_INPUT', error && error.message)
  }

  await call('connections.delete', { id: 'smoke-1' })
  const after = await call('connections.list', undefined)
  check('connection deleted', !after.some((c) => c.id === 'smoke-1'))
  return { checks }
})()
`

/** Drives the SQL workflow through the same stores the UI uses, against the demo engine. */
const SQL_SCRIPT = `
(async () => {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ui = window.__dbide_ui
  const call = window.__dbide_call
  const scripts = () => ui.useScripts.getState().scripts
  const waitFor = async (fn, label, ms = 30000) => {
    const started = Date.now()
    while (!fn()) {
      if (Date.now() - started > ms) throw new Error('timed out waiting for ' + label)
      await sleep(20)
    }
  }
  const stmt = (id, i = 0) => scripts()[id] && scripts()[id].run && scripts()[id].run.statements[i]
  const runState = (id) => scripts()[id] && scripts()[id].run && scripts()[id].run.state
  const base = (id, name, environment) => ({ id, name, engine: 'mysql', environment, host: '127.0.0.1', port: 3306, username: 'app', tls: { enabled: false, allowInvalidCertificates: false }, options: {} })
  await call('connections.save', { config: base('sql-dev', 'SQL dev', 'dev') })
  await call('connections.save', { config: base('sql-prod', 'SQL prod', 'prod') })

  try {
    const info = await call('sessions.open', { connectionId: 'sql-dev' })
    check('session opens and reports the server', info.serverVersion.includes('demo') && info.readOnly === false, JSON.stringify(info))
    const prodInfo = await call('sessions.open', { connectionId: 'sql-prod' })
    check('prod session starts read-only', prodInfo.readOnly === true)

    const roots = await call('tree.children', { connectionId: 'sql-dev', parent: null })
    check('tree: roots list user schemas then a system group', roots.map((n) => n.label).join(',') === 'analytics,shop,System schemas', roots.map((n) => n.label).join(','))
    const shop = roots.find((n) => n.label === 'shop')
    const groups = await call('tree.children', { connectionId: 'sql-dev', parent: shop })
    check('tree: schema shows its groups', groups.map((n) => n.label).join(',') === 'Tables,Views,Routines', groups.map((n) => n.label).join(','))
    const tables = await call('tree.children', { connectionId: 'sql-dev', parent: groups[0] })
    const orders = tables.find((n) => n.label === 'orders')
    check('tree: tables carry an estimate and size', orders && /rows/.test(orders.detail) && orders.scope === 'shop', orders && orders.detail)
    const columns = await call('tree.children', { connectionId: 'sql-dev', parent: orders })
    check('tree: table shows columns, indexes, and foreign keys', columns.slice(-2).map((n) => n.label).join(',') === 'Indexes,Foreign keys')
    const completion = await call('schema.completion', { connectionId: 'sql-dev', database: 'shop' })
    check('completion schema lists tables and columns', completion.orders && completion.orders.includes('customer'))

    // Streaming and paging
    const paged = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 5000;', run: true })
    await waitFor(() => stmt(paged) && stmt(paged).status === 'paused', 'first page')
    const set = stmt(paged).resultSets[0]
    check('first page is 1,000 rows, then it waits', set.store.length === 1000, set.store.length)
    check('columns and types arrive', set.columns.length === 7 && set.columns[2].type === 'decimal')
    const r0 = set.store.getRow(0)
    const r1 = set.store.getRow(1)
    check('values keep their types: numbers as numbers, decimals as exact text', r0[0] === 1 && r1[2] === '0.37' && typeof r1[2] === 'string', JSON.stringify(r1.slice(0, 3)))
    check('NULL and binary cells survive the trip', r0[4] === null && r0[6] instanceof Uint8Array && r0[6].length === 4, typeof r0[6])
    ui.loadMore(paged, 0, 'all')
    await waitFor(() => stmt(paged).status === 'done', 'rest of rows')
    check('load all streams the remaining rows', stmt(paged).resultSets[0].store.length === 5000 && runState(paged) === 'completed')

    const exact = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 1000;', run: true })
    await waitFor(() => runState(exact) === 'completed', 'exact page')
    check('a result that is exactly one page does not pause', stmt(exact).resultSets[0].store.length === 1000)

    // Cancel
    const slow = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT SLEEP(30);', run: true })
    await waitFor(() => stmt(slow) && stmt(slow).status === 'running', 'slow statement running')
    const cancelStarted = Date.now()
    ui.cancelRun(slow)
    await waitFor(() => runState(slow) === 'cancelled', 'cancel', 8000)
    check('cancel stops a running statement quickly', Date.now() - cancelStarted < 4000, (Date.now() - cancelStarted) + ' ms')

    // Errors and skipped statements
    const failing = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT 1;\\nSELECT * FROM bad;\\nSELECT 3;', run: true })
    await waitFor(() => runState(failing) === 'error', 'error run')
    check('an error stops the script and keeps its code', stmt(failing, 1).status === 'error' && stmt(failing, 1).error.code === 'ER_NO_SUCH_TABLE')
    check('statements before the error finished, after it were skipped', stmt(failing, 0).status === 'done' && stmt(failing, 2).status === 'skipped')

    // Hard cap
    const big = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT n FROM big;', run: true })
    await waitFor(() => stmt(big) && stmt(big).status === 'paused', 'big first page')
    const bigStarted = Date.now()
    ui.loadMore(big, 0, 'all')
    await waitFor(() => stmt(big).status === 'done', 'big result', 120000)
    check('a huge result stops at the cap and says so', stmt(big).truncated === true && stmt(big).resultSets[0].store.length === 1000000, stmt(big).resultSets[0].store.length + ' rows in ' + (Date.now() - bigStarted) + ' ms')

    // Safeguards
    const blocked = ui.createScript({ connectionId: 'sql-prod', text: 'DELETE FROM orders WHERE id = 1;', run: true })
    await sleep(100)
    check('a write on a locked prod connection is blocked before it is sent', runState(blocked) === 'error' && stmt(blocked).error.code === 'READ_ONLY' && scripts()[blocked].writable === false, runState(blocked))
    const prodRead = ui.createScript({ connectionId: 'sql-prod', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 10;', run: true })
    await waitFor(() => runState(prodRead) === 'completed', 'prod read')
    check('reads still run on prod', stmt(prodRead).resultSets[0].store.length === 10)

    const insert = ui.createScript({ connectionId: 'sql-dev', text: "INSERT INTO t VALUES (1);", run: true })
    await waitFor(() => runState(insert) === 'completed', 'insert')
    check('an ordinary write on dev runs without asking and reports rows affected', stmt(insert).ok && stmt(insert).ok.affectedRows === 3 && stmt(insert).ok.insertId === '1042')

    const risky = ui.createScript({ connectionId: 'sql-dev', text: 'DELETE FROM orders;', run: true })
    await waitFor(() => ui.useGuard.getState().request !== null, 'confirmation')
    const asked = ui.useGuard.getState().request
    check('a delete without WHERE asks first, and says why', asked.reasons.join(' ').includes('WHERE') && asked.typedName === false)
    ui.useGuard.getState().answer(false)
    await sleep(100)
    check('declining runs nothing', scripts()[risky].run === null)
    ui.createScript({ connectionId: 'sql-dev', text: 'SELECT 1;', run: false })
  } catch (error) {
    check('sql workflow', false, error && error.message)
  }
  return { checks }
})()
`

/** Drives row editing and the inspector through the real UI: DOM events on the grid and its panels. */
const EDIT_SCRIPT = `
(async () => {
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail === undefined ? undefined : String(detail) })
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const ui = window.__dbide_ui
  const scripts = () => ui.useScripts.getState().scripts
  const waitFor = async (fn, label, ms = 15000) => {
    const started = Date.now()
    while (!fn()) {
      if (Date.now() - started > ms) throw new Error('timed out waiting for ' + label)
      await sleep(20)
    }
  }
  const stmt = (id) => scripts()[id] && scripts()[id].run && scripts()[id].run.statements[0]
  const vis = (selector) => document.querySelector('.workbench-sql:not([hidden]) ' + selector)
  const visAll = (selector) => [...document.querySelectorAll('.workbench-sql:not([hidden]) ' + selector)]
  const cell = (r, c) => vis('[data-r="' + r + '"][data-c="' + c + '"]')
  const text = (el) => (el ? el.textContent : null)
  const setValue = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const setArea = (area, value) => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, value)
    area.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (el, key, init = {}) => el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  const dbl = (el) => el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
  const down = (el, init = {}) => el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...init }))
  const button = (label) => visAll('button').find((b) => b.textContent.trim().startsWith(label))
  const input = () => vis('.field-editor input')
  const typeInto = async (r, c, value) => {
    dbl(cell(r, c))
    await waitFor(input, 'cell editor')
    setValue(input(), value)
    press(input(), 'Enter')
    await sleep(80)
  }
  const base64url = (value) => btoa(value).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
  const gzipBase64 = async (value) => {
    const stream = new Blob([value]).stream().pipeThrough(new CompressionStream('gzip'))
    const bytes = new Uint8Array(await new Response(stream).arrayBuffer())
    let binary = ''
    bytes.forEach((b) => { binary += String.fromCharCode(b) })
    return btoa(binary)
  }
  const NL = String.fromCharCode(10)

  try {
    const id = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 20;', run: true })
    await waitFor(() => stmt(id) && stmt(id).status === 'done', 'results')
    await waitFor(() => button('Add row'), 'edit bar')
    const resultId = stmt(id).resultSets[0].id
    const store = stmt(id).resultSets[0].store
    check('a plain single-table result becomes editable once its keys are known', true)

    await typeInto(1, 1, 'Renamed')
    check('typing into a cell stages a change without saving it', visAll('.cell-changed').length === 1 && text(cell(1, 1)) === 'Renamed' && store.getRow(1)[1] === 'customer-1', text(cell(1, 1)))
    check('the change is counted', visAll('.edit-count').some((e) => e.textContent === '1 unsaved change'))

    dbl(cell(2, 2))
    await waitFor(input, 'editor')
    setValue(input(), 'abc')
    press(input(), 'Enter')
    await sleep(60)
    check('an invalid value keeps the editor open and says why', vis('.field-error-tip') && /Enter a number/.test(text(vis('.field-error-tip'))) && visAll('.cell-changed').length === 1)
    press(input(), 'Escape')
    await sleep(60)

    dbl(cell(3, 1))
    await waitFor(input, 'editor')
    check('a NOT NULL column offers no NULL button', !vis('.field-null'))
    press(input(), 'Escape')
    await sleep(60)
    dbl(cell(7, 5))
    await waitFor(input, 'editor')
    vis('.field-null').click()
    await sleep(80)
    check('the NULL button stages NULL for a nullable column', text(cell(7, 5)) === 'NULL' && visAll('.cell-changed').length === 2, text(cell(7, 5)))

    down(cell(4, 0))
    await sleep(60)
    press(vis('.grid'), 'Delete')
    await sleep(60)
    check('Delete marks the selected row for deletion', visAll('.row-deleted').length === 1)

    button('Add row').click()
    await waitFor(input, 'new row editor')
    setValue(input(), 'Brand new')
    press(input(), 'Enter')
    await sleep(80)
    check('a new row starts in the first column a person types into and leaves the key to the server', visAll('.row-new').length === 1 && text(cell(20, 1)) === 'Brand new' && text(cell(20, 0)) === 'DEFAULT', text(cell(20, 0)) + ' / ' + text(cell(20, 1)))
    check('all four changes are counted', visAll('.edit-count').some((e) => e.textContent === '4 unsaved changes'))

    button('Review SQL').click()
    await sleep(60)
    const preview = text(vis('.edit-preview')) || ''
    check('review shows the exact SQL: deletes, then updates, then inserts', preview.indexOf('DELETE') < preview.indexOf('UPDATE') && preview.indexOf('UPDATE') < preview.indexOf('INSERT') && preview.includes("SET \`customer\` = 'Renamed' WHERE \`id\` = 2") && preview.includes('SET \`note\` = NULL WHERE \`id\` = 8') && preview.includes("INSERT INTO \`shop\`.\`orders\` (\`customer\`) VALUES ('Brand new')"), preview)

    // Adding the row scrolled the grid down; the rows below are the ones that are rendered.
    vis('.grid').scrollTop = 0
    await waitFor(() => cell(2, 4), 'rows at the top')
    // The inspector follows the selection.
    down(cell(2, 4))
    await waitFor(() => ui.useInspector.getState().target && ui.useInspector.getState().target.rowIndex === 2, 'inspector target')
    await waitFor(() => document.querySelector('.inspector .value-block .tok-key'), 'json view')
    check('JSON is pretty-printed and colored in the value viewer', /"source"/.test(text(document.querySelector('.inspector .value-block'))))

    down(cell(0, 6))
    await waitFor(() => /00 00 de ad/.test(text(document.querySelector('.inspector .value-block')) || ''), 'hex view')
    check('a binary cell opens as a hexdump', true)

    dbl(cell(6, 5))
    await waitFor(input, 'editor')
    const jwt = base64url('{"alg":"HS256"}') + '.' + base64url('{"sub":"u1","exp":4102444800}') + '.c2ln'
    setValue(input(), jwt)
    press(input(), 'Enter')
    await sleep(80)
    down(cell(6, 5))
    await waitFor(() => [...document.querySelectorAll('.inspector .value-heading')].some((h) => h.textContent === 'Claims'), 'jwt view')
    check('a JWT is decoded, with the signature left unverified', /not verified/.test(text(document.querySelector('.inspector .note-warn')) || '') && /u1/.test(text(document.querySelector('.inspector')) || ''))

    dbl(cell(3, 5))
    await waitFor(input, 'editor')
    setValue(input(), await gzipBase64('{"deep":true}'))
    press(input(), 'Enter')
    await sleep(80)
    down(cell(3, 5))
    await waitFor(() => /Base64 → Compressed → JSON/.test(text(document.querySelector('.inspector .value-layers')) || ''), 'layered view')
    check('Base64 around gzip around JSON is unwrapped layer by layer', /deep/.test(text(document.querySelector('.inspector .value-block')) || ''))

    // Record view
    ;[...document.querySelectorAll('.inspector-tab')].find((t) => t.textContent === 'Record').click()
    await waitFor(() => document.querySelectorAll('.record-field').length === 7, 'record view')
    check('the record view lists every column of the row', document.querySelectorAll('.record-field').length === 7)
    down(cell(1, 0))
    await waitFor(() => ui.useInspector.getState().target.rowIndex === 1 && document.querySelectorAll('.record-field.changed').length >= 1, 'record of row 1')
    check('fields with a staged change are marked in the record view', document.querySelectorAll('.record-field.changed').length >= 1)
    document.querySelectorAll('.record-field')[2].querySelector('.record-edit').click()
    await waitFor(() => document.querySelector('.inspector .field-editor input'), 'record field editor')
    const recordInput = document.querySelector('.inspector .field-editor input')
    setValue(recordInput, '12.50')
    press(recordInput, 'Enter')
    await sleep(80)
    check('editing a field in the record view stages the same change as the grid', text(cell(1, 2)) === '12.50' && visAll('.cell-changed').length >= 4, text(cell(1, 2)))

    // Value tab editor for long values
    ;[...document.querySelectorAll('.inspector-tab')].find((t) => t.textContent === 'Value').click()
    down(cell(5, 5))
    await waitFor(() => [...document.querySelectorAll('.inspector button')].some((b) => b.textContent.trim() === 'Edit'), 'edit button')
    ;[...document.querySelectorAll('.inspector button')].find((b) => b.textContent.trim() === 'Edit').click()
    await waitFor(() => document.querySelector('.inspector textarea'), 'value editor')
    setArea(document.querySelector('.inspector textarea'), 'first line' + NL + 'second line')
    ;[...document.querySelectorAll('.inspector button')].find((b) => b.textContent.trim() === 'Stage change').click()
    await sleep(80)
    check('multi-line values are edited in the inspector and keep their line breaks', ui.useInspector.getState().target.row[5] === 'first line' + NL + 'second line')

    // Commit
    const before = ui.useEdits.getState().sets[resultId]
    const staged = Object.keys(before.updates).length + Object.keys(before.deletes).length + before.inserts.length
    button('Commit').click()
    await waitFor(() => !ui.useEdits.getState().sets[resultId], 'commit')
    check('commit saves every staged change at once and clears them', staged >= 7 && visAll('.cell-changed').length === 0 && visAll('.row-deleted').length === 0 && visAll('.row-new').length === 0, 'staged ' + staged)
    check('saved updates, deletions, and the new row (with the server key) show in the grid', store.length === 20 && store.rows.every((r) => r[0] !== 5) && store.rows.find((r) => r[0] === 2)[1] === 'Renamed' && store.rows.find((r) => r[0] === 2)[2] === '12.50' && store.rows[19][0] === 10001 && store.rows[19][1] === 'Brand new', store.length + ' rows, last id ' + store.rows[store.length - 1][0])
    check('a notice says it was saved', [...document.querySelectorAll('.notice')].some((n) => /Saved/.test(n.textContent)))

    // Conflict
    await typeInto(6, 1, '__conflict__')
    button('Commit').click()
    await waitFor(() => vis('.edit-error'), 'conflict message')
    check('a failed save explains itself and keeps the changes staged', /Nothing was saved/.test(text(vis('.edit-error'))) && ui.useEdits.getState().sets[resultId] !== undefined)
    // A second script with the same query must not see the first one's staged changes.
    const other = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 20;', run: true })
    await waitFor(() => stmt(other) && stmt(other).status === 'done', 'second result')
    await waitFor(() => button('Add row'), 'edit bar of the second result')
    const otherId = stmt(other).resultSets[0].id
    check('staged changes belong to their own result, not to every result of the same shape', otherId !== resultId && visAll('.cell-changed').length === 0 && visAll('.edit-count').length === 0 && ui.useEdits.getState().sets[resultId] !== undefined, resultId + ' vs ' + otherId)
    ui.useEdits.getState().discard(resultId)
    check('discard puts everything back', !ui.useEdits.getState().sets[resultId])

    // Results that cannot be edited say why
    const noKey = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT * FROM shop.customers LIMIT 5;', run: true })
    await waitFor(() => stmt(noKey) && stmt(noKey).status === 'done', 'customers')
    await waitFor(() => /no primary key/.test(text(vis('.edit-bar-quiet')) || ''), 'the reason')
    check('a table without a primary key is read-only, with the reason', /no primary key/.test(text(vis('.edit-bar-quiet'))), text(vis('.edit-bar-quiet')))
    const joined = ui.createScript({ connectionId: 'sql-dev', database: 'shop', text: 'SELECT o.id, c.name FROM shop.orders o JOIN shop.customers c LIMIT 3;', run: true })
    await waitFor(() => stmt(joined) && stmt(joined).status === 'done', 'join')
    await waitFor(() => /joins several tables/.test(text(vis('.edit-bar-quiet')) || ''), 'the reason')
    check('a join is read-only, with the reason', /joins several tables/.test(text(vis('.edit-bar-quiet'))), text(vis('.edit-bar-quiet')))
    const computed = ui.createScript({ connectionId: 'sql-dev', text: 'SELECT 1;', run: true })
    await waitFor(() => stmt(computed) && stmt(computed).status === 'done', 'select 1')
    await waitFor(() => /computed/.test(text(vis('.edit-bar-quiet')) || ''), 'the reason')
    check('a computed column is read-only, with the reason', /computed/.test(text(vis('.edit-bar-quiet'))), text(vis('.edit-bar-quiet')))

    // Production: locked until unlocked, then confirmed before saving
    const prod = ui.createScript({ connectionId: 'sql-prod', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 5;', run: true })
    await waitFor(() => stmt(prod) && stmt(prod).status === 'done', 'prod results')
    await waitFor(() => /Editing is locked/.test(text(vis('.edit-bar')) || ''), 'locked bar')
    dbl(cell(1, 1))
    await sleep(120)
    check('a locked prod result does not open an editor', !input())
    button('Unlock writes').click()
    await waitFor(() => ui.useGuard.getState().request, 'unlock question')
    check('unlocking prod asks first', ui.useGuard.getState().request.action === 'unlock')
    ui.useGuard.getState().answer(true)
    await waitFor(() => button('Add row'), 'unlocked bar')
    await typeInto(1, 1, 'prod edit')
    button('Commit').click()
    await waitFor(() => ui.useGuard.getState().request, 'commit question')
    const asked = ui.useGuard.getState().request
    check('saving on prod shows the SQL and asks first', asked.statements[0].startsWith('UPDATE') && /prod/.test(asked.reasons.join(' ')), asked.statements[0])
    ui.useGuard.getState().answer(false)
    await sleep(100)
    check('declining keeps the change staged', visAll('.edit-count').length === 1)
    button('Commit').click()
    await waitFor(() => ui.useGuard.getState().request, 'second commit question')
    ui.useGuard.getState().answer(true)
    await waitFor(() => visAll('.edit-count').length === 0, 'prod saved')
    check('confirming saves it', true)
  } catch (error) {
    check('row editing workflow', false, error && error.message)
  }
  return { checks }
})()
`

/** Helpers injected into the page for driving the UI the way a user would. */
const PAGE_HELPERS = `
  window.__h = {
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    mod: () => (window.dbide.platform === 'darwin' ? { metaKey: true } : { ctrlKey: true }),
    key: (code, init = {}) => window.dispatchEvent(new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init })),
    click: (el) => el && el.click(),
    byLabel: (text) => { const el = [...document.querySelectorAll('.tree-label')].find((e) => e.textContent === text); return el && el.closest('.tree-row') },
    mouse: (el, init = {}) => el && el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0, ...init })),
    vis: (selector) => document.querySelector('.workbench-sql:not([hidden]) ' + selector),
    cell: (r, c) => document.querySelector('.workbench-sql:not([hidden]) [data-r="' + r + '"][data-c="' + c + '"]'),
    dbl: (el) => el && el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    press: (el, k, init = {}) => el && el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init })),
    type: async (r, c, value) => {
      const h = window.__h
      h.dbl(h.cell(r, c))
      await h.wait(150)
      const input = h.vis('.field-editor input')
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, value)
      input.dispatchEvent(new Event('input', { bubbles: true }))
      h.press(input, 'Enter')
      await h.wait(120)
    },
    button: (label) => [...document.querySelectorAll('.workbench-sql:not([hidden]) button')].find((b) => b.textContent.trim().startsWith(label)),
    byText: (selector, text) => [...document.querySelectorAll(selector)].find((el) => el.textContent.includes(text)),
  };
  true
`

/**
 * Seeds a few connections and walks through the main screens, saving a PNG of each. Run with
 * DBIDE_SMOKE_SHOTS=<dir>. Used to eyeball the design and as CI artifacts.
 */
async function captureScreenshots(window: BrowserWindow, dir: string, port: number): Promise<void> {
  mkdirSync(dir, { recursive: true })
  const run = (script: string): Promise<unknown> =>
    window.webContents.executeJavaScript(`(async () => { ${script} })()`)
  const shot = async (name: string): Promise<void> => {
    await run('await window.__h.wait(350)')
    const image = await window.webContents.capturePage()
    writeFileSync(join(dir, `${name}.png`), image.toPNG())
    console.log(`SMOKE SHOT ${name}`)
  }

  await window.webContents.executeJavaScript(PAGE_HELPERS)
  // The sixth value overrides the port: port 1 is closed, so that connection fails its test.
  const seed = [
    ['shop-db', 'Orders DB', 'mysql', 'prod', 'Shop'],
    ['shop-events', 'Events', 'mongodb', 'staging', 'Shop'],
    ['job-queue', 'Job queue', 'rabbitmq', 'dev', 'Platform'],
    ['local-cache', 'Local cache', 'redis', 'local', undefined],
    ['legacy', 'Legacy MySQL', 'mysql', 'staging', 'Shop', 1],
  ] as const
  for (const [id, name, engine, environment, folder, portOverride] of seed) {
    await run(
      `await window.__dbide_call('connections.save', { config: ${JSON.stringify({
        id,
        name,
        engine,
        environment,
        ...(folder ? { folder } : {}),
        host: '127.0.0.1',
        port: portOverride ?? port,
        username: 'app',
        tls: { enabled: false, allowInvalidCertificates: false },
        options: {},
      })} })`,
    )
  }

  await shot('01-welcome')

  await run(
    `window.__h.click(window.__h.byText('.tree-main', 'Orders DB')); await window.__h.wait(200); window.__h.click(window.__h.byText('button', 'Test connection'))`,
  )
  await run('await window.__h.wait(600)')
  await shot('02-prod-connection')

  await run(`window.__h.click(document.querySelector('[aria-label="Edit Orders DB"]'))`)
  await shot('03-editor')

  await run(`window.__h.key('KeyP', { shiftKey: true, ...window.__h.mod() })`)
  await shot('04-command-palette')
  await run(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )

  await run(`window.__h.key('KeyP', window.__h.mod())`)
  await shot('05-go-to-anything')
  await run(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`,
  )

  await run(
    `window.__h.click(window.__h.byText('.tree-main', 'Events')); window.__h.key('Comma', window.__h.mod())`,
  )
  await shot('06-settings')

  await run(
    `await window.dbide.setThemeSource('dark'); await window.__h.wait(500); window.__h.click(window.__h.byText('.tree-main', 'Orders DB'))`,
  )
  await shot('07-dark-prod')

  await run(`await window.dbide.setThemeSource('dark')`)
  await run(`window.__h.click(window.__h.byText('.tab', 'Welcome'))`)

  // SQL workbench against the demo engine
  await run(`window.__h.click(window.__h.byLabel('Orders DB')); await window.__h.wait(500)`)
  await run(`window.__h.click(window.__h.byLabel('shop')); await window.__h.wait(400)`)
  await run(`window.__h.click(window.__h.byLabel('Tables')); await window.__h.wait(400)`)
  await shot('10-tree')

  await run(
    `window.__h.byLabel('orders').dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); await window.__h.wait(1200)`,
  )
  await shot('11-sql-results')

  await run(
    `window.__h.mouse(document.querySelector('.workbench-sql:not([hidden]) [data-r="2"][data-c="1"]')); window.__h.mouse(document.querySelector('.workbench-sql:not([hidden]) [data-r="7"][data-c="2"]'), { shiftKey: true })`,
  )
  await shot('12-selection')

  await run(
    `window.__dbide_ui.createScript({ connectionId: 'shop-db', text: 'DELETE FROM orders WHERE id = 7;', run: true }); await window.__h.wait(500)`,
  )
  await shot('13-readonly-blocked')

  await run(
    `window.__dbide_ui.createScript({ connectionId: 'legacy', text: 'DROP TABLE orders;', run: true }); await window.__h.wait(500)`,
  )
  await shot('14-confirm-dialog')
  await run(`window.__dbide_ui.useGuard.getState().answer(false)`)

  await run(`await window.dbide.setThemeSource('light'); await window.__h.wait(500)`)
  await run(
    `window.__h.click([...document.querySelectorAll('.tab')].find((t) => t.querySelector('.tab-title') && t.querySelector('.tab-title').textContent === 'orders')); await window.__h.wait(300)`,
  )
  await shot('15-light-sql')

  // Editing, the value viewer, and the record view
  await run(`await window.dbide.setThemeSource('dark'); await window.__h.wait(300)`)
  await run(
    `window.__dbide_ui.createScript({ connectionId: 'legacy', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 40;', run: true }); await window.__h.wait(1500)`,
  )
  await run(`window.__h.mouse(window.__h.cell(1, 4)); await window.__h.wait(400)`)
  await shot('16-value-json')

  await run(
    `const h = window.__h; await h.type(1, 1, 'Renamed customer'); await h.type(2, 2, '99.90')`,
  )
  await run(
    `const h = window.__h; h.mouse(h.cell(4, 0)); await h.wait(100); h.press(h.vis('.grid'), 'Delete'); await h.wait(100)`,
  )
  await run(
    `const h = window.__h; h.button('Add row').click(); await h.wait(300); const i = h.vis('.field-editor input'); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(i, 'New customer'); i.dispatchEvent(new Event('input', { bubbles: true })); h.press(i, 'Enter'); await h.wait(200)`,
  )
  await run(
    `const h = window.__h; h.button('Review SQL').click(); await h.wait(200); h.vis('.grid').scrollTop = 0; await h.wait(250); h.mouse(h.cell(1, 1)); await h.wait(300)`,
  )
  await shot('17-staged-edits')

  await run(
    `[...document.querySelectorAll('.inspector-tab')].find((t) => t.textContent === 'Record').click(); await window.__h.wait(300)`,
  )
  await shot('18-record-view')

  await run(`
    [...document.querySelectorAll('.inspector-tab')].find((t) => t.textContent === 'Value').click()
    const h = window.__h
    const b64 = (v) => btoa(v).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '')
    await h.type(6, 5, b64('{"alg":"HS256","typ":"JWT"}') + '.' + b64('{"sub":"user-42","iss":"auth.example","exp":4102444800,"iat":1700000000}') + '.c2lnbmF0dXJl')
    h.mouse(h.cell(6, 5)); await h.wait(400)`)
  await shot('19-value-jwt')

  await run(
    `window.__dbide_ui.createScript({ connectionId: 'shop-db', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 40;', run: true }); await window.__h.wait(1500); window.__h.mouse(window.__h.cell(2, 1)); await window.__h.wait(300)`,
  )
  await shot('20-locked-prod')

  // Scripts, query history, local history, export
  await run(
    `[...document.querySelectorAll('.sidebar-tab')].find((t) => t.textContent === 'Scripts').click(); await window.__h.wait(500)`,
  )
  await shot('21-scripts-panel')

  await run(
    `[...document.querySelectorAll('.sidebar-tab')].find((t) => t.textContent === 'History').click(); await window.__h.wait(600); const items = [...document.querySelectorAll('.history-item')]; (items.find((i) => i.classList.contains('status-error')) || items[1]).click(); await window.__h.wait(300)`,
  )
  await shot('22-history-panel')

  await run(`
    const h = window.__h
    const ui = window.__dbide_ui
    const list = await window.__dbide_call('scripts.list', undefined)
    const script = list.find((s) => s.name === 'Quarterly')
    await ui.openSavedScript(script.id)
    await h.wait(600)
    ui.useDialogs.getState().openLocalHistory(script.id)
    await h.wait(900)
    const item = [...document.querySelectorAll('.local-history .lh-item')].find((i) => i.textContent.includes('Changed outside'))
    if (item) item.click()
    await h.wait(500)`)
  await shot('23-local-history')
  await run(`window.__dbide_ui.useDialogs.getState().closeLocalHistory()`)

  await run(`
    const h = window.__h
    window.__dbide_ui.createScript({ connectionId: 'legacy', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 40;', name: 'orders', run: true })
    await h.wait(1500)
    h.button('Export').click()
    await h.wait(600)`)
  await shot('24-export-dialog')
  await run(`window.__dbide_ui.useDialogs.getState().closeExport()`)

  // The same screens in the light theme, where the diff colors have the least contrast to spare
  await run(`await window.dbide.setThemeSource('light'); await window.__h.wait(500)`)
  await run(`
    const h = window.__h
    const ui = window.__dbide_ui
    const list = await window.__dbide_call('scripts.list', undefined)
    const script = list.find((s) => s.name === 'Quarterly')
    ui.useDialogs.getState().openLocalHistory(script.id)
    await h.wait(900)
    const item = [...document.querySelectorAll('.local-history .lh-item')].find((i) => i.textContent.includes('Changed outside'))
    if (item) item.click()
    await h.wait(500)`)
  await shot('25-local-history-light')
  await run(`window.__dbide_ui.useDialogs.getState().closeLocalHistory()`)
  await run(
    `[...document.querySelectorAll('.sidebar-tab')].find((t) => t.textContent === 'Scripts').click(); await window.__h.wait(400)`,
  )
  await shot('26-scripts-light')

  // Foreign keys, the tree filter, and the Excel option
  await run(`await window.dbide.setThemeSource('dark'); await window.__h.wait(400)`)
  await run(`
    const h = window.__h
    window.__dbide_ui.createScript({ connectionId: 'legacy', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 40;', name: 'orders', run: true })
    await h.wait(1500)
    h.mouse(h.cell(2, 1)); await h.wait(400)`)
  await shot('27-foreign-key')

  await run(`
    const tab = [...document.querySelectorAll('.sidebar-tab')].find((t) => t.textContent === 'Connections')
    tab.click()
    await window.__h.wait(300)
    const filter = document.querySelector('[aria-label="Filter connections and loaded objects"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(filter, 'order')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    await window.__h.wait(400)`)
  await shot('28-tree-filter')

  await run(`
    const h = window.__h
    const filter = document.querySelector('[aria-label="Filter connections and loaded objects"]')
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(filter, '')
    filter.dispatchEvent(new Event('input', { bubbles: true }))
    h.button('Export').click()
    await h.wait(500)
    ;[...document.querySelectorAll('.dialog-export .segmented button')].find((b) => b.textContent === 'Excel').click()
    await h.wait(300)`)
  await shot('29-export-excel')
  await run(`window.__dbide_ui.useDialogs.getState().closeExport()`)

  // A wide result, and one with rows the core holds
  await run(`
    const h = window.__h
    window.__dbide_ui.createScript({ connectionId: 'legacy', database: 'shop', text: 'SELECT * FROM shop.wide;', name: 'wide', run: true })
    await h.wait(1500)
    h.mouse(h.cell(1, 0)); await h.wait(150)
    h.vis('.grid').scrollLeft = 11000; await h.wait(500)`)
  await shot('30-wide-result')

  await run(`
    const h = window.__h
    window.__dbide_ui.createScript({ connectionId: 'legacy', database: 'shop', text: 'SELECT * FROM shop.orders LIMIT 300000;', name: 'large', run: true })
    await h.wait(1200)
    const id = Object.values(window.__dbide_ui.useScripts.getState().scripts).filter((s) => s.text.includes('LIMIT 300000')).pop().id
    window.__dbide_ui.loadMore(id, 0, 'all')
    await h.wait(2500)
    const grid = h.vis('.grid')
    const rowHeight = grid.querySelector('.grid-row').getBoundingClientRect().height
    grid.scrollTop = 150000 * rowHeight
    await h.wait(800)
    h.mouse(h.cell(150003, 0)); await h.wait(100)
    h.mouse(h.cell(150020, 0), { shiftKey: true }); await h.wait(800)`)
  await shot('31-large-result')
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0))
    })
  })
}

/** The second launch of a smoke run: what the first one left behind has to come back by itself. */
async function runRestartSmoke(window: BrowserWindow): Promise<number> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve()
    else window.webContents.once('did-finish-load', () => resolve())
  })
  let checks: Check[]
  try {
    const result = (await window.webContents.executeJavaScript(RESTART)) as { checks: Check[] }
    checks = result.checks
  } catch (error) {
    checks = [{ name: 'restart script ran', ok: false, detail: String(error) }]
  }
  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} restart (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}

/** The app against a real MySQL or MariaDB server that `scripts/live-smoke.mjs` seeded. */
async function runLiveSmoke(window: BrowserWindow): Promise<number> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve()
    else window.webContents.once('did-finish-load', () => resolve())
  })
  let checks: Check[]
  try {
    const target = JSON.parse(process.env.DBIDE_SMOKE_MYSQL ?? '{}') as Parameters<
      typeof liveScript
    >[0]
    const result = (await window.webContents.executeJavaScript(liveScript(target))) as {
      checks: Check[]
      out: { files?: Record<string, string>; version?: string }
    }
    checks = [...result.checks, ...(result.out.files ? verifyLiveFiles(result.out.files) : [])]
    console.log(`SMOKE server ${result.out.version ?? 'unknown'}`)
  } catch (error) {
    checks = [{ name: 'live script ran', ok: false, detail: String(error) }]
  }
  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} live (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}

/** The app against a real MongoDB server that `scripts/mongo-smoke.mjs` seeded. */
async function runMongoSmoke(window: BrowserWindow): Promise<number> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve()
    else window.webContents.once('did-finish-load', () => resolve())
  })
  // The page names a moment worth a picture by setting its title; the picture is taken from here.
  const shots = process.env.DBIDE_SMOKE_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    window.webContents.on('page-title-updated', (_event, title) => {
      if (!title.startsWith('SHOT:')) return
      void window.webContents
        .capturePage()
        .then((image) => writeFileSync(join(shots, `${title.slice(5)}.png`), image.toPNG()))
    })
  }
  let checks: Check[]
  try {
    const target = JSON.parse(process.env.DBIDE_SMOKE_MONGO ?? '{}') as MongoTarget
    const result = (await window.webContents.executeJavaScript(mongoScript(target))) as {
      checks: Check[]
      out: { version?: string }
    }
    checks = result.checks
    console.log(`SMOKE server ${result.out.version ?? 'unknown'}`)
  } catch (error) {
    checks = [{ name: 'mongo script ran', ok: false, detail: String(error) }]
  }
  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} mongo (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}

/**
 * The app against RabbitMQ's management API. With a broker given (`pnpm smoke:rabbitmq`) it is a real one;
 * without, the run starts the in-memory stand-in, so it needs nothing installed.
 */
async function runRabbitSmoke(window: BrowserWindow): Promise<number> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve()
    else window.webContents.once('did-finish-load', () => resolve())
  })
  const shots = process.env.DBIDE_SMOKE_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    window.webContents.on('page-title-updated', (_event, title) => {
      if (!title.startsWith('SHOT:')) return
      void window.webContents
        .capturePage()
        .then((image) => writeFileSync(join(shots, `${title.slice(5)}.png`), image.toPNG()))
    })
  }
  let fake: FakeBroker | null = null
  let checks: Check[]
  try {
    let target: RabbitTarget
    if (process.env.DBIDE_SMOKE_RABBIT) {
      target = JSON.parse(process.env.DBIDE_SMOKE_RABBIT) as RabbitTarget
    } else {
      fake = await startFakeBroker()
      target = {
        host: '127.0.0.1',
        port: 5672,
        managementPort: fake.port,
        username: 'guest',
        password: 'guest',
        fake: true,
      }
    }
    const result = (await window.webContents.executeJavaScript(rabbitScript(target))) as {
      checks: Check[]
      out: { version?: string }
    }
    checks = result.checks
    console.log(
      `SMOKE server ${target.fake ? 'in-memory stand-in' : 'RabbitMQ'} ${result.out.version ?? 'unknown'}`,
    )
  } catch (error) {
    checks = [{ name: 'rabbitmq script ran', ok: false, detail: String(error) }]
  } finally {
    await fake?.close()
  }
  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} rabbitmq (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}

/**
 * The app against a Redis server. With one given (`pnpm smoke:redis`) it is a real one; without, the run
 * starts the in-memory stand-in, so it needs nothing installed.
 */
async function runRedisSmoke(window: BrowserWindow): Promise<number> {
  await new Promise<void>((resolve) => {
    if (!window.webContents.isLoading()) resolve()
    else window.webContents.once('did-finish-load', () => resolve())
  })
  const shots = process.env.DBIDE_SMOKE_SHOTS
  if (shots) {
    mkdirSync(shots, { recursive: true })
    window.webContents.on('page-title-updated', (_event, title) => {
      if (!title.startsWith('SHOT:')) return
      void window.webContents
        .capturePage()
        .then((image) => writeFileSync(join(shots, `${title.slice(5)}.png`), image.toPNG()))
    })
  }
  const fakes: FakeRedis[] = []
  let checks: Check[]
  try {
    let target: RedisTarget
    if (process.env.DBIDE_SMOKE_REDIS) {
      target = JSON.parse(process.env.DBIDE_SMOKE_REDIS) as RedisTarget
    } else {
      const open = await startFakeRedis()
      const guarded = await startFakeRedis({ password: 'secret' })
      fakes.push(open, guarded)
      target = { host: open.host, port: open.port, authPort: guarded.port, fake: true }
    }
    const result = (await window.webContents.executeJavaScript(redisScript(target))) as {
      checks: Check[]
      out: { version?: string }
    }
    checks = result.checks
    console.log(
      `SMOKE server ${target.fake ? 'in-memory stand-in' : 'Redis'} ${result.out.version ?? 'unknown'}`,
    )
  } catch (error) {
    checks = [{ name: 'redis script ran', ok: false, detail: String(error) }]
  } finally {
    await Promise.all(fakes.map((fake) => fake.close()))
  }
  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} redis (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}

export async function runSmoke(window: BrowserWindow, shotsDir?: string): Promise<number> {
  if (process.env.DBIDE_SMOKE_PHASE === 'restart') return runRestartSmoke(window)
  if (process.env.DBIDE_SMOKE_PHASE === 'live') return runLiveSmoke(window)
  if (process.env.DBIDE_SMOKE_PHASE === 'mongo') return runMongoSmoke(window)
  if (process.env.DBIDE_SMOKE_PHASE === 'rabbitmq') return runRabbitSmoke(window)
  if (process.env.DBIDE_SMOKE_PHASE === 'redis') return runRedisSmoke(window)

  const target = createServer((socket) => socket.end())
  await new Promise<void>((resolve) => target.listen(0, '127.0.0.1', resolve))
  const address = target.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const closedPort = await freePort()

  let checks: Check[]
  try {
    await new Promise<void>((resolve) => {
      if (!window.webContents.isLoading()) resolve()
      else window.webContents.once('did-finish-load', () => resolve())
    })
    const result = (await window.webContents.executeJavaScript(PAGE_SCRIPT(port, closedPort))) as {
      checks: Check[]
    }
    checks = result.checks
    const sql = (await window.webContents.executeJavaScript(SQL_SCRIPT)) as { checks: Check[] }
    checks = [...checks, ...sql.checks]
    const edit = (await window.webContents.executeJavaScript(EDIT_SCRIPT)) as { checks: Check[] }
    checks = [...checks, ...edit.checks]

    // Scripts as files, local history, query history, export. Between the parts, this process
    // plays other programs: it edits and deletes script files, and reads what an export wrote.
    type Part = { checks: Check[]; out: Record<string, unknown> }
    const none: Part = { checks: [], out: {} }
    /** One part failing outright is reported as a failed check, and the rest still run. */
    const part = async (name: string, run: () => Promise<Part> | Part): Promise<Part> => {
      try {
        const result = await run()
        checks = [...checks, ...result.checks]
        return result
      } catch (error) {
        checks = [...checks, { name: `${name} ran`, ok: false, detail: String(error) }]
        return none
      }
    }
    const page = async (script: string): Promise<Part> =>
      (await window.webContents.executeJavaScript(script)) as Part
    const dirs = {
      scriptsDir: join(app.getPath('userData'), 'scripts'),
      filesDir: process.env.DBIDE_SMOKE_FILES_DIR ?? '',
    }
    // Wide results, the commit shortcut, generated statements, foreign keys, and the tree filter
    await part('a wide result', () => page(GRID_WIDE))
    await part('the commit shortcut', () => page(GRID_COMMIT))
    await part('generated UPDATE statements', () => page(GRID_GENERATE))
    await part('generated DELETE statements', () => page(GRID_GENERATE_DELETE))
    await part('foreign keys', () => page(GRID_LINKS))
    await part('the tree filter', () => page(TREE_FILTER))
    await part('a result of a million rows', () => page(LARGE_RESULT))

    const files1 = await part('scripts as files (1)', () => page(FILES_1))
    touchFilesBehindTheAppsBack(dirs.scriptsDir)
    await part('scripts as files (2)', () =>
      page(files2({ id: String(files1.out.id), keep: String(files1.out.keep) })),
    )
    await part('query history', () => page(HISTORY_1))
    const exported = await part('export', () => page(EXPORT_1))
    await part('files on disk', () => ({
      checks: verifyFiles(dirs, {
        files: exported.out.files as Record<string, string> | undefined,
        csvPath: exported.out.csvPath as string | undefined,
      }),
      out: {},
    }))
    await part('leaving state for the restart', () => page(LEAVE_STATE))
    if (shotsDir) await captureScreenshots(window, shotsDir, port)
  } catch (error) {
    checks = [{ name: 'smoke script ran', ok: false, detail: String(error) }]
  } finally {
    target.close()
  }

  for (const check of checks) {
    console.log(
      `SMOKE ${check.ok ? 'PASS' : 'FAIL'} ${check.name}${check.detail ? ` — ${check.detail}` : ''}`,
    )
  }
  const failed = checks.filter((check) => !check.ok).length
  console.log(
    `SMOKE ${failed === 0 ? 'OK' : 'FAILED'} (${checks.length - failed}/${checks.length})`,
  )
  return failed === 0 ? 0 : 1
}
