import { describe, expect, it } from 'vitest'
import { parsePlan } from './explain'

const join = JSON.stringify({
  query_block: {
    select_id: 1,
    cost_info: { query_cost: '12345.60' },
    ordering_operation: {
      using_filesort: true,
      nested_loop: [
        {
          table: {
            table_name: 'orders',
            access_type: 'ALL',
            possible_keys: ['customer_id'],
            rows_examined_per_scan: 50000,
            rows_produced_per_join: 2500,
            filtered: '5.00',
            cost_info: { prefix_cost: '9000.00' },
            attached_condition: '(`o`.`total` > 100)',
          },
        },
        {
          table: {
            table_name: 'customers',
            access_type: 'eq_ref',
            key: 'PRIMARY',
            rows_examined_per_scan: 1,
            rows_produced_per_join: 2500,
            filtered: '100.00',
          },
        },
      ],
    },
  },
})

describe('parsePlan', () => {
  it('lists the steps, indented by what they sit in', () => {
    const plan = parsePlan(join)!
    expect(plan.cost).toBe(12345.6)
    expect(plan.steps.map((s) => [s.depth, s.title])).toEqual([
      [0, 'Sort'],
      [1, 'Nested loop join'],
      [2, 'orders'],
      [2, 'customers'],
    ])
  })

  it('warns about a full scan, a sort outside an index, and reading much to keep little', () => {
    const [sort, , orders, customers] = parsePlan(join)!.steps
    expect(sort!.warnings).toEqual(['filesort'])
    expect(orders).toMatchObject({ access: 'ALL', rowsExamined: 50000, filtered: 5 })
    expect(orders!.warnings).toEqual(['full-scan', 'low-filter'])
    expect(orders!.possibleKeys).toEqual(['customer_id'])
    expect(customers).toMatchObject({ access: 'eq_ref', key: 'PRIMARY', warnings: [] })
  })

  it('reads a plan of one table, and a union', () => {
    const one = parsePlan(
      JSON.stringify({
        query_block: { table: { table_name: 't', access_type: 'const', key: 'PRIMARY' } },
      }),
    )!
    expect(one.steps).toHaveLength(1)
    expect(one.cost).toBeNull()
    const union = parsePlan(
      JSON.stringify({
        query_block: {
          union_result: {
            query_specifications: [
              { query_block: { table: { table_name: 'a', access_type: 'ALL' } } },
              { query_block: { table: { table_name: 'b', access_type: 'ref', key: 'k' } } },
            ],
          },
        },
      }),
    )!
    expect(union.steps.map((s) => s.title)).toEqual(['Union', 'a', 'b'])
  })

  it('is null for text that is not a plan', () => {
    expect(parsePlan('not json')).toBeNull()
    expect(parsePlan('{"a":1}')).toBeNull()
  })
})
