import { isWrapper, type Json } from '@shared/mongo/ejson'

type Obj = { [key: string]: Json }

const isPlain = (value: Json | undefined): value is Obj =>
  typeof value === 'object' && value !== null && !Array.isArray(value) && !isWrapper(value)

/** Whether two values are the same. Documents are compared by what they hold, not by field order. */
export function same(a: Json | undefined, b: Json | undefined): boolean {
  if (a === b) return true
  if (a === undefined || b === undefined || a === null || b === null) return false
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((item, i) => same(item, b[i]))
  }
  if (Array.isArray(b)) return false
  if (typeof a !== 'object' || typeof b !== 'object') return false
  if (isWrapper(a) || isWrapper(b)) return JSON.stringify(a) === JSON.stringify(b)
  const keys = Object.keys(a)
  return (
    keys.length === Object.keys(b).length && keys.every((key) => key in b && same(a[key], b[key]))
  )
}

/** A field name that can be part of a dotted path in `$set`. */
const addressable = (key: string): boolean =>
  key !== '' && !key.includes('.') && !key.startsWith('$')

export interface FieldChanges {
  set: Record<string, Json>
  unset: string[]
}

export type Diff = { ok: true; changes: FieldChanges } | { ok: false; message: string }

/**
 * What it takes to turn one document into another with `$set` and `$unset` alone: only the fields that
 * differ are written, as dotted paths into sub-documents, so a change somebody else made to another
 * field in the meantime is left alone. Arrays and whole values are replaced as one.
 */
export function diffDocuments(original: Json, next: Json): Diff {
  if (!isPlain(original) || !isPlain(next)) {
    return { ok: false, message: 'A document is written { ... }.' }
  }
  if (!same(original._id, next._id)) {
    return { ok: false, message: 'The _id of a document can’t be changed. Insert a copy instead.' }
  }

  const set: Record<string, Json> = {}
  const unset: string[] = []

  const walk = (path: string, before: Obj, after: Obj): string | null => {
    for (const key of Object.keys(after)) {
      if (path === '' && key === '_id') continue
      const here = path === '' ? key : `${path}.${key}`
      if (!addressable(key)) {
        // A name with a dot can't be reached by a path; the whole parent is written instead.
        if (path === '')
          return `“${key}” can’t be edited here: field names with dots or a leading $ aren’t supported.`
        set[path] = after
        return null
      }
      const old = before[key]
      if (old === undefined) set[here] = after[key]!
      else if (!same(old, after[key])) {
        if (isPlain(old) && isPlain(after[key]) && Object.keys(old).length > 0) {
          const problem = walk(here, old, after[key])
          if (problem) return problem
        } else {
          set[here] = after[key]!
        }
      }
    }
    for (const key of Object.keys(before)) {
      if (path === '' && key === '_id') continue
      if (!(key in after)) {
        if (!addressable(key)) {
          if (path === '')
            return `“${key}” can’t be removed here: field names with dots or a leading $ aren’t supported.`
          set[path] = after
          return null
        }
        unset.push(path === '' ? key : `${path}.${key}`)
      }
    }
    return null
  }

  const problem = walk('', original, next)
  if (problem) return { ok: false, message: problem }

  // A parent that is written whole makes the paths under it redundant, and a conflict for the server.
  const parents = Object.keys(set)
  for (const path of Object.keys(set)) {
    if (parents.some((parent) => parent !== path && path.startsWith(`${parent}.`))) delete set[path]
  }
  const written = Object.keys(set)
  return {
    ok: true,
    changes: {
      set,
      unset: unset.filter((path) => !written.some((parent) => path.startsWith(`${parent}.`))),
    },
  }
}

/** The names of the top-level fields a set of changes touches, for a short summary. */
export function touchedFields(changes: FieldChanges): string[] {
  const names = new Set<string>()
  for (const path of [...Object.keys(changes.set), ...changes.unset]) names.add(path.split('.')[0]!)
  return [...names]
}

/** A copy of a document with one top-level field set. */
export function withField(document: Json, name: string, value: Json): Json {
  const source = isPlain(document) ? document : {}
  const out: Obj = {}
  let placed = false
  for (const [key, existing] of Object.entries(source)) {
    out[key] = key === name ? value : existing
    if (key === name) placed = true
  }
  if (!placed) out[name] = value
  return out
}
