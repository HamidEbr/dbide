import { randomUUID } from 'node:crypto'
import type { Document, MongoClient } from 'mongodb'
import type {
  DriverSession,
  ExecuteRequest,
  ResultBatch,
  SessionInfo,
  TreeNode,
} from '@shared/driver'
import type { DocumentEditBatch, DocumentEditResult } from '@shared/mongo/documents'
import { classifyCommand, MongoSyntaxError, parseMongoStatement } from '@shared/mongo/lang'
import { isReadOnlySafe } from '@shared/sql'
import { applyDocumentEdits } from './edit'
import { MongoError, SessionClosedError, ShellError, syntaxError } from './errors'
import { runCommand } from './run'
import { collectionNames, treeChildren } from './tree'

/** How long a cancel may spend looking for the operations it should stop. */
const KILL_TIMEOUT_MS = 5000
const SAMPLE_DOCUMENTS = 30
const MAX_SAMPLED_FIELDS = 300
const MAX_FIELD_DEPTH = 3

function abortError(): Error {
  return new DOMException('The query was cancelled', 'AbortError')
}

/** Dotted paths of the fields in a plain document, down to a few levels. */
function collectPaths(value: unknown, prefix: string, depth: number, into: Set<string>): void {
  if (value === null || typeof value !== 'object' || depth > MAX_FIELD_DEPTH) return
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 3)) collectPaths(item, prefix, depth, into)
    return
  }
  // A BSON value (ObjectId, Date, ...) is a leaf, not a document with fields.
  const proto = Object.getPrototypeOf(value)
  if (proto !== Object.prototype && proto !== null) return
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    into.add(path)
    collectPaths(child, path, depth + 1, into)
  }
}

export class MongoSession implements DriverSession {
  private state: SessionInfo
  private closed = false
  /** The database statements run in: the toolbar's choice, or what `use` last said. */
  private current: string | null

  constructor(
    private readonly client: MongoClient,
    info: SessionInfo,
    private readonly details: { defaultDatabase?: string; transactions: boolean },
  ) {
    this.state = info
    this.current = info.currentDatabase
    // An idle connection that dies emits 'error'. Without a listener that would crash the core.
    client.on('error', () => undefined)
  }

  get info(): SessionInfo {
    return this.state
  }

  private assertOpen(): void {
    if (this.closed) throw new SessionClosedError()
  }

  /** What went wrong, as the error the rest of the app understands. */
  private translate(error: unknown, text: string, signal?: AbortSignal): Error {
    if (signal?.aborted) return abortError()
    if (error instanceof ShellError || error instanceof MongoError) return error
    if (error instanceof MongoSyntaxError) return syntaxError(error, text)
    return new MongoError(error)
  }

  async ping(): Promise<void> {
    this.assertOpen()
    try {
      await this.client.db('admin').command({ ping: 1 })
    } catch (error) {
      throw new MongoError(error)
    }
  }

  async children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]> {
    this.assertOpen()
    signal.throwIfAborted()
    try {
      return await treeChildren(this.client, parent, {
        ...(this.details.defaultDatabase ? { defaultDatabase: this.details.defaultDatabase } : {}),
        signal,
      })
    } catch (error) {
      throw this.translate(error, '', signal)
    }
  }

  /** Collection names, for autocomplete. Fields come from `sampleFields`, per collection. */
  async completionSchema(
    database: string | null,
    signal: AbortSignal,
  ): Promise<Record<string, string[]>> {
    this.assertOpen()
    const target = database ?? this.current
    if (!target) return {}
    try {
      const names = await collectionNames(this.client, target, signal)
      return Object.fromEntries(names.map((name) => [name, []]))
    } catch (error) {
      throw this.translate(error, '', signal)
    }
  }

  /** The field names a few documents of a collection have, for autocomplete. */
  async sampleFields(database: string, collection: string, signal: AbortSignal): Promise<string[]> {
    this.assertOpen()
    signal.throwIfAborted()
    try {
      const documents = await this.client
        .db(database)
        .collection(collection)
        .aggregate([{ $sample: { size: SAMPLE_DOCUMENTS } }], {
          promoteValues: true,
          maxTimeMS: 5000,
          signal,
        } as never)
        .toArray()
      const paths = new Set<string>()
      for (const document of documents) collectPaths(document, '', 1, paths)
      return [...paths].sort((a, b) => a.localeCompare(b)).slice(0, MAX_SAMPLED_FIELDS)
    } catch (error) {
      throw this.translate(error, '', signal)
    }
  }

  async setReadOnly(readOnly: boolean): Promise<void> {
    this.state = { ...this.state, readOnly }
  }

  async applyDocumentEdits(
    batch: DocumentEditBatch,
    signal: AbortSignal,
  ): Promise<DocumentEditResult> {
    this.assertOpen()
    if (this.state.readOnly) {
      return {
        ok: false,
        failedIndex: 0,
        code: 'READ_ONLY',
        message: 'This connection is read-only. Unlock writes to edit documents.',
        applied: 0,
      }
    }
    return applyDocumentEdits(this.client, batch, {
      transactions: this.details.transactions,
      signal,
    })
  }

  async *execute(request: ExecuteRequest, signal: AbortSignal): AsyncGenerator<ResultBatch> {
    this.assertOpen()
    signal.throwIfAborted()

    let command
    try {
      command = parseMongoStatement(request.text)
    } catch (error) {
      throw this.translate(error, request.text)
    }

    if (this.state.readOnly) {
      const info = classifyCommand(command)
      if (!isReadOnlySafe(info)) {
        const what =
          info.kind === 'unknown'
            ? 'DBIDE can’t tell what this command does.'
            : `This command is ${info.kind === 'ddl' ? 'a schema change' : info.kind === 'write' ? 'a data change' : 'an administrative command'}.`
        throw new ShellError(
          `This connection is read-only, and MongoDB can’t enforce that itself, so DBIDE didn’t send the command. ${what} Unlock writes to run it.`,
          'READ_ONLY',
        )
      }
    }

    if (request.target) this.current = request.target
    const tag = `dbide:${randomUUID()}`
    const cancel = (): void => void this.killOperations(tag)
    signal.addEventListener('abort', cancel, { once: true })

    try {
      yield* runCommand(command, {
        client: this.client,
        database: this.current,
        signal,
        tag,
        switchDatabase: (name) => {
          this.current = name
          this.state = { ...this.state, currentDatabase: name }
        },
      })
    } catch (error) {
      throw this.translate(error, request.text, signal)
    } finally {
      signal.removeEventListener('abort', cancel)
    }
  }

  /**
   * Stops what a cancelled statement left running on the server. The driver drops its side at once; this
   * finds the operation by the tag it carried and kills it, so a slow scan doesn't keep working for
   * nobody. Best effort: a login without the right to see its own operations just skips it.
   */
  private async killOperations(tag: string): Promise<void> {
    if (this.closed) return
    const work = (async (): Promise<void> => {
      const admin = this.client.db('admin')
      const reply = (await admin.command({ currentOp: 1, $ownOps: true, 'command.comment': tag }, {
        promoteValues: true,
      } as never)) as Document
      for (const op of (reply.inprog ?? []) as Document[]) {
        await admin.command({ killOp: 1, op: op.opid })
      }
    })().catch(() => undefined)
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      work,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, KILL_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.client.close().catch(() => undefined)
  }
}
