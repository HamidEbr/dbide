import type { ConnectionConfig, ConnectionSecrets, EngineKind } from './connection'
import type { EditBatch, EditResult, TableDescription } from './edit'
import type { DocumentEditBatch, DocumentEditResult } from './mongo/documents'
import type { BrokerApi } from './rabbitmq'
import type { RedisApi } from './redis/types'

/** What a driver can do. Shared UI lights up per capability; engine panels cover the rest. */
export type Capability =
  'tabular' | 'documents' | 'keyvalue' | 'messaging' | 'explain' | 'edit' | 'search'

/**
 * `direct`: TLS starts on connect (Mongo, Redis, AMQP), so a bare TLS handshake is a valid probe.
 * `upgrade`: TLS is negotiated inside the protocol after a greeting (MySQL), so only the driver
 * can test it.
 */
export type TlsMode = 'direct' | 'upgrade'

export interface DriverDescriptor {
  engine: EngineKind
  displayName: string
  defaultPort: number
  uriSchemes: string[]
  capabilities: Capability[]
  tlsMode: TlsMode
  /** False until the engine's milestone lands; the app shows the engine but can't open it yet. */
  implemented: boolean
}

export interface TreeNode {
  id: string
  label: string
  /** Engine specific: `database`, `table`, `collection`, `key-prefix`, `vhost`, `queue`, ... */
  kind: string
  hasChildren: boolean
  /** Short muted text beside the label, such as a row count or a column type. */
  detail?: string
  /** The database, keyspace, or vhost the node lives in. New scripts from this node start there. */
  scope?: string
}

/** One column, as autocomplete shows it. */
export interface SchemaColumn {
  name: string
  /** The type as the server writes it: `varchar(120)`, `int unsigned`. */
  type: string
  nullable: boolean
  /** `PRI` for a primary key, `UNI` for a unique one, `MUL` for an indexed one, or empty. */
  key: '' | 'PRI' | 'UNI' | 'MUL'
  comment: string
}

export interface SchemaTable {
  name: string
  view: boolean
  comment: string
  columns: SchemaColumn[]
}

/** A foreign key: `table.column` points at `refTable.refColumn`, which may be in another schema. */
export interface SchemaForeignKey {
  table: string
  column: string
  refSchema: string
  refTable: string
  refColumn: string
}

/** What autocomplete knows about one database: its tables and views with their columns, and how they join. */
export interface SchemaDetail {
  database: string
  tables: SchemaTable[]
  foreignKeys: SchemaForeignKey[]
}

export interface ExecuteRequest {
  /** SQL, a Mongo shell expression, a Redis command or a publish payload. */
  text: string
  /** Database, collection, key or queue the request applies to. */
  target?: string
}

export interface ColumnInfo {
  name: string
  /** A readable type such as `int`, `varchar`, `decimal`, `json`, `blob`. */
  type: string
  nullable?: boolean
  /** The table the column comes from, as the query named it (an alias if it has one). */
  table?: string
  /** The real table and column behind a plain column. Missing for expressions and aggregates. */
  source?: { schema: string; table: string; column: string }
}

/**
 * Results stream in batches so the grid can render the first rows while the rest still arrive.
 * One statement can yield several result sets (a stored procedure): each starts with `columns`.
 */
export type ResultBatch =
  | { kind: 'columns'; columns: ColumnInfo[] }
  | { kind: 'rows'; rows: unknown[][] }
  | { kind: 'documents'; documents: unknown[] }
  | {
      kind: 'ok'
      affectedRows: number
      insertId: string | null
      message: string
      warnings: number
    }

export interface SessionInfo {
  serverVersion: string
  currentDatabase: string | null
  readOnly: boolean
  /**
   * Whether the server itself refuses writes while `readOnly` is set. False for a server too old to
   * have read-only transactions, where the driver refuses them instead. Missing means the server does.
   */
  readOnlyEnforcedByServer?: boolean
}

export interface DriverSession {
  readonly info: SessionInfo
  ping(): Promise<void>
  /** Children of `parent`, or the roots when `parent` is null. */
  children(parent: TreeNode | null, signal: AbortSignal): Promise<TreeNode[]>
  /**
   * Runs one request and yields its results in batches. Stopping the iteration, or aborting the
   * signal, cancels the work on the server. The consumer pulls batches at its own pace: a slow
   * consumer slows the server down instead of buffering the whole result.
   */
  execute(request: ExecuteRequest, signal: AbortSignal): AsyncIterable<ResultBatch>
  /** Table and column names for autocomplete. */
  completionSchema?(database: string | null, signal: AbortSignal): Promise<Record<string, string[]>>
  /** Every table, view and column of one database, with types and keys, for autocomplete. */
  schemaDetail?(database: string, signal: AbortSignal): Promise<SchemaDetail>
  /** The names of the databases this login can see, for autocomplete after `USE` and `db.`. */
  databaseNames?(signal: AbortSignal): Promise<string[]>
  /** Primary key and column details of one table, for editing rows. */
  describeTable?(schema: string, table: string, signal: AbortSignal): Promise<TableDescription>
  /**
   * Applies row changes in one transaction. Every change must touch exactly the rows it expects;
   * if any does not, nothing is changed. Expected failures come back as `ok: false`.
   */
  applyEdits?(batch: EditBatch, signal: AbortSignal): Promise<EditResult>
  /**
   * Applies changes to documents (insert, update fields, delete by `_id`). Together or not at all
   * wherever the server has transactions; the result says which. Expected failures come back as `ok: false`.
   */
  applyDocumentEdits?(batch: DocumentEditBatch, signal: AbortSignal): Promise<DocumentEditResult>
  /** The field names some documents of a collection have, for autocomplete. */
  sampleFields?(database: string, collection: string, signal: AbortSignal): Promise<string[]>
  /** What a message broker's session can do beyond browsing: look at messages, publish, declare and delete. */
  readonly broker?: BrokerApi
  /** What a Redis session can do beyond browsing the tree: read and change keys, run commands, report on the server. */
  readonly redis?: RedisApi
  /** Server-enforced read-only mode for this session. */
  setReadOnly?(readOnly: boolean): Promise<void>
  close(): Promise<void>
}

export interface ConnectContext {
  config: ConnectionConfig
  secrets: ConnectionSecrets
  /** Where to connect. Differs from `config.host` when an SSH tunnel is in the way. */
  endpoint: { host: string; port: number }
  /** Start the session read-only. The core sets this from the connection's environment. */
  readOnly?: boolean
  signal: AbortSignal
}

export interface Driver {
  descriptor: DriverDescriptor
  connect(context: ConnectContext): Promise<DriverSession>
  /**
   * Where the connection test should look for the server when it is not at the saved host and port: RabbitMQ is
   * browsed through its management API, a different port from the one the connection form holds.
   */
  testEndpoint?(config: ConnectionConfig): { host: string; port: number; tls: boolean }
}
