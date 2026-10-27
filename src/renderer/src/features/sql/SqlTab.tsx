import { AlignLeft, Gauge, History, ListVideo, Lock, LockOpen, Play, Square } from 'lucide-react'
import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Button, EnvBadge, EngineIcon, IconButton, Kbd } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useDialogs } from '@/state/dialogs'
import { useScripts } from '@/state/scripts'
import type { Tab } from '@/state/workbench'
import { cancelFromEditor, runFromEditor, setWritable, showQueryPlan } from './actions'
import { SchemaStatusChip } from './completion/SchemaStatus'
import { MongoEditor } from './editor/MongoEditor'
import { SqlEditor } from './editor/SqlEditor'
import { editorFor } from './editor/handles'
import { moveScriptToConnection, renameScript, setScriptDatabase } from './library'
import { isBusy } from './runs'
import { ResultsPane } from './ResultsPane'
import { extensionOf } from './statements'

/** Databases on a connection, for the toolbar's picker. Cached per connection for the session. */
const databaseCache = new Map<string, Promise<string[]>>()

function useDatabases(connectionId: string): string[] {
  const [names, setNames] = useState<string[]>([])
  useEffect(() => {
    let cancelled = false
    let pending = databaseCache.get(connectionId)
    if (!pending) {
      pending = coreLink
        .call('tree.children', { connectionId, parent: null })
        .then((nodes) => nodes.filter((n) => n.kind === 'database').map((n) => n.label))
      databaseCache.set(connectionId, pending)
      pending.catch(() => databaseCache.delete(connectionId))
    }
    pending.then((result) => !cancelled && setNames(result)).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [connectionId])
  return names
}

/** The script's file name. Click it to rename the file. */
function ScriptName({ scriptId }: { scriptId: string }) {
  const name = useScripts((state) => state.scripts[scriptId]?.name ?? '')
  const extension = useScripts((state) => extensionOf(state.scripts[scriptId]?.language ?? 'sql'))
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(name)

  const commit = async (): Promise<void> => {
    const next = draft.trim()
    if (next === '' || next === name) return setEditing(false)
    if (await renameScript(scriptId, next)) setEditing(false)
  }

  if (editing) {
    return (
      <input
        className="mono script-name-input"
        aria-label="Script name"
        value={draft}
        autoFocus
        onFocus={(event) => event.currentTarget.select()}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void commit()
          else if (event.key === 'Escape') setEditing(false)
          else return
          event.preventDefault()
          event.stopPropagation()
        }}
      />
    )
  }
  return (
    <button
      type="button"
      className="script-name"
      title="Rename this script’s file"
      onClick={() => {
        setDraft(name)
        setEditing(true)
      }}
    >
      <span>{name}</span>
      <span className="muted">{extension}</span>
    </button>
  )
}

/** Whether the text is safe in its file. Quiet when all is well. */
function SaveState({ scriptId }: { scriptId: string }) {
  const state = useScripts((s) => s.scripts[scriptId]?.saveState ?? 'saved')
  const error = useScripts((s) => s.scripts[scriptId]?.saveError ?? null)
  return (
    <span
      className={`save-state save-${state}`}
      role="status"
      title={error ?? (state === 'saved' ? 'Saved to its file' : undefined)}
    >
      {state === 'saving' ? 'Saving…' : state === 'error' ? 'Not saved' : 'Saved'}
    </span>
  )
}

