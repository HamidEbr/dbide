import { wrap } from './smoke-library'

/**
 * The real app against a RabbitMQ management API (`pnpm smoke:rabbitmq`): the tree, the vhost, queue and
 * exchange tabs, peeking, publishing, purging, creating and deleting, bindings, and the locks. It seeds what
 * it needs through the app's own core calls and removes it afterwards, so it works against a real broker as
 * well as against the in-memory stand-in that the smoke run starts when no broker is given.
 */

export interface RabbitTarget {
  host: string
  /** The AMQP port the connection form holds. */
  port: number
  managementPort: number
  username: string
  password: string
  /** The in-memory stand-in is the broker; its numbers are exact and it has no other users. */
  fake: boolean
}

export const rabbitScript = (target: RabbitTarget): string =>
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
    const names = { orders: P + '.orders', audit: P + '.audit', events: P + '.events', fresh: P + '.fresh', fan: P + '.fan' }
    const frame = () => vis('.broker-tab') || document.querySelector('.workbench-broker:not([hidden]) .broker-tab')
    const inTab = (selector) => document.querySelector('.workbench-broker:not([hidden]) ' + selector)
    const inTabAll = (selector) => [...document.querySelectorAll('.workbench-broker:not([hidden]) ' + selector)]
    const stat = (label) => {
      const el = inTabAll('.broker-stat').find((s) => s.querySelector('.broker-stat-label').textContent === label)
      return el ? el.querySelector('.broker-stat-value').textContent : null
    }
    const tabButton = (text) => inTabAll('button').find((b) => b.textContent.trim().startsWith(text))
    const dialogButton = (text) => [...document.querySelectorAll('.dialog button')].find((b) => b.textContent.trim().startsWith(text))
    const shot = async (name) => {
      document.title = 'SHOT:' + name
      await sleep(500)
      document.title = 'DBIDE'
    }
    const closeBrokerTabs = async () => {
      for (const tab of ui.useWorkbench.getState().tabs.filter((t) => t.kind === 'broker')) ui.useWorkbench.getState().closeTab(tab.id)
      await sleep(100)
    }
    const open = async (connectionId, view, name) => {
      const id = 'broker:' + connectionId + ':' + view + ':/:' + (name || '')
      window.__dbide_open(connectionId, { view, vhost: '/', ...(name === undefined ? {} : { name }) })
      await waitFor(() => ui.useWorkbench.getState().activeId === id, 'the tab to open')
      await sleep(250)
    }
    const write = (method, connectionId, params) => call(method, { connectionId, vhost: '/', writable: true, ...params })
    const declareQueue = (connectionId, name, type = 'classic') => write('broker.declareQueue', connectionId, { request: { name, type, durable: true, autoDelete: false, arguments: {} } })
    const publish = (connectionId, exchange, routingKey, payload, extra = {}) => write('broker.publish', connectionId, { request: { exchange, routingKey, payload, payloadEncoding: 'string', properties: { contentType: 'application/json' }, ...extra } })

    const base = { tls: { enabled: false, allowInvalidCertificates: false }, options: { managementPort: String(ARGS.managementPort) }, engine: 'rabbitmq', host: ARGS.host, port: ARGS.port, username: ARGS.username, database: '/' }
    const secrets = { password: ARGS.password }
    await call('connections.save', { config: { ...base, id: 'rb-dev', name: 'Rabbit dev', environment: 'dev' }, secrets })
    await call('connections.save', { config: { ...base, id: 'rb-prod', name: 'Rabbit prod', environment: 'prod' }, secrets })
    window.__dbide_open = (connectionId, broker) => ui.workbench.openBroker(connectionId, broker)

    const cleanup = async () => {
      for (const name of Object.values(names)) {
        await write('broker.deleteQueue', 'rb-dev', { name }).catch(() => undefined)
        await write('broker.deleteExchange', 'rb-dev', { name }).catch(() => undefined)
      }
    }

    try {
    await section('the broker', async () => {
      const dev = await call('sessions.open', { connectionId: 'rb-dev' })
      const prod = await call('sessions.open', { connectionId: 'rb-prod' })
      out.version = dev.serverVersion
      check('the app logs in through the management API and reports the broker version', /^[0-9]+[.][0-9]+/.test(dev.serverVersion) && dev.currentDatabase === '/' && dev.readOnly === false, JSON.stringify(dev))
      check('a production connection starts locked, and the person is told RabbitMQ can not enforce that', prod.readOnly === true && prod.readOnlyEnforcedByServer === false && notice(/can.t hold a connection read-only/), JSON.stringify(prod))
      const good = await call('connections.test', { config: { ...base, id: 'good', name: 'Good', environment: 'dev' }, secrets })
      check('the connection test looks at the management API, and passes', good.every((s) => s.status === 'ok' || s.status === 'skipped') && good.find((s) => s.id === 'tcp').detail.includes(String(ARGS.managementPort)), JSON.stringify(good.map((s) => s.id + ':' + s.status)))
      const wrong = await call('connections.test', { config: { ...base, id: 'bad', name: 'Bad', environment: 'dev' }, secrets: { password: 'wrong-password-' + run } })
      const auth = wrong.find((s) => s.id === 'auth')
      check('a wrong password fails at the login step, in words', auth && auth.status === 'failed' && /refused the login/.test(auth.detail || ''), auth && auth.detail)
      const closed = await call('connections.test', { config: { ...base, id: 'closed', name: 'Closed', environment: 'dev', options: { managementPort: '1' } }, secrets })
      const reach = closed.find((s) => s.id === 'tcp')
      check('a management port with nothing behind it fails at the connection step', reach && reach.status === 'failed' && /refused/.test(reach.detail || ''), reach && reach.detail)
      let unreachable = null
      try { await call('sessions.open', { connectionId: 'rb-closed' }) } catch (error) { unreachable = error.message }
      await call('connections.save', { config: { ...base, id: 'rb-closed', name: 'Rabbit closed', environment: 'dev', options: { managementPort: '1' } }, secrets })
      try { await call('sessions.open', { connectionId: 'rb-closed' }) } catch (error) { unreachable = error.message }
      check('opening it says what to enable', /management plugin/.test(unreachable || ''), unreachable)
      await call('connections.delete', { id: 'rb-closed' })
    })

    await section('seeding', async () => {
      await cleanup()
      await write('broker.declareExchange', 'rb-dev', { request: { name: names.events, type: 'topic', durable: true, autoDelete: false, internal: false, arguments: {} } })
      await declareQueue('rb-dev', names.orders)
      await declareQueue('rb-dev', names.audit)
      await write('broker.bind', 'rb-dev', { request: { source: names.events, destination: names.orders, destinationType: 'queue', routingKey: 'order.*', arguments: {} } })
      await write('broker.bind', 'rb-dev', { request: { source: names.events, destination: names.audit, destinationType: 'queue', routingKey: '#', arguments: {} } })
      for (let i = 1; i <= 25; i++) {
        const result = await publish('rb-dev', names.events, 'order.created', JSON.stringify({ id: i, status: 'new', items: [{ sku: 'a' + i, qty: i }] }), { properties: { contentType: 'application/json', messageId: 'm' + i, deliveryMode: 2, headers: { attempt: i } } })
        if (!result.routed) throw new Error('message ' + i + ' was not routed')
      }
      await publish('rb-dev', names.events, 'audit.note', 'plain text note')
      // A real broker updates its statistics every few seconds; what follows reads them.
      await waitFor(async () => (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.audit })).ready === 26 && (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 25, 'the broker to count the messages', 45000)
      check('messages published through an exchange reach every queue bound to it', true)
    })

    await section('the tree', async () => {
      const roots = await call('tree.children', { connectionId: 'rb-dev', parent: null })
      const vhost = roots.find((n) => n.label === '/')
      check('the tree lists the vhost', vhost && vhost.kind === 'vhost' && vhost.hasChildren, roots.map((n) => n.label).join(','))
      const groups = await call('tree.children', { connectionId: 'rb-dev', parent: vhost })
      check('a vhost is its queues and its exchanges', groups.map((g) => g.label).join(',') === 'Queues,Exchanges', groups.map((g) => g.label).join(','))
      const queues = await call('tree.children', { connectionId: 'rb-dev', parent: groups[0] })
      const orders = queues.find((n) => n.label === names.orders)
      const audit = queues.find((n) => n.label === names.audit)
      check('queues show what they hold', orders && /26 ready/.test(orders.detail) === false && /25 ready/.test(orders.detail) && audit && /26 ready/.test(audit.detail), (orders && orders.detail) + ' / ' + (audit && audit.detail))
      const exchanges = await call('tree.children', { connectionId: 'rb-dev', parent: groups[1] })
      const events = exchanges.find((n) => n.label === names.events)
      check('exchanges show their type, the ones made first and the broker’s own after', events && events.detail === 'topic' && exchanges.findIndex((n) => n.label === names.events) < exchanges.findIndex((n) => n.label === 'amq.direct'), exchanges.map((n) => n.label).join(','))
      const bindings = await call('tree.children', { connectionId: 'rb-dev', parent: orders })
      check('a queue lists its bindings', bindings.length === 1 && bindings[0].label === names.events && bindings[0].detail === 'order.*', JSON.stringify(bindings.map((b) => [b.label, b.detail])))
    })

    await section('the vhost tab', async () => {
      await closeBrokerTabs()
      await open('rb-dev', 'vhost')
      await waitFor(() => inTabAll('.broker-qrow').length > 1, 'the queue list')
      const rowNames = () => inTabAll('.broker-qrow .broker-name').map((el) => el.textContent)
      check('the vhost lists its queues with their counts', rowNames().includes(names.orders) && /vhost/.test(inTab('.broker-title').textContent), rowNames().join(','))
      const row = inTabAll('.broker-qrow').find((r) => r.textContent.includes(names.orders))
      check('a queue row shows ready, unacked and consumers', row.textContent.includes('25'), row.textContent)
      await shot('r1-vhost')

      const filter = inTab('input[aria-label="Filter queues"]')
      setValue(filter, '.audit')
      await waitFor(() => rowNames().length === 1 && rowNames()[0] === names.audit, 'the filtered list')
      check('the filter narrows the list', true)
      setValue(filter, P)
      await waitFor(() => rowNames().includes(names.orders), 'the list again')

      const readyHeader = inTabAll('.broker-qhead button').find((b) => b.textContent.startsWith('Ready'))
      readyHeader.click()
      await sleep(150)
      readyHeader.click()
      await sleep(150)
      const sorted = inTabAll('.broker-qrow').filter((r) => r.textContent.includes(P)).map((r) => r.querySelector('.broker-name').textContent)
      check('clicking a column sorts by it (biggest first), and again reverses it', sorted[0] === names.orders && sorted.length >= 2, sorted.join(','))

      dbl(inTabAll('.broker-qrow').find((r) => r.textContent.includes(names.orders)))
      await waitFor(() => ui.useWorkbench.getState().activeId === 'broker:rb-dev:queue:/:' + names.orders, 'the queue tab')
      check('double-clicking a queue opens its tab', all('.tab-title').some((t) => t.textContent === names.orders))
    })

    await section('the queue tab and peeking', async () => {
      await sleep(300)
      await waitFor(() => stat('Ready') !== null, 'the queue to load')
      check('the queue shows its counts and what it is', stat('Ready') === '25' && stat('Total') === '25' && /classic/.test(inTab('.broker-title').textContent) && /durable/.test(inTab('.broker-title').textContent), stat('Ready'))
      check('and says what peeking does, before it is asked', /puts it straight back/.test(inTab('.broker-note').textContent) && /redelivered/.test(inTab('.broker-note').textContent))
      tabButton('Peek').click()
      await waitFor(() => inTabAll('.broker-peek-row').length > 0, 'the messages')
      check('peek lists the first ten messages', inTabAll('.broker-peek-row').length === 10, inTabAll('.broker-peek-row').length)
      await waitFor(() => inTab('.broker-payload'), 'the payload')
      check('the first one is open, its payload read as JSON', /"id": 1/.test(inTab('.broker-payload').textContent) && /"sku": "a1"/.test(inTab('.broker-payload').textContent), inTab('.broker-payload').textContent.slice(0, 120))
      check('with its properties and headers', /order\\.created/.test(inTab('.broker-props').textContent) && /application\\/json/.test(inTab('.broker-props').textContent) && /"attempt": 1/.test(inTab('.broker-peek-detail').textContent) && /m1/.test(inTab('.broker-props').textContent), inTab('.broker-props').textContent)
      check('looking took nothing: the queue still holds all 25', (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 25)
      await shot('r2-peek')

      inTabAll('.broker-peek-row')[4].click()
      await waitFor(() => /"id": 5/.test(inTab('.broker-payload').textContent), 'the fifth message')
      check('selecting another shows it', true)

      tabButton('Peek').click()
      await waitFor(() => inTabAll('.broker-peek-row').length > 0 && inTabAll('.broker-peek-row .broker-chip').length >= 10, 'the second look')
      check('a second look finds the first ten marked redelivered, as the broker does', inTabAll('.broker-peek-row .broker-chip').length === 10 && /redelivered/.test(inTabAll('.broker-peek-row')[0].textContent), inTabAll('.broker-peek-row .broker-chip').length)

      const picker = inTab('select[aria-label="How many messages"]')
      Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(picker, '50')
      picker.dispatchEvent(new Event('change', { bubbles: true }))
      tabButton('Peek').click()
      await waitFor(() => inTabAll('.broker-peek-row').length === 25, 'all the messages')
      check('asking for more than there are shows what there is', true)
    })

    await section('publishing and purging from the tab', async () => {
      tabButton('Publish').click()
      await waitFor(() => document.querySelector('.broker-dialog'), 'the publish dialog')
      check('the dialog starts from the default exchange and this queue’s name', document.querySelector('.broker-dialog input[placeholder="(default)"]').value === '' && [...document.querySelectorAll('.broker-dialog input')].some((i) => i.value === names.orders))
      const payload = document.querySelector('.broker-dialog .broker-payload-input')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(payload, '{"id": 26, "status": "from the dialog"}')
      payload.dispatchEvent(new Event('input', { bubbles: true }))
      dialogButton('Publish').click()
      await waitFor(() => !document.querySelector('.broker-dialog'), 'the dialog to close')
      // The confirmation is shown for a few seconds; a real broker takes about that long to count.
      await waitFor(() => notice(/Published/), 'the confirmation')
      await waitFor(async () => (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 26, 'the message to arrive', 30000)
      check('publishing from the dialog sends the message to this queue', true)
      await waitFor(() => stat('Ready') === '26', 'the tab to show it', 25000)
      check('and the tab’s numbers follow', true)

      tabButton('Purge').click()
      await waitFor(() => notice(/Purged/), 'the confirmation')
      await waitFor(async () => (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 0, 'the purge', 30000)
      check('Purge empties the queue (a dev connection does not ask first)', true)
      await waitFor(() => stat('Ready') === '0', 'the tab to show it', 25000)
    })

    await section('a production broker is locked', async () => {
      await publish('rb-dev', '', names.orders, 'one for prod')
      await waitFor(async () => (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 1, 'the message to be counted', 30000)
      await closeBrokerTabs()
      await open('rb-prod', 'queue', names.orders)
      await waitFor(() => stat('Ready') !== null, 'the queue on prod')
      check('the tab says it is read-only', /Read-only/.test(inTab('.broker-toolbar').textContent))
      tabButton('Publish').click()
      await waitFor(() => document.querySelector('.broker-dialog'), 'the dialog')
      const field = document.querySelector('.broker-dialog .broker-payload-input')
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(field, 'blocked')
      field.dispatchEvent(new Event('input', { bubbles: true }))
      dialogButton('Publish').click()
      await waitFor(() => notice(/locked/), 'the refusal')
      check('publishing while locked is refused with a way forward', document.querySelector('.broker-dialog') !== null)
      check('and nothing was sent', (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 1)
      dialogButton('Cancel').click()

      // Even a client that skips the window is refused by the core.
      let refused = null
      try { await call('broker.purge', { connectionId: 'rb-prod', vhost: '/', writable: false, queue: names.orders }) } catch (error) { refused = error.code }
      check('the core refuses a change that says writes are locked', refused === 'READ_ONLY', refused)

      tabButton('Read-only').click()
      await waitFor(() => document.querySelector('.dialog[role="alertdialog"]'), 'the unlock question')
      check('unlocking asks first', /Unlock writes/.test(document.querySelector('.dialog h2').textContent))
      dialogButton('Unlock').click()
      await waitFor(() => /Writable/.test(inTab('.broker-toolbar').textContent), 'the unlock')

      tabButton('Purge').click()
      await waitFor(() => document.querySelector('.dialog[role="alertdialog"]'), 'the purge question')
      check('a purge on production asks, and wants the connection’s name typed', /Purge/.test(document.querySelector('.dialog h2').textContent) && document.querySelector('.dialog-confirm input') && dialogButton('Purge').disabled === true)
      await shot('r3-prod-purge')
      setValue(document.querySelector('.dialog-confirm input'), 'Rabbit prod')
      await waitFor(() => !dialogButton('Purge').disabled, 'the button to enable')
      dialogButton('Purge').click()
      await waitFor(async () => (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.orders })).ready === 0, 'the purge on prod', 30000)
      check('typing the name lets the purge go through', true)
    })

    await section('creating and deleting', async () => {
      await closeBrokerTabs()
      await open('rb-dev', 'vhost')
      await waitFor(() => tabButton('New queue'), 'the toolbar')
      tabButton('New queue').click()
      await waitFor(() => document.querySelector('.broker-dialog'), 'the new queue dialog')
      setValue(document.querySelector('.broker-dialog input'), names.fresh)
      dialogButton('Create').click()
      await waitFor(() => ui.useWorkbench.getState().activeId === 'broker:rb-dev:queue:/:' + names.fresh, 'the new queue’s tab', 10000)
      check('a queue made from the vhost tab opens in its own tab', (await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.fresh })).durable === true)

      // Bind it from its own tab.
      await waitFor(() => inTab('.broker-bind'), 'the bind form')
      setValue(inTab('input[aria-label="Exchange"]'), names.events)
      setValue(inTab('input[aria-label="Routing key"]'), 'fresh.*')
      inTab('.broker-bind button').click()
      await waitFor(() => inTabAll('.broker-table td').some((td) => td.textContent === 'fresh.*'), 'the new binding')
      check('a binding made from the queue’s tab appears in its list', true)
      await publish('rb-dev', names.events, 'fresh.one', 'for the new queue')
      await waitFor(() => stat('Ready') === '1', 'the routed message', 25000)
      check('and messages follow it', true)
      const remove = inTabAll('.broker-table button').find((b) => /Remove this binding/.test(b.getAttribute('aria-label')))
      remove.click()
      await waitFor(() => !inTabAll('.broker-table td').some((td) => td.textContent === 'fresh.*'), 'the binding to go')
      check('a binding can be removed', true)

      await shot('r4-queue')
      tabButton('Delete').click()
      await waitFor(() => !all('.tab-title').some((t) => t.textContent === names.fresh), 'the tab to close', 10000)
      let gone = null
      try { await call('broker.queue', { connectionId: 'rb-dev', vhost: '/', name: names.fresh }) } catch (error) { gone = error.code }
      check('deleting a queue closes its tab and removes it', gone === 'NOT_FOUND', gone)
    })

    await section('an exchange tab', async () => {
      await closeBrokerTabs()
      await open('rb-dev', 'exchange', names.events)
      await waitFor(() => stat('Sends to') !== null, 'the exchange')
      check('an exchange shows its type and where it sends', /topic/.test(inTab('.broker-title').textContent) && stat('Sends to') === '2' && inTabAll('.broker-table td').some((td) => td.textContent === 'order.*'), stat('Sends to'))
      await shot('r5-exchange')
      tabButton('Publish').click()
      await waitFor(() => document.querySelector('.broker-dialog'), 'the dialog')
      check('publishing from it starts at this exchange', [...document.querySelectorAll('.broker-dialog input')].some((i) => i.value === names.events))
      dialogButton('Cancel').click()
      await closeBrokerTabs()
      await open('rb-dev', 'exchange', '')
      await waitFor(() => stat('Sends to') !== null, 'the default exchange')
      check('the default exchange says how it works, and can not be deleted', /sends a message to the queue/.test(inTab('.broker-section').textContent) && !tabButton('Delete'))
    })

    await section('the connection tab', async () => {
      ui.useWorkbench.getState().openTab({ id: 'conn:rb-dev', kind: 'connection', connectionId: 'rb-dev' })
      await waitFor(() => document.querySelector('.broker-overview .broker-stat'), 'the overview')
      const text = document.querySelector('.broker-overview').textContent
      check('a RabbitMQ connection opens on the broker’s overview', /RabbitMQ [0-9]+[.][0-9]+/.test(text) && /Queues/.test(text) && /Publish \\/ s/.test(text), text.slice(0, 160))
      check('and offers no SQL script', !byText('button', 'New SQL script'))
      await shot('r6-overview')
      ui.useWorkbench.getState().openTab({ id: 'edit:rb-dev', kind: 'connection-editor', connectionId: 'rb-dev' })
      await waitFor(() => all('h2').some((h) => h.textContent === 'RabbitMQ'), 'the RabbitMQ section')
      check('the connection form has the management address', all('label').some((l) => /Management API address/.test(l.textContent)))
      ui.useWorkbench.getState().closeTab('edit:rb-dev')
    })
    } finally {
      await cleanup()
    }
  `,
    target as unknown as Record<string, unknown>,
  )
