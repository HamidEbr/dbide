import { documentSource } from '@shared/mongo/documents'
import { RpcError } from '@shared/rpc'
import { coreLink } from '@/ipc/link'
import { useScripts, type ResultSet } from '@/state/scripts'
import { buildBatch, useDocumentEdits } from './edits'
import { keyOf, parseDocument } from './docs'

/** The rows of the window by the key of the document they hold, for the keys asked about. */
function locate(rows: readonly (readonly unknown[])[], keys: Set<string>): Map<string, number> {
  const found = new Map<string, number>()
  for (let i = 0; i < rows.length && found.size < keys.size; i++) {
    const key = keyOf(parseDocument(rows[i]?.[0] as string | undefined))
    if (key !== null && keys.has(key)) found.set(key, i)
  }
  return found
}

/**
 * Saves a result's staged changes and brings the rows on screen in line with what the server stored.
 * Returns why it could not save, or null when it did (or when there was nothing to save).
 */
export async function commitDocuments(
  scriptId: string,
  resultSet: ResultSet,
): Promise<string | null> {
  const script = useScripts.getState().scripts[scriptId]
  const source = documentSource(resultSet.columns)
  const edits = useDocumentEdits.getState()
  const batch = buildBatch(edits.byOwner[resultSet.id], source ?? { database: '', collection: '' })
  if (!script || !source || !batch || batch.changes.length === 0) return null

  let result
  try {
    result = await coreLink.call('documents.apply', {
      connectionId: script.connectionId,
      scriptId,
      batch,
    })
  } catch (error) {
    return error instanceof RpcError || error instanceof Error ? error.message : String(error)
  }

  if (!result.ok) {
    // Changes that were made before the failure are on the server, and no longer match what is staged.
    if (result.applied > 0) {
      edits.discard(resultSet.id)
      return `${result.message} Run the query again to see the documents as they are now.`
    }
    return result.message
  }

  const { store } = resultSet
  const changedIds = new Set<string>()
  const deletedIds = new Set<string>()
  batch.changes.forEach((change) => {
    if (change.kind === 'insert') return
    const key = JSON.stringify(change.id)
    ;(change.kind === 'delete' ? deletedIds : changedIds).add(key)
  })
  const rowOf = locate(store.rows, new Set([...changedIds, ...deletedIds]))

  const appended: string[][] = []
  const dropped: number[] = []
  batch.changes.forEach((change, i) => {
    const stored = result.results[i]?.document ?? null
    if (change.kind === 'insert') {
      if (stored !== null) appended.push([stored])
    } else if (change.kind === 'delete') {
      const row = rowOf.get(JSON.stringify(change.id))
      if (row !== undefined) dropped.push(row)
    } else {
      const row = rowOf.get(JSON.stringify(change.id))
      if (row !== undefined && stored !== null) store.setCells(row, { 0: stored })
    }
  })
  if (dropped.length > 0) store.removeRows(dropped)
  if (appended.length > 0) store.append(appended)
  edits.discard(resultSet.id)
  return null
}
