import { Eraser, Square } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { classifyRedis } from '@shared/redis/command'
import { isReadSafe } from '@shared/redis/command'
import { prefixGlob } from '@shared/redis/types'
import { Button, EnvBadge } from '@/components/ui'
import { Chip, LockButton } from '@/components/panel'
import { coreLink } from '@/ipc/link'
import { messageOf } from '@/lib/format'
import { useData } from '@/state/data'
import { changeData, isWritable, useWritable } from '@/state/writes'
import type { Tab } from '@/state/workbench'
import { CommandHistory, completions, formatReply, hintFor, keyArgument, keyText } from './console'

interface Entry {
  id: number
  prompt: string
  line: string
  out: string[]
  tone: 'plain' | 'error' | 'status'
  ms: number | null
}

const MAX_ENTRIES = 300

const HELP = [
  'Type a Redis command and press Enter. Tab completes a command, and ↑ ↓ walk back through earlier ones.',
  'Quotes work as in redis-cli: SET greeting "hello world", and "\\xff" for a byte.',
  'clear empties this screen. SELECT 3 moves the console to database 3. MULTI … EXEC runs a transaction.',
  'SUBSCRIBE and MONITOR are not supported here yet.',
]

let nextEntry = 1

/** A Redis console: a line at a time on a connection of its own, with completion, hints and history. */
export function ConsoleView({ tab, active }: { tab: Tab; active: boolean }) {
  const connectionId = tab.connectionId!
  const startDb = tab.redis!.db
  const connection = useData((state) => state.connections.find((c) => c.id === connectionId))
  const writable = useWritable(connectionId)

  // One console is one connection to the server, which the core keeps until the tab is closed.
  const [consoleId] = useState(() => crypto.randomUUID())
  const [history] = useState(() => new CommandHistory())
  const [entries, setEntries] = useState<Entry[]>([])
  const [input, setInput] = useState('')
  const [db, setDb] = useState<number | null>(null)
  const [running, setRunning] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [startError, setStartError] = useState<string | null>(null)
  const controller = useRef<AbortController | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const scroller = useRef<HTMLDivElement>(null)

  const prompt = connection
    ? `${connection.host}:${connection.port}${db !== null && db !== 0 ? `[${db}]` : ''}>`
    : '>'

  // The first call opens the connection and learns which database it is in; a tab opened from a database
  // starts in that database.
  useEffect(() => {
    const ctl = new AbortController()
    void (async () => {
      try {
        const first = await coreLink.call(
          'redis.exec',
          { connectionId, consoleId, writable: isWritable(connectionId), line: 'PING' },
          { signal: ctl.signal },
        )
        let current = first.db
        if (startDb >= 0 && startDb !== current) {
          const moved = await coreLink.call(
            'redis.exec',
            {
              connectionId,
              consoleId,
              writable: isWritable(connectionId),
              line: `SELECT ${startDb}`,
            },
            { signal: ctl.signal },
          )
          current = moved.db
        }
        setDb(current)
      } catch (error) {
        if (!ctl.signal.aborted) setStartError(messageOf(error))
      }
    })()
    return () => ctl.abort()
  }, [connectionId, consoleId, startDb])

  // Closing the tab closes the connection.
  useEffect(
    () => () => {
      void coreLink.call('redis.consoleClose', { consoleId }).catch(() => undefined)
    },
    [consoleId],
  )

  useEffect(() => {
    if (active) inputRef.current?.focus()
  }, [active])

  useEffect(() => {
    const element = scroller.current
    if (element) element.scrollTop = element.scrollHeight
  }, [entries])

  const push = (entry: Omit<Entry, 'id'>): void =>
    setEntries((all) => [...all.slice(-(MAX_ENTRIES - 1)), { ...entry, id: nextEntry++ }])

  // Key names, asked of the server a moment after typing stops, while a key is being typed.
  const [keyNames, setKeyNames] = useState<{ line: string; keys: string[] }>({ line: '', keys: [] })
  useEffect(() => {
    const argument = keyArgument(input)
    if (argument === null || db === null || running) return
    const ctl = new AbortController()
    const timer = setTimeout(() => {
      coreLink
        .call(
          'redis.scan',
          {
            connectionId,
            db,
            pattern: prefixGlob(argument.prefix),
            cursor: null,
            limit: 8,
          },
          { signal: ctl.signal },
        )
        .then((page) => setKeyNames({ line: input, keys: page.keys.map((k) => k.key) }))
        .catch(() => undefined)
    }, 200)
    return () => {
      clearTimeout(timer)
      ctl.abort()
    }
  }, [input, db, running, connectionId])

  const commandSuggestions = completions(input)
  const keyArg = keyArgument(input)
  const suggestions =
    commandSuggestions.items.length === 0 && keyArg !== null && keyNames.line === input
      ? {
          from: keyArg.from,
          items: keyNames.keys.map((key) => ({
            text: keyText(key, keyArg.quote !== null),
            syntax: 'key',
          })),
        }
      : commandSuggestions
  const open = !dismissed && !running && suggestions.items.length > 0
  const hint = hintFor(input)

  const accept = (index: number): void => {
    const item = suggestions.items[index]
    if (!item) return
    setInput(`${input.slice(0, suggestions.from)}${item.text}${item.syntax === '…' ? ' ' : ' '}`)
    setSelected(null)
    setDismissed(false)
    inputRef.current?.focus()
  }

  const submit = async (): Promise<void> => {
    const line = input.trim()
    if (line === '' || running) return
    setInput('')
    setSelected(null)
    history.push(line)
    const shown = prompt

    const word = line.toLowerCase()
    if (word === 'clear' || word === 'cls') {
      setEntries([])
      return
    }
    if (word === 'help') {
      push({ prompt: shown, line, out: HELP, tone: 'plain', ms: null })
      return
    }

    const info = classifyRedis(line)
    if (!writable && !isReadSafe(info.kind)) {
      push({
        prompt: shown,
        line,
        out: [
          info.kind === 'unknown'
            ? `(blocked) The console is read-only, and DBIDE doesn’t know whether ${info.name || 'that command'} changes data. Unlock writes in the toolbar to run it.`
            : `(blocked) The console is read-only, so ${info.name} can’t run. Unlock writes in the toolbar to continue.`,
        ],
        tone: 'error',
        ms: null,
      })
      return
    }

    const run = async (): Promise<void> => {
      const ctl = new AbortController()
      controller.current = ctl
      setRunning(true)
      try {
        const result = await coreLink.call(
          'redis.exec',
          { connectionId, consoleId, writable, line },
          { signal: ctl.signal },
        )
        setDb(result.db)
        push({
          prompt: shown,
          line,
          out: formatReply(result.reply),
          tone:
            result.reply.t === 'error' ? 'error' : result.reply.t === 'status' ? 'status' : 'plain',
          ms: result.ms,
        })
      } catch (error) {
        push({
          prompt: shown,
          line,
          out: [
            ctl.signal.aborted
              ? '(stopped) The connection was dropped; the next command reconnects.'
              : `(error) ${messageOf(error)}`,
          ],
          tone: 'error',
          ms: null,
        })
        // A dropped connection forgets which database it was in.
        if (ctl.signal.aborted) setDb(startDb >= 0 ? null : null)
      } finally {
        setRunning(false)
        controller.current = null
        inputRef.current?.focus()
      }
    }

    if (isReadSafe(info.kind)) {
      await run()
      return
    }
    await changeData({
      connectionId,
      title: `Run ${info.name || 'this command'}?`,
      confirmLabel: 'Run',
      destructive: info.destructive,
      ...(info.reason ? { reasons: [info.reason] } : {}),
      lines: [line],
      // Writes may add, rename or remove keys the navigator shows.
      refreshTree: true,
      run,
    })
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'l' && event.ctrlKey) {
      event.preventDefault()
      setEntries([])
      return
    }
    if (event.key === 'c' && event.ctrlKey && running) {
      event.preventDefault()
      controller.current?.abort()
      return
    }
    if (open) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setSelected((s) => (s === null ? 0 : Math.min(suggestions.items.length - 1, s + 1)))
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        setSelected((s) => (s === null || s === 0 ? null : s - 1))
        return
      }
      if (event.key === 'Tab') {
        event.preventDefault()
        accept(selected ?? 0)
        return
      }
      if (event.key === 'Enter' && selected !== null) {
        event.preventDefault()
        accept(selected)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        setDismissed(true)
        return
      }
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      void submit()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      const line = history.previous()
      if (line !== null) setInput(line)
    } else if (event.key === 'ArrowDown') {
      event.preventDefault()
      const line = history.next()
      if (line !== null) setInput(line)
    }
  }

  return (
    <div className="broker-tab">
      <header className="broker-header">
        <div className="broker-title">
          <h1>Console</h1>
          {connection ? <span className="mono">{connection.name}</span> : null}
          {connection ? <EnvBadge environment={connection.environment} /> : null}
          {db !== null ? <Chip>db{db}</Chip> : null}
        </div>
        <div className="broker-toolbar">
          <Button icon={<Eraser size={14} />} variant="ghost" onClick={() => setEntries([])}>
            Clear
          </Button>
          <span className="muted redis-hint">
            Tab completes · ↑ ↓ history · <span className="mono">help</span> for more
          </span>
          <span className="spacer" />
          <LockButton connectionId={connectionId} allows="commands that change data" />
        </div>
      </header>

      <div className="redis-console">
        <div
          className="redis-scrollback"
          ref={scroller}
          onClick={() => {
            if (window.getSelection()?.toString() === '') inputRef.current?.focus()
          }}
        >
          {startError ? (
            <p className="note-error" role="alert">
              {startError}
            </p>
          ) : null}
          {entries.length === 0 && !startError ? (
            <p className="muted">
              Commands run on this console’s own connection, so MULTI, SELECT and WATCH carry from
              one line to the next. Type <span className="mono">help</span> to see what it can do.
            </p>
          ) : null}
          {entries.map((entry) => (
            <div key={entry.id} className="redis-entry">
              <pre className="redis-typed mono selectable">
                <span className="redis-prompt">{entry.prompt}</span> {entry.line}
              </pre>
              <pre className={`redis-out redis-out-${entry.tone} mono selectable`}>
                {entry.out.join('\n')}
              </pre>
              {entry.ms !== null ? (
                <span className="redis-ms muted">
                  {entry.ms < 1 ? '< 1' : Math.round(entry.ms)} ms
                </span>
              ) : null}
            </div>
          ))}
        </div>

        <div className="redis-input-area">
          {open ? (
            <ul className="redis-suggestions" role="listbox" aria-label="Commands">
              {suggestions.items.map((item, i) => (
                <li
                  key={item.text}
                  role="option"
                  aria-selected={selected === i}
                  className={selected === i ? 'selected' : ''}
                  onMouseDown={(event) => {
                    event.preventDefault()
                    accept(i)
                  }}
                >
                  <span className="mono">{item.text}</span>
                  <span className="muted mono redis-suggestion-syntax">{item.syntax}</span>
                </li>
              ))}
            </ul>
          ) : null}
          {hint ? (
            <p className="redis-hintline mono" aria-live="polite">
              <strong>{hint.name}</strong>{' '}
              {hint.words.map((word, i) => (
                <span key={i} className={i === hint.active ? 'redis-hint-active' : 'muted'}>
                  {word}{' '}
                </span>
              ))}
            </p>
          ) : null}
          <div className="redis-input-row">
            <span className="redis-prompt mono">{prompt}</span>
            <input
              ref={inputRef}
              className="redis-input mono"
              aria-label="Redis command"
              value={input}
              onChange={(event) => {
                setInput(event.target.value)
                setDismissed(false)
                setSelected(null)
                history.reset()
              }}
              onKeyDown={onKeyDown}
              onFocus={() => setDismissed(false)}
              onBlur={() => setDismissed(true)}
              disabled={db === null && startError === null}
              autoComplete="off"
              autoCapitalize="off"
              spellCheck={false}
            />
            {running ? (
              <Button
                icon={<Square size={12} />}
                onClick={() => controller.current?.abort()}
                title="Drops the connection, which is the only way to stop a command that is waiting"
              >
                Stop
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
