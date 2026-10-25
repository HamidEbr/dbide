import {
  Ban,
  CircleAlert,
  CircleCheck,
  CircleMinus,
  CirclePause,
  Download,
  LoaderCircle,
} from 'lucide-react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { DOCUMENT_RESIDENT_ROWS, isDocumentResult } from '@shared/mongo/documents'
import { MAX_ROWS_PER_RESULT, DEFAULT_PAGE_SIZE, RESIDENT_ROWS } from '@shared/query'
import { Button } from '@/components/ui'
import {
  useScripts,
  type ResultSet,
  type ScriptRun,
  type StatementRun,
  type StatementStatus,
} from '@/state/scripts'
import { DocumentResult } from '@/features/mongo/DocumentResult'
import { registerExporter } from './export/handles'
import { exportBlockedReason, openExport } from './export/open'
import { ResultGrid } from './grid/ResultGrid'
import { loadMore } from './runs'

interface ResultTab {
  key: string
  label: string
  statement: StatementRun
  resultSet: ResultSet | null
}

const STATUS_ICON: Record<StatementStatus, React.ReactNode> = {
  queued: <CircleMinus size={13} aria-label="Waiting" />,
  running: <LoaderCircle size={13} className="spin" aria-label="Running" />,
  paused: <CirclePause size={13} aria-label="More rows available" />,
  done: <CircleCheck size={13} className="step-ok" aria-label="Done" />,
  error: <CircleAlert size={13} className="step-failed" aria-label="Failed" />,
  cancelled: <Ban size={13} aria-label="Cancelled" />,
  skipped: <CircleMinus size={13} aria-label="Skipped" />,
}

