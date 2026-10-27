import {
  Activity,
  Boxes,
  Braces,
  ChevronDown,
  ChevronRight,
  Clock,
  Columns3,
  Database,
  Download,
  Eye,
  Import,
  FileCode,
  FileUp,
  Network,
  Folder,
  Hash,
  Inbox,
  Info,
  KeyRound,
  Link2,
  List,
  ListOrdered,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Server,
  Shuffle,
  SquareFunction,
  Table2,
  Terminal,
  Type,
  Waves,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { prefixGlob } from '@shared/redis/types'
import { DENSITY_ROW_HEIGHT } from '@shared/settings'
import { EngineIcon, EnvDot, IconButton, Kbd } from '@/components/ui'
import { openTableExport } from '@/features/sql/export/open'
import { useDialogs } from '@/state/dialogs'
import { createScript, findAllMongo, selectAllSql } from '@/features/sql/scripts'
import { useData } from '@/state/data'
import { useTree } from '@/state/tree'
import { workbench } from '@/state/workbench'
import { flattenTree, type TreeRow } from './tree-model'

const NODE_ICONS: Record<string, LucideIcon> = {
  database: Database,
  group: Folder,
  table: Table2,
  collection: Braces,
  view: Eye,
  column: Columns3,
  index: KeyRound,
  foreignKey: Link2,
  procedure: SquareFunction,
  function: SquareFunction,
  trigger: Zap,
  event: Clock,
  vhost: Server,
  queue: Inbox,
  exchange: Shuffle,
  binding: Link2,
  info: Info,
  'redis-db': Database,
  'redis-prefix': Folder,
}

/** What kind of value a Redis key holds, as the icon beside it. */
const REDIS_TYPE_ICONS: Record<string, LucideIcon> = {
  string: Type,
  hash: Hash,
  list: List,
  set: Boxes,
  zset: ListOrdered,
  stream: Waves,
}

const isRedisKey = (kind: string): boolean => kind.startsWith('redis-key-')

/** The icon for a kind of node: a Redis key shows the type of what it holds. */
function NodeIcon({ kind }: { kind: string }) {
  const Icon = isRedisKey(kind)
    ? (REDIS_TYPE_ICONS[kind.slice('redis-key-'.length)] ?? KeyRound)
    : (NODE_ICONS[kind] ?? Folder)
  return <Icon size={14} aria-hidden className={`tree-icon tree-icon-${kind}`} />
}
/** Nodes that open on a double-click, or Enter, instead of toggling. */
const opensData = (kind: string): boolean => OPENS_DATA.has(kind) || isRedisKey(kind)

const INDENT = 14
/** Table-like nodes open their data on double-click; a single click only selects them. */
const OPENS_DATA = new Set(['table', 'view', 'collection', 'vhost', 'queue', 'exchange'])
/** On a message broker the same gesture opens a tab about the vhost, queue or exchange, not a script. */
const BROKER_KINDS = new Set(['vhost', 'queue', 'exchange'])

export function Navigator() {
  const connections = useData((state) => state.connections)
  const loaded = useData((state) => state.loaded)
  const density = useData((state) => state.settings.density)
  const rowHeight = DENSITY_ROW_HEIGHT[density]

  const expanded = useTree((state) => state.expanded)
  const branches = useTree((state) => state.branches)
  const selected = useTree((state) => state.selected)
  const tree = useTree.getState

  const [filter, setFilter] = useState('')
  const scroller = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [height, setHeight] = useState(0)

  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => setHeight(element.clientHeight))
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  // The filter looks at connection names and at everything that has been loaded under them.
  const rows = useMemo(
    () => flattenTree(connections, expanded, branches, filter),
    [connections, expanded, branches, filter],
  )

  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - 4)
  const last = Math.min(rows.length, Math.ceil((scrollTop + height) / rowHeight) + 4)

  const selectedIndex = rows.findIndex((row) => row.key === selected)

  const select = (index: number): void => {
    const row = rows[index]
    if (!row) return
    tree().select(row.key)
    const element = scroller.current
    if (!element) return
    const top = index * rowHeight
    if (top < element.scrollTop) element.scrollTop = top
    else if (top + rowHeight > element.scrollTop + element.clientHeight) {
      element.scrollTop = top + rowHeight - element.clientHeight
    }
  }

  const activate = (row: TreeRow): void => {
    if (row.type === 'status') {
      tree().reload(row.connectionId, row.node)
      return
    }
    if (row.type === 'connection') return tree().toggle(row.connection.id, null)
    if (row.node.kind.startsWith('redis-')) {
      const [kind, db, rest] = JSON.parse(row.node.id) as string[]
      if (kind === 'key' && rest !== undefined) {
        workbench.openRedis(row.connectionId, { view: 'key', db: Number(db), key: rest })
      } else if (row.node.hasChildren) tree().toggle(row.connectionId, row.node)
      return
    }
    if (BROKER_KINDS.has(row.node.kind)) {
      const [, vhost, name] = JSON.parse(row.node.id) as string[]
      if (vhost !== undefined) {
        workbench.openBroker(row.connectionId, {
          view: row.node.kind as 'vhost' | 'queue' | 'exchange',
          vhost,
          ...(row.node.kind === 'vhost' ? {} : { name: name ?? '' }),
        })
      }
      return
    }
    if (OPENS_DATA.has(row.node.kind) && row.node.scope) {
      const mongo = connections.find((c) => c.id === row.connectionId)?.engine === 'mongodb'
      createScript({
        connectionId: row.connectionId,
        database: row.node.scope,
        text: mongo ? findAllMongo(row.node.label) : selectAllSql(row.node.scope, row.node.label),
        name: row.node.label,
        run: true,
      })
      return
    }
    if (row.node.hasChildren) tree().toggle(row.connectionId, row.node)
  }

  /** The keys of a database, or of a folder, in a tab of their own. */
  const browse = (row: TreeRow): void => {
    if (row.type !== 'node' || !row.node.kind.startsWith('redis-')) return
    const [kind, db, prefix] = JSON.parse(row.node.id) as string[]
    if (kind !== 'db' && kind !== 'prefix') return
    workbench.openRedis(row.connectionId, {
      view: 'keys',
      db: Number(db),
      ...(kind === 'prefix' && prefix ? { pattern: prefixGlob(prefix) } : {}),
    })
  }

  const openConsole = (row: TreeRow): void => {
    if (row.type === 'connection') {
      workbench.openRedis(row.connection.id, { view: 'console', db: -1 })
    } else if (row.type === 'node') {
      const [, db] = JSON.parse(row.node.id) as string[]
      workbench.openRedis(row.connectionId, { view: 'console', db: Number(db) })
    }
  }

  const newScript = (row: TreeRow): void => {
    if (row.type === 'connection') createScript({ connectionId: row.connection.id })
    else if (row.type === 'node') {
      createScript({ connectionId: row.connectionId, database: row.node.scope ?? null })
    }
  }

  const onKeyDown = (event: KeyboardEvent): void => {
    const row = rows[selectedIndex]
    let handled = true
    switch (event.key) {
      case 'ArrowDown':
        select(Math.min(rows.length - 1, selectedIndex + 1))
        break
      case 'ArrowUp':
        select(Math.max(0, selectedIndex - 1))
        break
      case 'Home':
        select(0)
        break
      case 'End':
        select(rows.length - 1)
        break
      case 'ArrowRight':
        if (row?.type === 'connection' && !row.expanded) tree().expand(row.connection.id, null)
        else if (row?.type === 'node' && row.node.hasChildren && !row.expanded) {
          tree().expand(row.connectionId, row.node)
        } else if (row && row.type !== 'status' && row.expanded) select(selectedIndex + 1)
        break
      case 'ArrowLeft':
        if (row?.type === 'connection' && row.expanded) tree().collapse(row.connection.id, null)
        else if (row?.type === 'node' && row.expanded) tree().collapse(row.connectionId, row.node)
        else if (row?.type === 'node') {
          select(rows.findIndex((r) => r.key === row.parentKey))
        }
        break
      case 'Enter':
        if (row) activate(row)
        break
      default:
        handled = false
    }
    if (handled) event.preventDefault()
  }

  const visible = rows.slice(first, last)

  return (
    <div className="side-view-inner" role="group" aria-label="Connections">
      <div className="pane-header">
        <h2>Connections</h2>
        <IconButton
          label="Import connections from another tool"
          onClick={() => useDialogs.getState().openDbeaverImport()}
        >
          <Import size={14} />
        </IconButton>
        <IconButton label="New connection" onClick={() => workbench.newConnection()}>
          <Plus size={14} />
        </IconButton>
      </div>

      <div className="filter">
        <Search size={13} aria-hidden />
        <input
          type="search"
          placeholder="Filter connections and tables"
          aria-label="Filter connections and loaded objects"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {loaded && connections.length === 0 ? (
        <div className="empty-state compact">
          <h3>No connections yet</h3>
          <p>Paste a URI on the welcome screen, or add one by hand.</p>
          <p className="tips">
            <Kbd shortcut="Mod+N" />
          </p>
        </div>
      ) : null}
      {loaded && connections.length > 0 && rows.length === 0 ? (
        <p className="muted pad">
          Nothing matches “{filter}”. Only what is already loaded is searched: open a schema to
          include its tables.
        </p>
      ) : null}
      {filter.trim() !== '' && rows.length > 0 ? (
        <p className="muted tree-filter-note">
          Searching what is loaded. Open a schema to include its tables.
        </p>
      ) : null}

      <div
        className="tree"
        role="tree"
        aria-label="Databases"
        tabIndex={0}
        ref={scroller}
        onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        onKeyDown={onKeyDown}
        onFocus={() => {
          if (selected === null && rows[0]) tree().select(rows[0].key)
        }}
      >
        <div style={{ height: rows.length * rowHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${first * rowHeight}px)` }}>
            {visible.map((row) => (
              <TreeRowView
                key={row.key}
                row={row}
                height={rowHeight}
                selected={row.key === selected}
                onSelect={() => tree().select(row.key)}
                onActivate={() => activate(row)}
                onNewScript={() => newScript(row)}
                onBrowse={() => browse(row)}
                onConsole={() => openConsole(row)}
                canExport={
                  row.type === 'node' &&
                  (row.node.kind === 'table' ||
                    row.node.kind === 'view' ||
                    row.node.kind === 'database') &&
                  connections.find((c) => c.id === row.connectionId)?.engine === 'mysql'
                }
                canDiagram={
                  row.type === 'node' &&
                  row.node.kind === 'database' &&
                  connections.find((c) => c.id === row.connectionId)?.engine === 'mysql'
                }
                onDiagram={() => {
                  if (row.type === 'node') {
                    useDialogs.getState().openDiagram({
                      connectionId: row.connectionId,
                      database: row.node.label,
                    })
                  }
                }}
                canImport={
                  row.type === 'node' &&
                  (row.node.kind === 'table' || row.node.kind === 'database') &&
                  connections.find((c) => c.id === row.connectionId)?.engine === 'mysql'
                }
                onImport={() => {
                  if (row.type !== 'node') return
                  const table = row.node.kind === 'table'
                  const database = table ? row.node.scope : row.node.label
                  if (!database) return
                  useDialogs.getState().openImportData({
                    connectionId: row.connectionId,
                    database,
                    ...(table ? { table: row.node.label } : {}),
                  })
                }}
                onExport={() => {
                  if (row.type === 'node' && row.node.kind === 'database') {
                    useDialogs.getState().openDump({
                      connectionId: row.connectionId,
                      database: row.node.label,
                    })
                  } else if (row.type === 'node' && row.node.scope) {
                    void openTableExport(row.connectionId, row.node.scope, row.node.label)
                  }
                }}
              />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

interface RowProps {
  row: TreeRow
  height: number
  selected: boolean
  onSelect: () => void
  onActivate: () => void
  onNewScript: () => void
  onBrowse: () => void
  onConsole: () => void
  /** A table or view of a SQL server, which can be written to a file from here. */
  canExport: boolean
  onExport: () => void
  /** A table or database of a SQL server, which a file can be imported into. */
  canImport: boolean
  onImport: () => void
  /** A database of a SQL server, whose tables can be drawn with the keys between them. */
  canDiagram: boolean
  onDiagram: () => void
}

function TreeRowView({
  row,
  height,
  selected,
  onSelect,
  onActivate,
  onNewScript,
  onBrowse,
  onConsole,
  canExport,
  onExport,
  canImport,
  onImport,
  canDiagram,
  onDiagram,
}: RowProps) {
  const indent = 8 + row.depth * INDENT

  if (row.type === 'status') {
    const busy = !row.error && row.text.endsWith('…')
    return (
      <div
        role="treeitem"
        aria-level={row.depth + 1}
        aria-selected={selected}
        className={`tree-row tree-status ${row.error ? 'tree-error' : ''} ${selected ? 'active' : ''}`}
        style={{ height, paddingLeft: indent + 18 }}
        onClick={() => {
          onSelect()
          if (row.error) onActivate()
        }}
      >
        {busy ? <LoaderCircle size={12} className="spin" aria-hidden /> : null}
        <span className="tree-label selectable" title={row.text}>
          {row.text}
        </span>
        {row.error ? <span className="tree-retry">Retry</span> : null}
      </div>
    )
  }

  if (row.type === 'connection') {
    const { connection } = row
    return (
      <div
        role="treeitem"
        aria-level={1}
        aria-expanded={row.expanded}
        aria-selected={selected}
        className={`tree-row ${selected ? 'active' : ''}`}
        style={{ height, paddingLeft: indent }}
        onClick={() => {
          onSelect()
          onActivate()
        }}
      >
        <span className="tree-chevron" aria-hidden>
          {row.expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        </span>
        <EnvDot environment={connection.environment} />
        <EngineIcon engine={connection.engine} />
        <span className="tree-label">{connection.name}</span>
        <span className="tree-actions">
          {connection.engine === 'redis' ? (
            <>
              <IconButton
                label={`Open a console on ${connection.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onConsole()
                }}
              >
                <Terminal size={12} />
              </IconButton>
              <IconButton
                label={`Server info of ${connection.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  workbench.openRedis(connection.id, { view: 'info', db: 0 })
                }}
              >
                <Activity size={12} />
              </IconButton>
            </>
          ) : null}
          {connection.engine === 'rabbitmq' || connection.engine === 'redis' ? null : (
            <IconButton
              label={`New script on ${connection.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onNewScript()
              }}
            >
              <FileCode size={12} />
            </IconButton>
          )}
          <IconButton
            label={`Refresh ${connection.name}`}
            onClick={(event) => {
              event.stopPropagation()
              useTree.getState().reset(connection.id)
              useTree.getState().expand(connection.id, null)
            }}
          >
            <RefreshCw size={12} />
          </IconButton>
          <IconButton
            label={`Edit ${connection.name}`}
            onClick={(event) => {
              event.stopPropagation()
              workbench.editConnection(connection.id)
            }}
          >
            <Pencil size={12} />
          </IconButton>
        </span>
      </div>
    )
  }

  const { node } = row
  const toggles = node.hasChildren && !opensData(node.kind)
  return (
    <div
      role="treeitem"
      aria-level={row.depth + 1}
      aria-expanded={node.hasChildren ? row.expanded : undefined}
      aria-selected={selected}
      className={`tree-row ${selected ? 'active' : ''}`}
      style={{ height, paddingLeft: indent }}
      onClick={() => {
        onSelect()
        if (toggles) onActivate()
      }}
      onDoubleClick={() => {
        if (opensData(node.kind)) onActivate()
        else if (node.kind === 'redis-db' || node.kind === 'redis-prefix') onBrowse()
      }}
    >
      <span
        className="tree-chevron"
        onClick={(event) => {
          if (!node.hasChildren) return
          event.stopPropagation()
          onSelect()
          useTree.getState().toggle(row.connectionId, node)
        }}
      >
        {node.hasChildren ? (
          row.expanded ? (
            <ChevronDown size={13} aria-hidden />
          ) : (
            <ChevronRight size={13} aria-hidden />
          )
        ) : null}
      </span>
      <NodeIcon kind={node.kind} />
      <span className="tree-label" title={node.label}>
        {node.label}
      </span>
      {node.detail ? <span className="tree-detail">{node.detail}</span> : null}
      {node.kind === 'redis-db' || node.kind === 'redis-prefix' ? (
        <span className="tree-actions">
          <IconButton
            label={`Browse the keys of ${node.label}`}
            onClick={(event) => {
              event.stopPropagation()
              onBrowse()
            }}
          >
            <Search size={12} />
          </IconButton>
          {node.kind === 'redis-db' ? (
            <IconButton
              label={`Open a console in ${node.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onConsole()
              }}
            >
              <Terminal size={12} />
            </IconButton>
          ) : null}
        </span>
      ) : node.kind === 'database' ||
        (OPENS_DATA.has(node.kind) && !BROKER_KINDS.has(node.kind)) ? (
        <span className="tree-actions">
          {canExport ? (
            <IconButton
              label={`Export ${node.label} to a file`}
              onClick={(event) => {
                event.stopPropagation()
                onExport()
              }}
            >
              <Download size={12} />
            </IconButton>
          ) : null}
          {canDiagram ? (
            <IconButton
              label={`Diagram of ${node.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onDiagram()
              }}
            >
              <Network size={12} />
            </IconButton>
          ) : null}
          {canImport ? (
            <IconButton
              label={`Import a file into ${node.label}`}
              onClick={(event) => {
                event.stopPropagation()
                onImport()
              }}
            >
              <FileUp size={12} />
            </IconButton>
          ) : null}
          <IconButton
            label={`New script in ${node.scope ?? node.label}`}
            onClick={(event) => {
              event.stopPropagation()
              onNewScript()
            }}
          >
            <FileCode size={12} />
          </IconButton>
        </span>
      ) : null}
    </div>
  )
}
