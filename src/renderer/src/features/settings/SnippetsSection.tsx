import { Plus, Trash2 } from 'lucide-react'
import { useState } from 'react'
import { BUILT_IN_SNIPPETS, snippetProblem, type Snippet } from '@shared/snippets'
import { Button, IconButton } from '@/components/ui'
import { useData } from '@/state/data'
import { notify } from '@/state/notices'

/** The person's own snippets, beside a list of the built-in ones. */
export function SnippetsSection() {
  const saved = useData((state) => state.settings.snippets)
  const updateSettings = useData((state) => state.updateSettings)
  const [draft, setDraft] = useState<Snippet[]>(saved)
  const changed = JSON.stringify(draft) !== JSON.stringify(saved)

  const set = (index: number, patch: Partial<Snippet>): void =>
    setDraft((list) => list.map((s, i) => (i === index ? { ...s, ...patch } : s)))

  const save = async (): Promise<void> => {
    const triggers = new Set<string>()
    for (const snippet of draft) {
      const problem = snippetProblem(snippet)
      if (problem) return notify(`${snippet.trigger || 'A snippet'}: ${problem}`, 'warn')
      if (triggers.has(snippet.trigger.toLowerCase())) {
        return notify(`Two snippets use the trigger “${snippet.trigger}”.`, 'warn')
      }
      triggers.add(snippet.trigger.toLowerCase())
    }
    await updateSettings({ snippets: draft })
    notify('Snippets saved.')
  }

  return (
    <section className="form-section">
      <h2>Snippets</h2>
      <p className="muted">
        Type a trigger in a SQL or Mongo script and pick it from the list: it expands into a whole
        statement. Press Tab to move between the places to fill in, written{' '}
        <span className="mono">{'${name}'}</span> in the body. Yours replace a built-in one with the
        same trigger.
      </p>
      <p className="muted">
        Built in:{' '}
        <span className="mono">
          {[...BUILT_IN_SNIPPETS.sql, ...BUILT_IN_SNIPPETS.mongo].map((s) => s.trigger).join(' · ')}
        </span>
      </p>
      {draft.map((snippet, index) => (
        <div className="snippet-row" key={index}>
          <input
            className="mono"
            aria-label="Trigger"
            placeholder="trigger"
            value={snippet.trigger}
            spellCheck={false}
            onChange={(event) => set(index, { trigger: event.target.value })}
          />
          <input
            aria-label="Name"
            placeholder="What it is"
            value={snippet.name}
            onChange={(event) => set(index, { name: event.target.value })}
          />
          <IconButton
            label="Remove this snippet"
            onClick={() => setDraft((list) => list.filter((_, i) => i !== index))}
          >
            <Trash2 size={13} />
          </IconButton>
          <textarea
            className="mono"
            aria-label="Body"
            rows={3}
            placeholder={'SELECT ${columns}\nFROM ${table};'}
            value={snippet.body}
            spellCheck={false}
            onChange={(event) => set(index, { body: event.target.value })}
          />
        </div>
      ))}
      <div className="snippet-actions">
        <Button
          icon={<Plus size={13} />}
          onClick={() => setDraft((list) => [...list, { trigger: '', name: '', body: '' }])}
        >
          Add a snippet
        </Button>
        <Button variant="primary" disabled={!changed} onClick={() => void save()}>
          Save snippets
        </Button>
      </div>
    </section>
  )
}
