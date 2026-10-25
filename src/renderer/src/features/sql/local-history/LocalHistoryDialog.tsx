import { History, RotateCcw, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { diffLines, diffStats } from '@shared/diff'
import { REVISION_LABELS, type ScriptRevision } from '@shared/scripts'
import { Button, IconButton, Segmented } from '@/components/ui'
import { coreLink } from '@/ipc/link'
import { writeClipboard } from '@/lib/clipboard'
import { dateTime } from '@/lib/time'
import { useDialogs } from '@/state/dialogs'
import { notify } from '@/state/notices'
import { useScripts } from '@/state/scripts'
import { editorFor } from '../editor/handles'
import { pullLiveText, saveNow, settled } from '../persistence'
import { extensionOf } from '../statements'
import { DiffView } from './DiffView'

/** Scripts bigger than this are shown without a comparison. */
const MAX_DIFF_CHARS = 400_000

const formatSize = (bytes: number): string =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10_240 ? 1 : 0)} KB`

type Compare = 'current' | 'previous'

/**
 * Every version of a script that was kept, with what changed in each. Restoring one puts its text
 * in the editor as an ordinary edit, so Undo takes it back.
 */
export function LocalHistoryDialog() {
  const scriptId = useDialogs((state) => state.localHistory)
  if (!scriptId) return null
  // Keyed, so a second script never shows the first one's versions for a moment.
  return <HistoryBody key={scriptId} scriptId={scriptId} />
}

function HistoryBody({ scriptId }: { scriptId: string }) {
  const close = useDialogs((state) => state.closeLocalHistory)
  const name = useScripts((state) => state.scripts[scriptId]?.name ?? 'Script')
  const extension = useScripts((state) => extensionOf(state.scripts[scriptId]?.language ?? 'sql'))
  const [versions, setVersions] = useState<ScriptRevision[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [compare, setCompare] = useState<Compare>('current')
  const [contents, setContents] = useState<Record<number, string>>({})
  const [current, setCurrent] = useState('')
  const list = useRef<HTMLUListElement>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        // What was typed a moment ago is saved first, so it is in the list too.
        const text = pullLiveText(scriptId) ?? ''
        await saveNow(scriptId, { text })
        await settled(scriptId)
        const found = await coreLink.call('scripts.history', { id: scriptId })
        if (cancelled) return
        setCurrent(text)
        setVersions(found)
        setSelected(found[0]?.id ?? null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [scriptId])

  const index = versions?.findIndex((v) => v.id === selected) ?? -1
  const previous = versions && index >= 0 ? versions[index + 1] : undefined

  // Versions are fetched as they are looked at, the one before it too for a comparison.
  useEffect(() => {
    const wanted = [selected, previous?.id].filter(
      (id): id is number => id !== null && id !== undefined && !(id in contents),
    )
    if (wanted.length === 0) return
    let cancelled = false
    void Promise.all(
      wanted.map(
        async (id) =>
          [id, await coreLink.call('scripts.revision', { id: scriptId, revisionId: id })] as const,
      ),
    )
      .then((pairs) => {
        if (!cancelled) setContents((known) => ({ ...known, ...Object.fromEntries(pairs) }))
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      })
    return () => {
      cancelled = true
    }
  }, [selected, previous?.id, contents, scriptId])

  const text = selected !== null ? contents[selected] : undefined
  const before = compare === 'previous' ? (previous ? contents[previous.id] : '') : undefined
  const ready = text !== undefined && (compare === 'current' || before !== undefined)

  const diff = useMemo(() => {
    if (!ready) return null
    const [from, to] = compare === 'current' ? [text, current] : [before ?? '', text]
    if (from.length + to.length > MAX_DIFF_CHARS) return 'too-large' as const
    return diffLines(from, to)
  }, [ready, compare, text, current, before])
  const stats = diff && diff !== 'too-large' ? diffStats(diff) : null

  const restore = async (): Promise<void> => {
    const editor = editorFor(scriptId)
    if (text === undefined || !editor) return
    // The text being replaced goes into history first, so restoring never loses anything.
    await saveNow(scriptId, { label: 'restore', text: editor.getText() })
    editor.setText(text)
    close()
    editor.focus()
    notify('Restored that version. Undo brings back what was there.')
  }

  return (
    <div className="dialog-overlay" onMouseDown={close}>
      <div
        className="dialog dialog-wide local-history"
        role="dialog"
        aria-modal="true"
        aria-labelledby="local-history-title"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation()
            close()
          }
        }}
      >
        <header>
          <History size={18} className="dialog-icon neutral" aria-hidden />
          <h2 id="local-history-title">
            Local history{' '}
            <span className="muted">
              · {name}
              {extension}
            </span>
          </h2>
          <IconButton label="Close" onClick={close}>
            <X size={14} />
          </IconButton>
        </header>

        {error ? <p className="note-error">{error}</p> : null}
        {versions === null && !error ? <p className="muted">Loading…</p> : null}
        {versions?.length === 0 ? (
          <p className="muted lh-empty">
            No earlier versions yet. A version is kept every time the script runs, and while you
            work on it.
          </p>
        ) : null}

        {versions && versions.length > 0 ? (
          <div className="lh-body">
            <ul className="lh-list" role="listbox" aria-label="Versions" ref={list}>
              {versions.map((version) => (
                <li
                  key={version.id}
                  role="option"
                  aria-selected={version.id === selected}
                  tabIndex={version.id === selected ? 0 : -1}
                  className={`lh-item ${version.id === selected ? 'active' : ''}`}
                  onClick={() => setSelected(version.id)}
                  onKeyDown={(event) => {
                    const at = versions.findIndex((v) => v.id === version.id)
                    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0
                    if (step === 0) return
                    const next = versions[at + step]
                    if (!next) return
                    setSelected(next.id)
                    event.preventDefault()
                    queueMicrotask(() =>
                      list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus(),
                    )
                  }}
                >
                  <span className="lh-when">{dateTime(version.createdAt)}</span>
                  <span className="lh-meta muted">
                    {version.label ? (
                      <span className={`pill pill-${version.label}`}>
                        {REVISION_LABELS[version.label]}
                      </span>
                    ) : null}
                    {formatSize(version.size)}
                  </span>
                </li>
              ))}
            </ul>

            <div className="lh-main">
              <div className="lh-toolbar">
                <Segmented<Compare>
                  label="Compare with"
                  value={compare}
                  options={[
                    { value: 'current', label: 'Current text' },
                    { value: 'previous', label: 'Version before' },
                  ]}
                  onChange={setCompare}
                />
                {stats ? (
                  <span className="lh-stats">
                    <span className="diff-added">+{stats.added}</span>{' '}
                    <span className="diff-removed">−{stats.removed}</span>
                  </span>
                ) : null}
                <span className="spacer" />
                <Button
                  variant="ghost"
                  disabled={text === undefined}
                  onClick={() => {
                    if (text !== undefined)
                      void writeClipboard(text).then(() => notify('Copied the version.'))
                  }}
                >
                  Copy
                </Button>
                <Button
                  variant="primary"
                  icon={<RotateCcw size={13} />}
                  disabled={text === undefined}
                  onClick={() => void restore()}
                >
                  Restore this version
                </Button>
              </div>
              <p className="lh-legend muted">
                {compare === 'current'
                  ? 'Red lines are in the selected version only. Green lines are in the text you have now.'
                  : 'Red lines were in the version before. Green lines were added in the selected one.'}
              </p>
              <div className="lh-diff">
                {!ready ? <p className="muted pad">Loading…</p> : null}
                {diff === 'too-large' ? (
                  <p className="muted pad">
                    This script is too large to compare. Restore the version to look at it.
                  </p>
                ) : diff ? (
                  <DiffView
                    lines={diff}
                    same={
                      compare === 'current'
                        ? 'This version is the same as the text you have now.'
                        : 'This version is the same as the one before it.'
                    }
                  />
                ) : null}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  )
}
