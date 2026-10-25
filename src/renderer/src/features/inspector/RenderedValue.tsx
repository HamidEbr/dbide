import { useState, type ReactNode } from 'react'
import { copyText } from '@/features/sql/grid/format'
import {
  formatByteCount,
  hexdump,
  toBase64,
  type DecodedJwt,
  type Rendered,
  type TimestampInfo,
  type UuidInfo,
} from './decode'

/** Large values are cut for display; copying always takes the whole thing. */
const MAX_SHOWN_CHARS = 200_000

const TOKEN = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)/g

/** JSON text with keys, strings, numbers, and literals colored. */
function JsonBlock({ text }: { text: string }) {
  const shown = text.length > MAX_SHOWN_CHARS ? text.slice(0, MAX_SHOWN_CHARS) : text
  const parts: ReactNode[] = []
  let last = 0
  for (const match of shown.matchAll(TOKEN)) {
    const at = match.index
    if (at > last) parts.push(shown.slice(last, at))
    const [whole, string, colon, literal] = match
    const className = string
      ? colon
        ? 'tok-key'
        : 'tok-string'
      : literal
        ? 'tok-literal'
        : 'tok-number'
    parts.push(
      <span key={at} className={className}>
        {string && colon ? string : whole}
      </span>,
    )
    if (string && colon) parts.push(colon)
    last = at + whole.length
  }
  if (last < shown.length) parts.push(shown.slice(last))
  return (
    <>
      <pre className="value-block mono selectable">{parts}</pre>
      {text.length > MAX_SHOWN_CHARS ? <Truncated total={text.length} /> : null}
    </>
  )
}

function Truncated({ total }: { total: number }) {
  return (
    <p className="muted value-note">
      Showing the first {MAX_SHOWN_CHARS.toLocaleString()} of {total.toLocaleString()} characters.
      Copy takes all of it.
    </p>
  )
}

function Facts({ rows }: { rows: [label: string, value: ReactNode][] }) {
  return (
    <dl className="facts value-facts selectable">
      {rows.map(([label, value]) => (
        <div key={label} className="fact-row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

function Jwt({ jwt }: { jwt: DecodedJwt }) {
  return (
    <>
      <p className="note-warn value-note">
        Decoded, not verified. Anyone can write a token that looks like this.
      </p>
      <h4 className="value-heading">Claims</h4>
      <Facts
        rows={jwt.claims.map((claim) => [
          claim.name,
          claim.time ? `${claim.time.iso} (${claim.time.relative})` : claim.value,
        ])}
      />
      <h4 className="value-heading">Header{jwt.algorithm ? ` · ${jwt.algorithm}` : ''}</h4>
      <JsonBlock text={jwt.header} />
      <h4 className="value-heading">Payload</h4>
      <JsonBlock text={jwt.payload} />
      <p className="muted value-note">Signature: {jwt.signatureBytes} bytes</p>
    </>
  )
}

function Timestamp({ info }: { info: TimestampInfo }) {
  return (
    <Facts
      rows={[
        ['Read as', `Unix time in ${info.unit}`],
        ['UTC', info.utc],
        ['Local', info.local],
        ['Relative', info.relative],
      ]}
    />
  )
}

function Uuid({ info }: { info: UuidInfo }) {
  return (
    <Facts
      rows={[
        ['UUID', info.text],
        ['Version', String(info.version)],
        ['Variant', info.variant],
        ...(info.time ? ([['Time', info.time]] as [string, string][]) : []),
      ]}
    />
  )
}

function UrlParts({ url }: { url: URL }) {
  const params = [...url.searchParams]
  return (
    <>
      <Facts
        rows={[
          ['Scheme', url.protocol.replace(':', '')],
          ['Host', url.host],
          ['Path', url.pathname],
          ...(url.hash ? ([['Fragment', url.hash]] as [string, string][]) : []),
        ]}
      />
      {params.length > 0 ? (
        <>
          <h4 className="value-heading">Query</h4>
          <Facts rows={params.map(([k, v]) => [k, v])} />
        </>
      ) : null}
    </>
  )
}

function Picture({ mime, bytes }: { mime: string; bytes: Uint8Array }) {
  const [size, setSize] = useState<string | null>(null)
  if (bytes.length > 5 * 1024 * 1024) {
    return (
      <p className="muted value-note">
        This image is {formatByteCount(bytes.length)}, too large to preview.
      </p>
    )
  }
  return (
    <figure className="value-image">
      <img
        alt="Value shown as an image"
        src={`data:${mime};base64,${toBase64(bytes)}`}
        onLoad={(event) =>
          setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`)
        }
      />
      <figcaption className="muted">
        {mime.replace('image/', '').toUpperCase()} · {formatByteCount(bytes.length)}
        {size ? ` · ${size}` : ''}
      </figcaption>
    </figure>
  )
}

/** One decoded value, laid out for its kind. */
export function RenderedValue({ rendered }: { rendered: Rendered }) {
  switch (rendered.type) {
    case 'empty':
      return <p className="muted value-note">Nothing to show.</p>
    case 'text':
      return (
        <>
          <pre className="value-block value-text selectable">
            {rendered.text.length > MAX_SHOWN_CHARS
              ? rendered.text.slice(0, MAX_SHOWN_CHARS)
              : rendered.text}
          </pre>
          {rendered.text.length > MAX_SHOWN_CHARS ? (
            <Truncated total={rendered.text.length} />
          ) : null}
        </>
      )
    case 'json':
    case 'php':
      return <JsonBlock text={rendered.text} />
    case 'jwt':
      return <Jwt jwt={rendered.jwt} />
    case 'timestamp':
      return <Timestamp info={rendered.info} />
    case 'uuid':
      return <Uuid info={rendered.info} />
    case 'url':
      return <UrlParts url={rendered.url} />
    case 'image':
      return <Picture mime={rendered.mime} bytes={rendered.bytes} />
    case 'hex':
      return <pre className="value-block mono selectable">{hexdump(rendered.bytes)}</pre>
    case 'error':
      return (
        <p className="note-error" role="alert">
          {rendered.message}
        </p>
      )
  }
}

/** The text a "copy decoded" action would put on the clipboard, if there is one. */
export function decodedText(rendered: Rendered): string | null {
  switch (rendered.type) {
    case 'text':
    case 'json':
    case 'php':
      return rendered.text
    case 'jwt':
      return `${rendered.jwt.header}\n${rendered.jwt.payload}`
    case 'hex':
      return hexdump(rendered.bytes, Number.MAX_SAFE_INTEGER)
    default:
      return null
  }
}

export { copyText }
