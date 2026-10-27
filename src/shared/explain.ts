/**
 * Reading MySQL's `EXPLAIN FORMAT=JSON` into steps a person can follow: which tables are read, how, and what is
 * costly about it. The server nests its answer by what each step does (a join, a sort, a subquery); this flattens it
 * into an indented list, with a warning wherever the plan reads more than it needs to.
 */

export type PlanWarning =
  'full-scan' | 'no-index' | 'filesort' | 'temporary' | 'low-filter' | 'index-scan'

export interface PlanStep {
  /** How deeply it is nested, for indentation. */
  depth: number
  /** What the step is: a table read, or an operation such as `Sort`. */
  kind: 'table' | 'operation'
  title: string
  /** The table's access type: ALL, index, range, ref, eq_ref, const… */
  access?: string
  key?: string
  possibleKeys?: string[]
  /** Rows the server expects to look at for each time the step runs. */
  rowsExamined?: number
  /** Rows the step is expected to pass on. */
  rowsProduced?: number
  /** Percent of the examined rows expected to pass the conditions. */
  filtered?: number
  cost?: number
  condition?: string
  warnings: PlanWarning[]
}

export interface Plan {
  /** The server's estimate for the whole query. */
  cost: number | null
  steps: PlanStep[]
}

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const num = (value: unknown): number | undefined => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
}

const WARNING_TEXT: Record<PlanWarning, string> = {
  'full-scan': 'Reads every row of the table',
  'no-index': 'No index is used',
  filesort: 'Sorts the rows outside an index',
  temporary: 'Builds a temporary table',
  'low-filter': 'Reads many rows to keep few',
  'index-scan': 'Reads the whole index',
}
export const warningText = (warning: PlanWarning): string => WARNING_TEXT[warning]

function tableStep(table: Json, depth: number): PlanStep {
  const access = typeof table.access_type === 'string' ? table.access_type : undefined
  const key = typeof table.key === 'string' ? table.key : undefined
  const rowsExamined = num(table.rows_examined_per_scan)
  const filtered = num(table.filtered)
  const warnings: PlanWarning[] = []
  if (access === 'ALL') warnings.push('full-scan')
  else if (access === 'index') warnings.push('index-scan')
  if (!key && access !== undefined && access !== 'const' && access !== 'system') {
    if (!warnings.includes('full-scan')) warnings.push('no-index')
  }
  if (
    rowsExamined !== undefined &&
    rowsExamined >= 1000 &&
    filtered !== undefined &&
    filtered < 10
  ) {
    warnings.push('low-filter')
  }
  const cost = isObject(table.cost_info) ? num(table.cost_info.prefix_cost) : undefined
  const possible = Array.isArray(table.possible_keys)
    ? table.possible_keys.filter((k): k is string => typeof k === 'string')
    : undefined
  return {
    depth,
    kind: 'table',
    title: typeof table.table_name === 'string' ? table.table_name : 'table',
    ...(access ? { access } : {}),
    ...(key ? { key } : {}),
    ...(possible && possible.length > 0 ? { possibleKeys: possible } : {}),
    ...(rowsExamined !== undefined ? { rowsExamined } : {}),
    ...(num(table.rows_produced_per_join) !== undefined
      ? { rowsProduced: num(table.rows_produced_per_join)! }
      : {}),
    ...(filtered !== undefined ? { filtered } : {}),
    ...(cost !== undefined ? { cost } : {}),
    ...(typeof table.attached_condition === 'string'
      ? { condition: table.attached_condition }
      : {}),
    warnings,
  }
}

const OPERATIONS: Record<string, string> = {
  ordering_operation: 'Sort',
  grouping_operation: 'Group',
  duplicates_removal: 'Remove duplicates',
  windowing: 'Window',
  buffer_result: 'Buffer the result',
}

