import { TriangleAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { Button, EnvBadge } from '@/components/ui'
import { useGuard } from '@/state/guard'

/**
 * Asks before something risky runs. For destructive statements on guarded environments the
 * user has to type the connection's name, so the button can't be hit on autopilot.
 */
export function RunGuardDialog() {
  const request = useGuard((state) => state.request)
  if (!request) return null
  // Keyed so typed text never carries over between two questions.
  return <GuardBody key={request.statements.join('\n') + request.connectionName} />
}

function GuardBody() {
  const request = useGuard((state) => state.request)!
  const answer = useGuard((state) => state.answer)
  const [typed, setTyped] = useState('')
  const confirmButton = useRef<HTMLButtonElement>(null)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // Typing the name comes first; otherwise the safe default is the cancel button.
    if (request.typedName) input.current?.focus()
  }, [request.typedName])

  const unlock = request.action === 'unlock'
  const ready = !request.typedName || typed.trim() === request.connectionName
  const policy = ENVIRONMENT_POLICIES[request.environment]

  return (
    <div className="dialog-overlay" onMouseDown={() => answer(false)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="guard-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') answer(false)
          if (event.key === 'Enter' && ready && event.target === confirmButton.current) answer(true)
        }}
      >
        <header>
          <TriangleAlert size={18} className="dialog-icon" aria-hidden />
          <h2 id="guard-title">
            {request.title ?? (unlock ? 'Unlock writes?' : 'Run these statements?')}
          </h2>
          <EnvBadge environment={request.environment} />
        </header>

        <ul className="dialog-reasons">
          {request.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>

        {request.statements.length > 0 ? (
          <pre className="dialog-sql mono selectable" tabIndex={0}>
            {request.statements.join(request.plain ? '\n' : ';\n')}
          </pre>
        ) : null}

        {request.typedName ? (
          <label className="dialog-confirm">
            <span>
              Type <strong>{request.connectionName}</strong> to continue
            </span>
            <input
              ref={input}
              className="mono"
              value={typed}
              onChange={(event) => setTyped(event.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        ) : null}

        <footer>
          <Button onClick={() => answer(false)} autoFocus={!request.typedName}>
            Cancel
          </Button>
          <Button
            ref={confirmButton}
            variant={policy.readOnlyByDefault || request.typedName ? 'danger' : 'primary'}
            disabled={!ready}
            onClick={() => answer(true)}
          >
            {request.confirmLabel ?? (unlock ? 'Unlock' : 'Run')}
          </Button>
        </footer>
      </div>
    </div>
  )
}
