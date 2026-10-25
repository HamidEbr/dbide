import { useInspector } from '@/state/inspector'
import { useWorkbench } from '@/state/workbench'
import { DocumentInspector } from '@/features/mongo/DocumentInspector'
import { RecordView } from './RecordView'
import { ValueView } from './ValueView'

/**
 * The right-hand panel. It follows the selected cell in the active result: the Value tab decodes
 * it, the Record tab lays out the whole row as a form.
 */
export function Inspector() {
  const target = useInspector((state) => state.target)
  const document = useInspector((state) => state.document)
  const tab = useInspector((state) => state.tab)
  const setTab = useInspector((state) => state.setTab)
  const inSqlTab = useWorkbench((state) => {
    const active = state.tabs.find((t) => t.id === state.activeId)
    return active?.kind === 'sql'
  })

  const show = inSqlTab && target !== null

  // A MongoDB result in front: its documents have no cells to decode, so the panel shows the document.
  if (inSqlTab && document !== null) {
    return (
      <aside className="inspector" aria-label="Inspector">
        <div className="pane-header inspector-tabs">
          <span className="inspector-tab active">Document</span>
        </div>
        <div className="inspector-body">
          <DocumentInspector key={document.id} target={document} />
        </div>
      </aside>
    )
  }

  return (
    <aside className="inspector" aria-label="Inspector">
      <div className="pane-header inspector-tabs" role="tablist" aria-label="Inspector views">
        {(['value', 'record'] as const).map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            aria-selected={tab === name}
            className={`inspector-tab ${tab === name ? 'active' : ''}`}
            onClick={() => setTab(name)}
          >
            {name === 'value' ? 'Value' : 'Record'}
          </button>
        ))}
      </div>

      {show ? (
        <div className="inspector-body">
          {tab === 'value' ? (
            <ValueView
              key={`${target.ownerId}:${target.rowIndex}:${target.colIndex}`}
              target={target}
            />
          ) : (
            <RecordView key={`${target.ownerId}:${target.rowIndex}`} target={target} />
          )}
        </div>
      ) : (
        <div className="empty-state compact">
          <h3>Nothing selected</h3>
          <p>Select a cell in a result to decode its value, or see the whole row.</p>
        </div>
      )}
    </aside>
  )
}
