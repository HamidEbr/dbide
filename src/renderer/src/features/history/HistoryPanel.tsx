import {
  Ban,
  CircleAlert,
  CircleCheck,
  Copy,
  CornerDownLeft,
  FileCode,
  Search,
  Trash2,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import { CoreEvents } from '@shared/api'
import type { HistoryEntry } from '@shared/scripts'
import { EnvDot, IconButton, Segmented } from '@/components/ui'
import { activeScriptId } from '@/features/sql/actions'
import { editorFor } from '@/features/sql/editor/handles'
import { createScript } from '@/features/sql/scripts'
import { clockTime, dayLabel } from '@/lib/time'
import { writeClipboard } from '@/lib/clipboard'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useHistory } from '@/state/history'
import { notify } from '@/state/notices'

const oneLine = (sql: string, max = 140): string => {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function Outcome({ entry }: { entry: HistoryEntry }) {
  if (entry.status === 'error')
    return <CircleAlert size={13} className="step-failed" aria-label="Failed" />
  if (entry.status === 'cancelled') return <Ban size={13} aria-label="Cancelled" />
  return <CircleCheck size={13} className="step-ok" aria-label="Succeeded" />
}

function detailOf(entry: HistoryEntry): string {
  const parts: string[] = []
  if (entry.durationMs !== null) parts.push(`${entry.durationMs.toLocaleString()} ms`)
  if (entry.affected !== null) parts.push(`${entry.affected.toLocaleString()} affected`)
  else if (entry.rows !== null)
    parts.push(`${entry.rows.toLocaleString()} row${entry.rows === 1 ? '' : 's'}`)
  return parts.join(' · ')
}

/** Every statement that was run, newest first. Find one again, then reuse it. */
export function HistoryPanel() {
  const state = useHistory()
  const connections = useData((s) => s.connections)
  const [open, setOpen] = useState<number | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [typed, setTyped] = useState(state.search)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    void useHistory.getState().reload()
    return coreLink.on(CoreEvents.historyChanged, () => void useHistory.getState().reload())
  }, [])

  const onSearch = (value: string): void => {
    setTyped(value)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => useHistory.getState().setFilters({ search: value }), 200)
  }

  const reuse = (entry: HistoryEntry): void => {
    const connection = connections.find((c) => c.id === entry.connectionId)
    if (!connection) {
      notify(`“${entry.connectionName}” no longer exists. Copy the statement instead.`)
      return
    }
    createScript({
      connectionId: connection.id,
      database: entry.database,
      text: entry.sql.endsWith(';') ? entry.sql : `${entry.sql};`,
    })
  }

  const insert = (entry: HistoryEntry): void => {
    const id = activeScriptId()
    const editor = id ? editorFor(id) : undefined
    if (!editor) return notify('Open a SQL tab first.')
    editor.insertAtCursor(entry.sql.endsWith(';') ? entry.sql : `${entry.sql};`)
  }

  const copy = (entry: HistoryEntry): void => {
    void writeClipboard(entry.sql).then(() => notify('Copied the statement.'))
  }

  // Each entry knows whether it starts a new day, so the list can show a heading there.
  const rows = state.entries.map((entry, index) => {
    const day = dayLabel(entry.ranAt)
    const previous = state.entries[index - 1]
    return { entry, heading: previous && dayLabel(previous.ranAt) === day ? null : day }
  })

  return (
    <div className="side-view-inner" role="group" aria-label="Query history">
      <div className="pane-header">
        <h2>History</h2>
        {confirmClear ? (
          <span className="history-confirm">
            <span>Clear {state.connectionId ? 'this connection’s' : 'all'} history?</span>
            <button
              type="button"
              className="link-btn danger"
              onClick={() => {
                setConfirmClear(false)
                void useHistory.getState().clear(state.connectionId ?? undefined)
              }}
            >
              Clear
            </button>
            <button type="button" className="link-btn" onClick={() => setConfirmClear(false)}>
              Cancel
            </button>
          </span>
        ) : (
          <IconButton
            label="Clear history"
            disabled={state.entries.length === 0 && !state.search && !state.connectionId}
            onClick={() => setConfirmClear(true)}
          >
            <Trash2 size={14} />
          </IconButton>
        )}
      </div>

      <div className="filter">
        <Search size={13} aria-hidden />
        <input
          type="search"
          placeholder="Search statements"
          aria-label="Search history"
          value={typed}
          onChange={(event) => onSearch(event.target.value)}
        />
      </div>
      <div className="history-filters">
        <select
          aria-label="Connection"
          value={state.connectionId ?? ''}
          onChange={(event) => state.setFilters({ connectionId: event.target.value || null })}
        >
          <option value="">All connections</option>
          {connections.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <Segmented<'all' | 'error'>
          label="Show"
          value={state.status}
          options={[
            { value: 'all', label: 'All' },
            { value: 'error', label: 'Errors' },
          ]}
          onChange={(status) => state.setFilters({ status })}
        />
      </div>

      {state.error ? <p className="note-error pad">{state.error}</p> : null}
      {!state.loading && state.entries.length === 0 && !state.error ? (
        <div className="empty-state compact">
          <h3>
            {state.search || state.connectionId || state.status === 'error'
              ? 'No matches'
              : 'Nothing run yet'}
          </h3>
          <p>Statements you run show up here, so you can find and reuse them.</p>
        </div>
      ) : null}

      <div className="history-list" role="list">
        {rows.map(({ entry, heading }) => {
          const expanded = open === entry.id
          const environment = entry.environment
          return (
            <Fragment key={entry.id}>
              {heading ? <h3 className="history-day">{heading}</h3> : null}
              <div
                className={`history-item ${expanded ? 'open' : ''} status-${entry.status}`}
                role="listitem"
                tabIndex={0}
                data-history={entry.id}
                onClick={() => setOpen(expanded ? null : entry.id)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') reuse(entry)
                  else if (event.key === ' ') setOpen(expanded ? null : entry.id)
                  else return
                  event.preventDefault()
                }}
              >
                <div className="history-line">
                  <Outcome entry={entry} />
                  <span className="history-sql mono">{oneLine(entry.sql)}</span>
                  <span className="row-actions">
                    <IconButton
                      label="Open in a new script"
                      onClick={(event) => {
                        event.stopPropagation()
                        reuse(entry)
                      }}
                    >
                      <FileCode size={12} />
                    </IconButton>
                    <IconButton
                      label="Insert into the current script"
                      onClick={(event) => {
                        event.stopPropagation()
                        insert(entry)
                      }}
                    >
                      <CornerDownLeft size={12} />
                    </IconButton>
                    <IconButton
                      label="Copy the statement"
                      onClick={(event) => {
                        event.stopPropagation()
                        copy(entry)
                      }}
                    >
                      <Copy size={12} />
                    </IconButton>
                    <IconButton
                      label="Remove from history"
                      onClick={(event) => {
                        event.stopPropagation()
                        void useHistory.getState().remove(entry.id)
                      }}
                    >
                      <X size={12} />
                    </IconButton>
                  </span>
                </div>
                <div className="history-meta muted">
                  <EnvDot environment={environment} />
                  <span className="history-conn">
                    {entry.connectionName}
                    {entry.database ? ` · ${entry.database}` : ''}
                  </span>
                  <span>{clockTime(entry.ranAt)}</span>
                  {detailOf(entry) ? <span>{detailOf(entry)}</span> : null}
                </div>
                {expanded ? (
                  <div className="history-detail">
                    <pre className="mono selectable">{entry.sql}</pre>
                    {entry.sqlTruncated ? (
                      <p className="note-warn-inline">
                        Only the start of this long statement is kept.
                      </p>
                    ) : null}
                    {entry.errorMessage ? (
                      <p className="history-error selectable">
                        {entry.errorMessage}
                        {entry.errorCode ? ` (${entry.errorCode})` : ''}
                      </p>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </Fragment>
          )
        })}
        {state.hasMore ? (
          <button
            type="button"
            className="history-more"
            disabled={state.loading}
            onClick={() => void useHistory.getState().loadMore()}
          >
            {state.loading ? 'Loading…' : 'Show older'}
          </button>
        ) : null}
      </div>
    </div>
  )
}
