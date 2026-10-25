import { Trash2 } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { CoreEvents } from '@shared/api'
import { CORE_TYPES, toGlob, type RedisProgress, type RedisType } from '@shared/redis/types'
import { Dialog } from '@/components/Dialog'
import { Button, Field } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { formatCount, messageOf } from '@/lib/format'
import { changeData } from '@/state/writes'

type Phase = 'idle' | 'counting' | 'counted' | 'deleting' | 'done'

/**
 * Deletes every key that matches a pattern. It counts them first, so what is about to go is known, and then
 * removes them a batch at a time. Both steps can be stopped, and neither stalls the server.
 */
export function BulkDeleteDialog({
  connectionId,
  db,
  pattern: initialPattern,
  type: initialType,
  onClose,
  onDone,
}: {
  connectionId: string
  db: number
  pattern: string
  type: RedisType | ''
  onClose: () => void
  onDone: () => void
}) {
  const [pattern, setPattern] = useState(initialPattern)
  const [type, setType] = useState<RedisType | ''>(initialType)
  const [phase, setPhase] = useState<Phase>('idle')
  const [count, setCount] = useState<number | null>(null)
  const [deleted, setDeleted] = useState(0)
  const [progress, setProgress] = useState<Omit<RedisProgress, 'taskId'> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const task = useRef('')

  useEffect(
    () =>
      coreLink.on(CoreEvents.redisProgress, (payload) => {
        const { taskId, ...rest } = payload as RedisProgress
        if (taskId === task.current) setProgress(rest)
      }),
    [],
  )
  useEffect(() => () => controller.current?.abort(), [])

  const glob = toGlob(pattern)
  const filter = type ? { type } : {}

  const start = (): { taskId: string; signal: AbortSignal } => {
    controller.current?.abort()
    const ctl = new AbortController()
    controller.current = ctl
    task.current = crypto.randomUUID()
    setProgress(null)
    setError(null)
    return { taskId: task.current, signal: ctl.signal }
  }

  const countKeys = async (): Promise<void> => {
    const { taskId, signal } = start()
    setPhase('counting')
    try {
      const result = await coreLink.call(
        'redis.count',
        { connectionId, db, pattern: glob, ...filter, taskId },
        { signal },
      )
      setCount(result.count)
      setPhase('counted')
    } catch (cause) {
      if (signal.aborted) {
        setPhase('idle')
        return
      }
      setError(messageOf(cause))
      setPhase('idle')
    }
  }

  const deleteKeys = async (): Promise<void> => {
    const total = count ?? 0
    const ran = await changeData({
      connectionId,
      title: `Delete ${formatCount(total)} keys?`,
      confirmLabel: 'Delete keys',
      destructive: true,
      reasons: [
        'The keys are deleted one batch at a time. Stopping part way leaves the rest, and nothing brings back what was deleted.',
      ],
      lines: [
        `Delete the ${formatCount(total)} keys matching ${glob}${type ? ` of type ${type}` : ''} in db${db}`,
      ],
      run: async () => {
        const { taskId, signal } = start()
        setPhase('deleting')
        try {
          const result = await coreLink.call(
            'redis.deleteMatching',
            { connectionId, db, writable: true, pattern: glob, ...filter, taskId },
            { signal },
          )
          setDeleted(result.deleted)
          setPhase('done')
        } catch (cause) {
          // Stopped part way: what was deleted is gone, and the count says how much.
          setPhase(signal.aborted ? 'done' : 'counted')
          if (!signal.aborted) throw cause
        }
      },
    })
    if (ran) onDone()
  }

  const busy = phase === 'counting' || phase === 'deleting'

  return (
    <Dialog title="Delete keys by pattern" icon={Trash2} onClose={busy ? () => undefined : onClose}>
      <p className="muted">
        Searching and deleting use SCAN and UNLINK in batches, so the server keeps answering
        everyone else.
      </p>
      <Field
        label="Pattern"
        hint="Text matches anywhere in a key. Use * and ? for more, such as session:*."
      >
        {(id) => (
          <input
            id={id}
            className="mono"
            autoFocus
            value={pattern}
            disabled={busy}
            onChange={(event) => {
              setPattern(event.target.value)
              setPhase('idle')
              setCount(null)
            }}
            spellCheck={false}
          />
        )}
      </Field>
      <Field label="Type">
        {(id) => (
          <select
            id={id}
            value={type}
            disabled={busy}
            onChange={(event) => {
              setType(event.target.value as RedisType | '')
              setPhase('idle')
              setCount(null)
            }}
          >
            <option value="">Any type</option>
            {CORE_TYPES.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        )}
      </Field>

      <p className="redis-bulk-status" aria-live="polite">
        {phase === 'counting'
          ? `Counting… ${formatCount(progress?.matched ?? 0)} found so far`
          : phase === 'counted' && count !== null
            ? `${formatCount(count)} keys match ${glob}.`
            : phase === 'deleting'
              ? `Deleting… ${formatCount(progress?.deleted ?? 0)} of about ${formatCount(count ?? 0)} deleted`
              : phase === 'done'
                ? `Deleted ${formatCount(deleted)} keys.`
                : 'Count the keys first to see what would be deleted.'}
      </p>
      {error ? (
        <p className="field-error" role="alert">
          {error}
        </p>
      ) : null}

      <footer>
        {busy ? (
          <Button onClick={() => controller.current?.abort()}>Stop</Button>
        ) : (
          <Button onClick={onClose}>{phase === 'done' ? 'Close' : 'Cancel'}</Button>
        )}
        {phase === 'done' ? null : (
          <>
            <Button disabled={busy} onClick={() => void countKeys()}>
              Count keys
            </Button>
            <Button
              variant="danger"
              disabled={phase !== 'counted' || count === 0}
              onClick={() => void deleteKeys()}
            >
              Delete {count !== null ? formatCount(count) : ''} keys
            </Button>
          </>
        )}
      </footer>
    </Dialog>
  )
}
