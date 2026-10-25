import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { MAX_SCRIPT_BYTES } from '@shared/scripts'
import { openDatabase } from '../storage/database'
import { ScriptStore } from './store'

let dir: string
let clock: number

function setup(options: { trash?: (path: string) => Promise<void> } = {}) {
  const store = new ScriptStore(openDatabase(':memory:'), dir, {
    now: () => clock,
    ...options,
  })
  return store
}

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const make = (store: ScriptStore, n: number, content = '', extra = {}) =>
  store.create({ id: id(n), connectionId: 'c1', database: null, content, ...extra })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dbide-scripts-'))
  clock = 1_000_000
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('creating and reading', () => {
  it('writes the script as a .sql file', async () => {
    const store = setup()
    const info = await make(store, 1, 'SELECT 1;')
    expect(info).toMatchObject({ name: 'Script', connectionId: 'c1', missing: false })
    expect(readFileSync(join(dir, 'Script.sql'), 'utf8')).toBe('SELECT 1;')
    expect((await store.read(id(1))).content).toBe('SELECT 1;')
  })

  it('numbers a name that is taken, whatever its case', async () => {
    const store = setup()
    await make(store, 1)
    expect((await make(store, 2)).name).toBe('Script 2')
    expect((await make(store, 3, '', { name: 'script' })).name).toBe('script 3')
  })

  it('never overwrites a file that is already in the folder', async () => {
    writeFileSync(join(dir, 'Orders.sql'), 'mine')
    const store = setup()
    const info = await make(store, 1, 'new', { name: 'Orders' })
    expect(info.name).toBe('Orders 2')
    expect(readFileSync(join(dir, 'Orders.sql'), 'utf8')).toBe('mine')
  })

  it('is idempotent for one id', async () => {
    const store = setup()
    await make(store, 1, 'first')
    await make(store, 1, 'second')
    expect((await store.read(id(1))).content).toBe('first')
    expect(await store.list()).toHaveLength(1)
  })

  it('cleans a name so it is safe on every platform', async () => {
    const store = setup()
    expect((await make(store, 1, '', { name: '../../etc/passwd' })).name).toBe('etc passwd')
    expect((await make(store, 2, '', { name: 'CON' })).name).toBe('CON_')
    expect((await make(store, 3, '', { name: 'report.sql' })).name).toBe('report')
    expect((await readdir(dir)).every((f) => !f.includes('/'))).toBe(true)
  })

  it('refuses an id that is not one', async () => {
    const store = setup()
    await expect(store.read('../x')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(store.read(id(9))).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('saving', () => {
  it('replaces the file and reports no outside change', async () => {
    const store = setup()
    await make(store, 1, 'a')
    clock += 5
    expect(await store.save(id(1), 'b')).toEqual({ savedAt: clock, externalChange: false })
    expect(readFileSync(join(dir, 'Script.sql'), 'utf8')).toBe('b')
  })

  it('leaves no temporary files behind', async () => {
    const store = setup()
    await make(store, 1, 'a')
    await store.save(id(1), 'b')
    expect(await readdir(dir)).toEqual(['Script.sql'])
  })

  it('keeps Windows line endings in a file that used them', async () => {
    writeFileSync(join(dir, 'Win.sql'), 'a\r\nb\r\n')
    const store = setup()
    const [script] = await store.list()
    const read = await store.read(script!.id)
    expect(read.content).toBe('a\nb\n')
    await store.save(script!.id, 'a\nb\nc\n')
    expect(readFileSync(join(dir, 'Win.sql'), 'utf8')).toBe('a\r\nb\r\nc\r\n')
  })

  it('drops a byte order mark and leaves non-UTF-8 files alone', async () => {
    writeFileSync(join(dir, 'Bom.sql'), '﻿SELECT 1;')
    writeFileSync(join(dir, 'Latin.sql'), Buffer.from([0x53, 0xe9, 0x6c]))
    const store = setup()
    const scripts = await store.list()
    const bom = scripts.find((s) => s.name === 'Bom')!
    const latin = scripts.find((s) => s.name === 'Latin')!
    expect((await store.read(bom.id)).content).toBe('SELECT 1;')
    await expect(store.read(latin.id)).rejects.toMatchObject({ code: 'NOT_UTF8' })
    expect(readFileSync(join(dir, 'Latin.sql'))).toEqual(Buffer.from([0x53, 0xe9, 0x6c]))
  })

  it('refuses text that is too large', async () => {
    const store = setup()
    await make(store, 1)
    await expect(store.save(id(1), 'x'.repeat(MAX_SCRIPT_BYTES + 1))).rejects.toMatchObject({
      code: 'TOO_LARGE',
    })
  })
})

describe('local history', () => {
  it('keeps the first version, then one every half minute, never an identical one', async () => {
    const store = setup()
    await make(store, 1, 'v1')
    expect(store.history(id(1)).map((r) => r.label)).toEqual(['created'])

    clock += 5_000
    await store.save(id(1), 'v2')
    expect(store.history(id(1))).toHaveLength(1) // too soon

    clock += 40_000
    await store.save(id(1), 'v3')
    // The version being replaced (v2) is kept, stamped with when it was saved.
    const versions = store.history(id(1))
    expect(versions).toHaveLength(2)
    expect(store.revision(id(1), versions[0]!.id)).toBe('v2')
    expect(versions[0]!.label).toBeNull()

    await store.save(id(1), 'v3')
    expect(store.history(id(1))).toHaveLength(2)
  })

  it('always keeps the text that was run', async () => {
    const store = setup()
    await make(store, 1, 'a')
    clock += 1000
    await store.save(id(1), 'SELECT 42;', 'run')
    const [latest] = store.history(id(1))
    expect(latest!.label).toBe('run')
    expect(store.revision(id(1), latest!.id)).toBe('SELECT 42;')
  })

  it('labels the newest version instead of duplicating it', async () => {
    const store = setup()
    await make(store, 1, 'a')
    await store.save(id(1), 'a', 'run')
    expect(store.history(id(1)).map((r) => r.label)).toEqual(['created'])

    clock += 100_000
    await store.save(id(1), 'b')
    await store.save(id(1), 'c', 'run')
    expect(store.history(id(1))[0]!.label).toBe('run')
  })

  it('does not keep an empty script', async () => {
    const store = setup()
    await make(store, 1, '')
    await store.save(id(1), '', 'run')
    expect(store.history(id(1))).toEqual([])
  })

  it('keeps a version changed outside the app before replacing it', async () => {
    const store = setup()
    await make(store, 1, 'mine')
    writeFileSync(join(dir, 'Script.sql'), 'edited elsewhere')
    clock += 1000
    const saved = await store.save(id(1), 'mine again')
    expect(saved.externalChange).toBe(true)
    const [latest] = store.history(id(1))
    expect(latest!.label).toBe('external')
    expect(store.revision(id(1), latest!.id)).toBe('edited elsewhere')
    expect(readFileSync(join(dir, 'Script.sql'), 'utf8')).toBe('mine again')
  })

  it('keeps the original of a file that was adopted, the first time it is overwritten', async () => {
    writeFileSync(join(dir, 'Old.sql'), 'legacy')
    const store = setup()
    const [script] = await store.list()
    await store.save(script!.id, 'rewritten')
    expect(store.revision(script!.id, store.history(script!.id)[0]!.id)).toBe('legacy')
  })

  it('brings a deleted file back from the newest version', async () => {
    const store = setup()
    await make(store, 1, 'precious')
    rmSync(join(dir, 'Script.sql'))
    expect((await store.list())[0]!.missing).toBe(true)
    const read = await store.read(id(1))
    expect(read).toMatchObject({ content: 'precious', recovered: true })
    expect(readFileSync(join(dir, 'Script.sql'), 'utf8')).toBe('precious')
  })

  it('keeps at most 300 versions and drops old ones but not the newest few', async () => {
    const store = setup()
    await make(store, 1, 'v0')
    for (let i = 1; i <= 320; i++) {
      clock += 60_000
      await store.save(id(1), `v${i}`, 'run')
    }
    const versions = store.history(id(1))
    expect(versions).toHaveLength(300)
    expect(store.revision(id(1), versions[0]!.id)).toBe('v320')

    clock += 200 * 24 * 60 * 60 * 1000
    await store.save(id(1), 'late', 'run')
    expect(store.history(id(1)).length).toBeLessThan(15)
    expect(store.revision(id(1), store.history(id(1))[0]!.id)).toBe('late')
  })

  it('reports a version that is gone', async () => {
    const store = setup()
    await make(store, 1, 'a')
    expect(() => store.revision(id(1), 999)).toThrow(/no longer kept/)
  })
})

describe('the folder', () => {
  it('adopts .sql files that were put there by hand, and ignores everything else', async () => {
    writeFileSync(join(dir, 'Report.sql'), 'SELECT 1;')
    writeFileSync(join(dir, 'notes.txt'), 'hi')
    mkdirSync(join(dir, 'nested.sql'))
    const store = setup()
    const scripts = await store.list()
    expect(scripts.map((s) => s.name)).toEqual(['Report'])
    expect(scripts[0]).toMatchObject({ connectionId: null, size: 9 })
    // A second listing does not adopt it twice.
    expect(await store.list()).toHaveLength(1)
  })

  it('reports when the file last changed from the file itself', async () => {
    const store = setup()
    await make(store, 1, 'a')
    utimesSync(join(dir, 'Script.sql'), new Date(5_000_000), new Date(5_000_000))
    expect((await store.list())[0]!.updatedAt).toBe(5_000_000)
  })
})

describe('renaming, duplicating, deleting', () => {
  it('renames the file and the script', async () => {
    const store = setup()
    await make(store, 1, 'a')
    const renamed = await store.rename(id(1), 'Monthly report')
    expect(renamed.name).toBe('Monthly report')
    expect(readFileSync(join(dir, 'Monthly report.sql'), 'utf8')).toBe('a')
    expect(await readdir(dir)).toEqual(['Monthly report.sql'])
  })

  it('refuses a name another script or file has', async () => {
    writeFileSync(join(dir, 'Taken.sql'), 'x')
    const store = setup()
    await make(store, 1)
    await make(store, 2, '', { name: 'Other' })
    await expect(store.rename(id(1), 'other')).rejects.toMatchObject({ code: 'NAME_TAKEN' })
    await expect(store.rename(id(1), '  ')).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('allows changing only the case of a name', async () => {
    const store = setup()
    await make(store, 1, 'a', { name: 'orders' })
    expect((await store.rename(id(1), 'Orders')).name).toBe('Orders')
  })

  it('duplicates with the text, connection and database', async () => {
    const store = setup()
    await make(store, 1, 'SELECT 1;', { database: 'shop', name: 'Report' })
    const copy = await store.duplicate(id(1))
    expect(copy).toMatchObject({ name: 'Report copy', connectionId: 'c1', database: 'shop' })
    expect((await store.read(copy.id)).content).toBe('SELECT 1;')
  })

  it('moves the file to the trash and forgets the script', async () => {
    const trashed: string[] = []
    const store = setup({
      trash: (path) => {
        trashed.push(path)
        rmSync(path)
        return Promise.resolve()
      },
    })
    await make(store, 1, 'a')
    await store.remove(id(1))
    expect(trashed).toEqual([join(dir, 'Script.sql')])
    expect(await store.list()).toEqual([])
  })

  it('deletes for real when there is no trash, and copes with a file that is already gone', async () => {
    const store = setup({ trash: () => Promise.reject(new Error('no trash here')) })
    await make(store, 1, 'a')
    await store.remove(id(1))
    expect(await readdir(dir)).toEqual([])

    await make(store, 2, 'b')
    rmSync(join(dir, 'Script.sql'))
    await expect(store.remove(id(2))).resolves.toBeUndefined()
  })
})

describe('importing', () => {
  it('copies files in, and reports the ones it could not use', async () => {
    const source = mkdtempSync(join(tmpdir(), 'dbide-import-'))
    try {
      writeFileSync(join(source, 'a.sql'), 'SELECT 1;\r\n')
      writeFileSync(join(source, 'bad.sql'), Buffer.from([0xff, 0xfe, 0xfa]))
      const store = setup()
      const result = await store.importFiles([
        join(source, 'a.sql'),
        join(source, 'bad.sql'),
        join(source, 'missing.sql'),
      ])
      expect(result.imported.map((s) => [s.name, s.connectionId])).toEqual([['a', null]])
      expect(result.failed.map((f) => f.name)).toEqual(['bad.sql', 'missing.sql'])
      // The original is untouched and the copy keeps its line endings.
      expect(readFileSync(join(source, 'a.sql'), 'utf8')).toBe('SELECT 1;\r\n')
      expect(readFileSync(join(dir, 'a.sql'), 'utf8')).toBe('SELECT 1;\r\n')
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })
})

describe('tabs and connections', () => {
  it('remembers which scripts are open, in order, and which is in front', async () => {
    const store = setup()
    await make(store, 1)
    await make(store, 2)
    await make(store, 3)
    store.setOpen([id(3), id(1)], id(1))
    const byId = Object.fromEntries((await store.list()).map((s) => [s.id, s]))
    expect(byId[id(3)]).toMatchObject({ openOrder: 0, active: false })
    expect(byId[id(1)]).toMatchObject({ openOrder: 1, active: true })
    expect(byId[id(2)]).toMatchObject({ openOrder: null, active: false })

    store.setOpen([], null)
    expect((await store.list()).every((s) => s.openOrder === null)).toBe(true)
  })

  it('moves a script to another connection or database', async () => {
    const store = setup()
    await make(store, 1)
    expect(await store.update(id(1), { connectionId: 'c2', database: 'shop' })).toMatchObject({
      connectionId: 'c2',
      database: 'shop',
    })
    expect(await store.update(id(1), { database: null })).toMatchObject({
      connectionId: 'c2',
      database: null,
    })
  })

  it('keeps the scripts of a deleted connection, without a connection', async () => {
    const store = setup()
    await make(store, 1)
    store.detachConnection('c1')
    expect((await store.list())[0]!.connectionId).toBeNull()
  })
})

describe('scripts in other languages', () => {
  it('writes a MongoDB script as a .mongodb file, and finds it again by that name', async () => {
    const store = setup()
    const info = await make(store, 1, 'db.orders.find({})', { language: 'mongodb', name: 'Orders' })
    expect(info).toMatchObject({ name: 'Orders', language: 'mongodb', missing: false })
    expect(readFileSync(join(dir, 'Orders.mongodb'), 'utf8')).toBe('db.orders.find({})')
    expect((await store.read(id(1))).content).toBe('db.orders.find({})')
    await store.save(id(1), 'db.orders.countDocuments({})')
    expect(readFileSync(join(dir, 'Orders.mongodb'), 'utf8')).toBe('db.orders.countDocuments({})')
  })

  it('keeps names unique across languages, since a name is one script', async () => {
    const store = setup()
    await make(store, 1, '', { name: 'Report' })
    expect((await make(store, 2, '', { name: 'Report', language: 'mongodb' })).name).toBe(
      'Report 2',
    )
  })

  it('renames, duplicates and deletes within its own extension', async () => {
    const trashed: string[] = []
    const store = setup({ trash: (path) => Promise.resolve(void trashed.push(path)) })
    await make(store, 1, 'db.a.find()', { language: 'mongodb', name: 'One' })
    expect((await store.rename(id(1), 'Two.mongodb')).name).toBe('Two')
    expect(readFileSync(join(dir, 'Two.mongodb'), 'utf8')).toBe('db.a.find()')
    const copy = await store.duplicate(id(1))
    expect(copy).toMatchObject({ name: 'Two copy', language: 'mongodb' })
    await store.remove(id(1))
    expect(trashed).toEqual([join(dir, 'Two.mongodb')])
  })

  it('adopts script files of either language that were dropped into the folder', async () => {
    writeFileSync(join(dir, 'by-hand.mongodb'), 'db.a.find()')
    writeFileSync(join(dir, 'old.sql'), 'SELECT 1')
    writeFileSync(join(dir, 'notes.txt'), 'not a script')
    const store = setup()
    const listed = await store.list()
    expect(listed.map((s) => [s.name, s.language])).toEqual([
      ['by-hand', 'mongodb'],
      ['old', 'sql'],
    ])
  })

  it('takes the language of an imported file from its extension', async () => {
    const source = mkdtempSync(join(tmpdir(), 'dbide-import-'))
    try {
      writeFileSync(join(source, 'q.mongodb'), 'db.a.find()')
      writeFileSync(join(source, 'r.js'), 'db.b.find()')
      writeFileSync(join(source, 's.sql'), 'SELECT 1')
      const store = setup()
      const result = await store.importFiles([
        join(source, 'q.mongodb'),
        join(source, 'r.js'),
        join(source, 's.sql'),
      ])
      expect(result.imported.map((s) => [s.name, s.language])).toEqual([
        ['q', 'mongodb'],
        ['r', 'mongodb'],
        ['s', 'sql'],
      ])
    } finally {
      rmSync(source, { recursive: true, force: true })
    }
  })
})
