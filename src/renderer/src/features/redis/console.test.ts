import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RedisReply } from '@shared/redis/types'
import { CommandHistory, completions, formatReply, hintFor, syntaxWords } from './console'

const bulk = (
  text: string,
  extra: Partial<Extract<RedisReply, { t: 'bulk' }>> = {},
): RedisReply => ({
  t: 'bulk',
  text,
  bytes: text.length,
  binary: false,
  truncated: false,
  ...extra,
})

describe('formatReply', () => {
  it('prints each kind of reply the way redis-cli does', () => {
    expect(formatReply({ t: 'status', text: 'OK' })).toEqual(['OK'])
    expect(formatReply({ t: 'error', text: 'ERR nope' })).toEqual(['(error) ERR nope'])
    expect(formatReply({ t: 'int', value: 42 })).toEqual(['(integer) 42'])
    expect(formatReply({ t: 'nil' })).toEqual(['(nil)'])
    expect(formatReply(bulk('hello'))).toEqual(['"hello"'])
  })

  it('writes out what cannot be seen, and keeps ordinary text as it is', () => {
    expect(formatReply(bulk('a"b\\c\nd\te\u0001'))).toEqual(['"a\\"b\\\\c\\nd\\te\\x01"'])
    expect(formatReply(bulk('café ☕'))).toEqual(['"café ☕"'])
  })

  it('shows bytes that are not text as escapes, and says when a string was cut', () => {
    expect(formatReply(bulk('\\xff\\x00', { binary: true }))).toEqual(['"\\xff\\x00"'])
    expect(formatReply(bulk('abc', { truncated: true, bytes: 100000 }))).toEqual([
      '"abc" … (100,000 bytes in all)',
    ])
  })

  it('numbers a list and indents what is inside a list', () => {
    const reply: RedisReply = {
      t: 'array',
      omitted: 0,
      items: [
        bulk('a'),
        { t: 'array', omitted: 0, items: [bulk('x'), { t: 'int', value: 2 }] },
        { t: 'nil' },
      ],
    }
    expect(formatReply(reply)).toEqual(['1) "a"', '2) 1) "x"', '   2) (integer) 2', '3) (nil)'])
  })

  it('aligns the numbers of a long list, and says what was left out', () => {
    const items = Array.from({ length: 10 }, (_, i) => bulk(String(i)))
    const lines = formatReply({ t: 'array', items, omitted: 5 })
    expect(lines[0]).toBe(' 1) "0"')
    expect(lines[9]).toBe('10) "9"')
    expect(lines[10]).toBe('… 5 more')
  })

  it('says an empty list is empty', () => {
    expect(formatReply({ t: 'array', items: [], omitted: 0 })).toEqual(['(empty array)'])
  })
})

describe('completions', () => {
  it('completes the first word, once for each command that begins with it', () => {
    const { items } = completions('hg')
    expect(items.map((i) => i.text)).toEqual(expect.arrayContaining(['HGET', 'HGETALL']))
    expect(items.every((i) => i.text.startsWith('HG'))).toBe(true)
    expect(items.find((i) => i.text === 'HGET')!.syntax).toBe('key field')
  })

  it('offers a command with sub-commands once, and its sub-commands after a space', () => {
    expect(completions('conf').items.map((i) => i.text)).toEqual(['CONFIG'])
    expect(completions('config ').items.map((i) => i.text)).toEqual(
      expect.arrayContaining(['CONFIG GET', 'CONFIG SET']),
    )
    expect(completions('config g').items.map((i) => i.text)).toEqual(['CONFIG GET'])
  })

  it('offers nothing for an empty line, an exact command, or an argument', () => {
    expect(completions('').items).toEqual([])
    expect(completions('GETDEL').items).toEqual([])
    expect(completions('ping').items).toEqual([])
    expect(completions('SET key v').items).toEqual([])
    expect(completions('CONFIG GET maxm').items).toEqual([])
  })

  it('does not offer commands the console will not run', () => {
    expect(completions('subs').items.map((i) => i.text)).not.toContain('SUBSCRIBE')
    expect(completions('mon').items.map((i) => i.text)).not.toContain('MONITOR')
  })

  it('knows where the line starts when it is indented', () => {
    expect(completions('  hge').from).toBe(2)
  })
})

describe('hintFor', () => {
  it('splits a syntax into its arguments, keeping an optional group whole', () => {
    expect(syntaxWords('key value [NX | XX] [GET]')).toEqual(['key', 'value', '[NX | XX]', '[GET]'])
    expect(syntaxWords('')).toEqual([])
  })

  it('marks the argument being typed', () => {
    expect(hintFor('SET')).toMatchObject({ name: 'SET', active: 0 })
    expect(hintFor('SET k')).toMatchObject({ active: 0 })
    expect(hintFor('SET k ')).toMatchObject({ active: 1 })
    expect(hintFor('SET k v')).toMatchObject({ active: 1 })
    expect(hintFor('SET k v ')).toMatchObject({ active: 2 })
  })

  it('reads a sub-command as part of the name', () => {
    expect(hintFor('config get ')).toMatchObject({ name: 'CONFIG GET', active: 0 })
  })

  it('stays on a repeating argument, and on nothing once past the end', () => {
    expect(hintFor('DEL a b c ')).toMatchObject({ name: 'DEL', active: 1 })
    expect(hintFor('GET a b ')).toMatchObject({ name: 'GET', active: -1 })
  })

  it('has nothing for an unknown command or an unreadable line', () => {
    expect(hintFor('nonsense a')).toBeNull()
    expect(hintFor('GET "open')).toBeNull()
    expect(hintFor('')).toBeNull()
  })
})

/** A localStorage that lives in memory, since the tests run without a window. */
function memoryStorage(): Storage {
  const data = new Map<string, string>()
  return {
    get length() {
      return data.size
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (index) => [...data.keys()][index] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  }
}

describe('CommandHistory', () => {
  let storage: Storage
  beforeEach(() => {
    storage = memoryStorage()
    vi.stubGlobal('window', { localStorage: storage })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('walks back through what was run and forward again', () => {
    const history = new CommandHistory()
    history.push('GET a')
    history.push('GET b')
    expect(history.previous()).toBe('GET b')
    expect(history.previous()).toBe('GET a')
    expect(history.previous()).toBeNull()
    expect(history.next()).toBe('GET b')
    expect(history.next()).toBe('')
    expect(history.next()).toBeNull()
  })

  it('does not repeat a line that was just run, and remembers between sessions', () => {
    const history = new CommandHistory()
    history.push('PING')
    history.push('PING')
    expect(history.all()).toEqual(['PING'])
    expect(new CommandHistory().all()).toEqual(['PING'])
  })

  it('starts from the newest line again after each run', () => {
    const history = new CommandHistory()
    history.push('a')
    history.previous()
    history.push('b')
    expect(history.previous()).toBe('b')
  })

  it('keeps only the latest lines', () => {
    const history = new CommandHistory()
    for (let i = 0; i < 520; i++) history.push(`line ${i}`)
    expect(history.all()).toHaveLength(500)
    expect(history.all()[499]).toBe('line 519')
  })

  it('works when storage is unavailable', () => {
    storage.getItem = () => {
      throw new Error('no storage')
    }
    storage.setItem = () => {
      throw new Error('no storage')
    }
    const history = new CommandHistory()
    history.push('x')
    expect(history.all()).toEqual(['x'])
  })
})
