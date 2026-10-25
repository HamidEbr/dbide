import { CircleCheck, CircleMinus, CircleX, LoaderCircle } from 'lucide-react'
import type { TestStep } from '@shared/connection'

const ICONS = {
  ok: <CircleCheck size={16} className="step-ok" aria-label="Passed" />,
  failed: <CircleX size={16} className="step-failed" aria-label="Failed" />,
  skipped: <CircleMinus size={16} className="step-skipped" aria-label="Skipped" />,
} as const

export function TestResults({ steps, testing }: { steps: TestStep[] | null; testing: boolean }) {
  if (!steps && !testing) return null
  return (
    <div className="test-results" role="status" aria-live="polite">
      {testing ? (
        <p className="test-running">
          <LoaderCircle size={14} className="spin" aria-hidden /> Testing the connection…
        </p>
      ) : null}
      {!testing && steps ? (
        <ol>
          {steps.map((step) => (
            <li key={step.id} data-status={step.status}>
              {ICONS[step.status]}
              <div>
                <div className="step-title">
                  <span>{step.label}</span>
                  {step.status !== 'skipped' ? (
                    <span className="step-time">{step.durationMs} ms</span>
                  ) : null}
                </div>
                {step.detail ? <p className="step-detail selectable">{step.detail}</p> : null}
              </div>
            </li>
          ))}
        </ol>
      ) : null}
    </div>
  )
}
