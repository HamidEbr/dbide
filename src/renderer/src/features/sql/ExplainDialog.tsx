import { LoaderCircle, TriangleAlert, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { parsePlan, warningText, type Plan } from '@shared/explain'
import { RpcError } from '@shared/rpc'
import { Button, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { useDialogs, type ExplainRequest } from '@/state/dialogs'

const ACCESS_HINT: Record<string, string> = {
  'Seq Scan': 'Reads the whole table',
  'Index Scan': 'Looks rows up by an index',
  'Index Only Scan': 'Reads only the index',
  'Bitmap Heap Scan': 'Reads the rows an index pointed at, page by page',
  ALL: 'Reads the whole table',
  index: 'Reads the whole index',
  range: 'Reads a range of an index',
  ref: 'Looks rows up by an index',
  eq_ref: 'Looks up one row by a unique index',
  const: 'Reads one row, known up front',
  system: 'A table with one row',
  fulltext: 'Full-text index',
  index_merge: 'Combines several indexes',
}

/** How bad an access type is, for its colour: a whole-table read is the one to look at. */
const accessTone = (access: string | undefined): 'bad' | 'warn' | 'good' =>
  access === 'ALL' || access === 'Seq Scan'
    ? 'bad'
    : access === 'index' || access === 'index_merge' || access === 'Bitmap Heap Scan'
      ? 'warn'
      : 'good'

const number = (n: number): string => Math.round(n).toLocaleString()

export function ExplainDialog() {
  const request = useDialogs((state) => state.explain)
  if (!request) return null
  return <ExplainBody request={request} />
}

type Mode = 'plan' | 'analyze'

function ExplainBody({ request }: { request: ExplainRequest }) {
  const close = useDialogs((state) => state.closeExplain)
  const [mode, setMode] = useState<Mode>('plan')
  const [state, setState] = useState<
    | { phase: 'loading' }
    | { phase: 'failed'; message: string }
    | { phase: 'plan'; plan: Plan }
    | { phase: 'text'; text: string }
  >({ phase: 'loading' })

  useEffect(() => {
    const abort = new AbortController()
    coreLink
      .call(
        'query.explain',
        {
          connectionId: request.connectionId,
          database: request.database,
          sql: request.sql,
          analyze: mode === 'analyze',
        },
        { signal: abort.signal },
      )
      .then((result) => {
        if (result.json !== null) {
          const plan = parsePlan(result.json)
          setState(
            plan
              ? { phase: 'plan', plan }
              : { phase: 'failed', message: 'The server answered with a plan DBIDE can’t read.' },
          )
        } else if (result.text !== null) {
          setState({ phase: 'text', text: result.text })
        } else {
          setState({ phase: 'failed', message: 'The server did not return a plan.' })
        }
      })
      .catch((e: unknown) => {
        if (abort.signal.aborted) return
        setState({
          phase: 'failed',
          message: e instanceof RpcError || e instanceof Error ? e.message : String(e),
        })
      })
    return () => abort.abort()
  }, [request, mode])

  const plan = state.phase === 'plan' ? state.plan : null
  const warned = plan ? plan.steps.filter((s) => s.warnings.length > 0).length : 0
  const widest = plan ? Math.max(1, ...plan.steps.map((s) => s.rowsExamined ?? 0)) : 1

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-explain"
        role="dialog"
        aria-modal="true"
        aria-labelledby="explain-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header>
          <h2 id="explain-title">Query plan</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        <pre className="dialog-sql mono selectable export-sql" tabIndex={0}>
          {request.sql}
        </pre>
        <Segmented<Mode>
          label="Plan"
          value={mode}
          options={[
            { value: 'plan', label: 'Estimated plan' },
            { value: 'analyze', label: 'Run and time it' },
          ]}
          onChange={(next) => {
            setState({ phase: 'loading' })
            setMode(next)
          }}
        />
        {mode === 'analyze' ? (
          <p className="muted export-note">
            The query really runs, once, on its own connection that can’t write, and the server
            reports how long each step took.
          </p>
        ) : null}

        {state.phase === 'loading' ? (
          <p className="export-progress" role="status">
            <LoaderCircle size={14} className="spin" aria-hidden /> Asking the server…
          </p>
        ) : null}
        {state.phase === 'failed' ? (
          <p className="note-error" role="alert">
            {state.message}
          </p>
        ) : null}
        {state.phase === 'text' ? (
          <pre className="explain-text mono selectable" tabIndex={0}>
            {state.text}
          </pre>
        ) : null}

        {plan ? (
          <>
            <p className="explain-summary">
              {plan.cost !== null ? (
                <span>
                  Estimated cost <strong>{number(plan.cost)}</strong>
                </span>
              ) : null}
              <span className={warned > 0 ? 'explain-warn' : 'muted'}>
                {warned > 0
                  ? `${warned} step${warned === 1 ? '' : 's'} worth a look`
                  : 'Nothing stands out'}
              </span>
            </p>
            <ol className="explain-steps">
              {plan.steps.map((step, i) => (
                <li
                  key={i}
                  className={`explain-step explain-${step.kind}`}
                  style={{ paddingLeft: 8 + step.depth * 18 }}
                >
                  <div className="explain-head">
                    <strong className={step.kind === 'table' ? 'mono' : ''}>{step.title}</strong>
                    {step.access ? (
                      <span
                        className={`explain-chip explain-${accessTone(step.access)}`}
                        title={ACCESS_HINT[step.access]}
                      >
                        {step.access}
                      </span>
                    ) : null}
                    {step.key ? (
                      <span className="muted mono">index {step.key}</span>
                    ) : step.kind === 'table' ? (
                      <span className="muted">no index</span>
                    ) : null}
                    <span className="spacer" />
                    {step.rowsExamined !== undefined ? (
                      <span className="muted">{number(step.rowsExamined)} rows read</span>
                    ) : null}
                    {step.cost !== undefined ? (
                      <span className="muted">cost {number(step.cost)}</span>
                    ) : null}
                  </div>
                  {step.rowsExamined !== undefined ? (
                    <div className="explain-bar" aria-hidden>
                      <span
                        className={`explain-${accessTone(step.access)}`}
                        style={{ width: `${Math.max(1, (step.rowsExamined / widest) * 100)}%` }}
                      />
                    </div>
                  ) : null}
                  {step.condition ? (
                    <div className="mono muted explain-cond">{step.condition}</div>
                  ) : null}
                  {step.warnings.map((w) => (
                    <div key={w} className="explain-warn explain-note">
                      <TriangleAlert size={12} aria-hidden /> {warningText(w)}
                      {w === 'full-scan' && step.possibleKeys
                        ? `. Indexes it could use: ${step.possibleKeys.join(', ')}`
                        : ''}
                    </div>
                  ))}
                </li>
              ))}
            </ol>
          </>
        ) : null}

        <footer>
          <Button variant="primary" onClick={close} autoFocus>
            Close
          </Button>
        </footer>
      </div>
    </div>
  )
}
