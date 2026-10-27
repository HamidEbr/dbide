import { ENGINES, type ConnectionConfig, type ConnectionSecrets } from '@shared/connection'
import { ENVIRONMENTS } from '@shared/environment'
import { MAX_CHANGES_PER_BATCH, type EditBatch, type RowChange } from '@shared/edit'
import {
  MAX_DOCUMENT_CHANGES,
  type DocumentChange,
  type DocumentEditBatch,
} from '@shared/mongo/documents'
import type { Json } from '@shared/mongo/ejson'
import {
  DEFAULT_PEEK_MESSAGES,
  MAX_PEEK_MESSAGES,
  PEEK_TRUNCATE_BYTES,
  type BindRequest,
  type DeclareExchangeRequest,
  type DeclareQueueRequest,
  type MessageProperties,
  type PublishRequest,
  type UnbindRequest,
} from '@shared/rabbitmq'
import {
  DEFAULT_EXPORT_OPTIONS,
  DELIMITERS,
  EXPORT_FORMATS,
  MAX_ROWS_PER_INSERT,
  type ExportFormat,
  type ExportOptions,
} from '@shared/export'
import { MAX_FETCH_ROWS, type Cell } from '@shared/query'
import {
  HISTORY_PAGE_SIZE,
  isScriptId,
  type HistoryQuery,
  type HistoryStatus,
  type RevisionLabel,
} from '@shared/scripts'
import { RpcError } from '@shared/rpc'
import { DEFAULT_SETTINGS, type Settings } from '@shared/settings'

function invalid(message: string): never {
  throw new RpcError('INVALID_INPUT', message)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string') invalid(`${field} must be text`)
  return value
}

/** Everything that crosses the process boundary is untrusted, so connections are re-validated. */
export function validateConnectionConfig(input: unknown): ConnectionConfig {
  if (!isRecord(input)) invalid('Connection must be an object')

  const { id, name, engine, environment, host, port, tls, ssh, options } = input
  if (typeof id !== 'string' || id.length === 0) invalid('Connection needs an id')
  if (typeof name !== 'string' || name.trim().length === 0) invalid('Give the connection a name')
  if (!ENGINES.includes(engine as never)) invalid('Unknown engine')
  if (!ENVIRONMENTS.includes(environment as never)) invalid('Unknown environment')
  if (typeof host !== 'string' || host.trim().length === 0) invalid('Enter a host')
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    invalid('Port must be between 1 and 65535')
  }
  if (!isRecord(tls) || typeof tls.enabled !== 'boolean') invalid('TLS settings are malformed')
  if (options !== undefined && !isRecord(options)) invalid('Options are malformed')
  for (const [key, value] of Object.entries(options ?? {})) {
    if (typeof value !== 'string') invalid(`Option "${key}" must be text`)
  }

  const config: ConnectionConfig = {
    id,
    name: name.trim(),
    engine: engine as ConnectionConfig['engine'],
    environment: environment as ConnectionConfig['environment'],
    host: host.trim(),
    port,
    tls: {
      enabled: tls.enabled,
      allowInvalidCertificates: tls.allowInvalidCertificates === true,
    },
    options: { ...(options as Record<string, string> | undefined) },
  }

  const folder = optionalString(input.folder, 'Folder')
  if (folder) config.folder = folder
  const username = optionalString(input.username, 'Username')
  if (username) config.username = username
  const database = optionalString(input.database, 'Database')
  if (database) config.database = database
  const caPath = optionalString(tls.caPath, 'CA path')
  if (caPath) config.tls.caPath = caPath
  const certPath = optionalString(tls.certPath, 'Client certificate path')
  if (certPath) config.tls.certPath = certPath
  const keyPath = optionalString(tls.keyPath, 'Client key path')
  if (keyPath) config.tls.keyPath = keyPath

  if (config.engine === 'redis') {
    if (config.database !== undefined && !/^\d+$/.test(config.database)) {
      invalid('The Redis database must be a number, such as 0')
    }
    const mode = config.options.mode
    if (mode !== undefined && !['standalone', 'sentinel', 'cluster'].includes(mode)) {
      invalid('Redis can be a single server, a Sentinel setup or a cluster')
    }
  }

  if (ssh !== undefined && ssh !== null) {
    if (!isRecord(ssh)) invalid('SSH settings are malformed')
    if (typeof ssh.host !== 'string' || typeof ssh.username !== 'string') {
      invalid('SSH needs a host and a username')
    }
    if (typeof ssh.port !== 'number' || !Number.isInteger(ssh.port)) invalid('SSH port is invalid')
    if (!['password', 'key', 'agent'].includes(ssh.auth as string)) invalid('Unknown SSH auth')
    config.ssh = {
      enabled: ssh.enabled === true,
      host: ssh.host,
      port: ssh.port,
      username: ssh.username,
      auth: ssh.auth as 'password' | 'key' | 'agent',
    }
    const privateKeyPath = optionalString(ssh.privateKeyPath, 'SSH key path')
    if (privateKeyPath) config.ssh.privateKeyPath = privateKeyPath
    const configHost = optionalString(ssh.configHost, 'SSH config host')
    if (configHost) config.ssh.configHost = configHost
    const jumpHost = optionalString(ssh.jumpHost, 'SSH jump host')
    if (jumpHost) config.ssh.jumpHost = jumpHost
  }

  return config
}

