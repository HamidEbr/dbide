import { LoaderCircle, Maximize, Minus, Plus, Save, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, IconButton } from '@/components/ui'
import { useDialogs, type DiagramRequest } from '@/state/dialogs'
import { schemaCache } from '@/features/sql/completion/schema-cache'
import { createScript, selectAllSql } from '@/features/sql/scripts'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import {
  HEADER_H,
  ROW_H,
  layoutDiagram,
  type DiagramLink,
  type DiagramTable,
  type Layout,
} from './layout'

/** Tables drawn at first, and how many each "Show more" adds. A page of hundreds says nothing. */
const FIRST_TABLES = 60
const MAX_TABLES = 240

export function ErDiagramDialog() {
  const request = useDialogs((state) => state.diagram)
  if (!request) return null
  return <DiagramBody request={request} />
}

interface View {
  scale: number
  x: number
  y: number
}

function DiagramBody({ request }: { request: DiagramRequest }) {
  const close = useDialogs((state) => state.closeDiagram)
  const { connectionId, database } = request
  const engine = useData((state) => state.connections.find((c) => c.id === connectionId)?.engine)
  const dialect: SqlDialect = (engine && dialectOf(engine)) || 'mysql'
  const [names, setNames] = useState<{ name: string; view: boolean }[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [filter, setFilter] = useState('')
  const [limit, setLimit] = useState(FIRST_TABLES)
  const [showColumns, setShowColumns] = useState(true)
  const [loading, setLoading] = useState(true)
  const [version, setVersion] = useState(0)
  const [selected, setSelected] = useState<string | null>(null)
  const [view, setView] = useState<View>({ scale: 1, x: 0, y: 0 })
  const svgRef = useRef<SVGSVGElement>(null)
  const drag = useRef<{ x: number; y: number; view: View } | null>(null)

  useEffect(() => {
    let alive = true
    schemaCache
      .detail(connectionId, database)
      .then((detail) => {
        if (!alive) return
        if (!detail) setError('The tables could not be read. Check the connection and try again.')
        else setNames(detail.tables.map((t) => ({ name: t.name, view: t.view })))
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : String(e)))
    return () => {
      alive = false
    }
  }, [connectionId, database])

  const matching = useMemo(
    () => (names ?? []).filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase())),
    [names, filter],
  )
  const wanted = useMemo(() => matching.slice(0, limit), [matching, limit])

  // Columns and foreign keys of the tables on the page, read in the cache's own batches.
  useEffect(() => {
    if (!names || wanted.length === 0) return
    let alive = true
    const names200 = wanted.map((t) => t.name)
    void (async () => {
      setLoading(true)
      for (let i = 0; i < names200.length; i += 200) {
        await schemaCache.columns(connectionId, database, names200.slice(i, i + 200))
      }
      if (alive) {
        setLoading(false)
        setVersion((v) => v + 1)
      }
    })()
    return () => {
      alive = false
    }
  }, [names, wanted, connectionId, database])

  const { tables, links, external } = useMemo(() => {
    void version
    const tables: DiagramTable[] = []
    const links: DiagramLink[] = []
    const external = new Map<string, string[]>()
    for (const w of wanted) {
      const known = schemaCache.peekTable(connectionId, database, w.name)
      if (!known) continue
      tables.push({
        name: known.name,
        view: w.view,
        columns: known.columns.map((c) => ({ name: c.name, type: c.type, key: c.key })),
      })
      for (const k of schemaCache.peekForeignKeys(connectionId, database, w.name)) {
        if (k.refSchema.toLowerCase() === database.toLowerCase()) {
          const target = (names ?? []).find(
            (n) => n.name.toLowerCase() === k.refTable.toLowerCase(),
          )
          links.push({
            table: known.name,
            column: k.column,
            refTable: target?.name ?? k.refTable,
            refColumn: k.refColumn,
          })
        } else {
          external.set(known.name, [
            ...(external.get(known.name) ?? []),
            `${k.column} → ${k.refSchema}.${k.refTable}`,
          ])
        }
      }
    }
    return { tables, links, external }
  }, [version, wanted, connectionId, database, names])

  const layout: Layout = useMemo(
    () => layoutDiagram(tables, links, { showColumns }),
    [tables, links, showColumns],
  )

  const fit = (): void => {
    const el = svgRef.current
    if (!el || layout.width === 0) return
    const box = el.getBoundingClientRect()
    const scale = Math.min(1, box.width / layout.width, box.height / layout.height)
    setView({ scale, x: (box.width - layout.width * scale) / 2, y: 12 })
  }
  // Fit when the set of tables changes (and not on every pan).
  useEffect(fit, [layout.width, layout.height])

  // Zoom with the wheel around the pointer. React's own wheel handler is passive, so this is attached by hand.
  useEffect(() => {
    const el = svgRef.current
    if (!el) return
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault()
      const box = el.getBoundingClientRect()
      const px = event.clientX - box.left
      const py = event.clientY - box.top
      setView((v) => {
        const scale = Math.min(3, Math.max(0.1, v.scale * Math.exp(-event.deltaY * 0.0015)))
        const k = scale / v.scale
        return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
      })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const related = useMemo(() => {
    if (!selected) return null
    const set = new Set<string>([selected])
    for (const l of layout.links) {
      if (l.table === selected) set.add(l.refTable)
      if (l.refTable === selected) set.add(l.table)
    }
    return set
  }, [selected, layout.links])

  const saveSvg = (): void => {
    const el = svgRef.current
    if (!el) return
    const clone = el.cloneNode(true) as SVGSVGElement
    clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    clone.setAttribute('viewBox', `0 0 ${layout.width} ${layout.height}`)
    clone.setAttribute('width', String(layout.width))
    clone.setAttribute('height', String(layout.height))
    // Out of the page the theme variables are gone: write the colours the diagram is showing now.
    const style = getComputedStyle(document.documentElement)
    const paint = (name: string): string => style.getPropertyValue(name).trim()
    const inner = clone.querySelector('.diagram-world')
    inner?.setAttribute('transform', '')
    let text = new XMLSerializer().serializeToString(clone)
    for (const name of [
      '--bg-0',
      '--bg-1',
      '--bg-2',
      '--fg-0',
      '--fg-1',
      '--fg-2',
      '--line',
      '--line-strong',
      '--accent',
      '--accent-soft',
    ]) {
      text = text.split(`var(${name})`).join(paint(name))
    }
    const url = URL.createObjectURL(new Blob([text], { type: 'image/svg+xml' }))
    const a = document.createElement('a')
    a.href = url
    a.download = `${database}-diagram.svg`
    a.click()
    URL.revokeObjectURL(url)
    notify('Diagram saved as an SVG file.')
  }

  const zoom = (factor: number): void =>
    setView((v) => {
      const box = svgRef.current?.getBoundingClientRect()
      const px = (box?.width ?? 0) / 2
      const py = (box?.height ?? 0) / 2
      const scale = Math.min(3, Math.max(0.1, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })

  const curve = (l: Layout['links'][number]): string => {
    if (l.self) {
      const { x, y } = l.from
      return `M ${x} ${y} C ${x + 50} ${y - 10}, ${x + 50} ${y + 30}, ${l.to.x} ${l.to.y + 10}`
    }
    const dx = Math.max(40, Math.abs(l.from.x - l.to.x) / 2)
    const fromDir = l.from.side === 'left' ? -1 : 1
    const toDir = l.to.side === 'left' ? -1 : 1
    return `M ${l.from.x} ${l.from.y} C ${l.from.x + fromDir * dx} ${l.from.y}, ${l.to.x + toDir * dx} ${l.to.y}, ${l.to.x} ${l.to.y}`
  }

  const open = (name: string): void => {
    createScript({
      connectionId,
      database,
      text: selectAllSql(database, name, 1000, dialect),
      name,
      run: true,
    })
    close()
  }

  const moreAvailable = matching.length > limit && limit < MAX_TABLES

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-diagram"
        role="dialog"
        aria-modal="true"
        aria-labelledby="diagram-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header>
          <h2 id="diagram-title">Diagram of {database}</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        <div className="tool-controls diagram-bar">
          <input
            aria-label="Filter tables"
            placeholder="Filter tables"
            value={filter}
            spellCheck={false}
            onChange={(event) => {
              setFilter(event.target.value)
              setLimit(FIRST_TABLES)
            }}
          />
          <label className="check">
            <input
              type="checkbox"
              checked={showColumns}
              onChange={(event) => setShowColumns(event.target.checked)}
            />
            <span>Columns</span>
          </label>
          <IconButton label="Zoom out" onClick={() => zoom(0.8)}>
            <Minus size={14} />
          </IconButton>
          <IconButton label="Zoom in" onClick={() => zoom(1.25)}>
            <Plus size={14} />
          </IconButton>
          <IconButton label="Fit to the window" onClick={fit}>
            <Maximize size={14} />
          </IconButton>
          <IconButton label="Save as SVG" onClick={saveSvg}>
            <Save size={14} />
          </IconButton>
          <span className="muted tool-note">
            {loading ? (
              <>
                <LoaderCircle size={12} className="spin" aria-hidden /> Reading…
              </>
            ) : (
              <>
                {tables.length.toLocaleString()} of {(names?.length ?? 0).toLocaleString()} tables ·{' '}
                {layout.links.length} relations
              </>
            )}
            {moreAvailable ? (
              <>
                {' '}
                <Button
                  variant="ghost"
                  onClick={() => setLimit((l) => Math.min(MAX_TABLES, l + FIRST_TABLES))}
                >
                  Show more
                </Button>
              </>
            ) : matching.length > limit ? (
              ' · narrow the filter to see others'
            ) : (
              ''
            )}
          </span>
        </div>

        {error ? (
          <p className="note-error" role="alert">
            {error}
          </p>
        ) : null}

        <svg
          ref={svgRef}
          className="diagram"
          role="img"
          aria-label={`Diagram of the tables of ${database} and the foreign keys between them`}
          onPointerDown={(event) => {
            if ((event.target as Element).closest('.diagram-table')) return
            drag.current = { x: event.clientX, y: event.clientY, view }
            event.currentTarget.setPointerCapture(event.pointerId)
            setSelected(null)
          }}
          onPointerMove={(event) => {
            const d = drag.current
            if (d)
              setView({
                ...d.view,
                x: d.view.x + event.clientX - d.x,
                y: d.view.y + event.clientY - d.y,
              })
          }}
          onPointerUp={() => (drag.current = null)}
        >
          <g
            className="diagram-world"
            transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}
          >
            {layout.links.map((l, i) => {
              const active = !selected || l.table === selected || l.refTable === selected
              return (
                <path
                  key={i}
                  d={curve(l)}
                  className={`diagram-link ${selected && active ? 'hot' : ''} ${selected && !active ? 'dim' : ''}`}
                >
                  <title>{`${l.table}.${l.column} → ${l.refTable}.${l.refColumn}`}</title>
                </path>
              )
            })}
            {layout.tables.map((p) => {
              const dim = related !== null && !related.has(p.table.name)
              return (
                <g
                  key={p.table.name}
                  className={`diagram-table ${p.table.view ? 'view' : ''} ${selected === p.table.name ? 'selected' : ''} ${dim ? 'dim' : ''}`}
                  transform={`translate(${p.x} ${p.y})`}
                  onClick={() => setSelected(p.table.name)}
                  onDoubleClick={() => open(p.table.name)}
                >
                  <title>{`${p.table.name}${external.get(p.table.name) ? '\n' + external.get(p.table.name)!.join('\n') : ''}\nDouble-click to open its rows`}</title>
                  <rect width={p.w} height={p.h} rx="6" className="diagram-box" />
                  <rect width={p.w} height={HEADER_H} rx="6" className="diagram-head" />
                  <text x={10} y={18} className="diagram-name">
                    {p.table.view ? `${p.table.name} (view)` : p.table.name}
                  </text>
                  {p.shown.map((c, i) => (
                    <g key={c.name} transform={`translate(0 ${HEADER_H + i * ROW_H})`}>
                      <text x={10} y={13} className={`diagram-col ${c.key === 'PRI' ? 'pk' : ''}`}>
                        {c.key === 'PRI' ? '🔑 ' : ''}
                        {c.name}
                      </text>
                      <text x={p.w - 8} y={13} textAnchor="end" className="diagram-type">
                        {c.type}
                      </text>
                    </g>
                  ))}
                  {p.hidden > 0 ? (
                    <text
                      x={10}
                      y={HEADER_H + p.shown.length * ROW_H + 13}
                      className="diagram-type"
                    >
                      + {p.hidden} more columns
                    </text>
                  ) : null}
                </g>
              )
            })}
          </g>
        </svg>
        <p className="muted diagram-help">
          Drag to move, scroll to zoom, click a table to see what it connects to, double-click to
          open its rows.
          {external.size > 0
            ? ' Some tables also point at other databases: hover them to see where.'
            : ''}
        </p>
      </div>
    </div>
  )
}
