import {
  Copy,
  FileCode,
  FolderOpen,
  Import,
  Pencil,
  Plus,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ScriptInfo } from '@shared/scripts'
import { Button, EnvDot, IconButton } from '@/components/ui'
import {
  deleteScript,
  duplicateScript,
  importScripts,
  renameScript,
  revealScripts,
} from '@/features/sql/library'
import { createScript, openSavedScript } from '@/features/sql/scripts'
import { defaultConnectionId } from '@/features/sql/target'
import { useData } from '@/state/data'
import { useLibrary } from '@/state/library'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { workbench } from '@/state/workbench'
import { timeAgo } from '@/lib/time'

/** Every script in the scripts folder, newest first. Opening one puts it in a tab. */
export function ScriptsPanel() {
  const scripts = useLibrary((state) => state.scripts)
  const loaded = useLibrary((state) => state.loaded)
  const error = useLibrary((state) => state.error)
  const connections = useData((state) => state.connections)
  const openIds = useScripts((state) => state.scripts)
  const [filter, setFilter] = useState('')
  const [renaming, setRenaming] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const list = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const refresh = (): void => void useLibrary.getState().refresh()
    refresh()
    // Files dropped into the folder (or deleted from it) show up when the window is used again.
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])

  const connectionName = (id: string | null): string | null =>
    id ? (connections.find((c) => c.id === id)?.name ?? null) : null

  const visible = useMemo(() => {
    const needle = filter.trim().toLowerCase()
    const sorted = [...scripts].sort((a, b) => b.updatedAt - a.updatedAt)
    if (!needle) return sorted
    return sorted.filter((s) =>
      `${s.name} ${connectionName(s.connectionId) ?? ''} ${s.database ?? ''}`
        .toLowerCase()
        .includes(needle),
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scripts, filter, connections])

  const newScript = (): void => {
    const connectionId = defaultConnectionId()
    if (connectionId) createScript({ connectionId })
    else if (connections.length === 0) workbench.newConnection()
    else notify('Select a connection in the navigator first.')
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement) return
    const items = [...(list.current?.querySelectorAll<HTMLElement>('[data-script]') ?? [])]
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'ArrowDown') items[Math.min(items.length - 1, index + 1)]?.focus()
    else if (event.key === 'ArrowUp') items[Math.max(0, index - 1)]?.focus()
    else return
    event.preventDefault()
  }

  return (
    <div className="side-view-inner" role="group" aria-label="Scripts">
      <div className="pane-header">
        <h2>Scripts</h2>
        <span className="pane-actions">
          <IconButton label="New script" onClick={newScript}>
            <Plus size={14} />
          </IconButton>
          <IconButton label="Import script files…" onClick={() => void importScripts()}>
            <Import size={14} />
          </IconButton>
          <IconButton label="Show scripts folder" onClick={() => revealScripts(null)}>
            <FolderOpen size={14} />
          </IconButton>
        </span>
      </div>

      <div className="filter">
        <Search size={13} aria-hidden />
        <input
          type="search"
          placeholder="Filter"
          aria-label="Filter scripts"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {error ? <p className="note-error pad">{error}</p> : null}
      {loaded && scripts.length === 0 ? (
        <div className="empty-state compact">
          <h3>No scripts yet</h3>
          <p>
            Every query tab is saved here as a file (.sql, or .mongodb for MongoDB). Drop files into
            the folder, or import some.
          </p>
        </div>
      ) : null}
      {loaded && scripts.length > 0 && visible.length === 0 ? (
        <p className="muted pad">Nothing matches “{filter}”.</p>
      ) : null}

      <div className="script-list" role="list" ref={list} onKeyDown={onKeyDown}>
        {visible.map((script) => (
          <ScriptRow
            key={script.id}
            script={script}
            connection={connectionName(script.connectionId)}
            environment={connections.find((c) => c.id === script.connectionId)?.environment ?? null}
            open={script.id in openIds}
            renaming={renaming === script.id}
            deleting={deleting === script.id}
            onRename={() => setRenaming(script.id)}
            onRenamed={() => setRenaming(null)}
            onAskDelete={() => setDeleting(script.id)}
            onCancelDelete={() => setDeleting(null)}
            onDelete={() => {
              setDeleting(null)
              void deleteScript(script.id)
            }}
          />
        ))}
      </div>
    </div>
  )
}

