import { X } from 'lucide-react'
import { useMemo, useState } from 'react'
import type { Cell } from '@shared/query'
import { Button, IconButton } from '@/components/ui'
import { useDialogs, type CompareRequest } from '@/state/dialogs'
import { useScripts } from '@/state/scripts'
import { displayCell } from '../grid/format'
import { compareResults, MAX_COMPARED_ROWS, type DiffStatus } from './compare'
import { useSnapshots } from './snapshots'

interface Side {
  id: string
  label: string
  columns: string[]
  rows: Cell[][]
}

const MAX_SHOWN = 1000
const STATUS_LABEL: Record<DiffStatus, string> = {
  same: 'Same',
  changed: 'Changed',
  added: 'Only in the second',
  removed: 'Only in the first',
}

const oneLine = (sql: string, max = 40): string => {
  const flat = sql.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

export function CompareDialog() {
  const request = useDialogs((state) => state.compare)
  if (!request) return null
  return <CompareBody request={request} />
}

function CompareBody({ request }: { request: CompareRequest }) {
  const close = useDialogs((state) => state.closeCompare)
  const run = useScripts((state) => state.scripts[request.scriptId]?.run ?? null)
  const snapshots = useSnapshots((state) => state.snapshots)

  // Every result of this script's last run, and the copies kept, as things to compare.
  const sides = useMemo<Side[]>(() => {
    const current: Side[] = (run?.statements ?? []).flatMap((s) =>
      s.resultSets.map((r) => ({
        id: r.id,
        label: `${oneLine(s.sql)} (this run)`,
        columns: r.columns.map((c) => c.name),
        rows: r.store.rows,
      })),
    )
    const kept: Side[] = snapshots.map((s) => ({
      id: s.id,
      label: `${s.label} (kept ${new Date(s.keptAt).toLocaleTimeString()})`,
      columns: s.columns,
      rows: s.rows,
    }))
    return [...current, ...kept]
  }, [run, snapshots])

  const [firstId, setFirstId] = useState(request.resultSetId)
  const [secondId, setSecondId] = useState<string>(
    () => sides.find((s) => s.id !== request.resultSetId)?.id ?? '',
  )
  const first = sides.find((s) => s.id === firstId)
  const second = sides.find((s) => s.id === secondId)

  const shared = useMemo(
    () =>
      first && second
        ? first.columns.filter((c) =>
            second.columns.some((d) => d.toLowerCase() === c.toLowerCase()),
          )
        : [],
    [first, second],
  )
  const [chosenKeys, setChosenKeys] = useState<string[] | null>(null)
  const keys = useMemo(
    () =>
      chosenKeys ?? (shared.length > 0 ? [shared.find((c) => /^id$/i.test(c)) ?? shared[0]!] : []),
    [chosenKeys, shared],
  )
  const [show, setShow] = useState<Record<DiffStatus, boolean>>({
    same: false,
    changed: true,
    added: true,
    removed: true,
  })

  const tooBig =
    (first?.rows.length ?? 0) > MAX_COMPARED_ROWS || (second?.rows.length ?? 0) > MAX_COMPARED_ROWS
  const comparison = useMemo(
    () => (first && second && !tooBig ? compareResults(first, second, keys) : null),
    [first, second, keys, tooBig],
  )
  const visible = comparison ? comparison.rows.filter((r) => show[r.status]) : []

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-compare"
        role="dialog"
        aria-modal="true"
        aria-labelledby="compare-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header>
          <h2 id="compare-title">Compare two results</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        {sides.length < 2 ? (
          <p className="muted">
            Run a second statement in this script, or use “Keep a copy” on a result, then run the
            query again and compare the two.
          </p>
        ) : (
          <>
            <div className="tool-controls">
              <label>
                <span>First</span>
                <select
                  value={firstId}
                  onChange={(e) => (setFirstId(e.target.value), setChosenKeys(null))}
                >
                  {sides.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Second</span>
                <select
                  value={secondId}
                  onChange={(e) => (setSecondId(e.target.value), setChosenKeys(null))}
                >
                  {sides.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {tooBig ? (
              <p className="note-error">
                Each result can be up to {MAX_COMPARED_ROWS.toLocaleString()} rows to compare.
              </p>
            ) : shared.length === 0 ? (
              <p className="note-error">These two results have no column name in common.</p>
            ) : (
              <>
                <fieldset className="export-fields">
                  <div className="export-columns-head">
                    <span>Rows match on (the key)</span>
                  </div>
                  <div className="export-columns" role="group" aria-label="Key columns">
                    {shared.map((c) => (
                      <label className="check" key={c}>
                        <input
                          type="checkbox"
                          checked={keys.includes(c)}
                          onChange={(event) =>
                            setChosenKeys(
                              event.target.checked ? [...keys, c] : keys.filter((k) => k !== c),
                            )
                          }
                        />
                        <span className="mono">{c}</span>
                      </label>
                    ))}
                  </div>
                  <p className="muted">
                    With no key ticked, a row is the same only when every value matches.
                    {comparison && (comparison.onlyA.length > 0 || comparison.onlyB.length > 0)
                      ? ` Not compared: ${[...comparison.onlyA.map((c) => `${c} (first only)`), ...comparison.onlyB.map((c) => `${c} (second only)`)].join(', ')}.`
                      : ''}
                  </p>
                </fieldset>

                {comparison ? (
                  <>
                    <div className="compare-filter" role="group" aria-label="Show">
                      {(Object.keys(STATUS_LABEL) as DiffStatus[]).map((status) => (
                        <label key={status} className={`check compare-chip compare-${status}`}>
                          <input
                            type="checkbox"
                            checked={show[status]}
                            onChange={(event) =>
                              setShow((s) => ({ ...s, [status]: event.target.checked }))
                            }
                          />
                          <span>
                            {STATUS_LABEL[status]} {comparison.counts[status].toLocaleString()}
                          </span>
                        </label>
                      ))}
                    </div>
                    <div className="tool-scroll compare-scroll">
                      <table className="pivot">
                        <thead>
                          <tr>
                            <th />
                            {comparison.columns.map((c) => (
                              <th key={c} className="mono">
                                {c}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {visible.slice(0, MAX_SHOWN).map((row, i) => (
                            <tr key={i} className={`compare-row compare-${row.status}`}>
                              <th>{STATUS_LABEL[row.status]}</th>
                              {comparison.columns.map((_, c) => {
                                const a = row.a?.[c]
                                const b = row.b?.[c]
                                const cell = (v: Cell | undefined): string =>
                                  v === undefined ? '' : displayCell(v, { name: '', type: '' }).text
                                return row.status === 'changed' && row.differs[c] ? (
                                  <td key={c} className="compare-changed-cell">
                                    <del>{cell(a)}</del> <ins>{cell(b)}</ins>
                                  </td>
                                ) : (
                                  <td key={c}>{cell(row.status === 'added' ? b : a)}</td>
                                )
                              })}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      {visible.length > MAX_SHOWN ? (
                        <p className="muted tool-note">
                          Showing the first {MAX_SHOWN.toLocaleString()} of{' '}
                          {visible.length.toLocaleString()}.
                        </p>
                      ) : null}
                      {visible.length === 0 ? (
                        <p className="muted tool-empty">Nothing to show with these filters.</p>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </>
            )}
          </>
        )}
        <footer>
          <Button variant="primary" onClick={close} autoFocus>
            Close
          </Button>
        </footer>
      </div>
    </div>
  )
}