function walk(node: Json, depth: number, steps: PlanStep[]): void {
  // An operation that sorts, groups or de-duplicates, which can also say it needs a sort or a temporary table.
  for (const [name, title] of Object.entries(OPERATIONS)) {
    const inner = node[name]
    if (!isObject(inner)) continue
    const warnings: PlanWarning[] = []
    if (inner.using_filesort === true) warnings.push('filesort')
    if (inner.using_temporary_table === true) warnings.push('temporary')
    steps.push({ depth, kind: 'operation', title, warnings })
    walk(inner, depth + 1, steps)
  }
  if (isObject(node.table)) {
    steps.push(tableStep(node.table, depth))
    walk(node.table, depth + 1, steps)
  }
  if (Array.isArray(node.nested_loop)) {
    steps.push({ depth, kind: 'operation', title: 'Nested loop join', warnings: [] })
    for (const item of node.nested_loop) if (isObject(item)) walk(item, depth + 1, steps)
  }
  if (isObject(node.union_result)) {
    steps.push({ depth, kind: 'operation', title: 'Union', warnings: [] })
    const specs = node.union_result.query_specifications
    if (Array.isArray(specs)) {
      for (const spec of specs)
        if (isObject(spec) && isObject(spec.query_block)) walk(spec.query_block, depth + 1, steps)
    }
  }
  for (const key of [
    'materialized_from_subquery',
    'attached_subqueries',
    'optimized_away_subqueries',
  ]) {
    const value = node[key]
    const list = Array.isArray(value) ? value : isObject(value) ? [value] : []
    for (const item of list) {
      if (!isObject(item)) continue
      steps.push({
        depth,
        kind: 'operation',
        title: key === 'materialized_from_subquery' ? 'Subquery' : 'Subquery',
        warnings: [],
      })
      walk(isObject(item.query_block) ? item.query_block : item, depth + 1, steps)
    }
  }
}

function postgresNode(node: Json, depth: number, steps: PlanStep[]): void {
  const type = typeof node['Node Type'] === 'string' ? node['Node Type'] : 'Step'
  const relation = typeof node['Relation Name'] === 'string' ? node['Relation Name'] : null
  const rows = num(node['Plan Rows'])
  const warnings: PlanWarning[] = []
  if (type === 'Seq Scan' && rows !== undefined && rows >= 1000) warnings.push('full-scan')
  if (/^Sort$|Incremental Sort/.test(type) && node['Sort Space Type'] === 'Disk')
    warnings.push('filesort')
  const index = typeof node['Index Name'] === 'string' ? node['Index Name'] : undefined
  const condition = [
    'Index Cond',
    'Filter',
    'Hash Cond',
    'Merge Cond',
    'Join Filter',
    'Recheck Cond',
  ]
    .map((k) => node[k])
    .find((v): v is string => typeof v === 'string')
  const alias =
    typeof node['Alias'] === 'string' && node['Alias'] !== relation ? ` ${node['Alias']}` : ''
  steps.push({
    depth,
    kind: relation ? 'table' : 'operation',
    title: relation ? `${relation}${alias}` : type,
    ...(relation ? { access: type } : {}),
    ...(index ? { key: index } : {}),
    ...(rows !== undefined ? { rowsExamined: rows } : {}),
    ...(num(node['Total Cost']) !== undefined ? { cost: num(node['Total Cost'])! } : {}),
    ...(condition ? { condition } : {}),
    warnings,
  })
  if (Array.isArray(node.Plans)) {
    for (const child of node.Plans) if (isObject(child)) postgresNode(child, depth + 1, steps)
  }
}

/** The plan in a server's `EXPLAIN FORMAT=JSON` text, or null when it isn't one. */
export function parsePlan(text: string): Plan | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  // PostgreSQL's plan is a list with one object holding the root node.
  if (Array.isArray(parsed) && isObject(parsed[0]) && isObject(parsed[0].Plan)) {
    const steps: PlanStep[] = []
    postgresNode(parsed[0].Plan, 0, steps)
    return { cost: num(parsed[0].Plan['Total Cost']) ?? null, steps }
  }
  if (!isObject(parsed) || !isObject(parsed.query_block)) return null
  const block = parsed.query_block
  const steps: PlanStep[] = []
  walk(block, 0, steps)
  return {
    cost: isObject(block.cost_info) ? (num(block.cost_info.query_cost) ?? null) : null,
    steps,
  }
}
