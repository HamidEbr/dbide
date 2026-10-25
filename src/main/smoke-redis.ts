import { wrap } from './smoke-library'

/**
 * The real app against a Redis server (`pnpm smoke:redis`): the key tree, the key browser with paging,
 * filters and sizes, every kind of key opened and edited in its own tab, TTLs, rename and duplicate, bulk
 * delete, the console with its completion and its locks, the server's numbers, and what a production
 * connection refuses. It seeds what it needs through the app's own core calls and removes it afterwards, so
 * it works against a real server as well as the in-memory stand-in the run starts when none is given.
 */

export interface RedisTarget {
  host: string
  port: number
  password?: string
  /** A second server that wants a password, for the login checks. Only the stand-in has one. */
  authPort?: number
  /** The in-memory stand-in is the server; its numbers are exact and it has no other users. */
  fake: boolean
}

export const redisScript = (target: RedisTarget): string =>
  wrap(
    `
    const section = async (name, work) => {
      try {
        await work()
      } catch (error) {
        check(name + ' did not finish', false, error && error.message)
      }
    }
    const run = Math.random().toString(16).slice(2, 8)
    const P = 'dbide-smoke-' + run
    const k = (name) => P + ':' + name
    const inTab = (selector) => document.querySelector('.workbench-broker:not([hidden]) ' + selector)
    const inTabAll = (selector) => [...document.querySelectorAll('.workbench-broker:not([hidden]) ' + selector)]
    const tabButton = (text) => inTabAll('button').find((b) => b.textContent.trim().startsWith(text))
    const dialogButton = (text) => [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim().startsWith(text))
    const setArea = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, value)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
    const setSelect = (el, value) => {
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(el, value)
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }
    const shot = async (name) => {
      document.title = 'SHOT:' + name
      await sleep(500)
      document.title = 'DBIDE'
    }
    const closeRedisTabs = async () => {
      for (const tab of ui.useWorkbench.getState().tabs.filter((t) => t.kind === 'redis')) ui.useWorkbench.getState().closeTab(tab.id)
      await sleep(100)
    }
    const open = async (connectionId, target) => {
      const id = 'redis:' + connectionId + ':' + target.view + ':' + target.db + ':' + (target.key || target.pattern || '')
      ui.workbench.openRedis(connectionId, target)
      await waitFor(() => ui.useWorkbench.getState().activeId === id, 'the tab to open')
      await sleep(250)
    }
    const x = (line, id = 'seed') => call('redis.exec', { connectionId: 'rd-dev', consoleId: id, writable: true, line }).then((r) => r.reply)
    const keyRows = () => inTabAll('.redis-krow.broker-qrow:not(.broker-qhead)')
    const keyNames = () => keyRows().map((r) => r.querySelector('.broker-name').textContent)
    const detail = (key, db = 0, connectionId = 'rd-dev') => call('redis.key', { connectionId, db, key })
    const value = (key, type, db = 0) => call('redis.value', { connectionId: 'rd-dev', db, key, type, cursor: null, count: 200 })
    const entryText = () => inTabAll('.redis-entry').map((e) => e.textContent)
    const stat = (label) => {
      const el = inTabAll('.broker-stat').find((s) => s.querySelector('.broker-stat-label').textContent === label)
      return el ? el.querySelector('.broker-stat-value').textContent : null
    }
    const rowWith = (text) => inTabAll('.redis-table tbody tr').find((r) => r.textContent.includes(text))
    const rowAction = (row, label) => [...row.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === label)

    const base = { tls: { enabled: false, allowInvalidCertificates: false }, options: {}, engine: 'redis', host: ARGS.host, port: ARGS.port, database: '0' }
    const secrets = ARGS.password ? { password: ARGS.password } : {}
    await call('connections.save', { config: { ...base, id: 'rd-dev', name: 'Redis dev', environment: 'dev' }, secrets })
    await call('connections.save', { config: { ...base, id: 'rd-prod', name: 'Redis prod', environment: 'prod' }, secrets })

    const cleanup = async () => {
      for (const db of [0, 1, 4]) {
        await call('redis.deleteMatching', { connectionId: 'rd-dev', db, writable: true, pattern: P + '*', taskId: 'cleanup-' + db }).catch(() => undefined)
      }
    }

    try {
    await section('the server', async () => {
      const dev = await call('sessions.open', { connectionId: 'rd-dev' })
      const prod = await call('sessions.open', { connectionId: 'rd-prod' })
      out.version = dev.serverVersion
      check('the app logs in and reports the server version', /^[0-9]+[.][0-9]+/.test(dev.serverVersion) && dev.currentDatabase === '0' && dev.readOnly === false, JSON.stringify(dev))
      check('a production connection starts locked, and the person is told Redis can not enforce that', prod.readOnly === true && prod.readOnlyEnforcedByServer === false && notice(/can.t hold a connection read-only/), JSON.stringify(prod))
      const good = await call('connections.test', { config: { ...base, id: 'good', name: 'Good', environment: 'dev' }, secrets })
      check('the connection test passes every step', good.every((s) => s.status === 'ok' || s.status === 'skipped'), JSON.stringify(good.map((s) => s.id + ':' + s.status)))
      const closed = await call('connections.test', { config: { ...base, id: 'closed', name: 'Closed', environment: 'dev', port: 1 }, secrets })
      const reach = closed.find((s) => s.id === 'tcp')
      check('a port with nothing behind it fails at the connection step', reach && reach.status === 'failed' && /refused/.test(reach.detail || ''), reach && reach.detail)
      if (ARGS.authPort) {
        const guarded = { ...base, id: 'auth', name: 'Guarded', environment: 'dev', port: ARGS.authPort }
        const none = (await call('connections.test', { config: guarded })).find((s) => s.id === 'auth')
        check('a server that wants a password says so when none is given', none && none.status === 'failed' && /password/.test(none.detail || ''), none && none.detail)
        const wrong = (await call('connections.test', { config: guarded, secrets: { password: 'wrong-' + run } })).find((s) => s.id === 'auth')
        check('a wrong password fails at the login step, in words', wrong && wrong.status === 'failed' && /refused the login/.test(wrong.detail || ''), wrong && wrong.detail)
        const right = (await call('connections.test', { config: guarded, secrets: { password: 'secret' } })).find((s) => s.id === 'auth')
        check('the right one passes', right && right.status === 'ok', right && right.detail)
      }
    })

    await section('seeding', async () => {
      await cleanup()
      await x('SET ' + k('json') + " '{\\"a\\":1,\\"nested\\":{\\"b\\":[1,2,3]}}'")
      await x('SET ' + k('plain') + ' hello')
      await x('SET ' + k('ttl') + ' soon EX 3600')
      await x('HSET ' + k('user:1') + ' name Ann email ann@example.com age 31')
      await x('HSET ' + k('user:2') + ' name Bob')
      await x('RPUSH ' + k('jobs') + ' first second third')
      await x('SADD ' + k('tags') + ' red green blue')
      await x('ZADD ' + k('scores') + ' 1 ann 2 bob 3 cy')
      await x('XADD ' + k('events') + ' 1-0 type signup user ann')
      await x('XADD ' + k('events') + ' 2-0 type login user bob')
      await x('XGROUP CREATE ' + k('events') + ' workers 0')
      await x('XREADGROUP GROUP workers alice COUNT 1 STREAMS ' + k('events') + ' >')
      for (let chunk = 0; chunk < 4; chunk++) {
        let line = 'MSET'
        for (let i = 0; i < 300; i++) line += ' ' + k('bulk:' + (chunk * 300 + i)) + ' v'
        await x(line)
      }
      const size = await call('redis.count', { connectionId: 'rd-dev', db: 0, pattern: k('bulk:') + '*', taskId: 'seed-count' })
      check('the keys the run needs were made through the app', size.count === 1200, size.count)
    })

    await section('the tree', async () => {
      const roots = await call('tree.children', { connectionId: 'rd-dev', parent: null })
      const db0 = roots.find((n) => n.label === 'db0')
      check('the tree lists database 0 with its key count', db0 && db0.kind === 'redis-db' && db0.hasChildren && /keys/.test(db0.detail), JSON.stringify(roots.map((n) => [n.label, n.detail])))
      const top = await call('tree.children', { connectionId: 'rd-dev', parent: db0 })
      const mine = top.find((n) => n.label === P + ':')
      check('keys are grouped into folders at the separator', mine && mine.kind === 'redis-prefix' && mine.hasChildren, top.map((n) => n.label).slice(0, 8).join(','))
      const level = await call('tree.children', { connectionId: 'rd-dev', parent: mine })
      const labels = level.map((n) => n.label)
      check('folders come before keys, and keys show their type', labels.indexOf('bulk:') < labels.indexOf('json') && labels.indexOf('user:') < labels.indexOf('json') && level.find((n) => n.label === 'jobs').kind === 'redis-key-list' && level.find((n) => n.label === 'scores').kind === 'redis-key-zset' && level.find((n) => n.label === 'events').kind === 'redis-key-stream', labels.join(','))
      check('a folder counts the keys under it', level.find((n) => n.label === 'bulk:').detail === '1.2K' && level.find((n) => n.label === 'user:').detail === '2', level.find((n) => n.label === 'bulk:').detail)

      ui.useTree.getState().expand('rd-dev', null)
      await waitFor(() => all('.tree-label').some((l) => l.textContent === 'db0'), 'db0 in the navigator')
      check('the navigator shows the connection’s databases', true)
    })

    await section('the key browser', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'keys', db: 0, pattern: k('bulk:') })
      await waitFor(() => keyRows().length > 0, 'the keys')
      const loaded = () => Number(((/([0-9,]+) keys loaded/.exec(inTab('.redis-status').textContent) || [])[1] || '0').replace(',', ''))
      check('searching a database lists its keys, a page at a time', loaded() >= 200 && loaded() < 1200, inTab('.redis-status').textContent)
      check('the page says there is more to scan', /more to scan/.test(inTab('.redis-status').textContent) && tabButton('Load more'), inTab('.redis-status').textContent)
      await shot('d1-keys')
      for (let i = 0; i < 12 && tabButton('Load more'); i++) {
        const before = keyRows().length
        tabButton('Load more').click()
        await waitFor(() => !tabButton('Load more') || keyRows().length > before, 'the next page')
        await sleep(100)
      }
      // The list draws only the rows in view, so ask the status line how many were loaded.
      check('loading more reaches every key, once each', /1,200 keys loaded/.test(inTab('.redis-status').textContent) && /end of the keyspace/.test(inTab('.redis-status').textContent), inTab('.redis-status').textContent)

      const pattern = inTab('input[aria-label="Key pattern"]')
      setValue(pattern, k('json'))
      tabButton('Search').click()
      await waitFor(() => keyNames().length === 1 && keyNames()[0] === k('json'), 'the one match')
      check('text matches anywhere in a key, so plain words work as a search', true)
      check('a row shows the key, its type and that it never expires', keyRows()[0].textContent.includes('string') && keyRows()[0].textContent.includes('–'), keyRows()[0].textContent)

      setValue(pattern, P)
      setSelect(inTab('select[aria-label="Type"]'), 'hash')
      tabButton('Search').click()
      await waitFor(() => keyNames().length === 2, 'the hashes')
      check('the type filter keeps only keys of that type', keyNames().sort().join(',') === k('user:1') + ',' + k('user:2'), keyNames().join(','))
      setSelect(inTab('select[aria-label="Type"]'), '')
      setValue(pattern, k('ttl'))
      tabButton('Search').click()
      await waitFor(() => keyNames().length === 1 && keyNames()[0] === k('ttl'), 'the ttl key')
      check('a key that expires shows how long it has', /[0-9]+h|[0-9]+m/.test(keyRows()[0].textContent) && !/–/.test(keyRows()[0].children[2].textContent), keyRows()[0].textContent)

      tabButton('Measure sizes').click()
      await waitFor(() => /[0-9] B|KB/.test(keyRows()[0].children[3].textContent), 'the size')
      check('measuring asks the server what a key takes', true, keyRows()[0].children[3].textContent)

      setValue(pattern, P)
      tabButton('Search').click()
      await waitFor(() => keyNames().length > 10, 'every key of the run')
      const keyHeader = inTabAll('.broker-qhead button').find((b) => b.textContent.startsWith('Key'))
      keyHeader.click()
      await sleep(150)
      const names = keyNames()
      check('clicking Key reverses the order', names[0] > names[names.length - 1] || names.length < 3, names.slice(0, 2).join(','))

      setValue(pattern, k('plain'))
      tabButton('Search').click()
      await waitFor(() => keyNames().length === 1, 'the plain key')
      dbl(keyRows()[0])
      await waitFor(() => ui.useWorkbench.getState().activeId === 'redis:rd-dev:key:0:' + k('plain'), 'the key tab')
      check('double-clicking a key opens it in a tab of its own', all('.tab-title').some((t) => t.textContent === k('plain')))
    })

    await section('a string', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('json') })
      await waitFor(() => inTab('.redis-type') && inTab('.broker-payload'), 'the key')
      check('a string shows its type, size and TTL state', inTab('.redis-type').textContent === 'string' && /no expiry/.test(inTab('.broker-title').textContent) && /bytes/.test(inTab('.broker-title').textContent), inTab('.broker-title').textContent)
      await waitFor(() => /nested/.test(inTab('.broker-payload').textContent), 'the decoded value')
      check('its value is decoded as the inspector decodes a cell (JSON laid out)', /"b":/.test(inTab('.broker-payload').textContent), inTab('.broker-payload').textContent.slice(0, 100))
      await shot('d2-string')

      tabButton('Edit').click()
      await waitFor(() => inTab('.redis-editor'), 'the editor')
      setArea(inTab('.redis-editor'), '{"a":2}')
      tabButton('Save').click()
      await waitFor(async () => (await value(k('json'), 'string')).value === '{"a":2}', 'the value to be saved')
      await waitFor(() => !inTab('.redis-editor') && /"a": 2/.test(inTab('.broker-payload').textContent), 'the new value on screen')
      check('editing a string saves it, and the tab shows the new value', true)

      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('ttl') })
      await waitFor(() => /expires in/.test(inTab('.broker-title').textContent), 'the TTL chip')
      check('a key that expires says when', /expires in 59m|expires in 1h/.test(inTab('.broker-title').textContent), inTab('.broker-title').textContent)
      inTab('.redis-chip-button').click()
      await waitFor(() => document.querySelector('.dialog'), 'the expiry dialog')
      setValue(document.querySelector('.dialog input'), '10')
      setSelect(document.querySelector('.dialog select'), 'm')
      dialogButton('Set expiry').click()
      await waitFor(async () => { const d = await detail(k('ttl')); return d.ttlMs && d.ttlMs > 500000 && d.ttlMs <= 600000 }, 'the new expiry')
      check('the expiry can be changed', true)
      await waitFor(() => /expires in 9m|expires in 10m/.test(inTab('.broker-title').textContent), 'the chip to follow')
      inTab('.redis-chip-button').click()
      await waitFor(() => document.querySelector('.dialog .link-button'), 'the remove link')
      document.querySelector('.dialog .link-button').click()
      await waitFor(async () => (await detail(k('ttl'))).ttlMs === null, 'the expiry to go')
      check('and removed, so the key stays', true)
    })

    await section('rename, duplicate and delete', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('plain') })
      await waitFor(() => inTab('.redis-type'), 'the key')
      tabButton('Rename').click()
      await waitFor(() => document.querySelector('.dialog input'), 'the rename dialog')
      setValue(document.querySelector('.dialog input'), k('renamed'))
      dialogButton('Rename').click()
      await waitFor(() => ui.useWorkbench.getState().activeId === 'redis:rd-dev:key:0:' + k('renamed'), 'the renamed key’s tab')
      check('renaming moves the key and opens it under its new name', (await detail(k('plain'))).type === 'none' && (await detail(k('renamed'))).type === 'string' && !all('.tab-title').some((t) => t.textContent === k('plain')))

      await waitFor(() => inTab('.redis-type'), 'the key')
      tabButton('Duplicate').click()
      await waitFor(() => document.querySelector('.dialog select'), 'the duplicate dialog')
      setValue(document.querySelector('.dialog input'), k('copy'))
      setSelect(document.querySelector('.dialog select'), '1')
      dialogButton('Duplicate').click()
      await waitFor(() => ui.useWorkbench.getState().activeId === 'redis:rd-dev:key:1:' + k('copy'), 'the copy’s tab')
      const copy = await detail(k('copy'), 1)
      check('duplicating copies a key into another database, and opens the copy', copy.type === 'string' && (await detail(k('renamed'))).type === 'string', JSON.stringify(copy))

      await waitFor(() => inTab('.redis-type'), 'the copy')
      tabButton('Delete').click()
      await waitFor(async () => (await detail(k('copy'), 1)).type === 'none', 'the delete')
      await waitFor(() => !all('.tab-title').some((t) => t.textContent === k('copy')), 'the tab to close')
      check('deleting a key closes its tab and removes it', true)
    })

    await section('a hash', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('user:1') })
      await waitFor(() => rowWith('email'), 'the fields')
      check('a hash lists its fields and values', rowWith('name').textContent.includes('Ann') && inTab('.redis-type').textContent === 'hash' && /3 fields/.test(inTab('.broker-title').textContent), inTab('.broker-title').textContent)
      await shot('d3-hash')
      setValue(inTab('input[aria-label="Field"]'), 'city')
      setValue(inTab('input[aria-label="Value"]'), 'Oslo')
      tabButton('Set field').click()
      await waitFor(() => rowWith('city'), 'the new field')
      check('a field can be added', (await value(k('user:1'), 'hash')).items.some((i) => i.field === 'city' && i.value === 'Oslo'))

      rowAction(rowWith('age'), 'Edit value').click()
      await waitFor(() => inTab('.redis-cell-editor'), 'the cell editor')
      setArea(inTab('.redis-cell-editor'), '32')
      tabButton('Save').click()
      await waitFor(async () => (await value(k('user:1'), 'hash')).items.some((i) => i.field === 'age' && i.value === '32'), 'the edit')
      check('a value can be edited in place', true)

      rowAction(rowWith('city'), 'Rename field').click()
      await waitFor(() => document.querySelector('.dialog input'), 'the rename dialog')
      setValue(document.querySelector('.dialog input'), 'town')
      dialogButton('Rename').click()
      await waitFor(async () => (await value(k('user:1'), 'hash')).items.some((i) => i.field === 'town'), 'the new field name')
      check('a field can be renamed, keeping its value', (await value(k('user:1'), 'hash')).items.find((i) => i.field === 'town').value === 'Oslo' && !(await value(k('user:1'), 'hash')).items.some((i) => i.field === 'city'))

      rowAction(rowWith('town'), 'Remove').click()
      await waitFor(async () => !(await value(k('user:1'), 'hash')).items.some((i) => i.field === 'town'), 'the removal')
      check('a field can be removed', true)

      const filter = inTab('input[aria-label="Filter"]')
      setValue(filter, 'mail')
      press(filter, 'Enter')
      await waitFor(() => inTabAll('.redis-table tbody tr').length === 1, 'the filter')
      check('the filter shows only the fields that match', rowWith('email') !== undefined && rowWith('name') === undefined)
    })

    await section('a list, a set and a sorted set', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('jobs') })
      await waitFor(() => rowWith('second'), 'the items')
      check('a list shows its items by position', inTabAll('.redis-table tbody tr').length === 3 && rowWith('first').textContent.startsWith('0'), inTabAll('.redis-table tbody tr').map((r) => r.textContent).join('|'))
      setValue(inTab('input[aria-label="New item"]'), 'zeroth')
      tabButton('Push to head').click()
      await waitFor(() => rowWith('zeroth'), 'the pushed item')
      check('an item can be pushed to the head', (await value(k('jobs'), 'list')).items[0].value === 'zeroth')
      rowAction(rowWith('second'), 'Remove').click()
      await waitFor(async () => (await value(k('jobs'), 'list')).items.length === 3, 'the removal')
      check('an item is removed by its position, whatever it says', (await value(k('jobs'), 'list')).items.map((i) => i.value).join(',') === 'zeroth,first,third')

      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('tags') })
      await waitFor(() => rowWith('green'), 'the members')
      setValue(inTab('input[aria-label="New member"]'), 'violet')
      tabButton('Add').click()
      await waitFor(() => rowWith('violet'), 'the new member')
      rowAction(rowWith('red'), 'Remove').click()
      await waitFor(async () => !(await value(k('tags'), 'set')).items.includes('red'), 'the removal')
      check('a set takes members and gives them up', (await value(k('tags'), 'set')).items.includes('violet'))

      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('scores') })
      await waitFor(() => rowWith('bob'), 'the scores')
      check('a sorted set shows members with their scores, lowest first', inTabAll('.redis-table tbody tr')[0].textContent.includes('ann'))
      rowAction(rowWith('bob'), 'Edit score').click()
      await waitFor(() => inTab('.redis-cell-editor'), 'the score editor')
      setArea(inTab('.redis-cell-editor'), '9.5')
      tabButton('Save').click()
      await waitFor(async () => (await value(k('scores'), 'zset')).items.some((i) => i.member === 'bob' && i.score === 9.5), 'the score')
      check('a score can be edited, and the order follows', true)
      await waitFor(() => inTabAll('.redis-table tbody tr')[2].textContent.includes('bob'), 'the new order')
    })

    await section('a stream', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'key', db: 0, key: k('events') })
      await waitFor(() => inTabAll('.redis-table tbody tr').length >= 2, 'the entries')
      const first = inTabAll('.redis-table tbody tr')[0].textContent
      check('a stream shows its entries, newest first', first.includes('2-0') && first.includes('login'), first)
      await waitFor(() => inTab('.broker-section') && /workers/.test(inTab('.broker-section').textContent), 'the group')
      check('and its consumer groups, with what is pending', /workers/.test(inTab('.broker-section').textContent) && /Pending/.test(inTab('.broker-section').textContent))
      inTabAll('.broker-click').find((r) => r.textContent.includes('workers')).click()
      await waitFor(() => /Consumers of workers/.test(inTab('.broker-section').textContent), 'the group detail')
      check('a group opens to its consumers and its pending entries', /alice/.test(inTab('.broker-section').textContent) && /1-0/.test(inTab('.broker-section').textContent), inTab('.broker-section').textContent.slice(0, 200))
      await shot('d4-stream')
      setValue(inTab('input[aria-label="Field 1"]'), 'type')
      setValue(inTab('input[aria-label="Value 1"]'), 'purchase')
      tabButton('Add entry').click()
      await waitFor(() => inTabAll('.redis-table')[0].textContent.includes('purchase'), 'the new entry')
      check('an entry can be added', (await call('redis.key', { connectionId: 'rd-dev', db: 0, key: k('events') })).length === 3)
    })

    await section('the console', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'console', db: -1 })
      const input = () => inTab('input[aria-label="Redis command"]')
      await waitFor(() => input() && !input().disabled, 'the console to connect')
      const send = async (line) => {
        const before = inTabAll('.redis-entry').length
        input().focus()
        setValue(input(), line)
        press(input(), 'Enter')
        await waitFor(() => inTabAll('.redis-entry').length === before + 1, 'the reply to ' + line)
        return inTabAll('.redis-entry')[before].querySelector('.redis-out').textContent
      }
      check('the console shows a prompt with the server it talks to', /:[0-9]+>/.test(inTab('.redis-prompt').textContent), inTab('.redis-prompt').textContent)
      check('a status reply is printed plain, a string in quotes, a number with its kind', (await send('SET ' + k('c') + ' hello')) === 'OK' && (await send('GET ' + k('c'))) === '"hello"' && (await send('APPEND ' + k('c') + ' !')) === '(integer) 6')
      check('a missing key is (nil)', (await send('GET ' + k('nothing'))) === '(nil)')
      const list = await send('HGETALL ' + k('user:2'))
      check('a list is numbered the way redis-cli numbers it', list === '1) "name"' + String.fromCharCode(10) + '2) "Bob"', list)
      check('an error reply is shown as one, and the console carries on', /^[(]error[)] ERR unknown command/.test(await send('NOSUCHCOMMAND x')))
      check('quotes and escapes are read as redis-cli reads them', (await send('SET ' + k('q') + ' "two words\\\\n"')) === 'OK' && (await send('STRLEN ' + k('q'))) === '(integer) 10')
      await send('MULTI')
      check('inside MULTI a command answers QUEUED', (await send('SET ' + k('m') + ' 1')) === 'QUEUED')
      const exec = await send('EXEC')
      check('EXEC runs what was queued, and shows each answer', /1[)] OK/.test(exec), exec)
      check('SELECT moves the console, and the prompt says so', (await send('SELECT 4')) === 'OK' && /[[]4[\\]]>/.test(inTab('.redis-input-row .redis-prompt').textContent), inTab('.redis-input-row .redis-prompt').textContent)
      await send('SET ' + k('in4') + ' x')
      check('commands then run in that database', (await detail(k('in4'), 4)).type === 'string')
      await send('SELECT 0')

      input().focus()
      setValue(input(), 'hge')
      await waitFor(() => inTabAll('.redis-suggestions li').length > 0, 'the suggestions')
      check('typing a command offers completions with their syntax', inTabAll('.redis-suggestions li').some((li) => /HGETALL/.test(li.textContent)) && /key field/.test(inTab('.redis-suggestions').textContent), inTab('.redis-suggestions').textContent)
      press(input(), 'Tab')
      await waitFor(() => /^HGET /.test(input().value), 'the completion')
      check('Tab completes the first suggestion', true, input().value)
      setValue(input(), 'SET a ')
      await waitFor(() => inTab('.redis-hintline') && /SET/.test(inTab('.redis-hintline').textContent), 'the hint')
      check('the arguments of a command are hinted, with the current one marked', inTab('.redis-hint-active') && inTab('.redis-hint-active').textContent.trim() === 'value', inTab('.redis-hintline').textContent)
      setValue(input(), '')
      press(input(), 'ArrowUp')
      await waitFor(() => input().value === 'SELECT 0', 'the last line')
      press(input(), 'ArrowUp')
      await waitFor(() => /SET .*in4/.test(input().value), 'the line before')
      check('the up arrow walks back through earlier lines', true, input().value)
      setValue(input(), '')
      await shot('d5-console')
      await send('clear').catch(() => undefined)
      setValue(input(), 'clear')
      press(input(), 'Enter')
      await waitFor(() => inTabAll('.redis-entry').length === 0, 'the console to clear')
      check('clear empties the screen', true)
    })

    await section('bulk delete', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'keys', db: 0, pattern: k('bulk:') })
      await waitFor(() => keyRows().length > 0, 'the keys')
      tabButton('Delete matching').click()
      await waitFor(() => document.querySelector('.dialog input'), 'the dialog')
      check('the dialog starts from the search that is on screen', document.querySelector('.dialog input').value === k('bulk:'))
      check('nothing can be deleted before the keys are counted', dialogButton('Delete').disabled === true)
      dialogButton('Count keys').click()
      await waitFor(() => /1,200 keys match/.test(document.querySelector('.redis-bulk-status').textContent), 'the count', 30000)
      check('counting says how many keys would go', true, document.querySelector('.redis-bulk-status').textContent)
      await shot('d6-bulk')
      dialogButton('Delete 1,200 keys').click()
      await waitFor(() => /Deleted 1,200 keys/.test(document.querySelector('.redis-bulk-status').textContent), 'the delete', 60000)
      const left = await call('redis.count', { connectionId: 'rd-dev', db: 0, pattern: k('bulk:') + '*', taskId: 'after' })
      check('deleting by pattern removes exactly those keys', left.count === 0 && (await detail(k('jobs'))).type === 'list', left.count)
      dialogButton('Close').click()
    })

    await section('the server tab', async () => {
      await closeRedisTabs()
      await open('rd-dev', { view: 'info', db: 0 })
      await waitFor(() => stat('Memory used') !== null, 'the numbers')
      check('the server tab shows version, memory, clients and the hit ratio', /Redis|Valkey/.test(inTab('.broker-title').textContent) && stat('Clients') !== null && stat('Hit ratio') !== null && stat('Keys') !== null, inTab('.broker-title').textContent)
      await waitFor(() => inTabAll('.redis-spark').length === 3, 'the sparklines')
      check('and draws the last readings', true)
      check('it lists the databases that hold keys, and every field of INFO', inTabAll('.broker-table td').some((td) => td.textContent === 'db0') && inTabAll('.broker-more').length > 3)
      await shot('d7-info')
    })

    await section('a production server is locked', async () => {
      await closeRedisTabs()
      await open('rd-prod', { view: 'key', db: 0, key: k('jobs') })
      await waitFor(() => rowWith('first'), 'the list on prod')
      check('the tab says it is read-only', /Read-only/.test(inTab('.broker-toolbar').textContent))
      setValue(inTab('input[aria-label="New item"]'), 'blocked')
      tabButton('Push to tail').click()
      await waitFor(() => notice(/locked/), 'the refusal')
      check('a change while locked is refused with a way forward, and nothing is sent', (await value(k('jobs'), 'list')).items.length === 3)

      let refused = null
      try { await call('redis.edit', { connectionId: 'rd-prod', db: 0, writable: false, key: k('jobs'), edit: { op: 'key.delete' } }) } catch (error) { refused = error.code }
      check('the core refuses a change that says writes are locked', refused === 'READ_ONLY', refused)

      await closeRedisTabs()
      await open('rd-prod', { view: 'console', db: -1 })
      const input = () => inTab('input[aria-label="Redis command"]')
      await waitFor(() => input() && !input().disabled, 'the console on prod')
      const send = async (line, answer) => {
        const before = inTabAll('.redis-entry').length
        input().focus()
        setValue(input(), line)
        press(input(), 'Enter')
        if (answer) await answer()
        await waitFor(() => inTabAll('.redis-entry').length === before + 1, 'the reply to ' + line)
        return inTabAll('.redis-entry')[before].querySelector('.redis-out').textContent
      }
      check('a write in a locked console is blocked in the scrollback', /blocked/.test(await send('SET ' + k('p') + ' 1')) && (await detail(k('p'))).type === 'none')
      check('a read still runs', (await send('GET ' + k('p'))) === '(nil)')

      tabButton('Read-only').click()
      await waitFor(() => document.querySelector('.dialog[role="alertdialog"]'), 'the unlock question')
      check('unlocking asks first, and says what it allows', /Unlock writes/.test(document.querySelector('.dialog h2').textContent) && /run commands that change data/.test(document.querySelector('.dialog').textContent))
      dialogButton('Unlock').click()
      await waitFor(() => /Writable/.test(inTab('.broker-toolbar').textContent), 'the unlock')

      const ok = await send('SET ' + k('p') + ' 1', async () => {
        await waitFor(() => document.querySelector('.dialog[role="alertdialog"]'), 'the question')
        check('a write on production asks before it runs, without the name', !document.querySelector('.dialog-confirm') && /SET/.test(document.querySelector('.dialog').textContent))
        dialogButton('Run').click()
      })
      check('and then runs', ok === 'OK' && (await detail(k('p'))).type === 'string', ok)
      const gone = await send('DEL ' + k('p'), async () => {
        await waitFor(() => document.querySelector('.dialog[role="alertdialog"]'), 'the question')
        check('a delete on production wants the connection’s name typed', document.querySelector('.dialog-confirm input') && dialogButton('Run').disabled === true)
        await shot('d8-prod-delete')
        setValue(document.querySelector('.dialog-confirm input'), 'Redis prod')
        await waitFor(() => !dialogButton('Run').disabled, 'the button to enable')
        dialogButton('Run').click()
      })
      check('typing it lets the delete go through', gone === '(integer) 1' && (await detail(k('p'))).type === 'none', gone)
    })

    await section('the connection tab', async () => {
      await closeRedisTabs()
      ui.useWorkbench.getState().openTab({ id: 'conn:rd-dev', kind: 'connection', connectionId: 'rd-dev' })
      await waitFor(() => document.querySelector('.broker-overview .broker-stat'), 'the overview')
      const text = document.querySelector('.broker-overview').textContent
      check('a Redis connection opens on the server’s numbers', /(Redis|Valkey) [0-9]+[.][0-9]+/.test(text) && /Keys/.test(text) && /Commands/.test(text), text.slice(0, 160))
      check('and offers to browse, to open a console and to show the server, but no SQL script', byText('button', 'Browse keys') && byText('button', 'Console') && byText('button', 'Server info') && !byText('button', 'New SQL script'))
      ui.useWorkbench.getState().openTab({ id: 'edit:rd-dev', kind: 'connection-editor', connectionId: 'rd-dev' })
      await waitFor(() => all('h2').some((h) => h.textContent === 'Redis'), 'the Redis section')
      check('the connection form has the deployment and the key separator', all('[role="radio"]').some((r) => r.textContent === 'Sentinel') && all('label').some((l) => /Key separator/.test(l.textContent)))
      ui.useWorkbench.getState().closeTab('edit:rd-dev')
    })
    } finally {
      await cleanup()
    }
  `,
    target as unknown as Record<string, unknown>,
  )
