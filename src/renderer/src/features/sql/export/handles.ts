/** What a command can ask of the results pane of a script: export what it is showing. */
const exporters = new Map<string, () => void>()

export const registerExporter = (scriptId: string, open: () => void): (() => void) => {
  exporters.set(scriptId, open)
  return () => {
    if (exporters.get(scriptId) === open) exporters.delete(scriptId)
  }
}

export const exporterFor = (scriptId: string): (() => void) | undefined => exporters.get(scriptId)
