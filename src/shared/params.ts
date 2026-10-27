import type { SqlDialect } from './dialect'
import { maskSql } from './sql'
import { sqlLiteral } from './value'

/**
 * Named parameters in a SQL script: `WHERE id = :id AND day >= :since`. A name starts with a colon and is not inside
 * a string, a comment or a quoted name; `::int` casts and `:=` assignments are not parameters.
 */

export type ParamKind = 'text' | 'number' | 'null'

export interface ParamValue {
  kind: ParamKind
  value: string
}

const PARAMETER = /(?<![:\w$]):([A-Za-z_]\w*)/g

/** Where each parameter appears in a statement: the offset of its colon and its name. */
export function parameterSites(
  sql: string,
  dialect: SqlDialect = 'mysql',
): { at: number; name: string }[] {
  const masked = maskSql(sql, dialect)
  const sites: { at: number; name: string }[] = []
  for (const match of masked.matchAll(PARAMETER)) {
    // `:=` is an assignment, and `a:b` inside a JSON path or a time is not ours: the match needs a word to follow.
    sites.push({ at: match.index, name: match[1]! })
  }
  return sites
}

/** The parameter names in some statements, each once, in the order they first appear. */
export function findParameters(
  statements: readonly string[],
  dialect: SqlDialect = 'mysql',
): string[] {
  const names: string[] = []
  for (const sql of statements) {
    for (const site of parameterSites(sql, dialect))
      if (!names.includes(site.name)) names.push(site.name)
  }
  return names
}

export type Substitution = { ok: true; statements: string[] } | { ok: false; message: string }

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

/** The statements with every parameter written in as a literal of the right kind. */
export function substituteParameters(
  statements: readonly string[],
  values: Readonly<Record<string, ParamValue>>,
  dialect: SqlDialect = 'mysql',
): Substitution {
  const out: string[] = []
  for (const sql of statements) {
    let text = sql
    for (const site of [...parameterSites(sql, dialect)].reverse()) {
      const given = values[site.name]
      if (!given) return { ok: false, message: `Give a value for :${site.name}.` }
      let literal: string
      if (given.kind === 'null') literal = 'NULL'
      else if (given.kind === 'number') {
        const trimmed = given.value.trim()
        if (!NUMBER.test(trimmed))
          return { ok: false, message: `:${site.name} should be a number.` }
        literal = trimmed
      } else literal = sqlLiteral(given.value, undefined, dialect)
      text = text.slice(0, site.at) + literal + text.slice(site.at + 1 + site.name.length)
    }
    out.push(text)
  }
  return { ok: true, statements: out }
}