export function validateSecrets(input: unknown): ConnectionSecrets {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) invalid('Secrets are malformed')
  const secrets: ConnectionSecrets = {}
  for (const name of ['password', 'sshPassword', 'sshPassphrase'] as const) {
    const value = input[name]
    if (value === undefined) continue
    if (typeof value !== 'string') invalid(`${name} must be text`)
    secrets[name] = value
  }
  return secrets
}

export function validateSettingsPatch(input: unknown): Partial<Settings> {
  if (!isRecord(input)) invalid('Settings must be an object')
  const patch: Partial<Settings> = {}
  for (const key of Object.keys(input)) {
    if (!(key in DEFAULT_SETTINGS)) invalid(`Unknown setting "${key}"`)
  }
  const { theme, density, navigatorOpen, inspectorOpen, recordHistory } = input
  for (const key of ['sqlFullPaths', 'sqlUppercaseKeywords'] as const) {
    if (input[key] === undefined) continue
    if (typeof input[key] !== 'boolean') invalid(`${key} must be true or false`)
    patch[key] = input[key]
  }
  if (theme !== undefined) {
    if (!['system', 'light', 'dark'].includes(theme as string)) invalid('Unknown theme')
    patch.theme = theme as Settings['theme']
  }
  if (density !== undefined) {
    if (!['compact', 'default', 'comfortable'].includes(density as string)) {
      invalid('Unknown density')
    }
    patch.density = density as Settings['density']
  }
  if (navigatorOpen !== undefined) {
    if (typeof navigatorOpen !== 'boolean') invalid('navigatorOpen must be true or false')
    patch.navigatorOpen = navigatorOpen
  }
  if (inspectorOpen !== undefined) {
    if (typeof inspectorOpen !== 'boolean') invalid('inspectorOpen must be true or false')
    patch.inspectorOpen = inspectorOpen
  }
  if (recordHistory !== undefined) {
    if (typeof recordHistory !== 'boolean') invalid('recordHistory must be true or false')
    patch.recordHistory = recordHistory
  }
  return patch
}

export interface RunParams {
  runId: string
  scriptId: string
  connectionId: string
  database: string | null
  readOnly: boolean
  statements: string[]
  pageSize: number
}

const MAX_STATEMENT_CHARS = 5_000_000

export function validateRunParams(input: unknown): RunParams {
  if (!isRecord(input)) invalid('Run request must be an object')
  const { runId, scriptId, connectionId, database, readOnly, statements, pageSize } = input
  for (const [name, value] of Object.entries({ runId, scriptId, connectionId })) {
    if (typeof value !== 'string' || value.length === 0) invalid(`${name} is required`)
  }
  if (database !== null && typeof database !== 'string') invalid('database must be text or null')
  if (typeof readOnly !== 'boolean') invalid('readOnly must be true or false')
  if (!Array.isArray(statements) || statements.length === 0) invalid('Nothing to run')
  for (const statement of statements) {
    if (typeof statement !== 'string' || statement.trim() === '') invalid('Empty statement')
    if (statement.length > MAX_STATEMENT_CHARS) invalid('A statement is too large to run')
  }
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1) {
    invalid('pageSize must be a positive whole number')
  }
  return {
    runId: runId as string,
    scriptId: scriptId as string,
    connectionId: connectionId as string,
    database: database as string | null,
    readOnly,
    statements: statements as string[],
    pageSize,
  }
}

