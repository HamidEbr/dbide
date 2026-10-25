import { Pencil, Tag, Trash2 } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { printable } from '@shared/redis/bstring'
import type { HashEntry, ListEntry, RedisEdit, ZsetEntry } from '@shared/redis/types'
import { toGlob } from '@shared/redis/types'
import { Button, IconButton } from '@/components/ui'
import { formatCount } from '@/lib/format'
import { FormDialog } from './PromptDialog'
import type { Change } from './KeyView'
import type { Elements } from './useElements'
import { ValueViewer } from './ValueViewer'

type Kind = 'hash' | 'list' | 'set' | 'zset'

interface Row {
  id: string
  /** The leading cells. */
  cells: ReactNode[]
  /** What the value viewer shows for this row, in the binary-safe form. */
  value: string
}

const SHORT = 160
const short = (text: string): string => {
  const shown = printable(text)
  return shown.length > SHORT ? `${shown.slice(0, SHORT)}…` : shown
}

/** The members of a hash, list, set or sorted set, with a way to change each and to add more. */
export function CollectionView({
  kind,
  elements,
  keyName,
  db,
  change,
  match,
  onMatch,
}: {
  kind: Kind
  elements: Elements
  keyName: string
  db: number
  change: Change
  match: string
  onMatch: (match: string) => void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [filter, setFilter] = useState(match)
  const [add, setAdd] = useState({ first: '', second: '' })

  const items = elements.items

  const rows: Row[] = items.map((item, i) => {
    switch (kind) {
      case 'hash': {
        const { field, value } = item as HashEntry
        return { id: field, cells: [field, value], value }
      }
      case 'list': {
        const { index, value } = item as ListEntry
        return { id: String(index), cells: [String(index), value], value }
      }
      case 'set': {
        const member = item as string
        return { id: member, cells: [member], value: member }
      }
      case 'zset': {
        const { member, score } = item as ZsetEntry
        return { id: member, cells: [member, String(score)], value: member }
      }
    }
    void i
    return { id: '', cells: [], value: '' }
  })
  const current = rows.find((r) => r.id === selected) ?? null

  const headers: Record<Kind, string[]> = {
    hash: ['Field', 'Value'],
    list: ['#', 'Value'],
    set: ['Member'],
    zset: ['Member', 'Score'],
  }

  const remove = (row: Row): Promise<boolean> => {
    const edits: Record<Kind, RedisEdit> = {
      hash: { op: 'hash.delete', fields: [row.id] },
      list: { op: 'list.remove', index: Number(row.id) },
      set: { op: 'set.remove', members: [row.id] },
      zset: { op: 'zset.remove', members: [row.id] },
    }
    return change(edits[kind], {
      title: 'Remove this entry?',
      confirmLabel: 'Remove',
      destructive: true,
      lines: [
        kind === 'list'
          ? `Remove item ${row.id} from the list ${keyName} in db${db}`
          : `Remove “${short(row.id)}” from ${keyName} in db${db}`,
      ],
    })
  }

  const save = async (row: Row): Promise<void> => {
    if (!editing) return
    let edit: RedisEdit
    if (kind === 'hash') edit = { op: 'hash.set', field: row.id, value: editing.draft }
    else if (kind === 'list') edit = { op: 'list.set', index: Number(row.id), value: editing.draft }
    else {
      const score = Number(editing.draft)
      if (editing.draft.trim() === '' || Number.isNaN(score)) return
      edit = { op: 'zset.add', member: row.id, score }
    }
    const ran = await change(edit, {
      title: 'Change this entry?',
      confirmLabel: 'Save',
      lines: [
        kind === 'zset'
          ? `Set the score of “${short(row.id)}” to ${editing.draft} in ${keyName}, db${db}`
          : `Change ${kind === 'list' ? `item ${row.id}` : `the field “${short(row.id)}”`} of ${keyName} in db${db}`,
      ],
    })
    if (ran) setEditing(null)
  }

  const addEntry = async (side?: 'head' | 'tail'): Promise<void> => {
    let edit: RedisEdit
    let line: string
    if (kind === 'hash') {
      if (add.first === '') return
      edit = { op: 'hash.set', field: add.first, value: add.second }
      line = `Set the field “${short(add.first)}” of ${keyName} in db${db}`
    } else if (kind === 'list') {
      edit = { op: 'list.push', side: side ?? 'tail', values: [add.first] }
      line = `Push an item onto the ${side === 'head' ? 'head' : 'tail'} of ${keyName} in db${db}`
    } else if (kind === 'set') {
      if (add.first === '') return
      edit = { op: 'set.add', members: [add.first] }
      line = `Add “${short(add.first)}” to ${keyName} in db${db}`
    } else {
      const score = Number(add.second)
      if (add.first === '' || add.second.trim() === '' || Number.isNaN(score)) return
      edit = { op: 'zset.add', member: add.first, score }
      line = `Add “${short(add.first)}” with score ${add.second} to ${keyName} in db${db}`
    }
    const ran = await change(edit, { title: 'Add this entry?', confirmLabel: 'Add', lines: [line] })
    if (ran) setAdd({ first: '', second: '' })
  }

  const addPlaceholders: Record<Kind, [string, string | null]> = {
    hash: ['Field', 'Value'],
    list: ['New item', null],
    set: ['New member', null],
    zset: ['Member', 'Score'],
  }
  const [firstHolder, secondHolder] = addPlaceholders[kind]

  return (
    <div className="redis-collection">
      <form
        className="broker-bind"
        onSubmit={(event) => {
          event.preventDefault()
          void addEntry()
        }}
      >
        <input
          className="mono"
          placeholder={firstHolder}
          aria-label={firstHolder}
          value={add.first}
          onChange={(event) => setAdd((a) => ({ ...a, first: event.target.value }))}
          spellCheck={false}
        />
        {secondHolder ? (
          <input
            className="mono"
            placeholder={secondHolder}
            aria-label={secondHolder}
            value={add.second}
            onChange={(event) => setAdd((a) => ({ ...a, second: event.target.value }))}
            spellCheck={false}
          />
        ) : null}
        {kind === 'list' ? (
          <>
            <Button onClick={() => void addEntry('head')} disabled={add.first === ''}>
              Push to head
            </Button>
            <Button onClick={() => void addEntry('tail')} disabled={add.first === ''}>
              Push to tail
            </Button>
          </>
        ) : (
          <Button type="submit" disabled={add.first === ''}>
            {kind === 'hash' ? 'Set field' : 'Add'}
          </Button>
        )}
        {kind === 'hash' || kind === 'set' ? (
          <input
            type="search"
            className="redis-member-filter mono"
            placeholder={kind === 'hash' ? 'Filter fields' : 'Filter members'}
            aria-label="Filter"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                onMatch(filter.trim() === '' ? '' : toGlob(filter))
              }
            }}
            spellCheck={false}
          />
        ) : null}
      </form>

      {elements.error ? (
        <p className="note-error" role="alert">
          {elements.error}
        </p>
      ) : null}

      <table className="broker-table redis-table">
        <thead>
          <tr>
            {headers[kind].map((h) => (
              <th key={h}>{h}</th>
            ))}
            <th className="broker-actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.id}
              className={`broker-click ${selected === row.id ? 'selected' : ''}`}
              tabIndex={0}
              onClick={() => setSelected(row.id)}
            >
              {row.cells.map((cell, i) => {
                const isValue = i === row.cells.length - 1 && (kind === 'hash' || kind === 'list')
                const isScore = kind === 'zset' && i === 1
                if (editing?.id === row.id && (isValue || isScore)) {
                  return (
                    <td key={i}>
                      <textarea
                        className="mono redis-cell-editor"
                        autoFocus
                        rows={isScore ? 1 : 2}
                        value={editing.draft}
                        onChange={(event) => setEditing({ id: row.id, draft: event.target.value })}
                        onKeyDown={(event) => {
                          if (event.key === 'Escape') setEditing(null)
                          if (
                            event.key === 'Enter' &&
                            (isScore || event.metaKey || event.ctrlKey)
                          ) {
                            event.preventDefault()
                            void save(row)
                          }
                        }}
                        spellCheck={false}
                      />
                      <span className="redis-actions">
                        <Button variant="primary" onClick={() => void save(row)}>
                          Save
                        </Button>
                        <Button onClick={() => setEditing(null)}>Cancel</Button>
                      </span>
                    </td>
                  )
                }
                return (
                  <td key={i} className="mono redis-cell" title={printable(String(cell))}>
                    {typeof cell === 'string' ? short(cell) : cell}
                  </td>
                )
              })}
              <td className="broker-actions redis-row-actions">
                {kind === 'set' ? null : (
                  <IconButton
                    label={kind === 'zset' ? 'Edit score' : 'Edit value'}
                    onClick={(event) => {
                      event.stopPropagation()
                      setEditing({
                        id: row.id,
                        draft: kind === 'zset' ? row.cells[1]!.toString() : row.value,
                      })
                    }}
                  >
                    <Pencil size={12} />
                  </IconButton>
                )}
                {kind === 'hash' ? (
                  <IconButton
                    label="Rename field"
                    onClick={(event) => {
                      event.stopPropagation()
                      setRenaming(row.id)
                    }}
                  >
                    <Tag size={12} />
                  </IconButton>
                ) : null}
                <IconButton
                  label="Remove"
                  onClick={(event) => {
                    event.stopPropagation()
                    void remove(row)
                  }}
                >
                  <Trash2 size={12} />
                </IconButton>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <p className="redis-status muted">
        {elements.loading
          ? 'Reading…'
          : `${formatCount(rows.length)} ${rows.length === 1 ? 'entry' : 'entries'} loaded${match ? ` matching ${match}` : ''}`}
        {elements.hasMore ? (
          <>
            {' · '}
            <Button variant="ghost" disabled={elements.loadingMore} onClick={elements.loadMore}>
              {elements.loadingMore ? 'Loading…' : 'Load more'}
            </Button>
          </>
        ) : null}
      </p>

      {current && (kind === 'hash' || kind === 'list') ? (
        <section className="broker-section">
          <h3>Value of {kind === 'hash' ? short(current.id) : `item ${current.id}`}</h3>
          <ValueViewer
            value={current.value}
            bytes={new TextEncoder().encode(current.value).length}
          />
        </section>
      ) : null}

      {renaming !== null ? (
        <RenameFieldDialog
          field={renaming}
          onClose={() => setRenaming(null)}
          onRename={(newField) =>
            change(
              { op: 'hash.rename', field: renaming, newField },
              {
                title: 'Rename this field?',
                confirmLabel: 'Rename',
                lines: [
                  `Rename the field “${short(renaming)}” to “${short(newField)}” in ${keyName}, db${db}`,
                ],
              },
            )
          }
        />
      ) : null}
    </div>
  )
}

function RenameFieldDialog({
  field,
  onClose,
  onRename,
}: {
  field: string
  onClose: () => void
  onRename: (newField: string) => Promise<boolean>
}) {
  const [name, setName] = useState(field)
  return (
    <FormDialog
      title="Rename field"
      confirmLabel="Rename"
      onClose={onClose}
      onSubmit={() => onRename(name)}
      disabled={name === '' || name === field}
    >
      <input
        className="mono"
        aria-label="New field name"
        autoFocus
        value={name}
        onChange={(event) => setName(event.target.value)}
        spellCheck={false}
      />
    </FormDialog>
  )
}
