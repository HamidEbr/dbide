import { useEffect, useMemo } from 'react'
import type { ColumnInfo } from '@shared/driver'
import type { TableDescription } from '@shared/edit'
import { tableKey, useTables } from '@/state/tables'
import { linksByColumn, type FkLink } from './foreign-keys'

/**
 * The foreign keys a result can be followed along, by column. Each table the result reads from is
 * described once the query has finished; until then there are no links.
 */
export function useForeignKeys(
  connectionId: string,
  columns: readonly ColumnInfo[],
  ready: boolean,
): FkLink[][] {
  const tables = useTables((state) => state.tables)

  const sources = useMemo(() => {
    const seen = new Map<string, { schema: string; table: string }>()
    for (const column of columns) {
      if (column.source) {
        seen.set(`${column.source.schema}\u0000${column.source.table}`, {
          schema: column.source.schema,
          table: column.source.table,
        })
      }
    }
    return [...seen.entries()]
  }, [columns])

  useEffect(() => {
    if (!ready || !connectionId) return
    for (const [, source] of sources) {
      useTables.getState().load(connectionId, source.schema, source.table)
    }
  }, [ready, connectionId, sources])

  return useMemo(() => {
    const described = new Map<string, TableDescription>()
    for (const [id, source] of sources) {
      const state = tables[tableKey(connectionId, source.schema, source.table)]
      if (state?.status === 'ready') described.set(id, state.table)
    }
    return linksByColumn(columns, described)
  }, [columns, sources, tables, connectionId])
}
