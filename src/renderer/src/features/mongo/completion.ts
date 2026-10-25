import type { Completion, CompletionContext, CompletionResult } from '@codemirror/autocomplete'
import {
  COLLECTION_METHODS,
  CURSOR_METHODS,
  DATABASE_METHODS,
  EXPRESSION_OPERATORS,
  PIPELINE_STAGES,
  QUERY_OPERATORS,
  UPDATE_OPERATORS,
  VALUE_HELPERS,
  type Suggestion,
} from '@shared/mongo/names'
import { splitMongoStatements } from '@shared/mongo/lang'

export interface CompletionEnv {
  /** The collections of the database the script runs in. */
  collections: () => string[]
  /** Field names a few documents of a collection have. Resolves to nothing when they can't be read. */
  fields: (database: string | null, collection: string) => Promise<string[]>
}

const FIELD_WAIT_MS = 1500

const toOptions = (list: Suggestion[], type: string): Completion[] =>
  list.map((item) => ({
    label: item.name,
    detail: item.detail,
    type,
    ...(item.insert ? { apply: item.insert } : {}),
  }))

/** What the statement being typed is about: its collection, and the database if it names another. */
function subjectOf(statement: string): { database: string | null; collection: string } | null {
  const match =
    /^\s*db\.(?:getSiblingDB\(\s*["']([^"']*)["']\s*\)\.)?(?:getCollection\(\s*["']([^"']+)["']\s*\)|([A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*?))\./.exec(
      statement,
    )
  if (!match) return null
  const collection = match[2] ?? match[3]
  return collection ? { database: match[1] ?? null, collection } : null
}

const wait = <T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

/**
 * Suggestions for a script: collections after `db.`, methods after a collection and after a query's closing
 * bracket, `$` operators, the field names of the collection being queried, and BSON helpers where a value goes.
 */
export function mongoCompletionSource(env: CompletionEnv, defaultDatabase: () => string | null) {
  return async (context: CompletionContext): Promise<CompletionResult | null> => {
    const doc = context.state.doc.toString()
    const statements = splitMongoStatements(doc)
    // The statement the cursor is in; a cursor past the last one starts a new statement.
    const current = statements.find((s) => context.pos >= s.from && context.pos <= s.end + 1)
    const statementText =
      current && context.pos >= current.from ? doc.slice(current.from, context.pos) : ''
    const done = (from: number, options: Completion[]): CompletionResult => ({
      from,
      options,
      validFor: /^[\w$.]*$/,
    })

    // db.<collection or method>
    const afterDb = /(?:^|[^\w$.])db\.([A-Za-z_$][\w$]*)?$/.exec(statementText)
    if (afterDb) {
      const partial = afterDb[1] ?? ''
      return done(context.pos - partial.length, [
        ...env.collections().map((name): Completion => ({
          label: name,
          type: 'class',
          detail: 'collection',
          ...(/^[A-Za-z_$][\w$]*$/.test(name)
            ? {}
            : { apply: `getCollection(${JSON.stringify(name)})` }),
        })),
        ...toOptions(DATABASE_METHODS, 'method'),
      ])
    }

    // db.<collection>.<method>
    const afterCollection =
      /\bdb\.(?:getSiblingDB\([^)]*\)\.)?(?:getCollection\(\s*(?:"[^"]*"|'[^']*')\s*\)|[A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)?$/.exec(
        statementText,
      )
    if (afterCollection) {
      const partial = afterCollection[1] ?? ''
      return done(context.pos - partial.length, toOptions(COLLECTION_METHODS, 'method'))
    }

    // find(...).<cursor method>
    const afterCall = /\)\s*\.([A-Za-z_$][\w$]*)?$/.exec(statementText)
    if (afterCall) {
      const partial = afterCall[1] ?? ''
      return done(context.pos - partial.length, toOptions(CURSOR_METHODS, 'method'))
    }

    // $operator
    const operator = /(\$[A-Za-z]*)$/.exec(statementText)
    if (operator) {
      const word = operator[1]!
      const inPipeline = /\.aggregate\(/.test(statementText)
      const inUpdate = /\.(?:updateOne|updateMany|findOneAndUpdate)\(/.test(statementText)
      const options = inPipeline
        ? [...PIPELINE_STAGES, ...QUERY_OPERATORS, ...EXPRESSION_OPERATORS]
        : inUpdate
          ? [...UPDATE_OPERATORS, ...QUERY_OPERATORS]
          : [...QUERY_OPERATORS, ...UPDATE_OPERATORS, ...PIPELINE_STAGES]
      return done(context.pos - word.length, toOptions(options, 'keyword'))
    }

    // A field name, where a key goes.
    const key = /([{,]\s*)(["']?)([\w.]*)$/.exec(statementText)
    const subject = subjectOf(statementText)
    if (
      key &&
      subject &&
      /\.(?:find|findOne|aggregate|count|countDocuments|distinct|update\w*|delete\w*|findOneAnd\w+|replaceOne)\(/.test(
        statementText,
      )
    ) {
      const partial = key[3] ?? ''
      const quoted = key[2] !== ''
      const database = subject.database ?? defaultDatabase()
      const fields = await wait(
        env.fields(database, subject.collection),
        [] as string[],
        FIELD_WAIT_MS,
      )
      if (
        fields.length > 0 &&
        (partial !== '' || context.explicit || quoted || /[{,]\s*$/.test(statementText))
      ) {
        return done(
          context.pos - partial.length,
          fields.map((name): Completion => {
            const bare = /^[A-Za-z_$][\w$]*$/.test(name)
            return {
              label: name,
              type: 'property',
              detail: 'field',
              ...(quoted || bare ? {} : { apply: JSON.stringify(name) }),
            }
          }),
        )
      }
    }

    // ObjectId(...), ISODate(...), where a value goes.
    const value = /(?:[:[,(]\s*)([A-Z][A-Za-z]*)$/.exec(statementText)
    if (value) {
      return done(context.pos - value[1]!.length, toOptions(VALUE_HELPERS, 'function'))
    }

    // The start of a statement.
    const start = /^\s*([A-Za-z]*)$/.exec(statementText)
    if (start && (statementText !== '' || context.explicit)) {
      return done(context.pos - (start[1] ?? '').length, [
        { label: 'db', type: 'variable', detail: 'the current database' },
        { label: 'use', type: 'keyword', detail: 'switch database', apply: 'use ' },
        { label: 'show dbs', type: 'keyword', detail: 'list databases' },
        { label: 'show collections', type: 'keyword', detail: 'list collections' },
      ])
    }
    return null
  }
}
