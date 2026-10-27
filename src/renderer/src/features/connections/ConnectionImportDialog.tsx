import { CircleCheck, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import type { DbeaverConnection, DbeaverSkipped } from '@shared/dbeaver'
import { CONNECTION_SOURCES, type ConnectionSource } from '@shared/connection-sources'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { Button, EngineIcon, EnvBadge, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useDialogs } from '@/state/dialogs'

type Phase = 'finding' | 'pick' | 'importing' | 'done' | 'failed'

interface Found {
  path: string | null
  connections: DbeaverConnection[]
  skipped: DbeaverSkipped[]
  hasCredentials: boolean
}

export function ConnectionImportDialog() {
  const open = useDialogs((state) => state.dbeaverImport)
  if (!open) return null
  return <DbeaverImportBody />
}

function DbeaverImportBody() {
  const close = useDialogs((state) => state.closeDbeaverImport)
  const existing = useData((state) => state.connections)
  const refresh = useData((state) => state.refreshConnections)
  const [source, setSource] = useState<ConnectionSource>('dbeaver')
  const [text, setText] = useState('')
  const info = CONNECTION_SOURCES.find((s) => s.value === source)!
  const [phase, setPhase] = useState<Phase>('finding')
  const [found, setFound] = useState<Found | null>(null)
  const [chosen, setChosen] = useState<Set<string>>(new Set())
  const [passwords, setPasswords] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [count, setCount] = useState(0)

  const alreadyHere = (c: DbeaverConnection): boolean =>
    existing.some(
      (e) =>
        e.engine === c.engine &&
        e.host.toLowerCase() === c.host.toLowerCase() &&
        e.port === c.port &&
        e.name.toLowerCase() === c.name.toLowerCase(),
    )

  const scan = (choose: boolean, from: ConnectionSource = source): Promise<void> => {
    setPhase('finding')
    setError(null)
    return load(choose, from)
  }

  const load = async (choose: boolean, from: ConnectionSource = source): Promise<void> => {
    const kind = CONNECTION_SOURCES.find((s) => s.value === from)!
    try {
      const result = await coreLink.call('connectionImport.scan', {
        source: from,
        choose,
        ...(kind.input === 'text' ? { text } : {}),
      })
      if (result.connections.length === 0) {
        setFound(null)
        setMessage(
          kind.input === 'text'
            ? 'No MySQL, MongoDB or Redis URL was found in that text.'
            : choose && result.path === null
              ? null
              : `${kind.label}’s connections weren’t found in the usual place, or none of them is a MySQL, MongoDB or Redis connection.`,
        )
        setPhase('pick')
        return
      }
      const known = { ...result }
      setFound(known)
      setMessage(null)
      setChosen(new Set(known.connections.filter((c) => !alreadyHere(c)).map((c) => c.sourceId)))
      setPhase('pick')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  useEffect(() => {
    // Look in DBeaver's usual folder first; the person can point at a file if it isn't there.
    void load(false, 'dbeaver')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const pickSource = (next: ConnectionSource): void => {
    setSource(next)
    setFound(null)
    setMessage(null)
    setError(null)
    setPasswords(false)
    // A tool with one usual place is read at once; a file or pasted text waits for the person.
    if (CONNECTION_SOURCES.find((s) => s.value === next)!.input === 'file') void scan(false, next)
    else setPhase('pick')
  }

  const folders = useMemo(() => {
    const groups = new Map<string, DbeaverConnection[]>()
    for (const c of found?.connections ?? []) {
      const list = groups.get(c.folder) ?? []
      list.push(c)
      groups.set(c.folder, list)
    }
    return [...groups].sort(([a], [b]) => a.localeCompare(b))
  }, [found])

  const picked = (found?.connections ?? []).filter((c) => chosen.has(c.sourceId))
  const canPasswords = found?.hasCredentials === true && picked.some((c) => c.hasPassword)

  const toggle = (id: string, on: boolean): void =>
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  const run = async (): Promise<void> => {
    if (!found) return
    setPhase('importing')
    try {
      const result = await coreLink.call('connectionImport.run', {
        source,
        path: found.path,
        ...(info.input === 'text' ? { text } : {}),
        ids: picked.map((c) => c.sourceId),
        passwords: passwords && canPasswords,
      })
      setCount(result.imported.length)
      await refresh()
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  return (
    <div className="dialog-overlay" onMouseDown={() => phase !== 'importing' && close()}>
      <div
        className="dialog dialog-export"
        role="dialog"
        aria-modal="true"
        aria-labelledby="cimport-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          if (phase !== 'importing') close()
        }}
      >
        <header>
          <h2 id="cimport-title">Import connections</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        {phase !== 'importing' && phase !== 'done' ? (
          <Segmented<ConnectionSource>
            label="Import from"
            value={source}
            options={CONNECTION_SOURCES.map((s) => ({ value: s.value, label: s.label }))}
            onChange={pickSource}
          />
        ) : null}

        {phase === 'finding' || phase === 'importing' ? (
          <p className="export-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden />{' '}
            {phase === 'finding' ? 'Looking for DBeaver’s connections…' : 'Importing…'}
          </p>
        ) : null}

        {phase === 'failed' ? (
          <>
            <p className="note-error" role="alert">
              {error}
            </p>
            <footer>
              <Button variant="ghost" onClick={close}>
                Close
              </Button>
              <Button onClick={() => void scan(false)}>Try again</Button>
            </footer>
          </>
        ) : null}

        {phase === 'pick' && !found ? (
          info.input === 'text' ? (
            <>
              <p className="muted export-note">
                {message ?? 'Paste one connection URL per line.'} For example{' '}
                <span className="mono">mysql://user:password@host:3306/database</span>,{' '}
                <span className="mono">mongodb://…</span> or <span className="mono">redis://…</span>
                .
              </p>
              <textarea
                className="mono"
                aria-label="Connection URLs"
                rows={6}
                value={text}
                spellCheck={false}
                onChange={(event) => setText(event.target.value)}
              />
              <footer>
                <Button variant="ghost" onClick={close}>
                  Close
                </Button>
                <Button
                  variant="primary"
                  disabled={text.trim() === ''}
                  onClick={() => void scan(false)}
                >
                  Read the URLs
                </Button>
              </footer>
            </>
          ) : (
            <>
              <p className="muted export-note">
                {message ?? `Choose ${info.label}’s file.`} It is {info.fileHint}.
              </p>
              <footer>
                <Button variant="ghost" onClick={close}>
                  Close
                </Button>
                <Button variant="primary" onClick={() => void scan(true)}>
                  Choose file…
                </Button>
              </footer>
            </>
          )
        ) : null}

        {phase === 'pick' && found ? (
          <>
            <p className="muted export-note">
              Tick the connections to bring over. Ones marked production open read-only.
              <br />
              {found.path ? <span className="mono selectable">{found.path}</span> : null}
            </p>
            <fieldset className="export-fields">
              <div className="export-columns-head">
                <span>
                  Connections ({picked.length} of {found.connections.length})
                </span>
                <Button
                  variant="ghost"
                  onClick={() => setChosen(new Set(found.connections.map((c) => c.sourceId)))}
                >
                  All
                </Button>
                <Button variant="ghost" onClick={() => setChosen(new Set())}>
                  None
                </Button>
              </div>
              <div className="dbeaver-list" role="group" aria-label="Connections">
                {folders.map(([folder, list]) => (
                  <div key={folder}>
                    {folders.length > 1 || folder ? (
                      <div className="dbeaver-folder muted">{folder || 'No folder'}</div>
                    ) : null}
                    {list.map((c) => (
                      <label className="check dbeaver-row" key={c.sourceId}>
                        <input
                          type="checkbox"
                          checked={chosen.has(c.sourceId)}
                          onChange={(event) => toggle(c.sourceId, event.target.checked)}
                        />
                        <EngineIcon engine={c.engine} />
                        <span className="dbeaver-name">{c.name}</span>
                        <span className="muted mono">
                          {c.host}:{c.port}
                          {c.database ? ` / ${c.database}` : ''}
                        </span>
                        <EnvBadge environment={c.environment} />
                        {c.ssh ? <span className="muted">SSH</span> : null}
                        {alreadyHere(c) ? <span className="muted">already added</span> : null}
                      </label>
                    ))}
                  </div>
                ))}
              </div>
            </fieldset>
            {found.skipped.length > 0 ? (
              <p className="muted">
                Not imported, as DBIDE has no driver for them:{' '}
                {found.skipped.map((s) => `${s.name} (${s.driver})`).join(', ')}.
              </p>
            ) : null}
            <div className="export-checks">
              <label
                className="check"
                title="Read from DBeaver’s encrypted credentials file and kept in this computer’s secure storage."
              >
                <input
                  type="checkbox"
                  checked={passwords && canPasswords}
                  disabled={!canPasswords}
                  onChange={(event) => setPasswords(event.target.checked)}
                />
                <span>Import saved passwords</span>
              </label>
            </div>
            <p className="muted">
              {found.hasCredentials
                ? canPasswords
                  ? `Passwords are read from ${info.label}’s own data and kept in secure storage, never shown here. User names come over either way.`
                  : 'None of the chosen connections has a saved password.'
                : info.passwords
                  ? 'No saved passwords were found, so connections come over without them.'
                  : `${info.label} keeps passwords in the system keychain, where DBIDE can’t read them: connections come over without one, and you enter it when you first connect.`}
            </p>
            <footer>
              {info.input === 'file' ? (
                <Button variant="ghost" onClick={() => void scan(true)}>
                  Choose another file…
                </Button>
              ) : (
                <Button variant="ghost" onClick={() => setFound(null)}>
                  Edit the text
                </Button>
              )}
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={picked.length === 0}
                onClick={() => void run()}
                autoFocus
              >
                Import {picked.length}
              </Button>
            </footer>
          </>
        ) : null}

        {phase === 'done' ? (
          <div className="export-done" role="status">
            <p>
              <CircleCheck size={16} className="step-ok" aria-hidden /> <strong>{count}</strong>{' '}
              connection{count === 1 ? '' : 's'} imported.
              {picked.some((c) => ENVIRONMENT_POLICIES[c.environment].readOnlyByDefault)
                ? ' Production connections start read-only.'
                : ''}
            </p>
            <footer>
              <Button variant="primary" onClick={close} autoFocus>
                Done
              </Button>
            </footer>
          </div>
        ) : null}
      </div>
    </div>
  )
}
