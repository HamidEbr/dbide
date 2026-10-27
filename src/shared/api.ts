import type { ConnectionConfig, ConnectionSecrets, ConnectionSummary, TestStep } from './connection'
import type { DriverDescriptor, SchemaDetail, SessionInfo, TableColumns, TreeNode } from './driver'
import type { EditBatch, EditResult, TableDescription } from './edit'
import type { ExportFormat, ExportOptions } from './export'
import type { DocumentEditBatch, DocumentEditResult } from './mongo/documents'
import type {
  BindRequest,
  BrokerOverview,
  DeclareExchangeRequest,
  DeclareQueueRequest,
  ExchangeDetail,
  PeekedMessage,
  PublishRequest,
  QueueDetail,
  UnbindRequest,
  VhostListing,
} from './rabbitmq'
import type {
  CountResult,
  DeleteResult,
  ExecResult,
  KeyDetail,
  RedisEdit,
  RedisInfo,
  RedisType,
  ScanPage,
  StreamGroupDetail,
  StreamInfo,
  ValuePage,
} from './redis/types'
import type { Cell, RunOutcome } from './query'
import type {
  HistoryPage,
  HistoryQuery,
  RevisionLabel,
  ScriptInfo,
  ScriptRevision,
} from './scripts'
import type { Settings } from './settings'

export interface AppInfo {
  version: string
  electron: string
  node: string
  sqlite: string
  dataDir: string
  /** Where script files live. */
  scriptsDir: string
  platform: string
}

export interface StoredConnection {
  config: ConnectionConfig
  /** Whether a password is saved. The value itself never leaves the secret store. */
  hasPassword: boolean
}

/** Served by the core utility process to renderers. */
export interface CoreApi {
  'app.info': { params: void; result: AppInfo }
  'engines.list': { params: void; result: DriverDescriptor[] }
  'settings.get': { params: void; result: Settings }
  'settings.set': { params: Partial<Settings>; result: Settings }
  'connections.list': { params: void; result: ConnectionSummary[] }
  'connections.get': { params: { id: string }; result: StoredConnection | null }
  'connections.save': {
    params: { config: ConnectionConfig; secrets?: ConnectionSecrets }
    result: ConnectionSummary
  }
  'connections.delete': { params: { id: string }; result: void }
  'connections.test': {
    params: { config: ConnectionConfig; secrets?: ConnectionSecrets }
    result: TestStep[]
  }
  /** Opens the connection-level session that serves the tree and autocomplete. */
  'sessions.open': { params: { connectionId: string }; result: SessionInfo }
  'sessions.close': { params: { connectionId: string }; result: void }
  'tree.children': {
    params: { connectionId: string; parent: TreeNode | null }
    result: TreeNode[]
  }
  'schema.completion': {
    params: { connectionId: string; database: string | null }
    result: Record<string, string[]>
  }
  /** The names of the databases the login can see, for autocomplete. */
  'schema.databases': { params: { connectionId: string }; result: string[] }
  /** The tables and views of one database, for autocomplete. Columns come from `schema.columns`. */
  'schema.detail': {
    params: { connectionId: string; database: string }
    result: SchemaDetail
  }
  /** The columns and foreign keys of some tables of one database, for autocomplete. */
  'schema.columns': {
    params: { connectionId: string; database: string; tables: string[] }
    result: TableColumns
  }
  /** The field names that some documents of a MongoDB collection have, for autocomplete. */
  'schema.fields': {
    params: { connectionId: string; database: string; collection: string }
    result: string[]
  }
  /**
   * Runs statements one after another on the script's own connection, streaming `query.event`
   * messages to the caller. Resolves when the run ends; abort the call to cancel it.
   */
  'query.run': {
    params: {
      runId: string
      scriptId: string
      connectionId: string
      database: string | null
      readOnly: boolean
      statements: string[]
      pageSize: number
    }
    result: { outcome: RunOutcome; statementsRun: number }
  }
  /**
   * Rows of a result that the window did not keep (those past `RESIDENT_ROWS`), by position within
   * the held part. Fewer at the end of the result, none once the run was replaced.
   */
  'results.fetch': { params: { key: string; from: number; count: number }; result: Cell[][] }
  /** The numbers in a block of held rows, for the selection statistics. */
  'results.stats': {
    params: {
      key: string
      from: number
      count: number
      columns: { index: number; type: string }[]
    }
    result: { numeric: number; sum: number; min: number; max: number; partial: boolean }
  }
  /** Lets a paused statement stream more rows. */
  'query.more': {
    params: { runId: string; statement: number; rows: number | 'all' }
    result: void
  }
  /** What the server knows about a table: its primary key and column details. */
  'tables.describe': {
    params: { connectionId: string; schema: string; table: string }
    result: TableDescription
  }
  /**
   * Applies staged row changes in one transaction on a private connection, so a transaction the
   * user has open in the script is never disturbed. The script must be writable.
   */
  'edits.apply': {
    params: { connectionId: string; scriptId: string; batch: EditBatch }
    result: EditResult
  }
  /**
   * Applies staged changes to MongoDB documents on a private connection, together where the server has
   * transactions. The script that showed the documents must be writable.
   */
  'documents.apply': {
    params: { connectionId: string; scriptId: string; batch: DocumentEditBatch }
    result: DocumentEditResult
  }
  // ───────── RabbitMQ. Every call that changes something names whether the tab has writes unlocked. ─────────

