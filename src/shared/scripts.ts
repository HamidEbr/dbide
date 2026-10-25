import type { EngineKind } from './connection'
import type { Environment } from './environment'

/** What a script is written in, which decides its file type and its editor. */
export type ScriptLanguage = 'sql' | 'mongodb'

export const SCRIPT_EXTENSIONS: Record<ScriptLanguage, string> = {
  sql: '.sql',
  mongodb: '.mongodb',
}

export const SCRIPT_LANGUAGES = Object.keys(SCRIPT_EXTENSIONS) as ScriptLanguage[]

/** The language a connection's scripts are written in. */
export function scriptLanguageOf(engine: EngineKind): ScriptLanguage {
  return engine === 'mongodb' ? 'mongodb' : 'sql'
}

/** The language of a script file by its extension, or null for a file that isn't a script. */
export function languageOfExtension(extension: string): ScriptLanguage | null {
  const lower = extension.toLowerCase()
  return SCRIPT_LANGUAGES.find((language) => SCRIPT_EXTENSIONS[language] === lower) ?? null
}

/** A script. It lives as a file in the scripts folder; this is what the app knows about it. */
export interface ScriptInfo {
  id: string
  /** The file name without its extension. */
  name: string
  language: ScriptLanguage
  /** The connection it runs on. Null for a script that was imported or whose connection was deleted. */
  connectionId: string | null
  database: string | null
  createdAt: number
  /** When the file last changed, from the file itself, so edits made elsewhere show too. */
  updatedAt: number
  size: number
  /** The file is gone from the folder. Opening the script restores it from local history. */
  missing: boolean
  /** Position among the open tabs, or null when it is closed. */
  openOrder: number | null
  /** The tab that was in front when the app last ran. */
  active: boolean
}

/** Why a version of a script was kept. Versions saved while typing have no label. */
export type RevisionLabel = 'created' | 'run' | 'external' | 'restore'

export interface ScriptRevision {
  id: number
  createdAt: number
  label: RevisionLabel | null
  size: number
}

export const REVISION_LABELS: Record<RevisionLabel, string> = {
  created: 'Created',
  run: 'Run',
  external: 'Changed outside DBIDE',
  restore: 'Before restore',
}

/** Bigger scripts are not opened: the editor would struggle and a diff would be useless. */
export const MAX_SCRIPT_BYTES = 8 * 1024 * 1024

const MAX_NAME_CHARS = 100
const RESERVED_WINDOWS_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/i
// eslint-disable-next-line no-control-regex
const UNSAFE_NAME_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g

/**
 * Makes a script name safe as a file name on every platform: no separators or reserved
 * characters, no reserved Windows names, no leading or trailing dots and spaces. An extension
 * the user typed is dropped, since the extension is always added.
 */
export function sanitizeScriptName(raw: string, fallback = 'Script'): string {
  let name = raw.replace(UNSAFE_NAME_CHARS, ' ').replace(/\s+/g, ' ').trim()
  for (const extension of Object.values(SCRIPT_EXTENSIONS)) {
    if (name.toLowerCase().endsWith(extension)) name = name.slice(0, -extension.length)
  }
  name = name
    .replace(/^[. ]+|[. ]+$/g, '')
    .slice(0, MAX_NAME_CHARS)
    .replace(/[. ]+$/g, '')
  if (name === '') return fallback
  if (RESERVED_WINDOWS_NAMES.test(name)) return `${name}_`
  return name
}

const SCRIPT_ID = /^[A-Za-z0-9-]{8,64}$/

export const isScriptId = (value: unknown): value is string =>
  typeof value === 'string' && SCRIPT_ID.test(value)

export type HistoryStatus = 'ok' | 'error' | 'cancelled'

/** One statement that was run, kept so it can be found again. */
export interface HistoryEntry {
  id: number
  ranAt: number
  connectionId: string | null
  /** Kept with the entry, so it still reads well after the connection is renamed or deleted. */
  connectionName: string
  environment: Environment
  database: string | null
  scriptId: string | null
  sql: string
  /** The statement was longer than what is kept; `sql` holds the start of it. */
  sqlTruncated: boolean
  status: HistoryStatus
  durationMs: number | null
  /** Rows a query returned (or had returned so far when it paused). */
  rows: number | null
  /** Rows a write changed. */
  affected: number | null
  errorCode: string | null
  errorMessage: string | null
}

export interface HistoryQuery {
  /** Text the statement contains. */
  search?: string
  connectionId?: string
  status?: HistoryStatus
  /** Return entries older than this id, for paging. */
  before?: number
  limit?: number
}

export interface HistoryPage {
  entries: HistoryEntry[]
  hasMore: boolean
}

export const HISTORY_PAGE_SIZE = 100
/** How much of a statement is kept. A bulk INSERT can be megabytes; the start of it is enough to find it. */
export const MAX_HISTORY_SQL_CHARS = 20_000
export const MAX_HISTORY_ENTRIES = 10_000
export const MAX_HISTORY_AGE_DAYS = 180
