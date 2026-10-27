import { Copy, FileCode, LoaderCircle, Play, Plus, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { dialectOf, type SqlDialect } from '@shared/dialect'
import type { SchemaForeignKey, SchemaTable } from '@shared/driver'
import {
  aliasFor,
  buildSql,
  emptyBuilder,
  FILTER_OPERATORS,
  suggestJoin,
  type Aggregate,
  type Builder,
  type BuilderFilter,
  type BuilderTable,
  type FilterOperator,
  type JoinType,
} from '@shared/query-builder'
import { Button, IconButton } from '@/components/ui'
import { writeClipboard } from '@/lib/clipboard'
import { schemaCache } from '@/features/sql/completion/schema-cache'
import { createScript } from '@/features/sql/scripts'
import { useData } from '@/state/data'
import { useDialogs, type QueryBuilderRequest } from '@/state/dialogs'
import { notify } from '@/state/notices'

const AGGREGATES: Aggregate[] = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX']

export function QueryBuilderDialog() {
  const request = useDialogs((state) => state.queryBuilder)
  if (!request) return null
  return <BuilderBody request={request} />
}

interface ColumnChoice {
  alias: string
  column: string
  type: string
}

const key = (c: { alias: string; column: string }): string => `${c.alias}\u0000${c.column}`
const fromKey = (k: string): { alias: string; column: string } => {
  const [alias = '', column = ''] = k.split('\u0000')
  return { alias, column }
}

function BuilderBody({ request }: { request: QueryBuilderRequest }) {
  const close = useDialogs((state) => state.closeQueryBuilder)
  const { connectionId, database } = request
  const engine = useData((state) => state.connections.find((c) => c.id === connectionId)?.engine)
  const dialect: SqlDialect = (engine && dialectOf(engine)) || 'mysql'

  const [names, setNames] = useState<{ name: string; view: boolean }[]>([])
  const [filter, setFilter] = useState('')
  const [builder, setBuilder] = useState<Builder>(emptyBuilder)
  const [version, setVersion] = useState(0)
  const [reading, setReading] = useState(0)

  useEffect(() => {
    let alive = true
    void schemaCache.detail(connectionId, database).then((d) => {
      if (alive && d) setNames(d.tables.map((t) => ({ name: t.name, view: t.view })))
    })
    return () => {
      alive = false
    }
  }, [connectionId, database])

  const tableOf = (name: string): SchemaTable | undefined => {
    void version
    return schemaCache.peekTable(connectionId, database, name)
  }
  const choices: ColumnChoice[] = builder.tables.flatMap((t) =>
    (tableOf(t.table)?.columns ?? []).map((c) => ({
      alias: t.alias,
      column: c.name,
      type: c.type,
    })),
  )
  const keysOf = (table: string): SchemaForeignKey[] =>
    schemaCache.peekForeignKeys(connectionId, database, table)

  const addTable = async (name: string): Promise<void> => {
    setReading((n) => n + 1)
    await schemaCache.columns(connectionId, database, [name])
    setReading((n) => n - 1)
    setVersion((v) => v + 1)
    setBuilder((b) => {
      const alias = aliasFor(
        name,
        b.tables.map((t) => t.alias),
      )
      const next = { alias, schema: database, table: name }
      // A table with a foreign key to one already chosen (or the other way round) joins on it.
      const keys = [...keysOf(name), ...b.tables.flatMap((t) => keysOf(t.table))]
      const join =
        b.tables.length > 0
          ? (suggestJoin(next, b.tables, keys) ?? { type: 'INNER' as JoinType, on: [] })
          : undefined
      return { ...b, tables: [...b.tables, { ...next, ...(join ? { join } : {}) }] }
    })
  }

  const removeTable = (alias: string): void =>
    setBuilder((b) => ({
      ...b,
      tables: b.tables.filter((t) => t.alias !== alias),
      columns: b.columns.filter((c) => c.alias !== alias),
      filters: b.filters.filter((f) => f.alias !== alias),
      orderBy: b.orderBy.filter((o) => o.alias !== alias),
    }))

  const renameAlias = (from: BuilderTable, next: string): void => {
    if (next === '' || builder.tables.some((x) => x.alias === next && x !== from)) return
    const swap = (a: string): string => (a === from.alias ? next : a)
    setBuilder((b) => ({
      ...b,
      tables: b.tables.map((x) => ({
        ...x,
        alias: swap(x.alias),
        ...(x.join
          ? {
              join: {
                ...x.join,
                on: x.join.on.map((o) => ({
                  ...o,
                  alias: swap(o.alias),
                  otherAlias: swap(o.otherAlias),
                })),
              },
            }
          : {}),
      })),
      columns: b.columns.map((c) => ({ ...c, alias: swap(c.alias) })),
      filters: b.filters.map((f) => ({ ...f, alias: swap(f.alias) })),
      orderBy: b.orderBy.map((o) => ({ ...o, alias: swap(o.alias) })),
    }))
  }

  const sql = buildSql(builder, dialect)
  const options = choices.map((c) => (
    <option key={key(c)} value={key(c)}>
      {builder.tables.length > 1 ? `${c.alias}.` : ''}
      {c.column}
    </option>
  ))
  const patchFilter = (i: number, change: Partial<BuilderFilter>): void =>
    setBuilder((b) => ({
      ...b,
      filters: b.filters.map((f, j) => (j === i ? { ...f, ...change } : f)),
    }))

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-builder"
        role="dialog"
        aria-modal="true"
        aria-labelledby="builder-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          close()
        }}
      >
        <header>
          <h2 id="builder-title">Query builder · {database}</h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>
        <div className="builder-body">
          <aside className="builder-tables">
            <input
              aria-label="Filter tables"
              placeholder="Filter tables"
              value={filter}
              spellCheck={false}
              onChange={(event) => setFilter(event.target.value)}
            />
            <ul>
              {names
                .filter((t) => t.name.toLowerCase().includes(filter.trim().toLowerCase()))
                .slice(0, 300)
                .map((t) => (
                  <li key={t.name}>
                    <button
                      type="button"
                      onClick={() => void addTable(t.name)}
                      title="Add to the query"
                    >
                      <Plus size={11} aria-hidden /> {t.name}
                      {t.view ? <span className="muted"> view</span> : null}
                    </button>
                  </li>
                ))}
            </ul>
          </aside>

          <div className="builder-main">
            {builder.tables.length === 0 ? (
              <p className="muted tool-empty">Pick a table on the left to start.</p>
            ) : (
              <>
                <section>
                  <h3>
                    From{' '}
                    {reading > 0 ? <LoaderCircle size={12} className="spin" aria-hidden /> : null}
                  </h3>
                  {builder.tables.map((t, i) => (
                    <div className="builder-table" key={t.alias}>
                      <div className="builder-table-head">
                        {i > 0 ? (
                          <select
                            aria-label={`How ${t.table} joins`}
                            value={t.join?.type ?? 'INNER'}
                            onChange={(event) =>
                              setBuilder((b) => ({
                                ...b,
                                tables: b.tables.map((x) =>
                                  x.alias === t.alias
                                    ? {
                                        ...x,
                                        join: {
                                          on: x.join?.on ?? [],
                                          type: event.target.value as JoinType,
                                        },
                                      }
                                    : x,
                                ),
                              }))
                            }
                          >
                            <option value="INNER">Join</option>
                            <option value="LEFT">Left join</option>
                            <option value="RIGHT">Right join</option>
                          </select>
                        ) : (
                          <span className="muted">From</span>
                        )}
                        <strong className="mono">{t.table}</strong>
                        <span className="muted">as</span>
                        <input
                          className="mono builder-alias"
                          aria-label={`Alias of ${t.table}`}
                          value={t.alias}
                          spellCheck={false}
                          onChange={(event) =>
                            renameAlias(t, event.target.value.replace(/\W/g, ''))
                          }
                        />
                        <IconButton
                          label={`Remove ${t.table}`}
                          onClick={() => removeTable(t.alias)}
                        >
                          <X size={12} />
                        </IconButton>
                      </div>
                      {i > 0 ? (
                        <div className="builder-on">
                          {(t.join?.on ?? []).length === 0 ? (
                            <span className="muted">
                              No foreign key links these: choose a column that matches one of{' '}
                              {builder.tables[0]!.table}.
                            </span>
                          ) : null}
                          {(t.join?.on ?? []).map((o, j) => (
                            <span key={j} className="mono">
                              {o.otherAlias}.{o.otherColumn} = {o.alias}.{o.column}
                            </span>
                          ))}
                          <select
                            aria-label={`Match a column of ${t.table}`}
                            value=""
                            onChange={(event) => {
                              const picked = fromKey(event.target.value)
                              setBuilder((b) => ({
                                ...b,
                                tables: b.tables.map((x) =>
                                  x.alias === t.alias
                                    ? {
                                        ...x,
                                        join: {
                                          type: x.join?.type ?? 'INNER',
                                          on: [
                                            ...(x.join?.on ?? []),
                                            {
                                              alias: t.alias,
                                              column: picked.column,
                                              otherAlias: b.tables[0]!.alias,
                                              otherColumn: picked.column,
                                            },
                                          ],
                                        },
                                      }
                                    : x,
                                ),
                              }))
                            }}
                          >
                            <option value="">Match on…</option>
                            {choices
                              .filter((c) => c.alias === t.alias)
                              .map((c) => (
                                <option key={key(c)} value={key(c)}>
                                  {c.column} = {builder.tables[0]!.alias}.{c.column}
                                </option>
                              ))}
                          </select>
                        </div>
                      ) : null}
                      <div className="builder-columns">
                        {choices
                          .filter((c) => c.alias === t.alias)
                          .map((c) => (
                            <label className="check" key={key(c)}>
                              <input
                                type="checkbox"
                                checked={builder.columns.some((x) => key(x) === key(c))}
                                onChange={(event) =>
                                  setBuilder((b) => ({
                                    ...b,
                                    columns: event.target.checked
                                      ? [...b.columns, { alias: c.alias, column: c.column }]
                                      : b.columns.filter((x) => key(x) !== key(c)),
                                  }))
                                }
                              />
                              <span className="mono">{c.column}</span>
                              <span className="muted">{c.type}</span>
                            </label>
                          ))}
                      </div>
                    </div>
                  ))}
                </section>

                {builder.columns.length > 0 ? (
                  <section>
                    <h3>Result columns</h3>
                    {builder.columns.map((c, i) => (
                      <div className="builder-row" key={key(c)}>
                        <span className="mono">
                          {c.alias}.{c.column}
                        </span>
                        <select
                          aria-label={`Summary of ${c.column}`}
                          value={c.aggregate ?? ''}
                          onChange={(event) =>
                            setBuilder((b) => ({
                              ...b,
                              columns: b.columns.map((x, j) => {
                                if (j !== i) return x
                                const { aggregate: _drop, ...rest } = x
                                return event.target.value
                                  ? { ...rest, aggregate: event.target.value as Aggregate }
                                  : rest
                              }),
                            }))
                          }
                        >
                          <option value="">as is</option>
                          {AGGREGATES.map((a) => (
                            <option key={a} value={a}>
                              {a}
                            </option>
                          ))}
                        </select>
                        <input
                          className="mono"
                          aria-label={`Heading of ${c.column}`}
                          placeholder="heading"
                          value={c.as ?? ''}
                          spellCheck={false}
                          onChange={(event) =>
                            setBuilder((b) => ({
                              ...b,
                              columns: b.columns.map((x, j) => {
                                if (j !== i) return x
                                const { as: _drop, ...rest } = x
                                return event.target.value
                                  ? { ...rest, as: event.target.value }
                                  : rest
                              }),
                            }))
                          }
                        />
                      </div>
                    ))}
                  </section>
                ) : null}

                <section>
                  <h3>Rows where</h3>
                  {builder.filters.map((f, i) => (
                    <div className="builder-row" key={i}>
                      {i > 0 ? (
                        <select
                          aria-label="And or or"
                          value={f.logic}
                          onChange={(event) =>
                            patchFilter(i, { logic: event.target.value as 'AND' | 'OR' })
                          }
                        >
                          <option>AND</option>
                          <option>OR</option>
                        </select>
                      ) : null}
                      <select
                        aria-label="Filter column"
                        value={key(f)}
                        onChange={(event) => patchFilter(i, fromKey(event.target.value))}
                      >
                        {options}
                      </select>
                      <select
                        aria-label="Operator"
                        value={f.operator}
                        onChange={(event) =>
                          patchFilter(i, { operator: event.target.value as FilterOperator })
                        }
                      >
                        {FILTER_OPERATORS.map((o) => (
                          <option key={o}>{o}</option>
                        ))}
                      </select>
                      {f.operator === 'IS NULL' || f.operator === 'IS NOT NULL' ? null : (
                        <>
                          <input
                            className="mono"
                            aria-label="Filter value"
                            placeholder={
                              f.operator === 'IN' || f.operator === 'BETWEEN'
                                ? 'a, b'
                                : f.kind === 'parameter'
                                  ? 'name'
                                  : 'value'
                            }
                            value={f.value}
                            spellCheck={false}
                            onChange={(event) => patchFilter(i, { value: event.target.value })}
                          />
                          <select
                            aria-label="Kind of value"
                            value={f.kind}
                            onChange={(event) =>
                              patchFilter(i, { kind: event.target.value as BuilderFilter['kind'] })
                            }
                          >
                            <option value="text">text</option>
                            <option value="number">number</option>
                            <option value="parameter">ask when run</option>
                          </select>
                        </>
                      )}
                      <IconButton
                        label="Remove this condition"
                        onClick={() =>
                          setBuilder((b) => ({
                            ...b,
                            filters: b.filters.filter((_, j) => j !== i),
                          }))
                        }
                      >
                        <X size={12} />
                      </IconButton>
                    </div>
                  ))}
                  <Button
                    icon={<Plus size={12} />}
                    disabled={choices.length === 0}
                    onClick={() =>
                      setBuilder((b) => ({
                        ...b,
                        filters: [
                          ...b.filters,
                          {
                            alias: choices[0]!.alias,
                            column: choices[0]!.column,
                            operator: '=',
                            value: '',
                            kind: 'text',
                            logic: 'AND',
                          },
                        ],
                      }))
                    }
                  >
                    Add a condition
                  </Button>
                </section>

                <section>
                  <h3>Order and size</h3>
                  <div className="builder-row">
                    <select
                      aria-label="Order by"
                      value={builder.orderBy[0] ? key(builder.orderBy[0]) : ''}
                      onChange={(event) =>
                        setBuilder((b) => ({
                          ...b,
                          orderBy: event.target.value
                            ? [
                                {
                                  ...fromKey(event.target.value),
                                  direction: b.orderBy[0]?.direction ?? 'ASC',
                                },
                              ]
                            : [],
                        }))
                      }
                    >
                      <option value="">No order</option>
                      {options}
                    </select>
                    <select
                      aria-label="Direction"
                      value={builder.orderBy[0]?.direction ?? 'ASC'}
                      disabled={builder.orderBy.length === 0}
                      onChange={(event) =>
                        setBuilder((b) => ({
                          ...b,
                          orderBy: b.orderBy.map((o) => ({
                            ...o,
                            direction: event.target.value as 'ASC' | 'DESC',
                          })),
                        }))
                      }
                    >
                      <option value="ASC">ascending</option>
                      <option value="DESC">descending</option>
                    </select>
                    <input
                      className="mono"
                      aria-label="At most this many rows"
                      placeholder="all rows"
                      inputMode="numeric"
                      value={builder.limit ?? ''}
                      onChange={(event) => {
                        const n = Number(event.target.value)
                        setBuilder((b) => ({
                          ...b,
                          limit:
                            event.target.value.trim() === ''
                              ? null
                              : Number.isInteger(n) && n >= 0
                                ? n
                                : b.limit,
                        }))
                      }}
                    />
                    <label className="check">
                      <input
                        type="checkbox"
                        checked={builder.distinct}
                        onChange={(event) =>
                          setBuilder((b) => ({ ...b, distinct: event.target.checked }))
                        }
                      />
                      <span>Distinct</span>
                    </label>
                  </div>
                </section>
              </>
            )}
          </div>
        </div>

        <pre className="dialog-sql mono selectable export-sql builder-sql" tabIndex={0}>
          {sql ?? '-- Pick a table to see the SQL.'}
        </pre>
        <footer>
          <Button
            variant="ghost"
            icon={<Copy size={13} />}
            disabled={!sql}
            onClick={() => void writeClipboard(sql!).then(() => notify('SQL copied.'))}
          >
            Copy
          </Button>
          <Button
            variant="ghost"
            icon={<FileCode size={13} />}
            disabled={!sql}
            onClick={() => {
              createScript({ connectionId, database, text: sql!, name: 'query' })
              close()
            }}
          >
            Open as a script
          </Button>
          <Button
            variant="primary"
            icon={<Play size={13} />}
            disabled={!sql}
            onClick={() => {
              createScript({ connectionId, database, text: sql!, name: 'query', run: true })
              close()
            }}
          >
            Run
          </Button>
        </footer>
      </div>
    </div>
  )
}
