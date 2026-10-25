import { create } from 'zustand'
import type { TableDescription } from '@shared/edit'
import { coreLink } from '@/ipc/link'

export type TableState =
  | { status: 'loading' }
  | { status: 'ready'; table: TableDescription }
  | { status: 'error'; message: string }

export const tableKey = (connectionId: string, schema: string, table: string): string =>
  `${connectionId}|${schema}|${table}`

interface TablesState {
  tables: Record<string, TableState>
  /** Loads a table's description once. Later calls reuse it until `forget`. */
  load: (connectionId: string, schema: string, table: string) => void
  forget: (connectionId: string, schema: string, table: string) => void
}

export const useTables = create<TablesState>((set, get) => ({
  tables: {},

  load: (connectionId, schema, table) => {
    const key = tableKey(connectionId, schema, table)
    if (get().tables[key]) return
    set((state) => ({ tables: { ...state.tables, [key]: { status: 'loading' } } }))
    coreLink
      .call('tables.describe', { connectionId, schema, table })
      .then((description) =>
        set((state) => ({
          tables: { ...state.tables, [key]: { status: 'ready', table: description } },
        })),
      )
      .catch((error: unknown) =>
        set((state) => ({
          tables: {
            ...state.tables,
            [key]: {
              status: 'error',
              message: error instanceof Error ? error.message : String(error),
            },
          },
        })),
      )
  },

  forget: (connectionId, schema, table) =>
    set((state) => {
      const { [tableKey(connectionId, schema, table)]: _gone, ...rest } = state.tables
      return { tables: rest }
    }),
}))