const MAX_NAME_CHARS = 256
const MAX_VALUE_BYTES = 16 * 1024 * 1024

function validateCell(value: unknown, what: string): Cell {
  if (value === null || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${what} is not a finite number`)
    return value
  }
  if (typeof value === 'string') {
    if (value.length > MAX_VALUE_BYTES) invalid(`${what} is too large`)
    return value
  }
  if (value instanceof Uint8Array) {
    if (value.length > MAX_VALUE_BYTES) invalid(`${what} is too large`)
    return value
  }
  return invalid(`${what} has an unsupported type`)
}

function validateRecord(input: unknown, what: string, allowEmpty: boolean): Record<string, Cell> {
  if (!isRecord(input)) invalid(`${what} must be an object`)
  const names = Object.keys(input)
  if (names.length === 0 && !allowEmpty) invalid(`${what} can't be empty`)
  const out: Record<string, Cell> = {}
  for (const name of names) {
    if (name.length === 0 || name.length > MAX_NAME_CHARS) invalid(`${what} has a bad column name`)
    out[name] = validateCell(input[name], `${what}.${name}`)
  }
  return out
}

/** Row changes arrive from the window, so they are checked like any other input. */
export function validateEditBatch(input: unknown): EditBatch {
  if (!isRecord(input)) invalid('Changes must be an object')
  const { schema, table, changes } = input
  for (const [name, value] of Object.entries({ schema, table })) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_CHARS) {
      invalid(`${name} is required`)
    }
  }
  if (!Array.isArray(changes) || changes.length === 0) invalid('There is nothing to apply')
  if (changes.length > MAX_CHANGES_PER_BATCH) {
    invalid(`Too many changes at once. Apply at most ${MAX_CHANGES_PER_BATCH.toLocaleString()}.`)
  }

  const validated = changes.map((change, index): RowChange => {
    if (!isRecord(change)) invalid(`Change ${index + 1} is malformed`)
    switch (change.kind) {
      case 'update':
        return {
          kind: 'update',
          key: validateRecord(change.key, 'key', false),
          values: validateRecord(change.values, 'values', false),
        }
      case 'delete':
        return { kind: 'delete', key: validateRecord(change.key, 'key', false) }
      case 'insert':
        return { kind: 'insert', values: validateRecord(change.values, 'values', true) }
      default:
        return invalid(`Change ${index + 1} has an unknown kind`)
    }
  })
  return { schema: schema as string, table: table as string, changes: validated }
}

function nullableString(value: unknown, field: string, max = MAX_NAME_CHARS): string | null {
  if (value === null || value === undefined) return null
  if (typeof value !== 'string' || value.length > max) invalid(`${field} must be text`)
  return value
}

function scriptId(value: unknown): string {
  if (!isScriptId(value)) invalid('That is not a script id')
  return value
}

export interface NewScriptParams {
  id: string
  connectionId: string | null
  database: string | null
  name?: string
  content?: string
}

export function validateNewScript(input: unknown): NewScriptParams {
  if (!isRecord(input)) invalid('Script must be an object')
  const params: NewScriptParams = {
    id: scriptId(input.id),
    connectionId: nullableString(input.connectionId, 'connectionId'),
    database: nullableString(input.database, 'database'),
  }
  if (input.name !== undefined) params.name = nullableString(input.name, 'name') ?? undefined
  if (input.content !== undefined) {
    if (typeof input.content !== 'string') invalid('content must be text')
    params.content = input.content
  }
  return params
}

const REVISION_LABELS: readonly RevisionLabel[] = ['created', 'run', 'external', 'restore']

export function validateScriptSave(input: unknown): {
  id: string
  content: string
  label?: RevisionLabel
} {
  if (!isRecord(input)) invalid('Save request must be an object')
  if (typeof input.content !== 'string') invalid('content must be text')
  const saved: { id: string; content: string; label?: RevisionLabel } = {
    id: scriptId(input.id),
    content: input.content,
  }
  if (input.label !== undefined) {
    if (!REVISION_LABELS.includes(input.label as RevisionLabel)) invalid('Unknown version label')
    saved.label = input.label as RevisionLabel
  }
  return saved
}

