import { Copy, FileCode, LoaderCircle, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { dialectOf } from '@shared/dialect'
import type { SchemaForeignKey, SchemaTable } from '@shared/driver'
import {
  compareSchemas,
  scriptOf,
  type SchemaChange,
  type SchemaSnapshot,
} from '@shared/schema-compare'
import { isSqlEngine } from '@shared/connection'
import { Button, Field, IconButton } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { createScript } from '@/features/sql/scripts'
import { writeClipboard } from '@/lib/clipboard'
import { useData } from '@/state/data'
import { useDialogs, type SchemaCompareRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'

const MAX_TABLES = 600

/** The tables, columns and foreign keys of one schema, read through the same calls autocomplete uses. */
async function snapshotOf(connectionId: string, database: string): Promise<SchemaSnapshot> {
  const detail = await coreLink.call('schema.detail', { connectionId, database })
  const names = detail.tables.slice(0, MAX_TABLES).map((t) => t.name)
  const tables: SchemaTable[] = []
  const foreignKeys: SchemaForeignKey[] = []
  for (let i = 0; i < names.length; i += 200) {
    const part = await coreLink.call('schema.columns', {
      connectionId,
      database,
      tables: names.slice(i, i + 200),
    })
    tables.push(...part.tables)
    foreignKeys.push(...part.foreignKeys)
  }
  return { tables, foreignKeys }
}

const KIND_LABEL: Record<SchemaChange['kind'], string> = {
  'table-added': 'Add table',
  'table-removed': 'Drop table',
  'column-added': 'Add column',
  'column-removed': 'Drop column',
  'column-changed': 'Change column',
  'key-added': 'Add key',
  'key-removed': 'Drop key',
}

export function SchemaCompareDialog() {
  const request = useDialogs((state) => state.schemaCompare)
  if (!request) return null
  return <CompareBody request={request} />
}

function CompareBody({ request }: { request: SchemaCompareRequest }) {
  const close = useDialogs((state) => state.closeSchemaCompare)
  const connections = useData((state) => state.connections).filter((c) => isSqlEngine(c.engine))
  const source = connections.find((c) => c.id === request.connectionId)
  const [targetId, setTargetId] = useState(request.connectionId)
  const [schemas, setSchemas] = useState<string[]>([])
  const [targetSchema, setTargetSchema] = useState('')
  const [phase, setPhase] = useState<'pick' | 'reading' | 'done' | 'failed'>('pick')
  const [error, setError] = useState<string | null>(null)
  const [changes, setChanges] = useState<SchemaChange[]>([])
  const [chosen, setChosen] = useState<Set<string>>(new Set())

  const target = connections.find((c) => c.id === targetId)
  const dialect =
    source && target && source.engine === target.engine ? dialectOf(source.engine) : null

  useEffect(() => {
    let alive = true
    coreLink
      .call('schema.databases', { connectionId: targetId })
      .then((names) => {
        if (!alive) return
        setSchemas(names)
        setTargetSchema((current) =>
          names.includes(current)
            ? current
            : (names.find((n) => n !== request.database && targetId === request.connectionId) ??
              names.find((n) => n === request.database) ??
              names[0] ??
              ''),
        )
      })
      .catch(() => alive && setSchemas([]))
    return () => {
      alive = false
    }
  }, [targetId, request.connectionId, request.database])

  const run = async (): Promise<void> => {
    setPhase('reading')
    setError(null)
    try {
      const [a, b] = await Promise.all([
        snapshotOf(request.connectionId, request.database),
        snapshotOf(targetId, targetSchema),
      ])
      const found = compareSchemas(a, b, { schema: targetSchema, dialect })
      setChanges(found)
      // What is safe is ticked; a drop has to be ticked on purpose.
      setChosen(
        new Set(found.filter((c) => !c.destructive && c.statements.length > 0).map((c) => c.id)),
      )
      setPhase('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setPhase('failed')
    }
  }

  const script = useMemo(() => scriptOf(changes.filter((c) => chosen.has(c.id))), [changes, chosen])
  const toggle = (id: string, on: boolean): void =>
    setChosen((current) => {
      const next = new Set(current)
      if (on) next.add(id)
      else next.delete(id)
      return next
    })

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-compare"
        role="dialog"
        aria-modal="true"
        aria-labelledby="schema-compare-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header>
          <h2 id="schema-compare-title">Compare schemas</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        <p className="muted export-note">
          Makes the <strong>target</strong> look like <strong>{source?.name}</strong> /{' '}
          <span className="mono">{request.database}</span>. Tables, columns (type and NULL) and
          foreign keys are compared; indexes and defaults are not.
        </p>
        <div className="tool-controls">
          <Field label="Target connection">
            {(id) => (
              <select
                id={id}
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
              >
                {connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field label="Target schema">
            {(id) => (
              <select
                id={id}
                value={targetSchema}
                onChange={(event) => setTargetSchema(event.target.value)}
              >
                {schemas.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Button
            variant="primary"
            disabled={
              phase === 'reading' ||
              targetSchema === '' ||
              (targetId === request.connectionId && targetSchema === request.database)
            }
            onClick={() => void run()}
          >
            Compare
          </Button>
        </div>
        {dialect === null && target ? (
          <p className="muted">
            The two are different kinds of server, so differences are listed but no script is
            written.
          </p>
        ) : null}
        {targetId === request.connectionId && targetSchema === request.database ? (
          <p className="muted">Pick a different schema or connection as the target.</p>
        ) : null}

        {phase === 'reading' ? (
          <p className="export-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden /> Reading both schemas…
          </p>
        ) : null}
        {phase === 'failed' && error ? (
          <p className="note-error" role="alert">
            {error}
          </p>
        ) : null}

        {phase === 'done' ? (
          changes.length === 0 ? (
            <p className="muted tool-empty">No differences found.</p>
          ) : (
            <>
              <div className="tool-scroll compare-scroll">
                <table className="pivot">
                  <tbody>
                    {changes.map((c) => (
                      <tr key={c.id} className={c.destructive ? 'compare-removed' : ''}>
                        <td>
                          <input
                            type="checkbox"
                            aria-label={c.summary}
                            checked={chosen.has(c.id)}
                            disabled={c.statements.length === 0}
                            onChange={(event) => toggle(c.id, event.target.checked)}
                          />
                        </td>
                        <th>{KIND_LABEL[c.kind]}</th>
                        <td>{c.summary}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="muted">
                {changes.length} difference{changes.length === 1 ? '' : 's'}; {chosen.size} in the
                script. Drops are left out until you tick them.
              </p>
              <pre className="dialog-sql mono selectable export-sql" tabIndex={0}>
                {script || '-- Nothing chosen.'}
              </pre>
              <footer>
                <Button
                  variant="ghost"
                  icon={<Copy size={13} />}
                  disabled={script === ''}
                  onClick={() => void writeClipboard(script).then(() => notify('Script copied.'))}
                >
                  Copy
                </Button>
                <Button
                  variant="primary"
                  icon={<FileCode size={13} />}
                  disabled={script === ''}
                  onClick={() => {
                    createScript({
                      connectionId: targetId,
                      database: targetSchema,
                      text: script,
                      name: `sync ${targetSchema}`,
                    })
                    close()
                  }}
                >
                  Open as a script on the target
                </Button>
              </footer>
            </>
          )
        ) : null}
      </div>
    </div>
  )
}