  'broker.overview': { params: { connectionId: string }; result: BrokerOverview }
  /** Every queue and exchange of a vhost, for the vhost view. */
  'broker.listing': { params: { connectionId: string; vhost: string }; result: VhostListing }
  'broker.queue': {
    params: { connectionId: string; vhost: string; name: string }
    result: QueueDetail
  }
  'broker.exchange': {
    params: { connectionId: string; vhost: string; name: string }
    result: ExchangeDetail
  }
  /** Looks at the first messages of a queue: they are taken and put straight back. */
  'broker.peek': {
    params: { connectionId: string; vhost: string; queue: string; count: number }
    result: PeekedMessage[]
  }
  'broker.publish': {
    params: { connectionId: string; vhost: string; writable: boolean; request: PublishRequest }
    result: { routed: boolean }
  }
  'broker.purge': {
    params: { connectionId: string; vhost: string; writable: boolean; queue: string }
    result: void
  }
  'broker.declareQueue': {
    params: { connectionId: string; vhost: string; writable: boolean; request: DeclareQueueRequest }
    result: void
  }
  'broker.deleteQueue': {
    params: { connectionId: string; vhost: string; writable: boolean; name: string }
    result: void
  }
  'broker.declareExchange': {
    params: {
      connectionId: string
      vhost: string
      writable: boolean
      request: DeclareExchangeRequest
    }
    result: void
  }
  'broker.deleteExchange': {
    params: { connectionId: string; vhost: string; writable: boolean; name: string }
    result: void
  }
  'broker.bind': {
    params: { connectionId: string; vhost: string; writable: boolean; request: BindRequest }
    result: void
  }
  'broker.unbind': {
    params: { connectionId: string; vhost: string; writable: boolean; request: UnbindRequest }
    result: void
  }

  // ───────── Redis. Reads name a database; every call that changes something names whether the tab has writes unlocked. ─────────

  'redis.info': { params: { connectionId: string }; result: RedisInfo }
  /** One page of keys, with the type and TTL of each. Pass the page's `cursor` back for the next. */
  'redis.scan': {
    params: {
      connectionId: string
      db: number
      pattern: string
      type?: RedisType
      cursor: string | null
      limit: number
    }
    result: ScanPage
  }
  'redis.key': { params: { connectionId: string; db: number; key: string }; result: KeyDetail }
  'redis.value': {
    params: {
      connectionId: string
      db: number
      key: string
      type: RedisType
      cursor: string | null
      count: number
      match?: string
    }
    result: ValuePage
  }
  'redis.memory': {
    params: { connectionId: string; db: number; keys: string[] }
    result: (number | null)[]
  }
  'redis.streamInfo': {
    params: { connectionId: string; db: number; key: string }
    result: StreamInfo
  }
  'redis.streamGroup': {
    params: { connectionId: string; db: number; key: string; group: string }
    result: StreamGroupDetail
  }
  'redis.edit': {
    params: {
      connectionId: string
      db: number
      writable: boolean
      key: string
      edit: RedisEdit
    }
    result: void
  }
  /** Counts the keys matching a pattern, streaming `redis.progress` events. Abort the call to stop. */
  'redis.count': {
    params: {
      connectionId: string
      db: number
      pattern: string
      type?: RedisType
      taskId: string
    }
    result: CountResult
  }
  /** Deletes the keys matching a pattern in batches, streaming `redis.progress` events. Abort the call to stop. */
  'redis.deleteMatching': {
    params: {
      connectionId: string
      db: number
      writable: boolean
      pattern: string
      type?: RedisType
      taskId: string
    }
    result: DeleteResult
  }
  /** Runs one console line on the console's own connection, so MULTI and SELECT carry over from line to line. */
  'redis.exec': {
    params: { connectionId: string; consoleId: string; writable: boolean; line: string }
    result: ExecResult
  }
  /** Closes the console's connection when its tab closes. */
  'redis.consoleClose': { params: { consoleId: string }; result: void }

