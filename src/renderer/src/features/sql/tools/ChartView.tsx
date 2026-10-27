import { useSyncExternalStore } from 'react'
import { isNumericType } from '@shared/value'
import type { ResultSet } from '@/state/scripts'
import { buildChart, formatNumber, niceTicks, type ChartKind } from './chart'
import { AGGREGATES, type Aggregate } from './pivot'
import { useLocalState } from './useLocalState'

const W = 820
const H = 340
const PAD = { left: 64, right: 16, top: 16, bottom: 64 }

/** Slice colours: the accent first, then hues that stay apart in both themes. */
const SLICE = [
  'var(--accent)',
  '#e07a1f',
  '#2f9e63',
  '#c0449a',
  '#7c5cd6',
  '#2aa3b8',
  '#c9a227',
  '#d9534f',
  '#6b8e23',
  '#8a6d3b',
  '#4682b4',
  '#8b8c96',
]

const shorten = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text

export function ChartView({ resultSet }: { resultSet: ResultSet }) {
  const { columns, store } = resultSet
  useSyncExternalStore(store.subscribe, store.getVersion)
  const firstNumber = columns.findIndex((c) => isNumericType(c.type))
  const firstText = columns.findIndex((c) => !isNumericType(c.type))
  const [kind, setKind] = useLocalState<ChartKind>('bar')
  const [x, setX] = useLocalState(Math.max(0, firstText))
  const [y, setY] = useLocalState(firstNumber)
  const [aggregate, setAggregate] = useLocalState<Aggregate>('sum')

  const data = buildChart(store.rows, { kind, x, y: y < 0 ? null : y, aggregate })
  const values = data.points.map((p) => p.value)
  const max = Math.max(0, ...values)
  const min = Math.min(0, ...values)
  const ticks = niceTicks(min, max)
  const top = Math.max(...ticks, max)
  const bottom = Math.min(...ticks, min)
  const plotW = W - PAD.left - PAD.right
  const plotH = H - PAD.top - PAD.bottom
  const yOf = (v: number): number => PAD.top + plotH - ((v - bottom) / (top - bottom || 1)) * plotH
  const xOf = (i: number, n: number): number =>
    PAD.left + (n === 1 ? plotW / 2 : (i / (n - 1)) * plotW)
  const slot = plotW / Math.max(1, data.points.length)
  const total = values.reduce((a, b) => a + Math.max(0, b), 0)

  return (
    <div className="tool">
      <div className="tool-controls">
        <label>
          <span>Chart</span>
          <select value={kind} onChange={(e) => setKind(e.target.value as ChartKind)}>
            <option value="bar">Bars</option>
            <option value="line">Line</option>
            <option value="pie">Pie</option>
          </select>
        </label>
        <label>
          <span>{kind === 'pie' ? 'Slices by' : 'Across'}</span>
          <select value={x} onChange={(e) => setX(Number(e.target.value))}>
            {columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Measure</span>
          <select value={y} onChange={(e) => setY(Number(e.target.value))}>
            <option value={-1}>Number of rows</option>
            {columns.map((c, i) => (
              <option key={i} value={i}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        {y >= 0 ? (
          <label>
            <span>As</span>
            <select value={aggregate} onChange={(e) => setAggregate(e.target.value as Aggregate)}>
              {AGGREGATES.filter((a) => a.value !== 'count').map((a) => (
                <option key={a.value} value={a.value}>
                  {a.label}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <span className="muted tool-note">
          {store.rows.length.toLocaleString()} rows
          {store.spilled > 0 ? ' (the first ones loaded)' : ''}
        </span>
      </div>

      {data.points.length === 0 ? (
        <p className="muted tool-empty">Nothing to chart: pick a column with numbers to measure.</p>
      ) : kind === 'pie' ? (
        <div className="chart-pie">
          <svg viewBox="-110 -110 220 220" role="img" aria-label="Pie chart">
            {(() => {
              let angle = -Math.PI / 2
              return data.points.map((p, i) => {
                const share = total > 0 ? Math.max(0, p.value) / total : 0
                const next = angle + share * Math.PI * 2
                const large = share > 0.5 ? 1 : 0
                const [x1, y1, x2, y2] = [
                  Math.cos(angle),
                  Math.sin(angle),
                  Math.cos(next),
                  Math.sin(next),
                ].map((n) => n * 100) as [number, number, number, number]
                const path =
                  share >= 0.9999
                    ? 'M 0 -100 A 100 100 0 1 1 0 100 A 100 100 0 1 1 0 -100 Z'
                    : `M 0 0 L ${x1} ${y1} A 100 100 0 ${large} 1 ${x2} ${y2} Z`
                angle = next
                return (
                  <path
                    key={p.label}
                    d={path}
                    fill={SLICE[i % SLICE.length]}
                    stroke="var(--bg-0)"
                    strokeWidth="1"
                  >
                    <title>{`${p.label}: ${formatNumber(p.value)} (${(share * 100).toFixed(1)}%)`}</title>
                  </path>
                )
              })
            })()}
          </svg>
          <ul className="chart-legend">
            {data.points.map((p, i) => (
              <li key={p.label}>
                <span className="swatch" style={{ background: SLICE[i % SLICE.length] }} />
                <span className="mono">{shorten(p.label, 28)}</span>
                <span className="muted">
                  {formatNumber(p.value)} ·{' '}
                  {total > 0 ? ((Math.max(0, p.value) / total) * 100).toFixed(1) : '0'}%
                </span>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <svg
          className="chart"
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={kind === 'bar' ? 'Bar chart' : 'Line chart'}
        >
          {ticks.map((t) => (
            <g key={t}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={yOf(t)}
                y2={yOf(t)}
                className={t === 0 ? 'chart-axis' : 'chart-grid'}
              />
              <text x={PAD.left - 8} y={yOf(t) + 4} textAnchor="end" className="chart-label">
                {formatNumber(t)}
              </text>
            </g>
          ))}
          {kind === 'bar' ? (
            data.points.map((p, i) => {
              const barW = Math.min(48, slot * 0.7)
              const cx = PAD.left + slot * (i + 0.5)
              const y0 = yOf(0)
              const y1 = yOf(p.value)
              return (
                <g key={p.label}>
                  <rect
                    x={cx - barW / 2}
                    y={Math.min(y0, y1)}
                    width={barW}
                    height={Math.abs(y0 - y1)}
                    className="chart-bar"
                  >
                    <title>{`${p.label}: ${formatNumber(p.value)}`}</title>
                  </rect>
                  <text
                    x={cx}
                    y={H - PAD.bottom + 14}
                    textAnchor={data.points.length > 8 ? 'end' : 'middle'}
                    transform={
                      data.points.length > 8
                        ? `rotate(-35 ${cx} ${H - PAD.bottom + 14})`
                        : undefined
                    }
                    className="chart-label"
                  >
                    {shorten(p.label, 14)}
                  </text>
                </g>
              )
            })
          ) : (
            <>
              <polyline
                className="chart-line"
                fill="none"
                points={data.points
                  .map((p, i) => `${xOf(i, data.points.length)},${yOf(p.value)}`)
                  .join(' ')}
              />
              {data.points.length <= 120
                ? data.points.map((p, i) => (
                    <circle
                      key={i}
                      cx={xOf(i, data.points.length)}
                      cy={yOf(p.value)}
                      r="3"
                      className="chart-dot"
                    >
                      <title>{`${p.label}: ${formatNumber(p.value)}`}</title>
                    </circle>
                  ))
                : null}
              {[0, Math.floor((data.points.length - 1) / 2), data.points.length - 1].map((i) => (
                <text
                  key={i}
                  x={xOf(i, data.points.length)}
                  y={H - PAD.bottom + 18}
                  textAnchor="middle"
                  className="chart-label"
                >
                  {shorten(data.points[i]!.label, 18)}
                </text>
              ))}
            </>
          )}
        </svg>
      )}
      {data.omitted > 0 ? (
        <p className="muted tool-note">
          {data.omitted.toLocaleString()} more{' '}
          {kind === 'line' ? 'points' : kind === 'pie' ? 'slices' : 'bars'} left out: showing the{' '}
          {kind === 'line' ? 'first' : 'largest'}.
        </p>
      ) : null}
    </div>
  )
}
