import { CircleAlert, LoaderCircle, RefreshCw } from 'lucide-react'
import { schemaCache, useSchemaStatus } from './schema-cache'

/**
 * How far autocomplete has got with the database a script is in: reading its tables, how many it knows, reading
 * the columns of the ones a statement names, or why it could not. A failure has a button to try again.
 */
export function SchemaStatusChip({
  connectionId,
  database,
}: {
  connectionId: string
  database: string | null
}) {
  const status = useSchemaStatus(connectionId, database)
  if (!database || status.state === 'idle') return null

  if (status.state === 'failed') {
    return (
      <button
        type="button"
        className="schema-status schema-status-failed"
        title={`Autocomplete couldn’t read ${database}: ${status.error ?? 'unknown error'}. Click to try again.`}
        onClick={() => {
          schemaCache.invalidate(connectionId, database)
          void schemaCache.detail(connectionId, database)
        }}
      >
        <CircleAlert size={12} aria-hidden /> Names unavailable
        <RefreshCw size={11} aria-hidden />
      </button>
    )
  }

  const busy = status.state === 'loading' || status.reading > 0
  return (
    <span
      className="schema-status"
      role="status"
      title={
        status.state === 'loading'
          ? `Reading the tables of ${database} for autocomplete…`
          : `Autocomplete knows the ${status.tables.toLocaleString()} tables and views of ${database}. Columns are read when a statement names a table (${status.withColumns.toLocaleString()} so far).`
      }
    >
      {busy ? <LoaderCircle size={12} className="spin" aria-hidden /> : null}
      {status.state === 'loading'
        ? 'Reading tables…'
        : status.reading > 0
          ? 'Reading columns…'
          : `${status.tables.toLocaleString()} tables`}
    </span>
  )
}
