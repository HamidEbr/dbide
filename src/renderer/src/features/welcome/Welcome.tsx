import { useState } from 'react'
import type { EngineKind } from '@shared/connection'
import { parseConnectionUri } from '@shared/uri'
import { EngineIcon, EnvDot, Kbd } from '@/components/ui'
import { engineName, useData } from '@/state/data'
import { workbench } from '@/state/workbench'

const START_ENGINES: EngineKind[] = ['mysql', 'postgresql', 'mssql', 'mongodb', 'redis', 'rabbitmq']

export function Welcome() {
  const connections = useData((state) => state.connections)
  const engines = useData((state) => state.engines)
  const [uri, setUri] = useState('')
  const [invalid, setInvalid] = useState(false)

  const submit = (): void => {
    const trimmed = uri.trim()
    if (!trimmed) return
    if (!parseConnectionUri(trimmed)) return setInvalid(true)
    workbench.newConnection({ initialUri: trimmed })
    setUri('')
  }

  return (
    <div className="view welcome">
      <header>
        <h1>Connect to a database</h1>
        <p className="muted">
          MySQL, MongoDB, Redis, and RabbitMQ in one place, with the same shortcuts everywhere.
        </p>
      </header>

      <form
        className="uri-box"
        onSubmit={(event) => {
          event.preventDefault()
          submit()
        }}
      >
        <label htmlFor="welcome-uri">Paste a connection URI</label>
        <input
          id="welcome-uri"
          className="mono"
          placeholder="redis://:password@cache.internal:6379/0"
          value={uri}
          onChange={(event) => {
            setUri(event.target.value)
            setInvalid(false)
          }}
          autoComplete="off"
          spellCheck={false}
          autoFocus
        />
        {invalid ? (
          <p className="field-error" role="alert">
            That doesn't look like a MySQL, MongoDB, Redis, or RabbitMQ URI.
          </p>
        ) : (
          <p className="field-hint">Press Enter to review it before saving.</p>
        )}
      </form>

      <section>
        <h2>Or start from an engine</h2>
        <div className="engine-grid">
          {START_ENGINES.map((engine) => (
            <button
              key={engine}
              type="button"
              className="engine-card"
              onClick={() => workbench.newConnection({ initialEngine: engine })}
            >
              <EngineIcon engine={engine} size={18} />
              <span>{engineName(engines, engine)}</span>
            </button>
          ))}
        </div>
      </section>

      {connections.length > 0 ? (
        <section>
          <h2>Your connections</h2>
          <ul className="recent">
            {connections.slice(0, 8).map((connection) => (
              <li key={connection.id}>
                <button type="button" onClick={() => workbench.openConnection(connection.id)}>
                  <EnvDot environment={connection.environment} />
                  <EngineIcon engine={connection.engine} />
                  <span>{connection.name}</span>
                  <span className="muted mono">
                    {connection.host}:{connection.port}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="tips">
        <p>
          <Kbd shortcut="Mod+Shift+P" /> <span>all commands</span>
        </p>
        <p>
          <Kbd shortcut="Mod+P" /> <span>go to anything</span>
        </p>
        <p>
          <Kbd shortcut="Mod+N" /> <span>new connection</span>
        </p>
      </section>
    </div>
  )
}
