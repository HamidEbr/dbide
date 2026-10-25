import type { ColumnInfo } from '@shared/driver'
import { classifyStatement } from '@shared/sql'
import { useDialogs } from '@/state/dialogs'
import { useScripts, type ResultSet, type StatementRun } from '@/state/scripts'

/** Why a result can't be exported yet, or null when it can. */
export function exportBlockedReason(statement: StatementRun): string | null {
  if (statement.status !== 'done' && statement.status !== 'paused') {
    return 'Wait for the query to finish first.'
  }
  if (classifyStatement(statement.sql).kind !== 'read') {
    return 'Only a query that reads data can be exported.'
  }
  return null
}

/** The table every column comes from, when there is exactly one. */
export function singleSourceName(columns: ColumnInfo[]): { schema: string; table: string } | null {
  const sources = columns.map((c) => c.source)
  const first = sources[0]
  if (!first || sources.some((s) => !s || s.schema !== first.schema || s.table !== first.table)) {
    return null
  }
  return { schema: first.schema, table: first.table }
}

/** Opens the export dialog for a result. The query is exported again in full, not the rows on screen. */
export function openExport(scriptId: string, statement: StatementRun, resultSet: ResultSet): void {
  const script = useScripts.getState().scripts[scriptId]
  if (!script || exportBlockedReason(statement)) return
  useDialogs.getState().openExport({
    scriptId,
    connectionId: script.connectionId,
    database: script.database,
    sql: statement.sql,
    columns: resultSet.columns,
  })
}
