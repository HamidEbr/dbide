import { useState } from 'react'
import type { NewKey } from '@shared/redis/types'
import { printable } from '@shared/redis/bstring'
import { CORE_TYPES, type CoreType } from '@shared/redis/types'
import { Field, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { changeData } from '@/state/writes'
import { FormDialog } from './PromptDialog'

const UNITS = { s: 1, m: 60, h: 3600, d: 86400 } as const

/** A TTL typed as a number and a unit, in milliseconds. Null when the field is empty. */
export function parseTtl(amount: string, unit: keyof typeof UNITS): number | null | 'invalid' {
  if (amount.trim() === '') return null
  const n = Number(amount)
  if (!Number.isFinite(n) || n <= 0) return 'invalid'
  return Math.round(n * UNITS[unit] * 1000)
}

/** Makes a key of any type, with its first element and, if wanted, a TTL. */
export function NewKeyDialog({
  connectionId,
  db,
  onClose,
  onDone,
}: {
  connectionId: string
  db: number
  onClose: () => void
  onDone: (key: string) => void
}) {
  const [name, setName] = useState('')
  const [type, setType] = useState<CoreType>('string')
  const [value, setValue] = useState('')
  const [field, setField] = useState('')
  const [score, setScore] = useState('0')
  const [ttl, setTtl] = useState('')
  const [unit, setUnit] = useState<keyof typeof UNITS>('s')

  const parsedTtl = parseTtl(ttl, unit)
  const parsedScore = Number(score)
  const problem =
    name === ''
      ? 'Give the key a name.'
      : parsedTtl === 'invalid'
        ? 'The expiry must be a positive number.'
        : type === 'zset' && (score.trim() === '' || Number.isNaN(parsedScore))
          ? 'The score must be a number.'
          : (type === 'hash' || type === 'stream') && field === ''
            ? type === 'hash'
              ? 'Give the hash its first field.'
              : 'Give the entry its first field.'
            : null

  const build = (): NewKey => {
    switch (type) {
      case 'string':
        return { type, value }
      case 'hash':
        return { type, field, value }
      case 'list':
        return { type, value }
      case 'set':
        return { type, member: value }
      case 'zset':
        return { type, member: value, score: parsedScore }
      case 'stream':
        return { type, fields: [[field, value]] }
    }
  }

  const create = (): Promise<boolean> =>
    changeData({
      connectionId,
      title: 'Create this key?',
      confirmLabel: 'Create',
      lines: [`Create the ${type} “${printable(name)}” in db${db}`],
      done: `Created “${printable(name)}”.`,
      run: async () => {
        await coreLink.call('redis.edit', {
          connectionId,
          db,
          writable: true,
          key: name,
          edit: { op: 'key.create', value: build() },
        })
        if (typeof parsedTtl === 'number') {
          await coreLink.call('redis.edit', {
            connectionId,
            db,
            writable: true,
            key: name,
            edit: { op: 'ttl.set', ttlMs: parsedTtl },
          })
        }
      },
    }).then((ran) => {
      if (ran) onDone(name)
      return ran
    })

  return (
    <FormDialog
      title="New key"
      confirmLabel="Create"
      onClose={onClose}
      onSubmit={create}
      disabled={problem !== null}
      error={name === '' ? null : problem}
    >
      <Field label="Name">
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
      <Segmented<CoreType>
        label="Type"
        value={type}
        onChange={setType}
        options={CORE_TYPES.map((t) => ({ value: t, label: t }))}
      />
      {type === 'hash' || type === 'stream' ? (
        <Field label={type === 'hash' ? 'First field' : 'First field of the entry'}>
          {(id) => (
            <input
              id={id}
              className="mono"
              value={field}
              onChange={(event) => setField(event.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
      ) : null}
      {type === 'zset' ? (
        <Field label="Score">
          {(id) => (
            <input
              id={id}
              className="mono"
              inputMode="decimal"
              value={score}
              onChange={(event) => setScore(event.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
      ) : null}
      <Field
        label={
          type === 'set' || type === 'zset'
            ? 'First member'
            : type === 'list'
              ? 'First item'
              : 'Value'
        }
      >
        {(id) => (
          <textarea
            id={id}
            className="mono broker-payload-input"
            rows={3}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            spellCheck={false}
          />
        )}
      </Field>
      <div className="broker-inline">
        <Field label="Expires in" hint="Leave empty to keep the key forever.">
          {(id) => (
            <input
              id={id}
              className="mono"
              inputMode="decimal"
              value={ttl}
              onChange={(event) => setTtl(event.target.value)}
              spellCheck={false}
            />
          )}
        </Field>
        <Field label="Unit">
          {(id) => (
            <select
              id={id}
              value={unit}
              onChange={(event) => setUnit(event.target.value as keyof typeof UNITS)}
            >
              <option value="s">seconds</option>
              <option value="m">minutes</option>
              <option value="h">hours</option>
              <option value="d">days</option>
            </select>
          )}
        </Field>
      </div>
    </FormDialog>
  )
}
