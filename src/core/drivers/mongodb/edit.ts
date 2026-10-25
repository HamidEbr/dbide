import type { Document, MongoClient } from 'mongodb'
import type { Json } from '@shared/mongo/ejson'
import type { DocumentChange, DocumentEditBatch, DocumentEditResult } from '@shared/mongo/documents'
import { fromEjson, plainNumber, toEjsonText } from './bson'
import { describeMongoError } from './errors'

/** A change that can't be applied. Thrown from inside the transaction so everything rolls back. */
class ChangeFailed extends Error {
  constructor(
    readonly index: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

const GONE = 'That document no longer exists, or its _id changed since it was loaded.'

/** Applies one change and returns the document as stored afterwards, or null for a delete. */
async function applyOne(
  client: MongoClient,
  batch: DocumentEditBatch,
  change: DocumentChange,
  index: number,
  session: unknown,
): Promise<string | null> {
  const collection = client.db(batch.database).collection(batch.collection)
  const options = { session } as never

  if (change.kind === 'insert') {
    const document = fromEjson(change.document) as Document
    await collection.insertOne(document, options)
    // The driver adds the _id it generated to the document it was given.
    return toEjsonText(document)
  }

  const filter = { _id: fromEjson(change.id) }
  if (change.kind === 'delete') {
    const result = await collection.deleteOne(filter, options)
    if (plainNumber(result.deletedCount) !== 1) throw new ChangeFailed(index, 'ROW_COUNT', GONE)
    return null
  }

  if ('_id' in change.set || change.unset.includes('_id')) {
    throw new ChangeFailed(index, 'INVALID_INPUT', 'The _id of a document can’t be changed.')
  }
  const update: Document = {}
  if (Object.keys(change.set).length > 0) update.$set = fromEjson(change.set as Json)
  if (change.unset.length > 0) {
    update.$unset = Object.fromEntries(change.unset.map((path) => [path, '']))
  }
  if (Object.keys(update).length === 0) {
    throw new ChangeFailed(index, 'INVALID_INPUT', 'There is nothing to change.')
  }
  const after = await collection.findOneAndUpdate(filter, update, {
    session,
    returnDocument: 'after',
  } as never)
  if (!after) throw new ChangeFailed(index, 'ROW_COUNT', GONE)
  return toEjsonText(after)
}

/**
 * Applies document changes. On a replica set or a sharded cluster they are one transaction, so either
 * every change lands or none does. A standalone server has no transactions: the changes are made one
 * after another, a failure stops the rest, and the result says how many were already made.
 */
export async function applyDocumentEdits(
  client: MongoClient,
  batch: DocumentEditBatch,
  options: { transactions: boolean; signal: AbortSignal },
): Promise<DocumentEditResult> {
  const { signal } = options
  signal.throwIfAborted()
  let applied = 0
  let index = 0

  try {
    if (options.transactions) {
      const session = client.startSession()
      try {
        const results: { document: string | null }[] = []
        await session.withTransaction(async () => {
          // The callback can run again after a transient error, so it starts from nothing each time.
          results.length = 0
          for (index = 0; index < batch.changes.length; index++) {
            signal.throwIfAborted()
            results.push({
              document: await applyOne(client, batch, batch.changes[index]!, index, session),
            })
          }
        })
        return { ok: true, results, atomic: true }
      } finally {
        await session.endSession().catch(() => undefined)
      }
    }

    const results: { document: string | null }[] = []
    for (index = 0; index < batch.changes.length; index++) {
      signal.throwIfAborted()
      results.push({
        document: await applyOne(client, batch, batch.changes[index]!, index, undefined),
      })
      applied = index + 1
    }
    return { ok: true, results, atomic: false }
  } catch (error) {
    if (signal.aborted) throw error
    const note = options.transactions
      ? ' Nothing was saved.'
      : applied > 0
        ? ` ${applied} earlier change${applied === 1 ? ' was' : 's were'} already saved, because this server has no transactions.`
        : ' Nothing was saved.'
    if (error instanceof ChangeFailed) {
      return {
        ok: false,
        failedIndex: error.index,
        code: error.code,
        message: `${error.message}${note}`,
        applied: options.transactions ? 0 : applied,
      }
    }
    const described = describeMongoError(error)
    return {
      ok: false,
      failedIndex: index,
      code: described.code,
      message: `${described.message}${note}`,
      applied: options.transactions ? 0 : applied,
    }
  }
}
