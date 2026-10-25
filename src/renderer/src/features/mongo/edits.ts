import { create } from 'zustand'
import { previewChange, type DocumentChange, type DocumentEditBatch } from '@shared/mongo/documents'
import type { Json } from '@shared/mongo/ejson'
import { diffDocuments } from './diff'
import { idKey, keyOf } from './docs'

export interface StagedUpdate {
  id: Json
  /** The document as it was loaded. */
  original: Json
  /** The document with the edits applied. */
  next: Json
}

export interface StagedInsert {
  key: string
  document: Json
}

/** The unsaved changes of one result. Updates and deletes are keyed by the document's `_id`. */
export interface StagedEdits {
  updates: Record<string, StagedUpdate>
  deletes: Record<string, { id: Json; original: Json }>
  inserts: StagedInsert[]
}

const empty = (): StagedEdits => ({ updates: {}, deletes: {}, inserts: [] })

export function changeCount(edits: StagedEdits | undefined): number {
  if (!edits) return 0
  return (
    Object.keys(edits.updates).length + Object.keys(edits.deletes).length + edits.inserts.length
  )
}

/** The changes as the core applies them. Null when there is nothing to apply. */
export function buildBatch(
  edits: StagedEdits | undefined,
  source: { database: string; collection: string },
): DocumentEditBatch | null {
  if (!edits || changeCount(edits) === 0) return null
  const changes: DocumentChange[] = []
  for (const update of Object.values(edits.updates)) {
    const diff = diffDocuments(update.original, update.next)
    if (diff.ok && (Object.keys(diff.changes.set).length > 0 || diff.changes.unset.length > 0)) {
      changes.push({ kind: 'update', id: update.id, ...diff.changes })
    }
  }
  for (const doomed of Object.values(edits.deletes)) changes.push({ kind: 'delete', id: doomed.id })
  for (const insert of edits.inserts) changes.push({ kind: 'insert', document: insert.document })
  return { ...source, changes }
}

/** The statements the batch stands for, one per change, for showing before anything is saved. */
export function previews(
  edits: StagedEdits | undefined,
  source: { database: string; collection: string },
): string[] {
  const batch = buildBatch(edits, source)
  return batch ? batch.changes.map((change) => previewChange(batch, change)) : []
}

interface EditState {
  byOwner: Record<string, StagedEdits>
  /** Stages a document's new contents. Returns why it can't be staged, or null. */
  stageUpdate: (owner: string, original: Json, next: Json) => string | null
  /** Marks documents for deletion, or unmarks them when they all are already. New documents are just dropped. */
  toggleDelete: (owner: string, documents: Json[]) => void
  addInsert: (owner: string, document: Json) => string
  setInsert: (owner: string, key: string, document: Json) => void
  removeInsert: (owner: string, key: string) => void
  discard: (owner: string) => void
}

let inserted = 0

function patch(
  state: EditState,
  owner: string,
  update: (edits: StagedEdits) => StagedEdits,
): Pick<EditState, 'byOwner'> {
  const next = update(state.byOwner[owner] ?? empty())
  const byOwner = { ...state.byOwner }
  if (changeCount(next) === 0) delete byOwner[owner]
  else byOwner[owner] = next
  return { byOwner }
}

export const useDocumentEdits = create<EditState>((set, get) => ({
  byOwner: {},

  stageUpdate: (owner, original, next) => {
    const key = keyOf(original)
    if (key === null) return 'This document has no _id, so it can’t be edited.'
    // The first version stays the baseline, so editing twice still diffs against what was loaded.
    const baseline = get().byOwner[owner]?.updates[key]?.original ?? original
    const diff = diffDocuments(baseline, next)
    if (!diff.ok) return diff.message
    const nothing = Object.keys(diff.changes.set).length === 0 && diff.changes.unset.length === 0
    set((state) =>
      patch(state, owner, (edits) => {
        const updates = { ...edits.updates }
        if (nothing) delete updates[key]
        else updates[key] = { id: (baseline as { _id: Json })._id, original: baseline, next }
        return { ...edits, updates }
      }),
    )
    return null
  },

  toggleDelete: (owner, documents) =>
    set((state) =>
      patch(state, owner, (edits) => {
        const keys = documents.flatMap((doc) => {
          const key = keyOf(doc)
          return key === null ? [] : [{ key, doc }]
        })
        const allMarked = keys.length > 0 && keys.every(({ key }) => edits.deletes[key])
        const deletes = { ...edits.deletes }
        const updates = { ...edits.updates }
        for (const { key, doc } of keys) {
          if (allMarked) delete deletes[key]
          else {
            deletes[key] = { id: (doc as { _id: Json })._id, original: doc }
            // A document that is going away has no use for the edits made to it.
            delete updates[key]
          }
        }
        return { ...edits, deletes, updates }
      }),
    ),

  addInsert: (owner, document) => {
    const key = `new-${++inserted}`
    set((state) =>
      patch(state, owner, (edits) => ({
        ...edits,
        inserts: [...edits.inserts, { key, document }],
      })),
    )
    return key
  },

  setInsert: (owner, key, document) =>
    set((state) =>
      patch(state, owner, (edits) => ({
        ...edits,
        inserts: edits.inserts.map((i) => (i.key === key ? { key, document } : i)),
      })),
    ),

  removeInsert: (owner, key) =>
    set((state) =>
      patch(state, owner, (edits) => ({
        ...edits,
        inserts: edits.inserts.filter((i) => i.key !== key),
      })),
    ),

  discard: (owner) => set((state) => patch(state, owner, () => empty())),
}))

/** The staged state of a document: what it is now, and whether that differs from what was loaded. */
export function stateOf(
  edits: StagedEdits | undefined,
  document: Json,
): { document: Json; state: 'clean' | 'changed' | 'deleted' } {
  const key = keyOf(document)
  if (key === null || !edits) return { document, state: 'clean' }
  if (edits.deletes[key]) return { document, state: 'deleted' }
  const update = edits.updates[key]
  return update ? { document: update.next, state: 'changed' } : { document, state: 'clean' }
}

export { idKey }
