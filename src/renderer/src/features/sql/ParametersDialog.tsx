import { X } from 'lucide-react'
import { useState } from 'react'
import type { ParamKind, ParamValue } from '@shared/params'
import { Button, IconButton } from '@/components/ui'
import { useParameterPrompt, type ParameterPrompt } from '@/state/params'

const NUMBER = /^-?\d+(\.\d+)?([eE][-+]?\d+)?$/

export function ParametersDialog() {
  const request = useParameterPrompt((state) => state.request)
  if (!request) return null
  return <ParametersBody key={request.scriptId + request.names.join()} request={request} />
}

function ParametersBody({ request }: { request: ParameterPrompt }) {
  const answer = useParameterPrompt((state) => state.answer)
  const [values, setValues] = useState<Record<string, ParamValue>>(() =>
    Object.fromEntries(
      request.names.map((n) => [
        n,
        request.defaults[n] ?? { kind: 'text' as ParamKind, value: '' },
      ]),
    ),
  )
  const set = (name: string, patch: Partial<ParamValue>): void =>
    setValues((v) => ({ ...v, [name]: { ...v[name]!, ...patch } }))
  const bad = request.names.find(
    (n) => values[n]!.kind === 'number' && !NUMBER.test(values[n]!.value.trim()),
  )

  return (
    <div className="dialog-overlay" onMouseDown={() => answer(null)}>
      <form
        className="dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="params-title"
        onMouseDown={(event) => event.stopPropagation()}
        onSubmit={(event) => {
          event.preventDefault()
          if (!bad) answer(values)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Escape') return
          event.stopPropagation()
          answer(null)
        }}
      >
        <header>
          <h2 id="params-title">Values for this run</h2>
          <IconButton label="Cancel" onClick={() => answer(null)}>
            <X size={14} />
          </IconButton>
        </header>
        <p className="muted export-note">
          The script has parameters. They are written into the statement as values, and remembered
          for the next run.
        </p>
        <div className="params-grid">
          {request.names.map((name, i) => (
            <div className="params-row" key={name}>
              <span className="mono">:{name}</span>
              <select
                aria-label={`Kind of :${name}`}
                value={values[name]!.kind}
                onChange={(event) => set(name, { kind: event.target.value as ParamKind })}
              >
                <option value="text">Text</option>
                <option value="number">Number</option>
                <option value="null">NULL</option>
              </select>
              <input
                className="mono"
                aria-label={`Value of :${name}`}
                value={values[name]!.kind === 'null' ? '' : values[name]!.value}
                disabled={values[name]!.kind === 'null'}
                placeholder={values[name]!.kind === 'null' ? 'NULL' : ''}
                spellCheck={false}
                autoFocus={i === 0}
                onChange={(event) => set(name, { value: event.target.value })}
              />
            </div>
          ))}
        </div>
        {bad ? <p className="note-error">:{bad} should be a number.</p> : null}
        <footer>
          <Button variant="ghost" onClick={() => answer(null)}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={Boolean(bad)}>
            Run
          </Button>
        </footer>
      </form>
    </div>
  )
}
