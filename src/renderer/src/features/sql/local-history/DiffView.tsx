import { useMemo, useState } from 'react'
import { collapseUnchanged, type DiffLine } from '@shared/diff'

/** More lines than this are cut off, so a rewrite of a huge script can't freeze the window. */
const MAX_LINES = 1500

const SIGN = { add: '+', del: '−', same: ' ' } as const

/** A unified diff with unchanged stretches folded away. A fold opens with a click. */
export function DiffView({ lines, same }: { lines: DiffLine[]; same?: string }) {
  const blocks = useMemo(() => collapseUnchanged(lines, 3), [lines])
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set())

  if (lines.length === 0) return <p className="muted pad">Empty.</p>
  if (!lines.some((l) => l.kind !== 'same')) {
    return <p className="muted pad">{same ?? 'No differences.'}</p>
  }

  let shown = 0
  const rows: React.ReactNode[] = []
  for (const [index, block] of blocks.entries()) {
    if (shown >= MAX_LINES) break
    if (block.type === 'skip') {
      if (!expanded.has(index)) {
        rows.push(
          <button
            key={index}
            type="button"
            className="diff-skip"
            onClick={() => setExpanded(new Set([...expanded, index]))}
          >
            ⋯ {block.count.toLocaleString()} unchanged line{block.count === 1 ? '' : 's'}
          </button>,
        )
        continue
      }
      for (const line of block.lines) {
        rows.push(<DiffRow key={`${index}-${rows.length}`} line={line} />)
        shown++
      }
      continue
    }
    for (const line of block.lines) {
      rows.push(<DiffRow key={`${index}-${rows.length}`} line={line} />)
      shown++
    }
  }

  return (
    <div className="diff mono" role="table" aria-label="Differences">
      {rows}
      {shown >= MAX_LINES ? (
        <p className="muted pad">The rest of the differences are not shown.</p>
      ) : null}
    </div>
  )
}

function DiffRow({ line }: { line: DiffLine }) {
  return (
    <div className={`diff-line diff-${line.kind}`} role="row">
      <span className="diff-no" aria-hidden>
        {line.oldNo ?? ''}
      </span>
      <span className="diff-no" aria-hidden>
        {line.newNo ?? ''}
      </span>
      <span
        className="diff-sign"
        aria-label={line.kind === 'add' ? 'added' : line.kind === 'del' ? 'removed' : 'unchanged'}
      >
        {SIGN[line.kind]}
      </span>
      <span className="diff-text">{line.text === '' ? ' ' : line.text}</span>
    </div>
  )
}
