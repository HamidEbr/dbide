import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { access, mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { RpcError } from '@shared/rpc'
import {
  isScriptId,
  languageOfExtension,
  MAX_SCRIPT_BYTES,
  SCRIPT_EXTENSIONS,
  sanitizeScriptName,
  type RevisionLabel,
  type ScriptInfo,
  type ScriptLanguage,
  type ScriptRevision,
} from '@shared/scripts'

/** A new version is kept at most this often while typing; a run or an outside edit always keeps one. */
const SNAPSHOT_INTERVAL_MS = 30_000
const MAX_REVISIONS_PER_SCRIPT = 300
const MAX_REVISION_AGE_MS = 90 * 24 * 60 * 60 * 1000
/** The newest versions are kept however old they are. */
const KEEP_NEWEST = 10
/** Files bigger than this are not read back before a save, to notice outside edits. */
const MAX_PREREAD_BYTES = 2 * 1024 * 1024
const MAX_FILES = 5000

interface ScriptRow {
  id: string
  name: string
  language: ScriptLanguage
  connection_id: string | null
  db_name: string | null
  created_at: number
  content_hash: string | null
  mtime_ms: number | null
  saved_at: number | null
  crlf: number
  open_order: number | null
  active: number
}

interface RevisionRow {
  id: number
  created_at: number
  label: RevisionLabel | null
  size: number
  content: string
}

export interface ScriptStoreOptions {
  /** Moves a file to the system trash. Falls back to deleting it. */
  trash?: (path: string) => Promise<void>
  now?: () => number
  snapshotIntervalMs?: number
}

export interface NewScript {
  id: string
  /** Defaults to SQL. */
  language?: ScriptLanguage
  connectionId: string | null
  database: string | null
  name?: string
  content?: string
}

const sha = (text: string): string => createHash('sha1').update(text).digest('hex')
const isMissing = (error: unknown): boolean =>
  (error as { code?: unknown } | null)?.code === 'ENOENT'

/** Text read from a file: no byte order mark, line breaks normalized, and which ones it used. */
interface FileText {
  text: string
  crlf: boolean
}

function decode(buffer: Buffer, what: string): FileText {
  if (buffer.length > MAX_SCRIPT_BYTES) {
    throw new RpcError('TOO_LARGE', `${what} is larger than ${MAX_SCRIPT_BYTES / 1024 / 1024} MB.`)
  }
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
  } catch {
    throw new RpcError(
      'NOT_UTF8',
      `${what} isn’t valid UTF-8 text. Opening it could damage it, so it was left alone.`,
    )
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  // Only a file that uses Windows line endings throughout keeps them when it is saved.
  const crlf = text.includes('\r\n') && !/(^|[^\r])\n/.test(text)
  return { text: text.replace(/\r\n/g, '\n'), crlf }
}

/**
 * Scripts as files. Each script is a file (`.sql`, or `.mongodb`) in one folder, so it can be opened, searched and
 * backed up with any other tool. SQLite keeps what the file can't: which connection it belongs
 * to, which tabs are open, and local history, so nothing typed is ever lost.
 */
export class ScriptStore {
  private readonly now: () => number
  private readonly interval: number

  constructor(
    private readonly db: DatabaseSync,
    readonly dir: string,
    private readonly options: ScriptStoreOptions = {},
  ) {
    this.now = options.now ?? Date.now
    this.interval = options.snapshotIntervalMs ?? SNAPSHOT_INTERVAL_MS
  }

  // ----- Files ---------------------------------------------------------------------------

  private pathOf(name: string, language: ScriptLanguage): string {
    if (name === '' || /[\\/]/.test(name) || name === '.' || name === '..') {
      throw new RpcError('INVALID_INPUT', 'That script name can’t be used.')
    }
    return join(this.dir, `${name}${SCRIPT_EXTENSIONS[language]}`)
  }

  scriptPath(id: string): string {
    const row = this.row(id)
    return this.pathOf(row.name, row.language)
  }

  private async readText(path: string, what: string): Promise<FileText> {
    return decode(await readFile(path), what)
  }

  /** Writes next to the file and renames over it, so a crash never leaves half a script. */
  private async writeAtomic(path: string, text: string): Promise<void> {
    const temp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(temp, text, 'utf8')
      await rename(temp, path)
    } catch (error) {
      await unlink(temp).catch(() => undefined)
      throw error
    }
  }

  private encode(text: string, crlf: boolean): string {
    return crlf ? text.replace(/\n/g, '\r\n') : text
  }

  // ----- Rows ----------------------------------------------------------------------------

  private rowOrNull(id: string): ScriptRow | undefined {
    return this.db.prepare('SELECT * FROM scripts WHERE id = ?').get(id) as ScriptRow | undefined
  }

  private row(id: string): ScriptRow {
    if (!isScriptId(id)) throw new RpcError('INVALID_INPUT', 'That is not a script id.')
    const row = this.rowOrNull(id)
    if (!row) throw new RpcError('NOT_FOUND', 'This script no longer exists.')
    return row
  }

  private nameTaken(name: string, exceptId?: string): boolean {
    const row = this.db
      .prepare('SELECT id FROM scripts WHERE name = ? COLLATE NOCASE')
      .get(name) as { id: string } | undefined
    return row !== undefined && row.id !== exceptId
  }

  private async describe(row: ScriptRow): Promise<ScriptInfo> {
    let size = 0
    let updatedAt = row.saved_at ?? row.created_at
    let missing = false
    try {
      const info = await stat(this.pathOf(row.name, row.language))
      size = info.size
      updatedAt = Math.round(info.mtimeMs)
    } catch (error) {
      if (!isMissing(error)) throw error
      missing = true
    }
    return {
      id: row.id,
      name: row.name,
      language: row.language,
      connectionId: row.connection_id,
      database: row.db_name,
      createdAt: row.created_at,
      updatedAt,
      size,
      missing,
      openOrder: row.open_order,
      active: row.active === 1,
    }
  }

  private async remember(id: string, text: string, crlf: boolean, savedAt?: number): Promise<void> {
    const row = this.row(id)
    let mtime: number | null = null
    try {
      mtime = (await stat(this.pathOf(row.name, row.language))).mtimeMs
    } catch (error) {
      if (!isMissing(error)) throw error
    }
    this.db
      .prepare(
        'UPDATE scripts SET content_hash = ?, mtime_ms = ?, crlf = ?, saved_at = COALESCE(?, saved_at) WHERE id = ?',
      )
      .run(sha(text), mtime, crlf ? 1 : 0, savedAt ?? null, id)
  }

  // ----- Listing -------------------------------------------------------------------------

  /**
   * Every script. Script files that appeared in the folder by hand are adopted, so the folder
   * is a real place to put scripts. Rows whose file vanished stay, flagged, so their local
   * history can bring them back.
   */
  async list(): Promise<ScriptInfo[]> {
    await mkdir(this.dir, { recursive: true })
    const entries = await readdir(this.dir, { withFileTypes: true })
    const known = new Set(
      (this.db.prepare('SELECT name FROM scripts').all() as unknown as { name: string }[]).map(
        (r) => r.name.toLowerCase(),
      ),
    )

    let adopted = 0
    for (const entry of entries) {
      const language = entry.isFile() ? languageOfExtension(extname(entry.name)) : null
      if (!language) continue
      const name = basename(entry.name, extname(entry.name))
      if (name === '' || known.has(name.toLowerCase()) || adopted >= MAX_FILES) continue
      adopted++
      const info = await stat(join(this.dir, entry.name))
      this.db
        .prepare(
          'INSERT INTO scripts (id, name, language, created_at, mtime_ms) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          randomUUID(),
          name,
          language,
          Math.round(info.birthtimeMs || info.mtimeMs),
          info.mtimeMs,
        )
      known.add(name.toLowerCase())
    }

    const rows = this.db
      .prepare('SELECT * FROM scripts ORDER BY name COLLATE NOCASE')
      .all() as unknown as ScriptRow[]
    return Promise.all(rows.map((row) => this.describe(row)))
  }

  async info(id: string): Promise<ScriptInfo> {
    return this.describe(this.row(id))
  }

  // ----- Create, read, save ----------------------------------------------------------------

  async create(input: NewScript, options: { crlf?: boolean } = {}): Promise<ScriptInfo> {
    if (!isScriptId(input.id)) throw new RpcError('INVALID_INPUT', 'That is not a script id.')
    const existing = this.rowOrNull(input.id)
    if (existing) return this.describe(existing)

    const text = (input.content ?? '').replace(/\r\n/g, '\n')
    if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) {
      throw new RpcError('TOO_LARGE', 'That text is too large for a script.')
    }
    const crlf = options.crlf === true
    await mkdir(this.dir, { recursive: true })

    const language = input.language ?? 'sql'
    const base = sanitizeScriptName(input.name ?? 'Script')
    const name = await this.claimName(base, language, this.encode(text, crlf))

    const now = this.now()
    this.db
      .prepare(
        'INSERT INTO scripts (id, name, language, connection_id, db_name, created_at, saved_at, crlf) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(input.id, name, language, input.connectionId, input.database, now, now, crlf ? 1 : 0)
    await this.remember(input.id, text, crlf)
    this.keep(input.id, text, 'created', now)
    return this.info(input.id)
  }

  /** Creates the file under the first free name: `base`, `base 2`, `base 3`… Returns the name. */
  private async claimName(
    base: string,
    language: ScriptLanguage,
    fileText: string,
  ): Promise<string> {
    for (let attempt = 1; attempt <= 1000; attempt++) {
      const name = attempt === 1 ? base : `${base} ${attempt}`
      if (this.nameTaken(name)) continue
      try {
        // `wx` never overwrites a file that is already there, such as one dropped in by hand.
        await writeFile(this.pathOf(name, language), fileText, { flag: 'wx' })
        return name
      } catch (error) {
        if ((error as { code?: unknown } | null)?.code !== 'EEXIST') throw error
      }
    }
    throw new RpcError('NAME_TAKEN', 'Too many scripts share that name.')
  }

  async read(id: string): Promise<{ info: ScriptInfo; content: string; recovered: boolean }> {
    const row = this.row(id)
    const path = this.pathOf(row.name, row.language)
    let file: FileText
    let recovered = false
    try {
      file = await this.readText(path, `“${row.name}${SCRIPT_EXTENSIONS[row.language]}”`)
    } catch (error) {
      if (!isMissing(error)) throw error
      // The file was deleted outside the app. The last saved version brings it back.
      const latest = this.latest(id)
      file = { text: latest?.content ?? '', crlf: row.crlf === 1 }
      recovered = latest !== undefined
      await this.writeAtomic(path, this.encode(file.text, file.crlf))
    }
    await this.remember(id, file.text, file.crlf)
    return { info: await this.info(id), content: file.text, recovered }
  }

  /**
   * Writes a script. Before the file is replaced, the version being replaced is kept in local
   * history when it is due, and always when it was changed outside the app.
   */
  async save(
    id: string,
    content: string,
    label?: RevisionLabel,
  ): Promise<{ savedAt: number; externalChange: boolean }> {
    const row = this.row(id)
    const text = content.replace(/\r\n/g, '\n')
    if (Buffer.byteLength(text) > MAX_SCRIPT_BYTES) {
      throw new RpcError('TOO_LARGE', 'This script is too large to save.')
    }
    const path = this.pathOf(row.name, row.language)
    const now = this.now()
    let externalChange = false
    let unchanged = false

    const disk = await this.readIfSmall(path)
    if (disk) {
      const hash = sha(disk.text)
      if (row.content_hash !== null && hash !== row.content_hash) {
        externalChange = true
        this.keep(id, disk.text, 'external', now)
      } else if (hash !== sha(text)) {
        this.keepIfDue(id, disk.text, row.saved_at ?? now, now)
      }
      unchanged = hash === sha(text)
    }

    if (!unchanged) {
      await mkdir(this.dir, { recursive: true })
      await this.writeAtomic(path, this.encode(text, row.crlf === 1))
    }
    await this.remember(id, text, row.crlf === 1, now)
    if (label) this.keep(id, text, label, now)
    return { savedAt: now, externalChange }
  }

  /** The file's text if it exists and is small enough to read before overwriting it. */
  private async readIfSmall(path: string): Promise<FileText | null> {
    try {
      if ((await stat(path)).size > MAX_PREREAD_BYTES) return null
      return await this.readText(path, 'This script')
    } catch (error) {
      // A file that can't be read (gone, or not text) is simply replaced.
      if (isMissing(error) || error instanceof RpcError) return null
      throw error
    }
  }

  // ----- Local history ---------------------------------------------------------------------

  private latest(id: string): RevisionRow | undefined {
    return this.db
      .prepare(
        'SELECT id, created_at, label, size, content FROM script_revisions WHERE script_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(id) as RevisionRow | undefined
  }

  private insertRevision(id: string, text: string, label: RevisionLabel | null, at: number): void {
    this.db
      .prepare(
        'INSERT INTO script_revisions (script_id, created_at, label, size, content) VALUES (?, ?, ?, ?, ?)',
      )
      .run(id, at, label, Buffer.byteLength(text), text)
    this.prune(id)
  }

  /** Keeps this exact text, unless the newest version already is it. An empty script isn't worth restoring. */
  private keep(id: string, text: string, label: RevisionLabel, at: number): void {
    if (text === '') return
    const latest = this.latest(id)
    if (latest?.content === text) {
      if (latest.label === null) {
        this.db.prepare('UPDATE script_revisions SET label = ? WHERE id = ?').run(label, latest.id)
      }
      return
    }
    this.insertRevision(id, text, label, at)
  }

  /** Keeps the text only if no version was kept in the last half minute. */
  private keepIfDue(id: string, text: string, at: number, now: number): void {
    if (text === '') return
    const latest = this.latest(id)
    if (latest?.content === text) return
    if (latest && now - latest.created_at < this.interval) return
    this.insertRevision(id, text, null, at)
  }

  private prune(id: string): void {
    const now = this.now()
    this.db
      .prepare(
        `DELETE FROM script_revisions WHERE script_id = ?1 AND id NOT IN (
           SELECT id FROM script_revisions WHERE script_id = ?1 ORDER BY id DESC LIMIT ?2)`,
      )
      .run(id, MAX_REVISIONS_PER_SCRIPT)
    this.db
      .prepare(
        `DELETE FROM script_revisions WHERE script_id = ?1 AND created_at < ?2 AND id NOT IN (
           SELECT id FROM script_revisions WHERE script_id = ?1 ORDER BY id DESC LIMIT ?3)`,
      )
      .run(id, now - MAX_REVISION_AGE_MS, KEEP_NEWEST)
  }

  history(id: string): ScriptRevision[] {
    this.row(id)
    const rows = this.db
      .prepare(
        'SELECT id, created_at, label, size FROM script_revisions WHERE script_id = ? ORDER BY id DESC',
      )
      .all(id) as unknown as Omit<RevisionRow, 'content'>[]
    return rows.map((r) => ({ id: r.id, createdAt: r.created_at, label: r.label, size: r.size }))
  }

  revision(id: string, revisionId: number): string {
    this.row(id)
    const row = this.db
      .prepare('SELECT content FROM script_revisions WHERE script_id = ? AND id = ?')
      .get(id, revisionId) as { content: string } | undefined
    if (!row) throw new RpcError('NOT_FOUND', 'That version is no longer kept.')
    return row.content
  }

  // ----- Changing scripts ------------------------------------------------------------------

  async update(
    id: string,
    patch: { connectionId?: string | null; database?: string | null },
  ): Promise<ScriptInfo> {
    const row = this.row(id)
    this.db
      .prepare('UPDATE scripts SET connection_id = ?, db_name = ? WHERE id = ?')
      .run(
        patch.connectionId !== undefined ? patch.connectionId : row.connection_id,
        patch.database !== undefined ? patch.database : row.db_name,
        id,
      )
    return this.info(id)
  }

  async rename(id: string, raw: string): Promise<ScriptInfo> {
    const row = this.row(id)
    if (raw.trim() === '') throw new RpcError('INVALID_INPUT', 'Give the script a name.')
    const name = sanitizeScriptName(raw)
    if (name === row.name) return this.describe(row)
    if (this.nameTaken(name, id)) {
      throw new RpcError('NAME_TAKEN', `A script named “${name}” already exists.`)
    }

    const from = this.pathOf(row.name, row.language)
    const to = this.pathOf(name, row.language)
    // Changing only the case of a name is the same file on macOS and Windows.
    if (row.name.toLowerCase() !== name.toLowerCase()) {
      const taken = await access(to).then(
        () => true,
        () => false,
      )
      if (taken) {
        throw new RpcError(
          'NAME_TAKEN',
          `A file named “${name}${SCRIPT_EXTENSIONS[row.language]}” already exists.`,
        )
      }
    }
    try {
      await rename(from, to)
    } catch (error) {
      // A script whose file is missing can still be renamed; its file comes back on open.
      if (!isMissing(error)) throw error
    }
    this.db.prepare('UPDATE scripts SET name = ? WHERE id = ?').run(name, id)
    return this.info(id)
  }

  async duplicate(id: string): Promise<ScriptInfo> {
    const { content, info } = await this.read(id)
    const row = this.row(id)
    return this.create(
      {
        id: randomUUID(),
        language: row.language,
        connectionId: info.connectionId,
        database: info.database,
        name: `${info.name} copy`,
        content,
      },
      { crlf: row.crlf === 1 },
    )
  }

  async remove(id: string): Promise<void> {
    const row = this.row(id)
    const path = this.pathOf(row.name, row.language)
    try {
      if (this.options.trash) await this.options.trash(path)
      else await unlink(path)
    } catch (error) {
      if (isMissing(error)) {
        // Nothing left to remove.
      } else {
        // No trash available (some Linux setups): delete it for real rather than leave it.
        await unlink(path).catch((e: unknown) => {
          if (!isMissing(e)) throw e
        })
      }
    }
    this.db.prepare('DELETE FROM scripts WHERE id = ?').run(id)
  }

  /** Copies text files into the scripts folder as new scripts. One bad file doesn't stop the rest. */
  async importFiles(
    paths: string[],
  ): Promise<{ imported: ScriptInfo[]; failed: { name: string; message: string }[] }> {
    const imported: ScriptInfo[] = []
    const failed: { name: string; message: string }[] = []
    for (const path of paths) {
      const name = basename(path)
      try {
        const info = await stat(path)
        if (!info.isFile()) throw new RpcError('INVALID_INPUT', 'It isn’t a file.')
        const file = await this.readText(path, `“${name}”`)
        imported.push(
          await this.create(
            {
              id: randomUUID(),
              language:
                languageOfExtension(extname(name)) ??
                (extname(name).toLowerCase() === '.js' ? 'mongodb' : 'sql'),
              connectionId: null,
              database: null,
              name: basename(name, extname(name)),
              content: file.text,
            },
            { crlf: file.crlf },
          ),
        )
      } catch (error) {
        failed.push({ name, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported, failed }
  }

  // ----- Tabs and connections --------------------------------------------------------------

  setOpen(ids: string[], active: string | null): void {
    this.db.exec('BEGIN')
    try {
      this.db.exec('UPDATE scripts SET open_order = NULL, active = 0')
      const open = this.db.prepare('UPDATE scripts SET open_order = ?, active = ? WHERE id = ?')
      ids.forEach((id, index) => open.run(index, id === active ? 1 : 0, id))
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  /** The connection was deleted. Its scripts stay, waiting to be moved to another one. */
  detachConnection(connectionId: string): void {
    this.db
      .prepare('UPDATE scripts SET connection_id = NULL WHERE connection_id = ?')
      .run(connectionId)
  }
}