interface RowProps {
  script: ScriptInfo
  connection: string | null
  environment: 'local' | 'dev' | 'staging' | 'prod' | null
  open: boolean
  renaming: boolean
  deleting: boolean
  onRename: () => void
  onRenamed: () => void
  onAskDelete: () => void
  onCancelDelete: () => void
  onDelete: () => void
}

function ScriptRow({
  script,
  connection,
  environment,
  open,
  renaming,
  deleting,
  onRename,
  onRenamed,
  onAskDelete,
  onCancelDelete,
  onDelete,
}: RowProps) {
  const [draft, setDraft] = useState(script.name)

  const commitRename = async (): Promise<void> => {
    const name = draft.trim()
    if (name === '' || name === script.name) return onRenamed()
    if (await renameScript(script.id, name)) onRenamed()
  }

  if (renaming) {
    return (
      <div className="script-row script-row-editing" role="listitem">
        <FileCode size={14} aria-hidden />
        <input
          className="mono script-rename"
          aria-label={`New name for ${script.name}`}
          value={draft}
          autoFocus
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={() => void commitRename()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void commitRename()
            else if (event.key === 'Escape') onRenamed()
            else return
            event.preventDefault()
            event.stopPropagation()
          }}
        />
      </div>
    )
  }

  if (deleting) {
    return (
      <div className="script-row script-row-confirm" role="listitem">
        <span className="script-confirm-text">Move “{script.name}” to the trash?</span>
        <Button variant="danger" onClick={onDelete} autoFocus>
          Delete
        </Button>
        <Button variant="ghost" onClick={onCancelDelete}>
          Cancel
        </Button>
      </div>
    )
  }

  return (
    <div
      className={`script-row ${open ? 'open' : ''}`}
      role="listitem"
      tabIndex={0}
      data-script={script.id}
      onKeyDown={(event) => {
        if (event.key === 'Enter') void openSavedScript(script.id)
        else if (event.key === 'F2') onRename()
        else if (event.key === 'Delete' || event.key === 'Backspace') onAskDelete()
        else return
        event.preventDefault()
      }}
      onClick={() => void openSavedScript(script.id)}
    >
      <FileCode size={14} aria-hidden className="script-icon" />
      <span className="script-main">
        <span className="script-name-line">
          <span className="script-title">{script.name}</span>
          {open ? (
            <span className="script-open-dot" title="Open in a tab" aria-label="Open" />
          ) : null}
        </span>
        <span className="script-sub muted">
          {environment ? <EnvDot environment={environment} /> : null}
          {connection ? (
            <span>
              {connection}
              {script.database ? ` · ${script.database}` : ''}
            </span>
          ) : (
            <span className="script-orphan">
              <TriangleAlert size={11} aria-hidden /> No connection
            </span>
          )}
          <span>· {script.missing ? 'file missing' : timeAgo(script.updatedAt)}</span>
        </span>
      </span>
      <span className="row-actions">
        <IconButton
          label={`Rename ${script.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onRename()
          }}
        >
          <Pencil size={12} />
        </IconButton>
        <IconButton
          label={`Duplicate ${script.name}`}
          onClick={(event) => {
            event.stopPropagation()
            void duplicateScript(script.id)
          }}
        >
          <Copy size={12} />
        </IconButton>
        <IconButton
          label={`Show ${script.name} in the file manager`}
          onClick={(event) => {
            event.stopPropagation()
            revealScripts(script.id)
          }}
        >
          <FolderOpen size={12} />
        </IconButton>
        <IconButton
          label={`Delete ${script.name}`}
          onClick={(event) => {
            event.stopPropagation()
            onAskDelete()
          }}
        >
          <Trash2 size={12} />
        </IconButton>
      </span>
    </div>
  )
}