export function validateScriptUpdate(input: unknown): {
  id: string
  connectionId?: string | null
  database?: string | null
} {
  if (!isRecord(input)) invalid('Update must be an object')
  const update: { id: string; connectionId?: string | null; database?: string | null } = {
    id: scriptId(input.id),
  }
  if (input.connectionId !== undefined) {
    update.connectionId = nullableString(input.connectionId, 'connectionId')
  }
  if (input.database !== undefined) update.database = nullableString(input.database, 'database')
  return update
}

export function validateScriptId(input: unknown): string {
  return scriptId(isRecord(input) ? input.id : undefined)
}

export function validateOpenScripts(input: unknown): { ids: string[]; active: string | null } {
  if (!isRecord(input)) invalid('Open scripts must be an object')
  if (!Array.isArray(input.ids) || input.ids.length > 500) invalid('ids must be a list')
  const ids = input.ids.map(scriptId)
  const active = input.active === null || input.active === undefined ? null : scriptId(input.active)
  return { ids, active }
}

const HISTORY_STATUSES: readonly HistoryStatus[] = ['ok', 'error', 'cancelled']

export function validateHistoryQuery(input: unknown): HistoryQuery {
  if (!isRecord(input)) invalid('History query must be an object')
  const query: HistoryQuery = {}
  if (input.search !== undefined) query.search = nullableString(input.search, 'search', 500) ?? ''
  if (input.connectionId !== undefined) {
    const id = nullableString(input.connectionId, 'connectionId')
    if (id) query.connectionId = id
  }
  if (input.status !== undefined) {
    if (!HISTORY_STATUSES.includes(input.status as HistoryStatus)) invalid('Unknown status')
    query.status = input.status as HistoryStatus
  }
  for (const field of ['before', 'limit'] as const) {
    const value = input[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      invalid(`${field} must be a whole number`)
    }
    query[field] = value
  }
  query.limit ??= HISTORY_PAGE_SIZE
  return query
}

export interface ExportParams {
  exportId: string
  connectionId: string
  database: string | null
  sql: string
  format: ExportFormat
  options: ExportOptions
  /** Write the file gzipped. An Excel file is a zip already, so it is never compressed again. */
  compress: boolean
  fileName: string
}

function validateExportOptions(input: unknown): ExportOptions {
  if (!isRecord(input)) invalid('Export options must be an object')
  const defaults = DEFAULT_EXPORT_OPTIONS
  const flag = (name: keyof ExportOptions): boolean => {
    const value = input[name]
    if (value === undefined) return defaults[name] as boolean
    if (typeof value !== 'boolean') invalid(`${name} must be true or false`)
    return value
  }
  const delimiter = input.delimiter ?? defaults.delimiter
  if (!DELIMITERS.includes(delimiter as never)) invalid('Unknown delimiter')
  const nullText = input.nullText ?? defaults.nullText
  if (typeof nullText !== 'string' || nullText.length > 100) invalid('nullText must be short text')
  const tableName = input.tableName ?? defaults.tableName
  if (typeof tableName !== 'string' || tableName.trim() === '' || tableName.length > 256) {
    invalid('Name the table for the INSERT statements')
  }
  const rowsPerInsert = input.rowsPerInsert ?? defaults.rowsPerInsert
  if (
    typeof rowsPerInsert !== 'number' ||
    !Number.isInteger(rowsPerInsert) ||
    rowsPerInsert < 1 ||
    rowsPerInsert > MAX_ROWS_PER_INSERT
  ) {
    invalid(`Rows per INSERT must be between 1 and ${MAX_ROWS_PER_INSERT}`)
  }
  return {
    header: flag('header'),
    delimiter: delimiter as ExportOptions['delimiter'],
    nullText,
    quoteAll: flag('quoteAll'),
    bom: flag('bom'),
    crlf: flag('crlf'),
    neutralizeFormulas: flag('neutralizeFormulas'),
    tableName,
    rowsPerInsert,
  }
}

export function validateExportParams(input: unknown): ExportParams {
  if (!isRecord(input)) invalid('Export request must be an object')
  const { exportId, connectionId, sql, format, fileName } = input
  for (const [name, value] of Object.entries({ exportId, connectionId, sql, fileName })) {
    if (typeof value !== 'string' || value.length === 0) invalid(`${name} is required`)
  }
  if ((sql as string).length > MAX_STATEMENT_CHARS) invalid('That statement is too large')
  if ((fileName as string).length > 255) invalid('That file name is too long')
  if (!EXPORT_FORMATS.some((f) => f.value === format)) invalid('Unknown export format')
  return {
    exportId: exportId as string,
    connectionId: connectionId as string,
    database: nullableString(input.database, 'database'),
    sql: sql as string,
    format: format as ExportFormat,
    options: validateExportOptions(input.options),
    compress: input.compress === true && format !== 'xlsx',
    fileName: fileName as string,
  }
}

