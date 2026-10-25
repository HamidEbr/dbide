import { Braces, Pencil } from 'lucide-react'
import { useState } from 'react'
import { byteLength, isBinary } from '@shared/redis/bstring'
import { STRING_LIMIT, type ValuePage } from '@shared/redis/types'
import { Button } from '@/components/ui'
import { prettyJson, tryJson } from '@/features/inspector/decode'
import type { Change } from './KeyView'
import { ValueViewer } from './ValueViewer'

/** A string value: shown decoded, and edited as text. */
export function StringEditor({
  page,
  keyName,
  db,
  change,
}: {
  page: Extract<ValuePage, { type: 'string' }>
  keyName: string
  db: number
  change: Change
}) {
  const [draft, setDraft] = useState<string | null>(null)
  const reason = page.truncated
    ? `This value is longer than ${(STRING_LIMIT / 1024 / 1024).toFixed(0)} MB, so only its start is loaded and it can’t be edited here.`
    : isBinary(page.value)
      ? 'This value is not text, so it can’t be edited here. The console can set it with escapes such as "\\xff".'
      : null

  const save = async (): Promise<void> => {
    if (draft === null) return
    const ran = await change(
      { op: 'string.set', value: draft },
      {
        title: 'Change this value?',
        confirmLabel: 'Save',
        lines: [
          `Set the string ${keyName} in db${db} (${byteLength(draft).toLocaleString()} bytes)`,
        ],
      },
    )
    if (ran) setDraft(null)
  }

  if (draft === null) {
    return (
      <div className="redis-string">
        <div className="redis-actions">
          <Button
            icon={<Pencil size={14} />}
            disabled={reason !== null}
            title={reason ?? 'Edit the value'}
            onClick={() => setDraft(page.value)}
          >
            Edit
          </Button>
          {reason ? <span className="muted">{reason}</span> : null}
        </div>
        <ValueViewer value={page.value} bytes={page.bytes} truncated={page.truncated} />
      </div>
    )
  }

  const asJson = tryJson(draft) !== undefined
  return (
    <div className="redis-string">
      <textarea
        className="mono redis-editor"
        aria-label="Value"
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setDraft(null)
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) void save()
        }}
        spellCheck={false}
      />
      <div className="redis-actions">
        <Button variant="primary" onClick={() => void save()}>
          Save
        </Button>
        <Button onClick={() => setDraft(null)}>Cancel</Button>
        <Button
          variant="ghost"
          icon={<Braces size={14} />}
          disabled={!asJson}
          title={asJson ? 'Lay the JSON out' : 'The text is not JSON'}
          onClick={() => setDraft(prettyJson(draft))}
        >
          Format JSON
        </Button>
        <span className="muted">{byteLength(draft).toLocaleString()} bytes · ⌘↵ saves</span>
      </div>
    </div>
  )
}
