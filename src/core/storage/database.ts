import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

/**
 * Forward-only migrations. Never edit a shipped migration; append a new one.
 * The schema version lives in SQLite's `user_version` pragma.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE connections (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    engine      TEXT NOT NULL,
    environment TEXT NOT NULL,
    folder      TEXT,
    config      TEXT NOT NULL,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
  );
  CREATE INDEX connections_folder_name ON connections (folder, name);

  CREATE TABLE settings (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  `
  -- A script is a .sql file in the scripts folder. The file holds the text; this holds the rest.
  CREATE TABLE scripts (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    connection_id TEXT,
    db_name      TEXT,
    created_at   INTEGER NOT NULL,
    -- What the file held when the app last wrote or read it, to notice edits made elsewhere.
    content_hash TEXT,
    mtime_ms     REAL,
    saved_at     INTEGER,
    -- The file used Windows line endings, so saving keeps them.
    crlf         INTEGER NOT NULL DEFAULT 0,
    -- Tab state, so the next launch can reopen what was open.
    open_order   INTEGER,
    active       INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX scripts_connection ON scripts (connection_id);

  -- Local history: earlier versions of a script.
  CREATE TABLE script_revisions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    script_id  TEXT NOT NULL REFERENCES scripts (id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    label      TEXT,
    size       INTEGER NOT NULL,
    content    TEXT NOT NULL
  );
  CREATE INDEX script_revisions_script ON script_revisions (script_id, id DESC);

  -- Query history: statements that were run.
  CREATE TABLE query_history (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    ran_at          INTEGER NOT NULL,
    connection_id   TEXT,
    connection_name TEXT NOT NULL,
    environment     TEXT NOT NULL,
    db_name         TEXT,
    script_id       TEXT,
    sql             TEXT NOT NULL,
    sql_truncated   INTEGER NOT NULL DEFAULT 0,
    status          TEXT NOT NULL,
    duration_ms     INTEGER,
    row_count       INTEGER,
    affected        INTEGER,
    error_code      TEXT,
    error_message   TEXT
  );
  CREATE INDEX query_history_connection ON query_history (connection_id, id DESC);
  CREATE INDEX query_history_ran_at ON query_history (ran_at);
  `,
  `
  -- What a script is written in decides its file type: .sql, or .mongodb for MongoDB.
  ALTER TABLE scripts ADD COLUMN language TEXT NOT NULL DEFAULT 'sql';
  `,
]

export function migrate(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number }
  for (let version = row.user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN')
    try {
      db.exec(MIGRATIONS[version]!)
      db.exec(`PRAGMA user_version = ${version + 1}`)
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }
}

/** Opens (and creates) the app database. Pass `:memory:` in tests. */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  migrate(db)
  return db
}

export function sqliteVersion(db: DatabaseSync): string {
  const row = db.prepare('SELECT sqlite_version() AS v').get() as { v: string }
  return row.v
}
