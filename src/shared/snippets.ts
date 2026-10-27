/**
 * Snippets: a short word that expands into a whole statement, with places to fill in. The body uses
 * CodeMirror's template notation: `${name}` is a place to type (Tab moves to the next), `${}` an empty one, and
 * `#{1}` the same text in more than one place.
 */

export interface Snippet {
  /** What is typed: letters, digits and underscores. */
  trigger: string
  /** What the popup says it is. */
  name: string
  body: string
}

export type SnippetEngine = 'sql' | 'mongo'

export const MAX_SNIPPETS = 200
export const MAX_SNIPPET_BODY = 5000

export const BUILT_IN_SNIPPETS: Record<SnippetEngine, Snippet[]> = {
  sql: [
    {
      trigger: 'sel',
      name: 'SELECT … WHERE',
      body: 'SELECT ${columns}\nFROM ${table}\nWHERE ${condition}\nLIMIT ${1000};',
    },
    {
      trigger: 'selc',
      name: 'Count rows',
      body: 'SELECT COUNT(*)\nFROM ${table}\nWHERE ${condition};',
    },
    {
      trigger: 'selg',
      name: 'Count by group',
      body: 'SELECT ${column}, COUNT(*) AS total\nFROM ${table}\nGROUP BY ${column}\nORDER BY total DESC\nLIMIT ${100};',
    },
    {
      trigger: 'join',
      name: 'SELECT with a JOIN',
      body: 'SELECT ${a}.${columns}\nFROM ${table} ${a}\nJOIN ${other} ${b} ON ${b}.${key} = ${a}.${key}\nWHERE ${condition};',
    },
    {
      trigger: 'ins',
      name: 'INSERT',
      body: 'INSERT INTO ${table} (${columns})\nVALUES (${values});',
    },
    {
      trigger: 'upd',
      name: 'UPDATE … WHERE',
      body: 'UPDATE ${table}\nSET ${column} = ${value}\nWHERE ${condition};',
    },
    { trigger: 'del', name: 'DELETE … WHERE', body: 'DELETE FROM ${table}\nWHERE ${condition};' },
    {
      trigger: 'cte',
      name: 'WITH (common table expression)',
      body: 'WITH ${name} AS (\n  SELECT ${columns}\n  FROM ${table}\n)\nSELECT *\nFROM ${name};',
    },
    {
      trigger: 'crt',
      name: 'CREATE TABLE',
      body: 'CREATE TABLE ${table} (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,\n  ${column} VARCHAR(255) NOT NULL,\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,\n  PRIMARY KEY (id)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;',
    },
    {
      trigger: 'alt',
      name: 'ALTER TABLE ADD COLUMN',
      body: 'ALTER TABLE ${table}\n  ADD COLUMN ${column} ${VARCHAR(255)} NULL;',
    },
    {
      trigger: 'idx',
      name: 'CREATE INDEX',
      body: 'CREATE INDEX ${idx_name} ON ${table} (${columns});',
    },
    {
      trigger: 'expl',
      name: 'EXPLAIN',
      body: 'EXPLAIN\nSELECT ${columns}\nFROM ${table}\nWHERE ${condition};',
    },
  ],
  mongo: [
    {
      trigger: 'find',
      name: 'find with a filter',
      body: 'db.${collection}.find({ ${field}: ${value} }).limit(${100})',
    },
    {
      trigger: 'findone',
      name: 'findOne',
      body: 'db.${collection}.findOne({ ${field}: ${value} })',
    },
    {
      trigger: 'aggr',
      name: 'aggregate: match, group',
      body: 'db.${collection}.aggregate([\n  { $match: { ${field}: ${value} } },\n  { $group: { _id: "$${field}", total: { $sum: 1 } } },\n  { $sort: { total: -1 } }\n])',
    },
    {
      trigger: 'insm',
      name: 'insertOne',
      body: 'db.${collection}.insertOne({ ${field}: ${value} })',
    },
    {
      trigger: 'updm',
      name: 'updateMany with $set',
      body: 'db.${collection}.updateMany(\n  { ${field}: ${value} },\n  { $set: { ${field}: ${value} } }\n)',
    },
    {
      trigger: 'delm',
      name: 'deleteMany',
      body: 'db.${collection}.deleteMany({ ${field}: ${value} })',
    },
    {
      trigger: 'count',
      name: 'countDocuments',
      body: 'db.${collection}.countDocuments({ ${field}: ${value} })',
    },
  ],
}

/** What a person's own snippets and the built-in ones make, the person's winning when a trigger is shared. */
export function allSnippets(engine: SnippetEngine, own: readonly Snippet[]): Snippet[] {
  const mine = own.filter((s) => s.trigger !== '' && s.body !== '')
  const taken = new Set(mine.map((s) => s.trigger.toLowerCase()))
  return [...mine, ...BUILT_IN_SNIPPETS[engine].filter((s) => !taken.has(s.trigger.toLowerCase()))]
}

/** The first thing wrong with a snippet, or null. */
export function snippetProblem(snippet: Snippet): string | null {
  if (!/^[A-Za-z_]\w{0,31}$/.test(snippet.trigger)) {
    return 'A trigger is letters, digits and underscores, starting with a letter.'
  }
  if (snippet.name.length > 80) return 'Keep the name under 80 characters.'
  if (snippet.body.trim() === '') return 'A snippet needs a body.'
  if (snippet.body.length > MAX_SNIPPET_BODY) return `A body can be ${MAX_SNIPPET_BODY} characters.`
  return null
}
