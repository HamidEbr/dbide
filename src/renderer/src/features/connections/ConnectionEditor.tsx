import { LoaderCircle, Plug, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import {
  ENGINES,
  newConnectionDraft,
  type ConnectionConfig,
  type EngineKind,
  type TestStep,
} from '@shared/connection'
import { ENVIRONMENT_POLICIES, ENVIRONMENTS, type Environment } from '@shared/environment'
import type { DriverDescriptor } from '@shared/driver'
import { RpcError } from '@shared/rpc'
import { applyParsedUri, parseConnectionUri } from '@shared/uri'
import { Button, Field, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { engineName, useData } from '@/state/data'
import { useTree } from '@/state/tree'
import { useWorkbench, workbench, type Tab } from '@/state/workbench'
import { TestResults } from './TestResults'

const DATABASE_LABEL: Record<EngineKind, { label: string; hint: string }> = {
  mysql: { label: 'Database', hint: 'Optional. The schema selected after login.' },
  postgresql: {
    label: 'Database',
    hint: 'The database to connect to. The tree then lists its schemas.',
  },
  mssql: {
    label: 'Database',
    hint: 'The database to connect to. The tree then lists its schemas, such as dbo.',
  },
  mongodb: { label: 'Default database', hint: 'Optional. Also used as the auth database.' },
  redis: {
    label: 'Database index',
    hint: 'A number, 0 to 15 on most servers. Not used by a cluster.',
  },
  rabbitmq: { label: 'Virtual host', hint: 'The default vhost is "/".' },
}

function describeError(error: unknown): string {
  if (error instanceof RpcError) return error.message
  return error instanceof Error ? error.message : String(error)
}

interface UriNote {
  ok: boolean
  text: string
}

/** What pasting a URI changes: the form values, a password if the URI carried one, and a note. */
function interpretUri(
  text: string,
  current: ConnectionConfig,
  engines: DriverDescriptor[],
): { config: ConnectionConfig; password?: string; note: UriNote | null } {
  const trimmed = text.trim()
  if (!trimmed) return { config: current, note: null }
  const parsed = parseConnectionUri(trimmed)
  if (!parsed) {
    return {
      config: current,
      note: trimmed.includes('://')
        ? { ok: false, text: "That doesn't look like a MySQL, MongoDB, Redis, or RabbitMQ URI." }
        : null,
    }
  }
  const applied = applyParsedUri(current, parsed)
  return {
    config: applied.name ? applied : { ...applied, name: parsed.host },
    ...(parsed.password ? { password: parsed.password } : {}),
    note: { ok: true, text: `Filled in from a ${engineName(engines, parsed.engine)} URI.` },
  }
}

export function ConnectionEditor({ tab }: { tab: Tab }) {
  const engines = useData((state) => state.engines)
  const refreshConnections = useData((state) => state.refreshConnections)
  const closeTab = useWorkbench((state) => state.closeTab)

  const isNew = tab.connectionId === undefined
  const draftId = tab.connectionId ?? tab.draftId ?? tab.id

  // A URI pasted on the welcome screen arrives with the tab; apply it before the first render.
  const [initial] = useState(() => {
    const draft = newConnectionDraft(tab.initialEngine ?? 'mysql', draftId)
    if (!tab.initialUri) return { config: draft, password: '', note: null as UriNote | null }
    const result = interpretUri(tab.initialUri, draft, engines)
    return { config: result.config, password: result.password ?? '', note: result.note }
  })

  const [config, setConfig] = useState<ConnectionConfig>(initial.config)
  const [password, setPassword] = useState(initial.password)
  const [hasSavedPassword, setHasSavedPassword] = useState(false)
  const [uri, setUri] = useState(tab.initialUri ?? '')
  const [uriNote, setUriNote] = useState<UriNote | null>(initial.note)
  const [steps, setSteps] = useState<TestStep[] | null>(null)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(!isNew)
  const testAbort = useRef<AbortController | null>(null)

  const applyUri = (text: string): void => {
    setUri(text)
    const result = interpretUri(text, config, engines)
    setUriNote(result.note)
    if (result.note?.ok) {
      setConfig(result.config)
      if (result.password) setPassword(result.password)
      setSteps(null)
    }
  }

  // Load an existing connection for editing.
  useEffect(() => {
    if (!tab.connectionId) return
    let cancelled = false
    coreLink
      .call('connections.get', { id: tab.connectionId })
      .then((stored) => {
        if (cancelled) return
        if (stored) {
          setConfig(stored.config)
          setHasSavedPassword(stored.hasPassword)
        }
        setLoading(false)
      })
      .catch((cause: unknown) => {
        if (cancelled) return
        setError(describeError(cause))
        setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [tab.connectionId])

  const update = (patch: Partial<ConnectionConfig>): void => {
    setConfig((current) => ({ ...current, ...patch }))
    setSteps(null)
  }

  const changeEngine = (engine: EngineKind): void => {
    const previous = engines.find((d) => d.engine === config.engine)
    const next = engines.find((d) => d.engine === engine)
    const draft = newConnectionDraft(engine, config.id)
    update({
      engine,
      // Keep a port the user typed; swap it only when it was the old engine's default.
      port:
        config.port === previous?.defaultPort ? (next?.defaultPort ?? config.port) : config.port,
      ...(draft.database ? { database: draft.database } : {}),
      ...(config.username === undefined || config.username === 'root' || config.username === 'guest'
        ? { username: draft.username ?? '' }
        : {}),
    })
  }

  /** Sets one engine option, or removes it when it is cleared. */
  const setOption = (key: string, value: string | null): void => {
    const options = { ...config.options }
    if (value === null || value === '') delete options[key]
    else options[key] = value
    update({ options })
  }

  const secrets = (): { password?: string } => (password ? { password } : {})

  const runTest = async (): Promise<void> => {
    testAbort.current?.abort()
    const controller = new AbortController()
    testAbort.current = controller
    setTesting(true)
    setError(null)
    try {
      setSteps(
        await coreLink.call(
          'connections.test',
          { config, secrets: secrets() },
          { signal: controller.signal },
        ),
      )
    } catch (cause) {
      if (!(cause instanceof RpcError && cause.code === 'ABORTED')) setError(describeError(cause))
    } finally {
      if (testAbort.current === controller) setTesting(false)
    }
  }

  const save = async (): Promise<void> => {
    setSaving(true)
    setError(null)
    try {
      const saved = await coreLink.call('connections.save', { config, secrets: secrets() })
      await refreshConnections()
      useTree.getState().reset(saved.id)
      closeTab(tab.id)
      workbench.openConnection(saved.id)
    } catch (cause) {
      setError(describeError(cause))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (): Promise<void> => {
    if (!window.confirm(`Delete "${config.name}"? Its saved password is removed too.`)) return
    try {
      await coreLink.call('connections.delete', { id: config.id })
      await refreshConnections()
      useTree.getState().reset(config.id)
      closeTab(tab.id)
      closeTab(`conn:${config.id}`)
    } catch (cause) {
      setError(describeError(cause))
    }
  }

  if (loading) {
    return (
      <div className="view">
        <p className="muted">
          <LoaderCircle size={14} className="spin" aria-hidden /> Loading connection…
        </p>
      </div>
    )
  }

  const databaseField = DATABASE_LABEL[config.engine]
  const policy = ENVIRONMENT_POLICIES[config.environment]

  return (
    <form
      className="view editor"
      onSubmit={(event) => {
        event.preventDefault()
        void save()
      }}
    >
      <header className="view-header">
        <h1>{isNew ? 'New connection' : `Edit ${config.name || 'connection'}`}</h1>
      </header>

      <Field
        label="Paste a connection URI"
        hint="mysql://, mongodb://, mongodb+srv://, redis://, rediss://, amqp://, amqps://"
        error={uriNote && !uriNote.ok ? uriNote.text : undefined}
      >
        {(id) => (
          <input
            id={id}
            className="mono"
            placeholder="mysql://user:password@db.internal:3306/shop"
            value={uri}
            onChange={(event) => applyUri(event.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
      </Field>
      {uriNote?.ok ? <p className="note-ok">{uriNote.text}</p> : null}

      <section className="form-section">
        <h2>General</h2>
        <div className="form-grid">
          <Field label="Name">
            {(id) => (
              <input
                id={id}
                value={config.name}
                placeholder="Orders database"
                onChange={(event) => update({ name: event.target.value })}
                autoFocus={isNew && !tab.initialUri}
              />
            )}
          </Field>
          <Field label="Engine">
            {(id) => (
              <select
                id={id}
                value={config.engine}
                onChange={(event) => changeEngine(event.target.value as EngineKind)}
              >
                {ENGINES.map((engine) => (
                  <option key={engine} value={engine}>
                    {engineName(engines, engine)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field
          label="Environment"
          hint={
            policy.readOnlyByDefault
              ? 'Opens read-only, tints the window red, and asks before anything destructive.'
              : policy.confirmDestructive
                ? 'Asks before anything destructive.'
                : 'No extra safeguards.'
          }
        >
          {() => (
            <Segmented<Environment>
              label="Environment"
              value={config.environment}
              onChange={(environment) => update({ environment })}
              options={ENVIRONMENTS.map((environment) => ({
                value: environment,
                label: ENVIRONMENT_POLICIES[environment].label,
                swatch: `var(--env-${environment})`,
              }))}
            />
          )}
        </Field>
      </section>

      <section className="form-section">
        <h2>Server</h2>
        <div className="form-grid host-port">
          <Field label="Host">
            {(id) => (
              <input
                id={id}
                className="mono"
                value={config.host}
                onChange={(event) => update({ host: event.target.value })}
                spellCheck={false}
              />
            )}
          </Field>
          <Field label="Port">
            {(id) => (
              <input
                id={id}
                className="mono"
                type="number"
                min={1}
                max={65535}
                value={config.port}
                onChange={(event) => update({ port: Number(event.target.value) })}
              />
            )}
          </Field>
        </div>
        <div className="form-grid">
          <Field label="Username">
            {(id) => (
              <input
                id={id}
                value={config.username ?? ''}
                onChange={(event) => update({ username: event.target.value })}
                autoComplete="off"
                spellCheck={false}
              />
            )}
          </Field>
          <Field
            label="Password"
            hint={
              hasSavedPassword && !password
                ? 'A password is saved. Leave blank to keep it.'
                : 'Stored in your system keychain.'
            }
          >
            {(id) => (
              <input
                id={id}
                type="password"
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value)
                  setSteps(null)
                }}
                autoComplete="new-password"
              />
            )}
          </Field>
        </div>
        <Field label={databaseField.label} hint={databaseField.hint}>
          {(id) => (
            <input
              id={id}
              className="mono"
              value={config.database ?? ''}
              onChange={(event) => update({ database: event.target.value })}
              spellCheck={false}
            />
          )}
        </Field>
      </section>

      {config.engine === 'mongodb' ? (
        <section className="form-section">
          <h2>MongoDB</h2>
          <Field
            label="Authentication database"
            hint="Where the user is defined, usually admin. Left blank, the default database above is used, or admin."
          >
            {(id) => (
              <input
                id={id}
                className="mono"
                value={config.options.authSource ?? ''}
                placeholder="admin"
                onChange={(event) => setOption('authSource', event.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          <div className="form-grid">
            <Field label="Replica set" hint="Optional. The name of the replica set.">
              {(id) => (
                <input
                  id={id}
                  className="mono"
                  value={config.options.replicaSet ?? ''}
                  onChange={(event) => setOption('replicaSet', event.target.value)}
                  spellCheck={false}
                />
              )}
            </Field>
            <Field label="Read preference" hint="Which members reads may come from.">
              {(id) => (
                <select
                  id={id}
                  value={config.options.readPreference ?? ''}
                  onChange={(event) => setOption('readPreference', event.target.value)}
                >
                  <option value="">Primary (default)</option>
                  <option value="primaryPreferred">Primary preferred</option>
                  <option value="secondary">Secondary</option>
                  <option value="secondaryPreferred">Secondary preferred</option>
                  <option value="nearest">Nearest</option>
                </select>
              )}
            </Field>
          </div>
          <Field
            label="Other hosts"
            hint="Optional. Every member as host:port, separated by commas. Replaces the host and port above."
          >
            {(id) => (
              <input
                id={id}
                className="mono"
                value={config.options.hosts ?? ''}
                placeholder="db1.internal:27017,db2.internal:27017"
                onChange={(event) => setOption('hosts', event.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={config.options.directConnection === 'true'}
              onChange={(event) =>
                setOption('directConnection', event.target.checked ? 'true' : null)
              }
            />
            Connect to this host only, without looking for other replica set members
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={config.options.srv === 'true'}
              onChange={(event) => {
                setOption('srv', event.target.checked ? 'true' : null)
                if (event.target.checked) update({ tls: { ...config.tls, enabled: true } })
              }}
            />
            Find the servers through DNS (mongodb+srv, as Atlas gives)
          </label>
        </section>
      ) : null}

      {config.engine === 'redis' ? (
        <section className="form-section">
          <h2>Redis</h2>
          <Segmented<'standalone' | 'sentinel' | 'cluster'>
            label="Deployment"
            value={
              config.options.mode === 'sentinel' || config.options.mode === 'cluster'
                ? config.options.mode
                : 'standalone'
            }
            onChange={(mode) => setOption('mode', mode === 'standalone' ? null : mode)}
            options={[
              { value: 'standalone', label: 'Single server' },
              { value: 'sentinel', label: 'Sentinel' },
              { value: 'cluster', label: 'Cluster' },
            ]}
          />
          {config.options.mode === 'sentinel' ? (
            <>
              <p className="muted">
                The host and port above are a Sentinel. DBIDE asks the sentinels where the primary
                is, and follows it if it moves.
              </p>
              <Field
                label="Primary name"
                hint="What the sentinels call the primary. The default is mymaster."
              >
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={config.options.master ?? ''}
                    placeholder="mymaster"
                    onChange={(event) => setOption('master', event.target.value)}
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field label="More sentinels" hint="Optional. host:port, separated by commas.">
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={config.options.sentinels ?? ''}
                    placeholder="sentinel-2:26379, sentinel-3:26379"
                    onChange={(event) => setOption('sentinels', event.target.value)}
                    spellCheck={false}
                  />
                )}
              </Field>
            </>
          ) : null}
          {config.options.mode === 'cluster' ? (
            <p className="muted">
              The host and port above are any node of the cluster; DBIDE finds the rest. A cluster
              has only database 0, and its keys are searched on every primary.
            </p>
          ) : null}
          <Field
            label="Key separator"
            hint="What splits a key into folders in the navigator, such as : in user:42:name. The default is a colon."
          >
            {(id) => (
              <input
                id={id}
                className="mono"
                value={config.options.separator ?? ''}
                placeholder=":"
                disabled={config.options.folders === 'off'}
                onChange={(event) => setOption('separator', event.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
          <label className="check">
            <input
              type="checkbox"
              checked={config.options.folders === 'off'}
              onChange={(event) => setOption('folders', event.target.checked ? 'off' : null)}
            />
            Don’t group keys into folders: list them all at the top level
          </label>
        </section>
      ) : null}

      {config.engine === 'rabbitmq' ? (
        <section className="form-section">
          <h2>RabbitMQ</h2>
          <Field
            label="Management API address"
            hint={
              <>
                Optional. Queues and messages are read through RabbitMQ’s management API, which is
                HTTP on its own port, not the AMQP port above. Left blank, DBIDE uses this host on
                port 15672 (15671 with TLS). Fill it in for another port, a proxy or a path, such as{' '}
                <span className="mono">https://rabbit.example.com/</span>.
              </>
            }
          >
            {(id) => (
              <input
                id={id}
                className="mono"
                value={config.options.managementUrl ?? ''}
                placeholder="http://localhost:15672"
                onChange={(event) => setOption('managementUrl', event.target.value)}
                spellCheck={false}
              />
            )}
          </Field>
        </section>
      ) : null}

      <section className="form-section">
        <h2>Security</h2>
        <label className="check">
          <input
            type="checkbox"
            checked={config.tls.enabled}
            onChange={(event) => update({ tls: { ...config.tls, enabled: event.target.checked } })}
          />
          Use TLS
        </label>
        {config.tls.enabled ? (
          <>
            <Field
              label="CA certificate"
              hint="Optional. A PEM file, for servers with a private CA."
            >
              {(id) => (
                <input
                  id={id}
                  className="mono"
                  value={config.tls.caPath ?? ''}
                  placeholder="/path/to/ca.pem"
                  onChange={(event) =>
                    update({ tls: { ...config.tls, caPath: event.target.value } })
                  }
                  spellCheck={false}
                />
              )}
            </Field>
            <div className="form-grid">
              <Field
                label="Client certificate"
                hint="Optional. A PEM file, for servers that ask the client for one."
              >
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={config.tls.certPath ?? ''}
                    placeholder="/path/to/client.pem"
                    onChange={(event) =>
                      update({ tls: { ...config.tls, certPath: event.target.value } })
                    }
                    spellCheck={false}
                  />
                )}
              </Field>
              <Field label="Client key" hint="Optional. The private key for that certificate.">
                {(id) => (
                  <input
                    id={id}
                    className="mono"
                    value={config.tls.keyPath ?? ''}
                    placeholder="/path/to/client.key"
                    onChange={(event) =>
                      update({ tls: { ...config.tls, keyPath: event.target.value } })
                    }
                    spellCheck={false}
                  />
                )}
              </Field>
            </div>
            <label className="check">
              <input
                type="checkbox"
                checked={config.tls.allowInvalidCertificates}
                onChange={(event) =>
                  update({ tls: { ...config.tls, allowInvalidCertificates: event.target.checked } })
                }
              />
              Allow invalid certificates
            </label>
            {config.tls.allowInvalidCertificates ? (
              <p className="note-warn">
                The server's identity won't be verified. Use this for local development only.
              </p>
            ) : null}
          </>
        ) : null}
        <label className="check disabled">
          <input type="checkbox" disabled />
          Connect through an SSH tunnel
          <span className="pill">Coming soon</span>
        </label>
      </section>

      <TestResults steps={steps} testing={testing} />
      {error ? (
        <p className="note-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer className="form-actions">
        {!isNew ? (
          <Button variant="danger" icon={<Trash2 size={14} />} onClick={() => void remove()}>
            Delete
          </Button>
        ) : null}
        <span className="spacer" />
        <Button icon={<Plug size={14} />} onClick={() => void runTest()} disabled={testing}>
          Test connection
        </Button>
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save'}
        </Button>
      </footer>
    </form>
  )
}