export function validateFetch(input: unknown): { key: string; from: number; count: number } {
  if (!isRecord(input)) invalid('Fetch request must be an object')
  const { key, from, count } = input
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) invalid('key is required')
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0)
    invalid('from must be a position')
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_FETCH_ROWS
  ) {
    invalid(`count must be between 1 and ${MAX_FETCH_ROWS}`)
  }
  return { key, from, count }
}

export function validateStats(input: unknown): {
  key: string
  from: number
  count: number
  columns: { index: number; type: string }[]
} {
  if (!isRecord(input)) invalid('Stats request must be an object')
  const { key, from, count, columns } = input
  if (typeof key !== 'string' || key.length === 0 || key.length > 300) invalid('key is required')
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0)
    invalid('from must be a position')
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 10_000_000) {
    invalid('count must be a number of rows')
  }
  if (!Array.isArray(columns) || columns.length > 5000) invalid('columns must be a list')
  const checked = columns.map((column) => {
    if (
      !isRecord(column) ||
      typeof column.index !== 'number' ||
      !Number.isInteger(column.index) ||
      column.index < 0 ||
      typeof column.type !== 'string' ||
      column.type.length > 60
    ) {
      invalid('A column is malformed')
    }
    return { index: column.index as number, type: column.type as string }
  })
  return { key, from, count, columns: checked }
}

// ───────────────────────────── MongoDB documents ─────────────────────────────

const MAX_JSON_DEPTH = 100
const MAX_JSON_CHARS = 32 * 1024 * 1024

/** A value that is plain JSON all the way down, as Extended JSON is. */
function validateJson(value: unknown, what: string, depth = 0): Json {
  if (depth > MAX_JSON_DEPTH) invalid(`${what} is nested too deeply`)
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid(`${what} holds a number JSON can’t carry`)
    return value
  }
  if (Array.isArray(value)) return value.map((item) => validateJson(item, what, depth + 1))
  if (isRecord(value)) {
    const out: { [key: string]: Json } = {}
    for (const [key, item] of Object.entries(value)) {
      Object.defineProperty(out, key, {
        value: validateJson(item, what, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      })
    }
    return out
  }
  return invalid(`${what} is not plain JSON`)
}

export function validateDocumentBatch(input: unknown): DocumentEditBatch {
  if (!isRecord(input)) invalid('Changes must be an object')
  const { database, collection, changes } = input
  for (const [name, value] of Object.entries({ database, collection })) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_CHARS) {
      invalid(`${name} is required`)
    }
  }
  if (!Array.isArray(changes) || changes.length === 0) invalid('There is nothing to apply')
  if (changes.length > MAX_DOCUMENT_CHANGES) {
    invalid(`Too many changes at once. Apply at most ${MAX_DOCUMENT_CHANGES.toLocaleString()}.`)
  }

  const validated = changes.map((change, index): DocumentChange => {
    if (!isRecord(change)) invalid(`Change ${index + 1} is malformed`)
    switch (change.kind) {
      case 'update': {
        const set = validateJson(change.set ?? {}, 'set')
        if (!isRecord(set)) invalid(`Change ${index + 1} has malformed fields to set`)
        const unset = change.unset ?? []
        if (
          !Array.isArray(unset) ||
          unset.some((p) => typeof p !== 'string' || p === '' || p.length > MAX_NAME_CHARS)
        ) {
          invalid(`Change ${index + 1} has malformed fields to remove`)
        }
        if (change.id === undefined) invalid(`Change ${index + 1} needs the document’s _id`)
        return {
          kind: 'update',
          id: validateJson(change.id, '_id'),
          set: set as Record<string, Json>,
          unset: unset as string[],
        }
      }
      case 'delete':
        if (change.id === undefined) invalid(`Change ${index + 1} needs the document’s _id`)
        return { kind: 'delete', id: validateJson(change.id, '_id') }
      case 'insert': {
        const document = validateJson(change.document, 'document')
        if (!isRecord(document)) invalid(`Change ${index + 1} must insert a document`)
        return { kind: 'insert', document }
      }
      default:
        return invalid(`Change ${index + 1} has an unknown kind`)
    }
  })
  if (JSON.stringify(validated).length > MAX_JSON_CHARS) invalid('These changes are too large')
  return { database: database as string, collection: collection as string, changes: validated }
}