/** One line of SQL for a tab label. */
function oneLine(sql: string, max = 26): string {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

function tabsOf(run: ScriptRun): ResultTab[] {
  return run.statements.flatMap<ResultTab>((statement) => {
    const base = `${statement.index + 1}`
    if (statement.resultSets.length > 0) {
      return statement.resultSets.map((resultSet, i) => ({
        key: resultSet.id,
        label:
          statement.resultSets.length > 1
            ? `${base}.${i + 1} ${oneLine(statement.sql, 18)}`
            : oneLine(statement.sql),
        statement,
        resultSet,
      }))
    }
    return [
      { key: `${statement.index}`, label: oneLine(statement.sql), statement, resultSet: null },
    ]
  })
}

function plural(count: number, word: string): string {
  return `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`
}

/** Row count and actions for a result set. Re-renders as rows stream in. */
function ResultSummary({
  scriptId,
  statement,
  resultSet,
}: {
  scriptId: string
  statement: StatementRun
  resultSet: ResultSet
}) {
  useSyncExternalStore(resultSet.store.subscribe, resultSet.store.getVersion)
  const loaded = resultSet.store.length
  // A MongoDB result is documents, not rows, and has no SQL to export.
  const documents = isDocumentResult(resultSet.columns)
  const noun = documents ? 'document' : 'row'

  let status: React.ReactNode
  switch (statement.status) {
    case 'running':
      status = (
        <>
          <LoaderCircle size={14} className="spin" aria-hidden /> Fetching… {plural(loaded, noun)}
        </>
      )
      break
    case 'paused':
      status = <>{plural(loaded, noun)} loaded, more available</>
      break
    case 'cancelled':
      status = <>Cancelled after {plural(loaded, noun)}</>
      break
    case 'error':
      status = <>Failed after {plural(loaded, noun)}</>
      break
    default:
      status = (
        <>
          {plural(loaded, noun)}
          {statement.durationMs !== null ? ` · ${statement.durationMs.toLocaleString()} ms` : ''}
        </>
      )
  }

  return (
    <div className="result-summary">
      <span>{status}</span>
      {statement.status === 'paused' ? (
        <>
          <Button onClick={() => loadMore(scriptId, statement.index, DEFAULT_PAGE_SIZE)}>
            Load {DEFAULT_PAGE_SIZE.toLocaleString()} more
          </Button>
          <Button onClick={() => loadMore(scriptId, statement.index, 'all')}>Load all</Button>
        </>
      ) : null}
      {resultSet.store.spilled > 0 ? (
        <span
          className="muted"
          title={`${noun === 'row' ? 'Rows' : 'Documents'} past the first ${(documents ? DOCUMENT_RESIDENT_ROWS : RESIDENT_ROWS).toLocaleString()} are read from disk as you scroll.`}
        >
          Large result · read-only
        </span>
      ) : null}
      {statement.truncated ? (
        <span className="note-warn-inline">
          {documents
            ? `Stopped at ${MAX_ROWS_PER_RESULT.toLocaleString()} documents. Narrow the filter or add a limit.`
            : `Stopped at ${MAX_ROWS_PER_RESULT.toLocaleString()} rows. Narrow the query or add a LIMIT. Export has no row limit.`}
        </span>
      ) : null}
      <span className="spacer" />
      {documents ? null : (
        <Button
          variant="ghost"
          icon={<Download size={12} />}
          disabled={exportBlockedReason(statement) !== null}
          title={exportBlockedReason(statement) ?? 'Export every row of this query to a file'}
          onClick={() => openExport(scriptId, statement, resultSet)}
        >
          Export…
        </Button>
      )}
    </div>
  )
}

/** Lets the "Export result" command reach the result this pane is showing. */
function ExporterRegistration({
  scriptId,
  statement,
  resultSet,
}: {
  scriptId: string
  statement: StatementRun
  resultSet: ResultSet
}) {
  useEffect(() => {
    if (exportBlockedReason(statement)) return
    return registerExporter(scriptId, () => openExport(scriptId, statement, resultSet))
  }, [scriptId, statement, resultSet])
  return null
}

function Message({ tab }: { tab: ResultTab }) {
  const { statement } = tab
  switch (statement.status) {
    case 'error':
      return (
        <div className="result-message result-error" role="alert">
          <h3>
            <CircleAlert size={16} aria-hidden />{' '}
            {statement.error?.code === 'READ_ONLY'
              ? 'Not run'
              : `Statement ${statement.index + 1} failed`}
          </h3>
          <p className="selectable mono">{statement.error?.message}</p>
          {statement.error?.code ? <p className="muted">{statement.error.code}</p> : null}
        </div>
      )
    case 'skipped':
      return (
        <div className="result-message">
          <p className="muted">
            Skipped because an earlier statement failed or the run was cancelled.
          </p>
        </div>
      )
    case 'cancelled':
      return (
        <div className="result-message">
          <p>Cancelled.</p>
        </div>
      )
    case 'queued':
      return (
        <div className="result-message">
          <p className="muted">Waiting for the previous statement.</p>
        </div>
      )
    case 'running':
      return (
        <div className="result-message">
          <p>
            <LoaderCircle size={14} className="spin" aria-hidden /> Running…
          </p>
        </div>
      )
    default: {
      const ok = statement.ok
      return (
        <div className="result-message">
          <h3>
            <CircleCheck size={16} className="step-ok" aria-hidden />{' '}
            {ok ? `${plural(ok.affectedRows, 'row')} affected` : 'Done'}
            {statement.durationMs !== null ? ` · ${statement.durationMs.toLocaleString()} ms` : ''}
          </h3>
          {ok?.message ? <p className="selectable mono">{ok.message}</p> : null}
          {ok?.insertId ? <p className="muted">Last insert id {ok.insertId}</p> : null}
          {ok && ok.warnings > 0 ? (
            <p className="note-warn-inline">{plural(ok.warnings, 'warning')}</p>
          ) : null}
        </div>
      )
    }
  }
}

export function ResultsPane({
  scriptId,
  active: tabActive,
}: {
  scriptId: string
  active: boolean
}) {
  const run = useScripts((state) => state.scripts[scriptId]?.run ?? null)
  const [choice, setChoice] = useState<{ runId: string; key: string } | null>(null)

  if (!run) {
    return (
      <div className="results results-empty">
        <p className="muted">Results appear here. Run a statement to see them stream in.</p>
      </div>
    )
  }

  const tabs = tabsOf(run)
  // Follow the statement that is running, unless the user picked a tab during this run.
  const latest = [...tabs]
    .reverse()
    .find((t) => t.statement.status !== 'queued' && t.statement.status !== 'skipped')
  const chosen = choice?.runId === run.runId ? tabs.find((t) => t.key === choice.key) : undefined
  const active = chosen ?? latest ?? tabs[0]

  return (
    <div className="results">
      <div className="result-tabs" role="tablist" aria-label="Results">
        {tabs.map((tab) => (
          <button
            key={tab.key}
            type="button"
            role="tab"
            aria-selected={tab.key === active?.key}
            className={`result-tab ${tab.key === active?.key ? 'active' : ''}`}
            onClick={() => setChoice({ runId: run.runId, key: tab.key })}
            title={tab.statement.sql}
          >
            {STATUS_ICON[tab.statement.status]}
            <span className="mono">{tab.label}</span>
          </button>
        ))}
        {run.state === 'cancelling' ? (
          <span className="muted result-state">Cancelling…</span>
        ) : null}
      </div>

      {active?.resultSet ? (
        <div className="result-body">
          {tabActive && !isDocumentResult(active.resultSet.columns) ? (
            <ExporterRegistration
              scriptId={scriptId}
              statement={active.statement}
              resultSet={active.resultSet}
            />
          ) : null}
          <ResultSummary
            scriptId={scriptId}
            statement={active.statement}
            resultSet={active.resultSet}
          />
          {isDocumentResult(active.resultSet.columns) ? (
            <DocumentResult
              key={active.resultSet.id}
              resultSet={active.resultSet}
              scriptId={scriptId}
              statement={active.statement}
              active={tabActive}
            />
          ) : (
            <ResultGrid
              key={active.resultSet.id}
              resultSet={active.resultSet}
              scriptId={scriptId}
              statement={active.statement}
              active={tabActive}
            />
          )}
        </div>
      ) : active ? (
        <Message tab={active} />
      ) : null}
    </div>
  )
}
