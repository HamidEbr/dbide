import type { ColumnInfo } from '@shared/driver'
import { classifyStatement } from '@shared/sql'
import { coreLink } from '@/ipc/link'
import { useDialogs } from '@/state/dialogs'
import { notify } from '@/state/notices'
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

/**
 * Opens the export dialog for a whole table or view, from the tree. The columns come from the server, so the
 * dialog can offer them, and the SELECT is built from what is chosen there.
 */
export async function openTableExport(
  connectionId: string,
  schema: string,
  table: string,
): Promise<void> {
  try {
    const description = await coreLink.call('tables.describe', { connectionId, schema, table })
    useDialogs.getState().openExport({
      connectionId,
      database: schema,
      sql: '',
      columns: [],
      table: { schema, table, columns: description.columns.map((c) => c.name) },
    })
  } catch (error) {
    notify(error instanceof Error ? error.message : String(error), 'error')
  }
}