export function SqlTab({ tab, active }: { tab: Tab; active: boolean }) {
  const scriptId = tab.scriptId!
  const script = useScripts((state) => state.scripts[scriptId])
  const connection = useData((state) =>
    state.connections.find((c) => c.id === script?.connectionId),
  )
  const connections = useData((state) => state.connections)
  const databases = useDatabases(script?.connectionId ?? '')

  const [editorShare, setEditorShare] = useState(0.45)
  const split = useRef<HTMLDivElement>(null)

  if (!script || !connection) return null
  const busy = isBusy(script.run)
  const isMongo = script.language === 'mongodb'
  const sameEngine = connections.filter((c) => c.engine === connection.engine)
  const databaseOptions =
    script.database && !databases.includes(script.database)
      ? [script.database, ...databases]
      : databases

  const dragSplitter = (): void => {
    const onMove = (event: MouseEvent): void => {
      const box = split.current?.getBoundingClientRect()
      if (!box) return
      setEditorShare(Math.min(0.8, Math.max(0.15, (event.clientY - box.top) / box.height)))
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  const onSplitterKey = (event: KeyboardEvent): void => {
    if (event.key === 'ArrowUp') setEditorShare((s) => Math.max(0.15, s - 0.03))
    else if (event.key === 'ArrowDown') setEditorShare((s) => Math.min(0.8, s + 0.03))
    else return
    event.preventDefault()
  }

  return (
    <div className="sql-tab">
      <div className="sql-toolbar" role="toolbar" aria-label={isMongo ? 'MongoDB script' : 'SQL'}>
        {busy ? (
          <Button
            variant="danger"
            icon={<Square size={13} />}
            onClick={() => cancelFromEditor(scriptId)}
          >
            Cancel
            <Kbd shortcut="Mod+." />
          </Button>
        ) : (
          <>
            <Button
              variant="primary"
              icon={<Play size={13} />}
              onClick={() => runFromEditor(scriptId, 'cursor')}
            >
              Run
              <Kbd shortcut="Mod+Enter" />
            </Button>
            <Button
              icon={<ListVideo size={14} />}
              onClick={() => runFromEditor(scriptId, 'all')}
              title="Run the whole script"
            >
              Run script
            </Button>
          </>
        )}
        {isMongo ? null : (
          <IconButton label="Format SQL" onClick={() => void editorFor(scriptId)?.format()}>
            <AlignLeft size={15} />
          </IconButton>
        )}
        {connection.engine === 'mysql' ? (
          <IconButton label="Show the query plan" onClick={() => showQueryPlan(scriptId)}>
            <Gauge size={15} />
          </IconButton>
        ) : null}

        <span className="spacer" />

        <ScriptName scriptId={scriptId} />
        {isMongo ? null : (
          <SchemaStatusChip connectionId={connection.id} database={script.database} />
        )}
        <SaveState scriptId={scriptId} />
        <IconButton
          label="Local history: earlier versions of this script"
          onClick={() => useDialogs.getState().openLocalHistory(scriptId)}
        >
          <History size={15} />
        </IconButton>

        <span className="sql-context">
          <EngineIcon engine={connection.engine} />
          {sameEngine.length > 1 ? (
            <select
              className="sql-database sql-connection"
              aria-label="Connection"
              value={connection.id}
              onChange={(event) => void moveScriptToConnection(scriptId, event.target.value)}
            >
              {sameEngine.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          ) : (
            <span>{connection.name}</span>
          )}
          <EnvBadge environment={connection.environment} />
        </span>
        <select
          className="sql-database"
          aria-label="Database"
          value={script.database ?? ''}
          onChange={(event) => setScriptDatabase(scriptId, event.target.value || null)}
        >
          <option value="">{isMongo ? 'No database selected' : 'No database'}</option>
          {databaseOptions.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
        <Button
          variant={script.writable ? 'default' : 'ghost'}
          className={script.writable ? 'writable-on' : 'writable-off'}
          icon={script.writable ? <LockOpen size={14} /> : <Lock size={14} />}
          aria-pressed={script.writable}
          title={
            script.writable
              ? 'Writes are allowed. Click to lock.'
              : 'Read-only. Click to allow writes.'
          }
          onClick={() => void setWritable(scriptId, !script.writable)}
        >
          {script.writable ? 'Writable' : 'Read-only'}
        </Button>
      </div>

      <div
        className="sql-split"
        ref={split}
        style={{ gridTemplateRows: `${editorShare}fr 7px ${1 - editorShare}fr` }}
      >
        {isMongo ? (
          <MongoEditor
            scriptId={scriptId}
            connectionId={script.connectionId}
            database={script.database}
            active={active}
          />
        ) : (
          <SqlEditor
            scriptId={scriptId}
            connectionId={script.connectionId}
            database={script.database}
            active={active}
          />
        )}
        <div
          className="splitter"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize results"
          tabIndex={0}
          onMouseDown={dragSplitter}
          onKeyDown={onSplitterKey}
        />
        <ResultsPane scriptId={scriptId} active={active} />
      </div>
    </div>
  )
}
