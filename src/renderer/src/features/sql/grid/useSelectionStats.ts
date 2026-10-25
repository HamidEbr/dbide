import { useEffect, useMemo, useState } from 'react'
import type { ColumnInfo } from '@shared/driver'
import type { Cell } from '@shared/query'
import { mergeTotals, type NumberTotals } from '@shared/value'
import type { EffectiveRow } from '../edit/useRowEditing'
import type { RowStore } from './row-store'
import {
  selectionSize,
  selectionTotals,
  statsFrom,
  type Selection,
  type SelectionStats,
} from './selection'

const SCAN_LIMIT = 500_000

interface HeldAnswer {
  /** What the answer is for: the selection and the number of rows then held. */
  for: string
  totals: NumberTotals
  partial: boolean
}

/**
 * Count, sum, average, min and max of the numbers in the selected cells. The rows the window holds
 * are added up here, straight away. Rows held by the core are added up there and arrive a moment
 * later, so a selection that reaches into them shows the part it has until the rest is in.
 */
export function useSelectionStats(options: {
  store: RowStore
  columns: ColumnInfo[]
  selection: Selection | null
  /** A row with staged edits applied, without asking the core for it. */
  peekRow: (row: number) => EffectiveRow | null
  /** Changes as rows stream in, which can change what a selection covers. */
  version: number
}): SelectionStats | null {
  const { store, columns, selection, peekRow, version } = options
  const inWindow = store.rows.length

  const local = useMemo(() => {
    if (!selection || selection.r1 >= inWindow) return null
    const clipped = { ...selection, r2: Math.min(selection.r2, inWindow - 1) }
    return selectionTotals(
      clipped,
      (r) => peekRow(r)?.cells as Cell[] | undefined,
      columns,
      SCAN_LIMIT,
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection, columns, peekRow, version, inWindow])

  const wantsHeld = selection !== null && selection.r2 >= inWindow
  const askedFor = selection
    ? `${selection.r1}:${selection.r2}:${selection.c1}:${selection.c2}:${store.length}`
    : ''
  const [held, setHeld] = useState<HeldAnswer | null>(null)

  useEffect(() => {
    if (!selection || !wantsHeld) return
    let cancelled = false
    // A moment's wait, so dragging a selection over a million rows asks once, not for every row.
    const timer = setTimeout(() => {
      const wanted = Array.from({ length: selection.c2 - selection.c1 + 1 }, (_, i) => ({
        index: selection.c1 + i,
        type: columns[selection.c1 + i]?.type ?? '',
      }))
      store
        .heldTotals(selection.r1, selection.r2, wanted)
        .then((answer) => {
          if (!cancelled && answer) {
            setHeld({ for: askedFor, totals: answer, partial: answer.partial })
          }
        })
        .catch(() => undefined)
    }, 200)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selection, wantsHeld, askedFor, columns, store])

  return useMemo(() => {
    if (!selection) return null
    const cells = selectionSize(selection)
    const fromHeld = wantsHeld && held?.for === askedFor ? held : null
    const totals =
      fromHeld && local
        ? mergeTotals(local.totals, fromHeld.totals)
        : (fromHeld?.totals ?? local?.totals)
    const scannedHere = local?.scanned ?? 0
    return statsFrom(
      totals ?? { numeric: 0, sum: 0, min: Infinity, max: -Infinity },
      cells,
      cells > SCAN_LIMIT ||
        scannedHere >= SCAN_LIMIT ||
        fromHeld?.partial === true ||
        (wantsHeld && !fromHeld),
    )
  }, [selection, local, held, wantsHeld, askedFor])
}
