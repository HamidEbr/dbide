import { useState, type Dispatch, type SetStateAction } from 'react'

/** State kept for as long as a result is shown. A plain `useState`, named for what the tools use it for. */
export function useLocalState<T>(initial: T): [T, Dispatch<SetStateAction<T>>] {
  return useState(initial)
}
