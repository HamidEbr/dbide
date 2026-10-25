import { useState } from 'react'
import { printable } from '@shared/redis/bstring'
import { Field } from '@/components/ui'
import { FormDialog } from './PromptDialog'
import { parseTtl } from './NewKeyDialog'

const UNITS = ['s', 'm', 'h', 'd'] as const
const UNIT_LABELS = { s: 'seconds', m: 'minutes', h: 'hours', d: 'days' } as const

/** Sets how long a key lives, or lets it live forever. */
export function TtlDialog({
  keyName,
  hasTtl,
  onClose,
  onSet,
  onClear,
}: {
  keyName: string
  hasTtl: boolean
  onClose: () => void
  onSet: (ttlMs: number) => Promise<boolean>
  onClear: () => Promise<boolean>
}) {
  const [amount, setAmount] = useState('')
  const [unit, setUnit] = useState<(typeof UNITS)[number]>('s')
  const ttl = parseTtl(amount, unit)
  return (
    <FormDialog
      title={`Expiry of ${printable(keyName)}`}
      confirmLabel="Set expiry"
      onClose={onClose}
      onSubmit={() => (typeof ttl === 'number' ? onSet(ttl) : Promise.resolve(false))}
      disabled={typeof ttl !== 'number'}
      error={ttl === 'invalid' ? 'The expiry must be a positive number.' : null}
    >
      <div className="broker-inline">
        <Field label="Expires in">
          {(id) => (
            <input
              id={id}
              className="mono"
              autoFocus
              inputMode="decimal"
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="Unit">
          {(id) => (
            <select
              id={id}
              value={unit}
              onChange={(event) => setUnit(event.target.value as (typeof UNITS)[number])}
            >
              {UNITS.map((u) => (
                <option key={u} value={u}>
                  {UNIT_LABELS[u]}
                </option>
              ))}
            </select>
          )}
        </Field>
      </div>
      {hasTtl ? (
        <p className="muted">
          Or{' '}
          <button
            type="button"
            className="link-button"
            onClick={() => void onClear().then((done) => done && onClose())}
          >
            remove the expiry
          </button>{' '}
          so the key never expires.
        </p>
      ) : null}
    </FormDialog>
  )
}

/** Gives a key another name, optionally replacing a key that has it. */
export function RenameKeyDialog({
  keyName,
  onClose,
  onRename,
}: {
  keyName: string
  onClose: () => void
  onRename: (newKey: string, overwrite: boolean) => Promise<boolean>
}) {
  const [name, setName] = useState(keyName)
  const [overwrite, setOverwrite] = useState(false)
  return (
    <FormDialog
      title="Rename key"
      confirmLabel="Rename"
      onClose={onClose}
      onSubmit={() => onRename(name, overwrite)}
      disabled={name === '' || name === keyName}
    >
      <Field label="New name">
        {(id) => (
          <input
            id={id}
            className="mono"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            spellCheck={false}
          />
        )}
      </Field>
      <label className="check">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        Replace a key that already has this name
      </label>
    </FormDialog>
  )
}

/** Copies a key, with its TTL, under another name, in this database or another. */
export function DuplicateKeyDialog({
  keyName,
  db,
  databases,
  onClose,
  onDuplicate,
}: {
  keyName: string
  db: number
  /** How many databases the server has; one means there is no other to choose. */
  databases: number
  onClose: () => void
  onDuplicate: (newKey: string, overwrite: boolean, toDb: number) => Promise<boolean>
}) {
  const [name, setName] = useState(`${keyName}:copy`)
  const [toDb, setToDb] = useState(db)
  const [overwrite, setOverwrite] = useState(false)
  return (
    <FormDialog
      title="Duplicate key"
      confirmLabel="Duplicate"
      onClose={onClose}
      onSubmit={() => onDuplicate(name, overwrite, toDb)}
      disabled={name === '' || (name === keyName && toDb === db)}
    >
      <Field label="Name of the copy">
        {(id) => (
          <input
            id={id}
            className="mono"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            spellCheck={false}
          />
        )}
      </Field>
      {databases > 1 ? (
        <Field label="Database">
          {(id) => (
            <select id={id} value={toDb} onChange={(event) => setToDb(Number(event.target.value))}>
              {Array.from({ length: Math.min(databases, 256) }, (_, i) => i).map((i) => (
                <option key={i} value={i}>
                  db{i}
                </option>
              ))}
            </select>
          )}
        </Field>
      ) : null}
      <label className="check">
        <input
          type="checkbox"
          checked={overwrite}
          onChange={(event) => setOverwrite(event.target.checked)}
        />
        Replace a key that already has this name
      </label>
    </FormDialog>
  )
}
