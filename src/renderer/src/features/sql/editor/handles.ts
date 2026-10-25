/** What commands can ask of an open SQL editor. Registered by the editor while it is mounted. */
export interface EditorHandle {
  /** `cursor`: the selection, or else the statement under the cursor. `all`: the whole script. */
  statements(mode: 'cursor' | 'all'): string[]
  format(): Promise<void>
  focus(): void
  /** The text as it is now, including what was typed in the last moment. */
  getText(): string
  /** Replaces the whole text. It is one step in the editor's own undo history. */
  setText(text: string): void
  /** Puts text at the cursor, replacing the selection. */
  insertAtCursor(text: string): void
}

const handles = new Map<string, EditorHandle>()

export const registerEditor = (scriptId: string, handle: EditorHandle): (() => void) => {
  handles.set(scriptId, handle)
  return () => {
    if (handles.get(scriptId) === handle) handles.delete(scriptId)
  }
}

export const editorFor = (scriptId: string): EditorHandle | undefined => handles.get(scriptId)
