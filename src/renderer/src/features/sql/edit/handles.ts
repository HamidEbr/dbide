/** What a command can ask of the staged changes of a script's visible result. */
export interface EditHandle {
  /** How many unsaved changes there are. */
  count(): number
  commit(): void
  discard(): void
}

const handles = new Map<string, EditHandle>()

/** The results pane registers the front result's changes while it has any. */
export const registerEditHandle = (scriptId: string, handle: EditHandle): (() => void) => {
  handles.set(scriptId, handle)
  return () => {
    if (handles.get(scriptId) === handle) handles.delete(scriptId)
  }
}

export const editHandleFor = (scriptId: string): EditHandle | undefined => handles.get(scriptId)