export function validateSampleFields(input: unknown): {
  connectionId: string
  database: string
  collection: string
} {
  if (!isRecord(input)) invalid('Name a connection, a database and a collection')
  const { connectionId, database, collection } = input
  for (const [name, value] of Object.entries({ connectionId, database, collection })) {
    if (typeof value !== 'string' || value.length === 0 || value.length > MAX_NAME_CHARS) {
      invalid(`${name} is required`)
    }
  }
  return {
    connectionId: connectionId as string,
    database: database as string,
    collection: collection as string,
  }
}

// ───────────────────────────── RabbitMQ ─────────────────────────────

/** AMQP names are at most 255 bytes. */
const MAX_BROKER_NAME = 255
const MAX_PAYLOAD_CHARS = 16 * 1024 * 1024

function brokerString(value: unknown, field: string, allowEmpty = false): string {
  if (typeof value !== 'string') invalid(`${field} must be text`)
  if (!allowEmpty && value === '') invalid(`${field} is required`)
  if (new TextEncoder().encode(value).length > MAX_BROKER_NAME) {
    invalid(`${field} is longer than RabbitMQ allows (255 bytes)`)
  }
  return value
}

function brokerArguments(value: unknown, field: string): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  const json = validateJson(value, field)
  if (typeof json !== 'object' || json === null || Array.isArray(json))
    invalid(`${field} must be an object`)
  return json
}

function writable(value: unknown): boolean {
  if (typeof value !== 'boolean') invalid('Say whether writes are unlocked')
  return value
}

/** A connection and a vhost: what every call that looks at the broker names. */
export function validateBrokerTarget(input: unknown): { connectionId: string; vhost: string } {
  if (!isRecord(input)) invalid('Name a connection and a vhost')
  return {
    connectionId: brokerString(input.connectionId, 'connectionId'),
    vhost: brokerString(input.vhost, 'vhost'),
  }
}

/** A target and one object in it, by the field that holds its name. */
export function validateBrokerObject(
  input: unknown,
  field: 'name' | 'queue',
): { connectionId: string; vhost: string; name: string } {
  const target = validateBrokerTarget(input)
  const body = input as Record<string, unknown>
  return { ...target, name: brokerString(body[field], field, field === 'name' ? true : false) }
}

export function validateBrokerWrite(
  input: unknown,
  field: 'name' | 'queue' | null,
): { connectionId: string; vhost: string; writable: boolean; name: string } {
  const target = validateBrokerTarget(input)
  const body = input as Record<string, unknown>
  return {
    ...target,
    writable: writable(body.writable),
    name: field === null ? '' : brokerString(body[field], field),
  }
}

export function validatePeek(input: unknown): {
  connectionId: string
  vhost: string
  queue: string
  count: number
  truncate: number
} {
  const { connectionId, vhost, name } = validateBrokerObject(input, 'queue')
  const count = (input as { count?: unknown }).count ?? DEFAULT_PEEK_MESSAGES
  if (
    typeof count !== 'number' ||
    !Number.isInteger(count) ||
    count < 1 ||
    count > MAX_PEEK_MESSAGES
  ) {
    invalid(`Peek at between 1 and ${MAX_PEEK_MESSAGES} messages`)
  }
  return { connectionId, vhost, queue: name, count, truncate: PEEK_TRUNCATE_BYTES }
}

function validateProperties(input: unknown): MessageProperties {
  if (input === undefined || input === null) return {}
  if (!isRecord(input)) invalid('Message properties must be an object')
  const out: MessageProperties = {}
  for (const key of [
    'contentType',
    'contentEncoding',
    'correlationId',
    'replyTo',
    'expiration',
    'messageId',
    'type',
    'userId',
    'appId',
  ] as const) {
    const value = input[key]
    if (value === undefined || value === null || value === '') continue
    out[key] = brokerString(value, key)
  }
  for (const key of ['deliveryMode', 'priority', 'timestamp'] as const) {
    const value = input[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0)
      invalid(`${key} must be a whole number`)
    out[key] = value
  }
  if (out.deliveryMode !== undefined && out.deliveryMode !== 1 && out.deliveryMode !== 2) {
    invalid('deliveryMode is 1 (transient) or 2 (persistent)')
  }
  if (input.headers !== undefined && input.headers !== null)
    out.headers = brokerArguments(input.headers, 'headers')
  return out
}

