import { create } from 'zustand'

export type ResultView = 'grid' | 'pivot' | 'chart'

interface ResultViewsState {
  /** How each result is shown, by result id. A result nobody changed is a table. */
  views: Record<string, ResultView>
  /** The result the front tab is showing, so commands and shortcuts can act on it. */
  current: { scriptId: string; resultSetId: string } | null
  setView: (resultSetId: string, view: ResultView) => void
  setCurrent: (current: ResultViewsState['current']) => void
}

export const useResultViews = create<ResultViewsState>((set) => ({
  views: {},
  current: null,
  setView: (resultSetId, view) => set((s) => ({ views: { ...s.views, [resultSetId]: view } })),
  setCurrent: (current) => set({ current }),
}))

export const hasResultView = (): boolean => useResultViews.getState().current !== null

/** Shows the result the front tab has in this way. */
export function showCurrentResultAs(view: ResultView): void {
  const { current, setView } = useResultViews.getState()
  if (current) setView(current.resultSetId, view)
}