  /** Brings the script's server session in line with its lock, so a change takes effect at once. */
  'scripts.setReadOnly': { params: { scriptId: string; readOnly: boolean }; result: void }
  /** Closes the script's connection when its tab closes. */
  'scripts.close': { params: { scriptId: string }; result: void }

  /** Every script in the scripts folder, including `.sql` files that were dropped in by hand. */
  'scripts.list': { params: void; result: ScriptInfo[] }
  /** Creates the script and its file. The id comes from the window, so the tab can open at once. */
  'scripts.create': {
    params: {
      id: string
      connectionId: string | null
      database: string | null
      name?: string
      content?: string
    }
    result: ScriptInfo
  }
  /** The script's text, read from its file. A missing file is restored from local history. */
  'scripts.read': {
    params: { id: string }
    result: { info: ScriptInfo; content: string; recovered: boolean }
  }
  /**
   * Writes the script's file. A `label` keeps this exact text in local history. If the file was
   * changed outside the app, that version is kept in local history before it is replaced.
   */
  'scripts.save': {
    params: { id: string; content: string; label?: RevisionLabel }
    result: { savedAt: number; externalChange: boolean }
  }
  /** Moves a script to another connection or database. */
  'scripts.update': {
    params: { id: string; connectionId?: string | null; database?: string | null }
    result: ScriptInfo
  }
  'scripts.rename': { params: { id: string; name: string }; result: ScriptInfo }
  'scripts.duplicate': { params: { id: string }; result: ScriptInfo }
  /** Moves the file to the system trash and forgets the script. */
  'scripts.delete': { params: { id: string }; result: void }
  /** Asks for .sql files with a file dialog and copies them into the scripts folder. */
  'scripts.import': {
    params: void
    result: { imported: ScriptInfo[]; failed: { name: string; message: string }[] }
  }
  /** Shows a script's file, or the scripts folder when no id is given, in the file manager. */
  'scripts.reveal': { params: { id: string | null }; result: void }
  /** Remembers which scripts have a tab open, in order, so the next launch can restore them. */
  'scripts.setOpen': { params: { ids: string[]; active: string | null }; result: void }
  /** The saved versions of a script, newest first. */
  'scripts.history': { params: { id: string }; result: ScriptRevision[] }
  'scripts.revision': { params: { id: string; revisionId: number }; result: string }

  /** Statements that were run, newest first. */
  'history.list': { params: HistoryQuery; result: HistoryPage }
  'history.delete': { params: { id: number }; result: void }
  /** Forgets all history, or only one connection's. */
  'history.clear': { params: { connectionId?: string }; result: void }

  /**
   * Runs a read-only query on a private connection and streams every row to a file the user
   * picks, with no row limit. Streams `export.progress` events; abort the call to cancel.
   */
  'export.run': {
    params: {
      exportId: string
      connectionId: string
      database: string | null
      sql: string
      format: ExportFormat
      options: ExportOptions
      /** Write the file gzipped (ignored for Excel, which is a zip already). */
      compress?: boolean
      /** Suggested name in the save dialog. */
      fileName: string
    }
    result:
      | { status: 'saved'; path: string; rows: number; bytes: number; durationMs: number }
      /** The user closed the save dialog without choosing a file. */
      | { status: 'dismissed' }
  }
  /** Shows a file that an export wrote in the file manager. */
  'export.reveal': { params: { path: string }; result: void }
}

/** Served by the main process to the core, for things only the main process can do. */
export interface HostApi {
  'secrets.available': { params: void; result: boolean }
  'secrets.get': { params: { key: string }; result: string | null }
  'secrets.set': { params: { key: string; value: string }; result: void }
  'secrets.delete': { params: { key: string }; result: void }
  /** A native save dialog. Null when the user cancels. */
  'files.chooseSavePath': {
    params: { defaultName: string; filterName: string; extension: string }
    result: string | null
  }
  /** A native open dialog that allows several files. Empty when the user cancels. */
  'files.chooseOpenPaths': {
    params: { filterName: string; extensions: string[] }
    result: string[]
  }
  'files.reveal': { params: { path: string }; result: void }
  'files.trash': { params: { path: string }; result: void }
}

export const CoreEvents = {
  connectionsChanged: 'connections.changed',
  queryEvent: 'query.event',
  /** A script was created, renamed, deleted or moved. Sent to every window. */
  scriptsChanged: 'scripts.changed',
  /** A statement was added to the history, or the history was cleared. Sent to every window. */
  historyChanged: 'history.changed',
  /** Progress of an export, sent to the window that started it. */
  exportProgress: 'export.progress',
  /** Something the person should know about the server they are using. Sent to the window that caused it. */
  notice: 'notice',
  /** How far a Redis count or bulk delete has got, sent to the window that started it. */
  redisProgress: 'redis.progress',
} as const

export interface ExportProgress {
  exportId: string
  rows: number
  bytes: number
}