export function validatePublish(input: unknown): {
  connectionId: string
  vhost: string
  writable: boolean
  request: PublishRequest
} {
  const { connectionId, vhost, writable: allowed } = validateBrokerWrite(input, null)
  const request = (input as { request?: unknown }).request
  if (!isRecord(request)) invalid('Say what to publish')
  const { payload, payloadEncoding } = request
  if (typeof payload !== 'string') invalid('The payload must be text')
  if (payload.length > MAX_PAYLOAD_CHARS) invalid('That payload is too large to publish from here')
  if (payloadEncoding !== 'string' && payloadEncoding !== 'base64')
    invalid('The payload is text or base64')
  return {
    connectionId,
    vhost,
    writable: allowed,
    request: {
      exchange: brokerString(request.exchange, 'exchange', true),
      routingKey: brokerString(request.routingKey, 'routing key', true),
      payload,
      payloadEncoding,
      properties: validateProperties(request.properties),
    },
  }
}

const QUEUE_TYPES = ['classic', 'quorum', 'stream'] as const

export function validateDeclareQueue(input: unknown): {
  connectionId: string
  vhost: string
  writable: boolean
  request: DeclareQueueRequest
} {
  const { connectionId, vhost, writable: allowed } = validateBrokerWrite(input, null)
  const request = (input as { request?: unknown }).request
  if (!isRecord(request)) invalid('Describe the queue')
  if (!QUEUE_TYPES.includes(request.type as never))
    invalid('A queue is classic, quorum or a stream')
  return {
    connectionId,
    vhost,
    writable: allowed,
    request: {
      name: brokerString(request.name, 'name'),
      type: request.type as DeclareQueueRequest['type'],
      durable: request.durable === true,
      autoDelete: request.autoDelete === true,
      arguments: brokerArguments(request.arguments, 'arguments'),
    },
  }
}

export function validateDeclareExchange(input: unknown): {
  connectionId: string
  vhost: string
  writable: boolean
  request: DeclareExchangeRequest
} {
  const { connectionId, vhost, writable: allowed } = validateBrokerWrite(input, null)
  const request = (input as { request?: unknown }).request
  if (!isRecord(request)) invalid('Describe the exchange')
  return {
    connectionId,
    vhost,
    writable: allowed,
    request: {
      name: brokerString(request.name, 'name'),
      type: brokerString(request.type, 'type'),
      durable: request.durable === true,
      autoDelete: request.autoDelete === true,
      internal: request.internal === true,
      arguments: brokerArguments(request.arguments, 'arguments'),
    },
  }
}

function destinationType(value: unknown): 'queue' | 'exchange' {
  if (value !== 'queue' && value !== 'exchange') invalid('A binding goes to a queue or an exchange')
  return value
}

export function validateBind(input: unknown): {
  connectionId: string
  vhost: string
  writable: boolean
  request: BindRequest
} {
  const { connectionId, vhost, writable: allowed } = validateBrokerWrite(input, null)
  const request = (input as { request?: unknown }).request
  if (!isRecord(request)) invalid('Describe the binding')
  const source = brokerString(request.source, 'source')
  if (source === '') invalid('The default exchange can’t be bound')
  return {
    connectionId,
    vhost,
    writable: allowed,
    request: {
      source,
      destination: brokerString(request.destination, 'destination'),
      destinationType: destinationType(request.destinationType),
      routingKey: brokerString(request.routingKey, 'routing key', true),
      arguments: brokerArguments(request.arguments, 'arguments'),
    },
  }
}

export function validateUnbind(input: unknown): {
  connectionId: string
  vhost: string
  writable: boolean
  request: UnbindRequest
} {
  const { connectionId, vhost, writable: allowed } = validateBrokerWrite(input, null)
  const request = (input as { request?: unknown }).request
  if (!isRecord(request)) invalid('Name the binding')
  return {
    connectionId,
    vhost,
    writable: allowed,
    request: {
      source: brokerString(request.source, 'source'),
      destination: brokerString(request.destination, 'destination'),
      destinationType: destinationType(request.destinationType),
      propertiesKey: brokerString(request.propertiesKey, 'propertiesKey'),
    },
  }
}
