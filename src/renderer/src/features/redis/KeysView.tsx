import { ArrowDown, ArrowUp, Gauge, Plus, Square, Trash2 } from 'lucide-react'
import { useMemo, useState } from 'react'
import { printable } from '@shared/redis/bstring'
import { CORE_TYPES, describeTtl, type KeySummary, type RedisType } from '@shared/redis/types'
import { Button, EnvBadge } from '@/components/ui'
import { Chip, LockButton, VirtualRows } from '@/components/panel'
import { coreLink } from '@/ipc/link'
import { formatBytes, formatCount, messageOf } from '@/lib/format'
import { useServerCall } from '@/lib/useServerCall'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'
import { changeData } from '@/state/writes'
import { workbench, type Tab } from '@/state/workbench'
import { BulkDeleteDialog } from './BulkDeleteDialog'
import { TypeBadge } from './common'
import { NewKeyDialog } from './NewKeyDialog'
import { useKeyScan } from './useKeyScan'

type SortKey = 'key' | 'type' | 'ttl' | 'size'

const ROW_HEIGHT = 28
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

/** The keys of one database: searched with SCAN a page at a time, never with KEYS. */
export function KeysView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const { db, pattern: initialPattern = '' } = tab.redis!
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))

  const [typed, setTyped] = useState(initialPattern)
  const [typeFilter, setTypeFilter] = useState<RedisType | ''>('')
  const [applied, setApplied] = useState({ pattern: initialPattern, type: '' as RedisType | '' })
  const scan = useKeyScan(connectionId, db, applied.pattern, applied.type || undefined)

  const info = useServerCall(
    (signal) => coreLink.call('redis.info', { connectionId }, { signal }),
    {
      paused: !active,
    },
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [sort, setSort] = useState<{ key: SortKey; descending: boolean }>({
    key: 'key',
    descending: false,
  })
  const [sizes, setSizes] = useState<Record<string, number | null>>({})
  const [measuring, setMeasuring] = useState(false)
  const [dialog, setDialog] = useState<'new' | 'delete' | null>(null)

  const rows = useMemo(() => {
    const sorted = [...scan.keys]
    const byName = (a: KeySummary, b: KeySummary): number =>
      collator.compare(printable(a.key), printable(b.key))
    const order = (a: KeySummary, b: KeySummary): number => {
      switch (sort.key) {
        case 'key':
          return byName(a, b)
        case 'type':
          return a.type.localeCompare(b.type)
        case 'ttl': {
          // A key with no expiry sorts after every key that has one.
          const left = a.ttlMs ?? Infinity
          const right = b.ttlMs ?? Infinity
          return left === right ? 0 : left < right ? -1 : 1
        }
        case 'size':
          return (sizes[a.key] ?? -1) - (sizes[b.key] ?? -1)
      }
    }
    sorted.sort((a, b) => (order(a, b) || byName(a, b)) * (sort.descending ? -1 : 1))
    return sorted
  }, [scan.keys, sort, sizes])

  const apply = (): void => {
    setApplied({ pattern: typed, type: typeFilter })
    setSelected(null)
  }

  const open = (key: string): void => workbench.openRedis(connectionId, { view: 'key', db, key })

  const measure = async (): Promise<void> => {
    const todo = scan.keys.map((k) => k.key).filter((k) => !(k in sizes))
    if (todo.length === 0) return
    setMeasuring(true)
    try {
      for (let i = 0; i < todo.length; i += 200) {
        const chunk = todo.slice(i, i + 200)
        const result = await coreLink.call('redis.memory', { connectionId, db, keys: chunk })
        setSizes((s) => ({
          ...s,
          ...Object.fromEntries(chunk.map((k, j) => [k, result[j] ?? null])),
        }))
      }
    } catch (error) {
      notify(messageOf(error), 'error')
    } finally {
      setMeasuring(false)
    }
  }

  const remove = async (key: string): Promise<void> => {
    const ran = await changeData({
      connectionId,
      title: `Delete “${printable(key)}”?`,
      confirmLabel: 'Delete',
      destructive: true,
      reasons: ['Deleting a key removes it and what it holds, and it can’t be undone.'],
      lines: [`Delete the key ${printable(key)} in db${db}`],
      run: () =>
        coreLink.call('redis.edit', {
          connectionId,
          db,
          writable: true,
          key,
          edit: { op: 'key.delete' },
        }),
    })
    if (ran) {
      scan.remove(key)
      setSelected(null)
    }
  }

  const databases = info.data?.databases ?? 16
  const clustered = info.data?.mode === 'cluster'
  const keyspace = new Map((info.data?.keyspace ?? []).map((k) => [k.db, k.keys]))
  const filtered = applied.pattern.trim() !== '' || applied.type !== ''

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1 className="mono">{clustered ? 'Keys' : `db${db}`}</h1>
          <span className="muted">keys{applied.pattern ? ` matching ${applied.pattern}` : ''}</span>
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {scan.total !== null ? <Chip>{formatCount(scan.total)} keys</Chip> : null}
          {info.data ? (
            <Chip>
              {info.data.flavor} {info.data.version}
              {info.data.mode !== 'standalone' ? ` · ${info.data.mode}` : ''}
            </Chip>
          ) : null}
        </div>
        <div className="broker-toolbar">
          {clustered ? null : (
            <select
              aria-label="Database"
              value={db}
              onChange={(event) =>
                workbench.openRedis(connectionId, { view: 'keys', db: Number(event.target.value) })
              }
            >
              {Array.from({ length: Math.min(databases, 256) }, (_, i) => i).map((i) => (
                <option key={i} value={i}>
                  db{i}
                  {keyspace.get(i) ? ` (${formatCount(keyspace.get(i)!)})` : ''}
                </option>
              ))}
            </select>
          )}
          <input
            type="search"
            className="redis-pattern mono"
            placeholder="Search keys: text, or a pattern like user:*"
            aria-label="Key pattern"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') apply()
            }}
            spellCheck={false}
          />
          <select
            aria-label="Type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as RedisType | '')}
          >
            <option value="">Any type</option>
            {CORE_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          <Button variant="primary" onClick={apply}>
            Search
          </Button>
          <span className="spacer" />
          <LockButton connectionId={connectionId} allows="creating, editing and deleting keys" />
        </div>
        <div className="broker-toolbar">
          <Button icon={<Plus size={14} />} onClick={() => setDialog('new')}>
            New key
          </Button>
          <Button
            icon={<Trash2 size={14} />}
            disabled={selected === null}
            onClick={() => selected !== null && void remove(selected)}
          >
            Delete
          </Button>
          <Button icon={<Trash2 size={14} />} variant="ghost" onClick={() => setDialog('delete')}>
            Delete matching…
          </Button>
          <Button
            icon={<Gauge size={14} />}
            variant="ghost"
            disabled={measuring || scan.keys.length === 0}
            title="Asks the server how much memory each loaded key takes (MEMORY USAGE). It looks inside each key, so it is slower on big ones."
            onClick={() => void measure()}
          >
            {measuring ? 'Measuring…' : 'Measure sizes'}
          </Button>
          <span className="muted redis-hint">Double-click a key to open it.</span>
        </div>
      </header>

      <div className="broker-body broker-body-fill">
        {scan.error ? (
          <p className="note-error" role="alert">
            {scan.error}
          </p>
        ) : null}

        <div className="broker-grid" role="table" aria-label="Keys">
          <div className="redis-krow broker-qrow broker-qhead" role="row">
            {(
              [
                ['key', 'Key'],
                ['type', 'Type'],
                ['ttl', 'TTL'],
                ['size', 'Size'],
              ] as [SortKey, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="columnheader"
                className={key === 'size' || key === 'ttl' ? 'broker-num' : ''}
                aria-sort={
                  sort.key === key ? (sort.descending ? 'descending' : 'ascending') : 'none'
                }
                onClick={() =>
                  setSort((s) => ({ key, descending: s.key === key ? !s.descending : false }))
                }
              >
                {label}
                {sort.key === key ? (
                  sort.descending ? (
                    <ArrowDown size={11} />
                  ) : (
                    <ArrowUp size={11} />
                  )
                ) : null}
              </button>
            ))}
          </div>
          {scan.loading ? (
            <p className="muted pad">
              Scanning…{' '}
              <Button variant="ghost" icon={<Square size={12} />} onClick={scan.stop}>
                Stop
              </Button>
            </p>
          ) : rows.length === 0 ? (
            <p className="muted pad">
              {scan.done
                ? filtered
                  ? 'No keys match.'
                  : 'This database has no keys.'
                : 'No keys in what was scanned so far. Load more to keep looking.'}
            </p>
          ) : (
            <VirtualRows
              count={rows.length}
              rowHeight={ROW_HEIGHT}
              render={(index) => {
                const row = rows[index]!
                const size = sizes[row.key]
                return (
                  <div
                    key={row.key}
                    role="row"
                    tabIndex={0}
                    aria-selected={selected === row.key}
                    className={`redis-krow broker-qrow ${selected === row.key ? 'selected' : ''}`}
                    style={{ height: ROW_HEIGHT }}
                    onClick={() => setSelected(row.key)}
                    onDoubleClick={() => open(row.key)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') open(row.key)
                    }}
                  >
                    <span className="mono broker-name" title={printable(row.key)}>
                      {printable(row.key)}
                    </span>
                    <span>
                      <TypeBadge type={row.type} />
                    </span>
                    <span className="broker-num muted">
                      {row.ttlMs === null ? '–' : describeTtl(row.ttlMs)}
                    </span>
                    <span className="broker-num muted">
                      {row.key in sizes
                        ? size === null || size === undefined
                          ? '–'
                          : formatBytes(size)
                        : ''}
                    </span>
                  </div>
                )
              }}
            />
          )}
        </div>

        <p className="redis-status muted">
          {formatCount(rows.length)} keys loaded
          {scan.loading ? '' : scan.done ? ' · reached the end of the keyspace' : ' · more to scan'}
          {filtered && !scan.loading ? ` · looked at about ${formatCount(scan.examined)} keys` : ''}
          {scan.loadingMore ? (
            <>
              {' · '}
              <Button variant="ghost" icon={<Square size={12} />} onClick={scan.stop}>
                Stop
              </Button>
            </>
          ) : !scan.loading && !scan.done ? (
            <>
              {' · '}
              <Button variant="ghost" onClick={scan.loadMore}>
                Load more
              </Button>
            </>
          ) : null}
        </p>
      </div>

      {dialog === 'new' ? (
        <NewKeyDialog
          connectionId={connectionId}
          db={db}
          onClose={() => setDialog(null)}
          onDone={(key) => {
            scan.reload()
            open(key)
          }}
        />
      ) : null}
      {dialog === 'delete' ? (
        <BulkDeleteDialog
          connectionId={connectionId}
          db={db}
          pattern={typed}
          type={typeFilter}
          onClose={() => setDialog(null)}
          onDone={() => {
            scan.reload()
            setSelected(null)
          }}
        />
      ) : null}
    </div>
  )
}
