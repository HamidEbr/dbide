import { beforeEach, describe, expect, it } from 'vitest'
import type { Json } from '@shared/mongo/ejson'
import { buildBatch, changeCount, previews, stateOf, useDocumentEdits } from './edits'

const int = (n: number): Json => ({ $numberInt: String(n) })
const doc = (id: number, extra: Record<string, Json> = {}): Json => ({ _id: int(id), ...extra })
const source = { database: 'shop', collection: 'orders' }
const store = () => useDocumentEdits.getState()
const edits = (owner = 'r1') => store().byOwner[owner]

beforeEach(() => useDocumentEdits.setState({ byOwner: {} }))

describe('staging updates', () => {
  it('keeps what changed against the first loaded version', () => {
    const loaded = doc(1, { status: 'new', qty: int(1) })
    expect(store().stageUpdate('r1', loaded, doc(1, { status: 'paid', qty: int(1) }))).toBeNull()
    // Edited again from the already-edited version: the baseline is still what was loaded.
    expect(
      store().stageUpdate(
        'r1',
        doc(1, { status: 'paid', qty: int(1) }),
        doc(1, { status: 'paid', qty: int(2) }),
      ),
    ).toBeNull()
    expect(buildBatch(edits(), source)?.changes).toEqual([
      { kind: 'update', id: int(1), set: { status: 'paid', qty: int(2) }, unset: [] },
    ])
  })

  it('drops the update when the edits are undone', () => {
    const loaded = doc(1, { status: 'new' })
    store().stageUpdate('r1', loaded, doc(1, { status: 'paid' }))
    expect(changeCount(edits())).toBe(1)
    store().stageUpdate('r1', doc(1, { status: 'paid' }), loaded)
    expect(edits()).toBeUndefined()
  })

  it('refuses what can’t be saved, and stages nothing', () => {
    expect(store().stageUpdate('r1', doc(1), doc(2))).toMatch(/_id/)
    expect(store().stageUpdate('r1', { name: 'no id' }, { name: 'x' })).toMatch(/no _id/)
    expect(edits()).toBeUndefined()
  })
})

describe('deleting and inserting', () => {
  it('marks documents for deletion and unmarks them', () => {
    store().toggleDelete('r1', [doc(1), doc(2)])
    expect(changeCount(edits())).toBe(2)
    expect(stateOf(edits(), doc(1)).state).toBe('deleted')
    store().toggleDelete('r1', [doc(1), doc(2)])
    expect(edits()).toBeUndefined()
  })

  it('marks the rest when only some are marked already', () => {
    store().toggleDelete('r1', [doc(1)])
    store().toggleDelete('r1', [doc(1), doc(2)])
    expect(Object.keys(edits()!.deletes)).toHaveLength(2)
  })

  it('forgets the edits of a document that is deleted', () => {
    store().stageUpdate('r1', doc(1, { a: int(1) }), doc(1, { a: int(2) }))
    store().toggleDelete('r1', [doc(1, { a: int(1) })])
    expect(Object.keys(edits()!.updates)).toHaveLength(0)
    expect(buildBatch(edits(), source)?.changes).toEqual([{ kind: 'delete', id: int(1) }])
  })

  it('adds, changes and drops new documents', () => {
    const key = store().addInsert('r1', { name: 'x' })
    store().setInsert('r1', key, { name: 'y' })
    expect(edits()!.inserts).toEqual([{ key, document: { name: 'y' } }])
    store().removeInsert('r1', key)
    expect(edits()).toBeUndefined()
  })
})

describe('the batch', () => {
  it('lists updates, then deletes, then inserts, and previews each as a statement', () => {
    store().stageUpdate('r1', doc(1, { a: int(1) }), doc(1, { a: int(2) }))
    store().toggleDelete('r1', [doc(2)])
    store().addInsert('r1', { _id: int(3), a: int(3) })
    expect(buildBatch(edits(), source)?.changes.map((c) => c.kind)).toEqual([
      'update',
      'delete',
      'insert',
    ])
    expect(previews(edits(), source)).toEqual([
      'db.orders.updateOne({ _id: 1 }, { $set: { a: 2 } })',
      'db.orders.deleteOne({ _id: 2 })',
      'db.orders.insertOne({ _id: 3, a: 3 })',
    ])
  })

  it('has nothing to apply when nothing is staged', () => {
    expect(buildBatch(undefined, source)).toBeNull()
    expect(previews(undefined, source)).toEqual([])
  })

  it('keeps each result’s changes apart, and discards one result’s alone', () => {
    store().toggleDelete('r1', [doc(1)])
    store().toggleDelete('r2', [doc(1)])
    store().discard('r1')
    expect(edits('r1')).toBeUndefined()
    expect(changeCount(edits('r2'))).toBe(1)
  })
})

describe('stateOf', () => {
  it('shows a document with its edits applied', () => {
    const loaded = doc(1, { a: int(1) })
    store().stageUpdate('r1', loaded, doc(1, { a: int(2) }))
    expect(stateOf(edits(), loaded)).toEqual({ document: doc(1, { a: int(2) }), state: 'changed' })
    expect(stateOf(edits(), doc(9))).toEqual({ document: doc(9), state: 'clean' })
    expect(stateOf(undefined, doc(1))).toEqual({ document: doc(1), state: 'clean' })
  })
})
