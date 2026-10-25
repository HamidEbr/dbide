import { Fragment, type ReactNode } from 'react'
import { tokenize } from '@shared/mongo/lang'

const KEYWORDS = new Set(['true', 'false', 'null', 'undefined', 'NaN', 'Infinity'])

/**
 * Text in the shell's notation with its parts coloured: keys, strings, numbers, the types such as
 * ObjectId(...) and the keywords. Whatever the reader can't make out is shown as it is, uncoloured.
 */
export function highlightShell(text: string): ReactNode {
  const { tokens } = tokenize(text)
  const out: ReactNode[] = []
  let at = 0
  tokens.forEach((token, i) => {
    if (token.start > at) out.push(text.slice(at, token.start))
    const raw = text.slice(token.start, token.end)
    const after = tokens[i + 1]
    let kind: string | null = null
    if (token.type === 'string') {
      kind = after?.type === 'punct' && after.value === ':' ? 'key' : 'string'
    } else if (token.type === 'name') {
      if (after?.type === 'punct' && after.value === ':') kind = 'key'
      else if (after?.type === 'punct' && after.value === '(') kind = 'type'
      else if (KEYWORDS.has(token.value)) kind = 'keyword'
    } else if (token.type === 'number') kind = 'number'
    else if (token.type === 'regex') kind = 'string'
    out.push(
      kind ? (
        <span key={i} className={`sh-${kind}`}>
          {raw}
        </span>
      ) : (
        <Fragment key={i}>{raw}</Fragment>
      ),
    )
    at = token.end
  })
  if (at < text.length) out.push(text.slice(at))
  return out
}
