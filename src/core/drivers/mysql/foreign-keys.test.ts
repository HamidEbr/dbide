import { describe, expect, it } from 'vitest'
import { groupForeignKeys, groupReferencingKeys } from './foreign-keys'

describe('groupForeignKeys', () => {
  it('makes one key per constraint, with its columns in order', () => {
    expect(
      groupForeignKeys([
        ['fk_customer', 'customer_id', 'shop', 'customers', 'id'],
        ['fk_region', 'country', 'geo', 'regions', 'country'],
        ['fk_region', 'region', 'geo', 'regions', 'code'],
      ]),
    ).toEqual([
      {
        name: 'fk_customer',
        columns: ['customer_id'],
        refSchema: 'shop',
        refTable: 'customers',
        refColumns: ['id'],
      },
      {
        name: 'fk_region',
        columns: ['country', 'region'],
        refSchema: 'geo',
        refTable: 'regions',
        refColumns: ['country', 'code'],
      },
    ])
  })

  it('has nothing for no rows', () => {
    expect(groupForeignKeys([])).toEqual([])
  })
})

describe('groupReferencingKeys', () => {
  it('keeps two tables’ constraints apart even when they share a name', () => {
    expect(
      groupReferencingKeys([
        ['fk_parent', 'shop', 'orders', 'customer_id', 'id'],
        ['fk_parent', 'shop', 'invoices', 'customer_id', 'id'],
        ['fk_pair', 'shop', 'links', 'a', 'x'],
        ['fk_pair', 'shop', 'links', 'b', 'y'],
      ]),
    ).toEqual([
      {
        name: 'fk_parent',
        schema: 'shop',
        table: 'orders',
        columns: ['customer_id'],
        refColumns: ['id'],
      },
      {
        name: 'fk_parent',
        schema: 'shop',
        table: 'invoices',
        columns: ['customer_id'],
        refColumns: ['id'],
      },
      {
        name: 'fk_pair',
        schema: 'shop',
        table: 'links',
        columns: ['a', 'b'],
        refColumns: ['x', 'y'],
      },
    ])
  })
})
