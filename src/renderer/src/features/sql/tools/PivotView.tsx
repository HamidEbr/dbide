import { useSyncExternalStore } from 'react'
import { isNumericType } from '@shared/value'
import type { ResultSet } from '@/state/scripts'
import { useLocalState } from './useLocalState'
import { formatNumber } from './chart'
import { AGGREGATES, buildPivot, type Aggregate } from './pivot'

const NONE = -1

export function PivotView({ resultSet }: { resultSet: ResultSet }) {
  const { columns, store } = resultSet
  useSyncExternalStore(store.subscribe, store.getVersion)
  const firstNumber = columns.findIndex((c) => isNumericType(c.type))
  const firstText = columns.findIndex((c) => !isNumericType(c.type))
  const [rowColumn, setRowColumn] = useLocalState(Math.max(0, firstText))
  const [columnColumn, setColumnColumn] = useLocalState(NONE)
  const [valueColumn, setValueColumn] = useLocalState(firstNumber)
  const [aggregate, setAggregate] = useLocalState<Aggregate>(firstNumber === NONE ? 'count' : 'sum')

  const pivot = buildPivot(store.rows, {
    rows: rowColumn,
    columns: columnColumn === NONE ? null : columnColumn,
    value: valueColumn === NONE ? null : valueColumn,
    aggregate,
  })
  const needsValue = aggregate !== 'count'
  const showTotals = aggregate === 'count' || aggregate === 'sum'

  return (
    <div className="tool">
      <div className="tool-controls">
        <label>
          <span>Rows</span>
          <select value={rowColumn} onChange={(e) => setRowColumn(Number(e.target.value))}>
            {columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Columns</span>
          <select value={columnColumn} onChange={(e) => setColumnColumn(Number(e.target.value))}>
            <option value={NONE}>(none)</option>
            {columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Show</span>
          <select value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)}>
            {AGGREGATES.map((a) => (
              <option key={a.value} value={a.value}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
        {needsValue ? (
          <label>
            <span>Of</span>
            <select value={valueColumn} onChange={(e) => setValueColumn(Number(e.target.value))}>
              <option value={NONE}>(pick a column)</option>
              {columns.map((c, i) => (
                <option key={i} value={i}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="muted tool-note">
          {store.rows.length.toLocaleString()} rows
          {store.spilled > 0 ? ' (the first ones loaded; the rest are not included)' : ''}
        </span>
      </div>
      {needsValue && valueColumn === NONE ? (
        <p className="muted tool-empty">
          Pick the column to {aggregate === 'sum' ? 'add up' : 'measure'}.
        </p>
      ) : store.rows.length === 0 ? (
        <p className="muted tool-empty">No rows to pivot.</p>
      ) : (
        <div className="tool-scroll">
          <table className="pivot">
            <thead>
              <tr>
                <th>{columns[rowColumn]?.name}</th>
                {columnColumn === NONE ? (
                  <th className="num">
                    {aggregate === 'count' ? 'Rows' : (columns[valueColumn]?.name ?? '')}
                  </th>
                ) : (
                  pivot.columnLabels.map((c) => (
                    <th key={c} className="num">
                      {c}
                    </th>
                  ))
                )}
                {showTotals && columnColumn !== NONE ? <th className="num total">Total</th> : null}
              </tr>
            </thead>
            <tbody>
              {pivot.rowLabels.map((label, r) => (
                <tr key={label}>
                  <th className="mono">{label}</th>
                  {pivot.cells[r]!.map((value, c) => (
                    <td key={c} className={`num ${value === null ? 'muted' : ''}`}>
                      {value === null ? '–' : formatNumber(value)}
                    </td>
                  ))}
                  {showTotals && columnColumn !== NONE ? (
                    <td className="num total">
                      {pivot.rowTotals[r] === null ? '–' : formatNumber(pivot.rowTotals[r]!)}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
            {showTotals && pivot.rowLabels.length > 1 ? (
              <tfoot>
                <tr>
                  <th>Total</th>
                  {pivot.columnTotals.map((v, c) => (
                    <td key={c} className="num total">
                      {v === null ? '–' : formatNumber(v)}
                    </td>
                  ))}
                  {columnColumn !== NONE ? (
                    <td className="num total">
                      {pivot.total === null ? '–' : formatNumber(pivot.total)}
                    </td>
                  ) : null}
                </tr>
              </tfoot>
            ) : null}
          </table>
          {pivot.capped ? (
            <p className="muted tool-note">
              Only the first values are shown: there are too many to list.
            </p>
          ) : null}
        </div>
      )}
    </div>
  )
}
