import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { CoreEvents, type CoreApi } from '@shared/api'
import {
  secretKey,
  summarize,
  type ConnectionConfig,
  type ConnectionSummary,
  type ConnectionSecrets,
  type SecretName,
} from '@shared/connection'
import { ENVIRONMENT_POLICIES } from '@shared/environment'
import { exportFormat } from '@shared/export'
import { CONNECTION_SOURCES, type ConnectionSource } from '@shared/connection-sources'
import {
  IMPORT_FORMATS,
  inferColumnType,
  type ImportFormat,
  type ImportSource,
} from '@shared/import'
import type { DriverSession } from '@shared/driver'
import { RpcError, type HandlerContext, type RpcHandlers } from '@shared/rpc'
import { DOCUMENT_RESIDENT_ROWS } from '@shared/mongo/documents'
import { describeCommand, isReadSafe, tokenize } from '@shared/redis/command'
import { scriptLanguageOf } from '@shared/scripts'
import { classifyStatement, maskSql, splitStatements } from '@shared/sql'
import type { DriverRegistry } from './drivers/registry'
import { defaultSourcePath, readConnections } from './dbeaver/sources'
import { dumpDatabase } from './export/dump'
import { openRecords } from './import/records'
import { importRows } from './import/run'
import { exportQuery, fileSink } from './export/export-query'
import { RunRecorder } from './history/recorder'
import { HistoryStore } from './history/store'
import type { HostFiles } from './host-files'
import { runStatements, type RowAllowance } from './query/runner'
import type { SpillStore } from './results/spill'
import { ScriptStore } from './scripts/store'
import type { SecretsClient } from './secrets'
import { testConnection } from './session/connection-test'
import type { SessionManager } from './session/manager'
import { sqliteVersion } from './storage/database'
import { ConnectionsRepo } from './storage/connections-repo'
import { SettingsRepo } from './storage/settings-repo'
import {
  validateConsoleId,
  validateEdit,
  validateExec,
  validateMemory,
  validateRedisKey,
  validateRedisTarget,
  validateScan,
  validateStreamGroup,
  validateTask,
  validateValueRequest,
} from './validate-redis'
import {
  validateBind,
  validateBrokerObject,
  validateBrokerTarget,
  validateBrokerWrite,
  validateConnectionConfig,
  validateDeclareExchange,
  validateDeclareQueue,
  validateDocumentBatch,
  validatePeek,
  validatePublish,
  validateUnbind,
  validateEditBatch,
  validateDumpParams,
  validateExportParams,
  validateHistoryQuery,
  validateNewScript,
  validateOpenScripts,
  validateRunParams,
  validateScriptId,
  validateScriptSave,
  validateScriptUpdate,
  validateSampleFields,
  validateSecrets,
  validateSettingsPatch,
  validateFetch,
  validateStats,
} from './validate'

/** Rows read for the preview and for guessing column types, and how many of them the preview shows. */
const INFERENCE_ROWS = 2000
const PREVIEW_ROWS = 20

/** The file and how to read it, checked. */
function validateImportInput(input: unknown): { path: string; source: ImportSource } {
  const { path, source } = (input ?? {}) as { path?: unknown; source?: Partial<ImportSource> }
  if (typeof path !== 'string' || path === '') throw new RpcError('INVALID_INPUT', 'Choose a file.')
  if (!source || !IMPORT_FORMATS.includes(source.format as ImportFormat)) {
    throw new RpcError('INVALID_INPUT', 'Unknown file format.')
  }
  const delimiter = source.delimiter ?? ','
  if (![',', ';', '\t', '|'].includes(delimiter))
    throw new RpcError('INVALID_INPUT', 'Unknown separator.')
  return {
    path,
    source: { format: source.format!, delimiter, header: source.header !== false },
  }
}

const SECRET_NAMES: readonly SecretName[] = ['password', 'sshPassword', 'sshPassphrase']

/** Errors after which a session cannot be reused; the next use opens a fresh one. */
const DEAD_SESSION_CODES = new Set([
  'CONNECTION_CLOSED',
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'ECONNABORTED',
])

export interface CoreDeps {
  db: DatabaseSync
  secrets: SecretsClient
  drivers: DriverRegistry
  sessions: SessionManager
  notify: (event: string, payload?: unknown) => void
  info: { version: string; dataDir: string }
  /** Where script files live. */
  scriptsDir: string
  files: HostFiles
  /** Holds the rows of big results that the window does not keep. */
  spill: SpillStore
}

/** Every method the renderer can call. Inputs are validated here because they cross a process boundary. */
export function createCoreHandlers(deps: CoreDeps): RpcHandlers<CoreApi> {
  const connections = new ConnectionsRepo(deps.db)
  const settings = new SettingsRepo(deps.db)
  const { secrets, drivers, sessions, files, spill } = deps
  const scripts = new ScriptStore(deps.db, deps.scriptsDir, { trash: (path) => files.trash(path) })
  const history = new HistoryStore(deps.db)
  /** Files this process wrote for an export, so "show in folder" can only point at those. */
  const exportedFiles = new Set<string>()
  /** Files the user chose to import, which are the only ones an import may read. */
  const importFiles = new Set<string>()
  /** Connection files this process read (source and path), the only ones an import may be made from. */
  const importSourcePaths = new Set<string>()

  // Many statements can finish in a burst; windows hear about them once.
  let historyTimer: ReturnType<typeof setTimeout> | undefined
  const announceHistory = (): void => {
    if (historyTimer) return
    historyTimer = setTimeout(() => {
      historyTimer = undefined
      deps.notify(CoreEvents.historyChanged)
    }, 250)
    historyTimer.unref?.()
  }

  /** Which connection each script tab belongs to, and the allowances of runs in flight. */
  const scriptConnections = new Map<string, string>()
  const watchedScripts = new Set<string>()
  const runs = new Map<string, Map<number, RowAllowance>>()

  const connectionKey = (id: string): string => `conn:${id}`
  const scriptKey = (id: string): string => `script:${id}`

  async function loadConnection(
    id: string,
  ): Promise<{ config: ConnectionConfig; secrets: ConnectionSecrets }> {
    const config = connections.get(id)
    if (!config) throw new RpcError('NOT_FOUND', 'This connection no longer exists.')
    return { config, secrets: await withSavedSecrets(id, {}) }
  }

  /** Connections whose server has been explained to the person already, so it is said once. */
  const announced = new Set<string>()

  /**
   * A server that can't hold a connection read-only by itself (MySQL before 5.6.5, and MongoDB, which has no
   * such mode) is guarded by the driver, which refuses writes instead. This says so once, because it is
   * a weaker promise.
   */
  function explainWeakReadOnly(
    ctx: HandlerContext,
    config: ConnectionConfig,
    session: DriverSession,
  ): void {
    if (!session.info.readOnly || session.info.readOnlyEnforcedByServer !== false) return
    if (announced.has(config.id)) return
    announced.add(config.id)
    ctx.emit(CoreEvents.notice, {
      message:
        config.engine === 'rabbitmq'
          ? `RabbitMQ can’t hold a connection read-only, so DBIDE keeps every change (publish, purge, create, delete) locked in ${config.name} until you unlock it. For a hard guarantee, connect with a user that has only read permissions.`
          : config.engine === 'redis'
            ? `Redis can’t hold a connection read-only, so DBIDE keeps every change (editing keys, deleting, the console’s write commands) locked in ${config.name} until you unlock it. For a hard guarantee, connect with an ACL user limited to read commands (for example +@read ~*).`
            : config.engine === 'mongodb'
              ? `MongoDB can’t hold a connection read-only, so DBIDE checks every command before sending it and blocks the ones that change data. For a hard guarantee, connect with a user that only has the read role.`
              : `${config.name} runs MySQL ${session.info.serverVersion}, which can’t enforce read-only itself. DBIDE blocks writes before sending them, but it can’t see a stored function that changes data when a SELECT calls it.`,
    })
  }

  /** The broker side of a connection's shared session. */
  async function brokerOf(connectionId: string, ctx: HandlerContext) {
    const { session } = await connectionSession(connectionId, ctx)
    if (!session.broker)
      throw new RpcError('NOT_SUPPORTED', 'This connection is not a message broker.')
    return session.broker
  }

  /** A call to the broker. A session that died is dropped, so the next call reconnects. */
  async function viaBroker<T>(
    connectionId: string,
    ctx: HandlerContext,
    call: (broker: NonNullable<DriverSession['broker']>) => Promise<T>,
  ): Promise<T> {
    const broker = await brokerOf(connectionId, ctx)
    try {
      return await call(broker)
    } catch (error) {
      await dropIfDead(connectionKey(connectionId), error)
      throw error
    }
  }

  /** The Redis side of a connection's shared session. */
  async function redisOf(connectionId: string, ctx: HandlerContext) {
    const { session } = await connectionSession(connectionId, ctx)
    if (!session.redis)
      throw new RpcError('NOT_SUPPORTED', 'This connection is not a Redis server.')
    return session.redis
  }

  /** A call to Redis. A session that died is dropped, so the next call reconnects. */
  async function viaRedis<T>(
    connectionId: string,
    ctx: HandlerContext,
    call: (redis: NonNullable<DriverSession['redis']>) => Promise<T>,
  ): Promise<T> {
    const redis = await redisOf(connectionId, ctx)
    try {
      return await call(redis)
    } catch (error) {
      await dropIfDead(connectionKey(connectionId), error)
      throw error
    }
  }

  /** Progress events for a long Redis task, at most one every 100 ms, and always the last. */
  function progressEmitter(ctx: HandlerContext, taskId: string) {
    let last = 0
    let pending: { examined: number; matched: number; deleted: number } | null = null
    const send = (progress: { examined: number; matched: number; deleted: number }): void => {
      last = Date.now()
      pending = null
      ctx.emit(CoreEvents.redisProgress, { taskId, ...progress })
    }
    return {
      report(progress: { examined: number; matched: number; deleted: number }) {
        if (Date.now() - last >= 100) send(progress)
        else pending = progress
      },
      flush() {
        if (pending) send(pending)
      },
    }
  }

  /** Which console belongs to which connection, so editing or deleting the connection closes its consoles. */
  const consoleConnections = new Map<string, string>()
  const watchedConsoles = new Set<string>()
  const consoleKey = (id: string): string => `console:${id}`

  /** Changes need the tab to have writes unlocked, as running a statement does. */
  function requireWritable(allowed: boolean): void {
    if (!allowed) {
      throw new RpcError('READ_ONLY', 'This tab is read-only. Unlock writes to make this change.')
    }
  }

  /** The shared session that serves the tree and autocomplete. Opened on first use. */
  async function connectionSession(id: string, ctx: HandlerContext) {
    const { config, secrets: saved } = await loadConnection(id)
    const open = await sessions.open(connectionKey(id), config, saved, ctx.signal, {
      readOnly: ENVIRONMENT_POLICIES[config.environment].readOnlyByDefault,
    })
    explainWeakReadOnly(ctx, config, open.session)
    return open
  }

  /** Drops a session that died, so the next request reconnects instead of failing forever. */
  async function dropIfDead(key: string, error: unknown): Promise<void> {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && DEAD_SESSION_CODES.has(code)) await sessions.close(key)
  }

  /** Settings changed or the connection was removed: every session using it is stale. */
  async function closeSessionsOf(connectionId: string): Promise<void> {
    announced.delete(connectionId)
    await sessions.close(connectionKey(connectionId))
    for (const [consoleId, owner] of consoleConnections) {
      if (owner !== connectionId) continue
      await sessions.close(consoleKey(consoleId))
      consoleConnections.delete(consoleId)
    }
    for (const [scriptId, owner] of scriptConnections) {
      if (owner !== connectionId) continue
      await sessions.close(scriptKey(scriptId))
      scriptConnections.delete(scriptId)
    }
  }

  async function requireSecretStore(): Promise<void> {
    if (!(await secrets.available())) {
      throw new RpcError(
        'SECRETS_UNAVAILABLE',
        'No system keychain is available, so passwords can’t be stored safely. Install or unlock a keyring (GNOME Keyring or KWallet) and try again.',
      )
    }
  }

  /** Secrets typed in the form win; anything left blank falls back to what is already saved. */
  async function withSavedSecrets(
    id: string,
    typed: ConnectionSecrets,
  ): Promise<ConnectionSecrets> {
    const merged: ConnectionSecrets = { ...typed }
    if (!(await secrets.available())) return merged
    for (const name of SECRET_NAMES) {
      if (merged[name] !== undefined && merged[name] !== '') continue
      const saved = await secrets.get(secretKey(id, name))
      if (saved !== null) merged[name] = saved
    }
    return merged
  }

  return {
    'app.info': () => ({
      version: deps.info.version,
      electron: process.versions.electron ?? 'n/a',
      node: process.versions.node,
      sqlite: sqliteVersion(deps.db),
      dataDir: deps.info.dataDir,
      scriptsDir: deps.scriptsDir,
      platform: process.platform,
    }),

    'engines.list': () => drivers.descriptors(),

    'settings.get': () => settings.getAll(),

    'settings.set': async (patch) => settings.set(validateSettingsPatch(patch)),

    'connections.list': () => connections.list(),

    'connections.get': async ({ id }) => {
      const config = connections.get(id)
      if (!config) return null
      const hasPassword = (await secrets.available())
        ? (await secrets.get(secretKey(id, 'password'))) !== null
        : false
      return { config, hasPassword }
    },

    'connections.save': async (params) => {
      const config = validateConnectionConfig(params.config)
      const typed = validateSecrets(params.secrets)

      const toStore = SECRET_NAMES.filter((name) => (typed[name] ?? '') !== '')
      if (toStore.length > 0) await requireSecretStore()
      for (const name of toStore) await secrets.set(secretKey(config.id, name), typed[name]!)

      connections.save(config)
      await closeSessionsOf(config.id)
      deps.notify(CoreEvents.connectionsChanged)
      return summarize(config)
    },

    'connectionImport.scan': async (input) => {
      const { source, choose, text } = (input ?? {}) as {
        source?: ConnectionSource
        choose?: boolean
        text?: string
      }
      const info = CONNECTION_SOURCES.find((s) => s.value === source)
      if (!info) throw new RpcError('INVALID_INPUT', 'Unknown source.')
      if (info.input === 'text' && (typeof text !== 'string' || text.length > 200_000)) {
        throw new RpcError('INVALID_INPUT', 'Paste the connection URLs.')
      }
      let path: string | null = null
      if (info.input === 'file') {
        if (choose === true) {
          ;[path = null] = await files.chooseOpenPaths({
            filterName: `${info.label} connections`,
            extensions: info.extensions,
          })
        } else {
          path = defaultSourcePath(info.value)
        }
      }
      const none = { path: null, connections: [], skipped: [], hasCredentials: false }
      if (info.input === 'file' && path === null) return none
      const read = await readConnections(info.value, { path, text })
      if (!read) return none
      if (path !== null) importSourcePaths.add(`${info.value}\0${path}`)
      return {
        path,
        connections: read.connections.map((c) => ({
          ...c,
          username: read.logins[c.sourceId]?.connection?.user || c.username,
          ssh: c.ssh
            ? { ...c.ssh, username: read.logins[c.sourceId]?.ssh?.user || c.ssh.username }
            : null,
        })),
        skipped: read.skipped,
        hasCredentials: read.hasCredentials,
      }
    },

    'connectionImport.run': async (input) => {
      const { source, path, text, ids, passwords } = (input ?? {}) as Record<string, unknown>
      const info = CONNECTION_SOURCES.find((s) => s.value === source)
      if (!info) throw new RpcError('INVALID_INPUT', 'Unknown source.')
      if (
        info.input === 'file' &&
        (typeof path !== 'string' || !importSourcePaths.has(`${info.value}\0${path}`))
      ) {
        throw new RpcError('INVALID_INPUT', 'Look for the connections first.')
      }
      if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) {
        throw new RpcError('INVALID_INPUT', 'Choose which connections to import.')
      }
      const read = await readConnections(info.value, {
        path: typeof path === 'string' ? path : null,
        text: typeof text === 'string' ? text : '',
      })
      if (!read) throw new RpcError('NOT_FOUND', 'Those connections can’t be read any more.')
      const chosen = new Set(ids as string[])
      const taken = new Set(connections.list().map((c) => c.name.toLowerCase()))
      const imported: ConnectionSummary[] = []
      for (const source of read.connections.filter((c) => chosen.has(c.sourceId))) {
        const login = read.logins[source.sourceId]
        let name = source.name
        for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${source.name} (${n})`
        taken.add(name.toLowerCase())
        const id = randomUUID()
        const ssh = source.ssh
        const config = validateConnectionConfig({
          id,
          name,
          engine: source.engine,
          environment: source.environment,
          ...(source.folder ? { folder: source.folder } : {}),
          host: source.host,
          port: source.port,
          ...(login?.connection?.user || source.username
            ? { username: login?.connection?.user || source.username }
            : {}),
          ...(source.database ? { database: source.database } : {}),
          tls: { enabled: source.tls, allowInvalidCertificates: false },
          ...(ssh
            ? {
                ssh: {
                  enabled: true,
                  host: ssh.host,
                  port: ssh.port,
                  username: login?.ssh?.user || ssh.username,
                  auth: ssh.auth,
                  ...(ssh.keyPath ? { privateKeyPath: ssh.keyPath } : {}),
                },
              }
            : {}),
          options: {},
        })
        const typed: ConnectionSecrets = {}
        if (passwords === true) {
          if (login?.connection?.password) typed.password = login.connection.password
          if (ssh?.auth === 'password' && login?.ssh?.password)
            typed.sshPassword = login.ssh.password
        }
        const toStore = SECRET_NAMES.filter((n) => (typed[n] ?? '') !== '')
        if (toStore.length > 0) await requireSecretStore()
        for (const n of toStore) await secrets.set(secretKey(config.id, n), typed[n]!)
        connections.save(config)
        imported.push(summarize(config))
      }
      deps.notify(CoreEvents.connectionsChanged)
      return { imported }
    },

    'connections.delete': async ({ id }) => {
      await closeSessionsOf(id)
      connections.delete(id)
      // Its scripts stay, waiting to be moved to another connection.
      scripts.detachConnection(id)
      deps.notify(CoreEvents.scriptsChanged)
      if (await secrets.available()) {
        for (const name of SECRET_NAMES) await secrets.delete(secretKey(id, name))
      }
      deps.notify(CoreEvents.connectionsChanged)
    },

    'connections.test': async (params, { signal }) => {
      const config = validateConnectionConfig(params.config)
      const typed = validateSecrets(params.secrets)
      return testConnection(config, await withSavedSecrets(config.id, typed), { drivers, signal })
    },

    'sessions.open': async ({ connectionId }, ctx) =>
      (await connectionSession(connectionId, ctx)).session.info,

    'sessions.close': async ({ connectionId }) => closeSessionsOf(connectionId),

    'tree.children': async ({ connectionId, parent }, ctx) => {
      const { session } = await connectionSession(connectionId, ctx)
      try {
        return await session.children(parent, ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'schema.completion': async ({ connectionId, database }, ctx) => {
      const { session } = await connectionSession(connectionId, ctx)
      try {
        return (await session.completionSchema?.(database, ctx.signal)) ?? {}
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'broker.overview': async (input, ctx) => {
      const { connectionId } = validateBrokerTarget({ ...(input as object), vhost: '/' })
      return viaBroker(connectionId, ctx, (broker) => broker.overview(ctx.signal))
    },

    'broker.listing': async (input, ctx) => {
      const { connectionId, vhost } = validateBrokerTarget(input)
      return viaBroker(connectionId, ctx, (broker) => broker.listing(vhost, ctx.signal))
    },

    'broker.queue': async (input, ctx) => {
      const { connectionId, vhost, name } = validateBrokerObject(input, 'name')
      return viaBroker(connectionId, ctx, (broker) => broker.queue(vhost, name, ctx.signal))
    },

    'broker.exchange': async (input, ctx) => {
      const { connectionId, vhost, name } = validateBrokerObject(input, 'name')
      return viaBroker(connectionId, ctx, (broker) => broker.exchange(vhost, name, ctx.signal))
    },

    'broker.peek': async (input, ctx) => {
      const { connectionId, vhost, queue, count, truncate } = validatePeek(input)
      return viaBroker(connectionId, ctx, (broker) =>
        broker.peek(vhost, queue, { count, truncate }, ctx.signal),
      )
    },

    'broker.publish': async (input, ctx) => {
      const { connectionId, vhost, writable, request } = validatePublish(input)
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) => broker.publish(vhost, request, ctx.signal))
    },

    'broker.purge': async (input, ctx) => {
      const { connectionId, vhost, writable, name } = validateBrokerWrite(input, 'queue')
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) => broker.purge(vhost, name, ctx.signal))
    },

    'broker.declareQueue': async (input, ctx) => {
      const { connectionId, vhost, writable, request } = validateDeclareQueue(input)
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) =>
        broker.declareQueue(vhost, request, ctx.signal),
      )
    },

    'broker.deleteQueue': async (input, ctx) => {
      const { connectionId, vhost, writable, name } = validateBrokerWrite(input, 'name')
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) => broker.deleteQueue(vhost, name, ctx.signal))
    },

    'broker.declareExchange': async (input, ctx) => {
      const { connectionId, vhost, writable, request } = validateDeclareExchange(input)
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) =>
        broker.declareExchange(vhost, request, ctx.signal),
      )
    },

    'broker.deleteExchange': async (input, ctx) => {
      const { connectionId, vhost, writable, name } = validateBrokerWrite(input, 'name')
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) =>
        broker.deleteExchange(vhost, name, ctx.signal),
      )
    },

    'broker.bind': async (input, ctx) => {
      const { connectionId, vhost, writable, request } = validateBind(input)
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) => broker.bind(vhost, request, ctx.signal))
    },

    'broker.unbind': async (input, ctx) => {
      const { connectionId, vhost, writable, request } = validateUnbind(input)
      requireWritable(writable)
      return viaBroker(connectionId, ctx, (broker) => broker.unbind(vhost, request, ctx.signal))
    },

    'redis.info': async (input, ctx) => {
      const { connectionId } = validateRedisTarget({ ...(input as object), db: 0 })
      return viaRedis(connectionId, ctx, (redis) => redis.info(ctx.signal))
    },

    'redis.scan': async (input, ctx) => {
      const { connectionId, ...request } = validateScan(input)
      return viaRedis(connectionId, ctx, (redis) => redis.scan(request, ctx.signal))
    },

    'redis.key': async (input, ctx) => {
      const { connectionId, db, key } = validateRedisKey(input)
      return viaRedis(connectionId, ctx, (redis) => redis.key(db, key, ctx.signal))
    },

    'redis.value': async (input, ctx) => {
      const { connectionId, request } = validateValueRequest(input)
      return viaRedis(connectionId, ctx, (redis) => redis.value(request, ctx.signal))
    },

    'redis.memory': async (input, ctx) => {
      const { connectionId, db, keys } = validateMemory(input)
      return viaRedis(connectionId, ctx, (redis) => redis.memory(db, keys, ctx.signal))
    },

    'redis.streamInfo': async (input, ctx) => {
      const { connectionId, db, key } = validateRedisKey(input)
      return viaRedis(connectionId, ctx, (redis) => redis.streamInfo(db, key, ctx.signal))
    },

    'redis.streamGroup': async (input, ctx) => {
      const { connectionId, db, key, group } = validateStreamGroup(input)
      return viaRedis(connectionId, ctx, (redis) => redis.streamGroup(db, key, group, ctx.signal))
    },

    'redis.edit': async (input, ctx) => {
      const { connectionId, db, key } = validateRedisKey(input)
      const body = input as { writable?: unknown; edit?: unknown }
      requireWritable(body.writable === true)
      const edit = validateEdit(body.edit)
      return viaRedis(connectionId, ctx, (redis) => redis.edit(db, key, edit, ctx.signal))
    },

    'redis.count': async (input, ctx) => {
      const { connectionId, db, pattern, type, taskId } = validateTask(input)
      const progress = progressEmitter(ctx, taskId)
      try {
        return await viaRedis(connectionId, ctx, (redis) =>
          redis.count(db, pattern, type, ctx.signal, (p) => progress.report(p)),
        )
      } finally {
        progress.flush()
      }
    },

    'redis.deleteMatching': async (input, ctx) => {
      const { connectionId, db, pattern, type, taskId, writable } = validateTask(input)
      requireWritable(writable)
      const progress = progressEmitter(ctx, taskId)
      try {
        return await viaRedis(connectionId, ctx, (redis) =>
          redis.deleteMatching(db, pattern, type, ctx.signal, (p) => progress.report(p)),
        )
      } finally {
        progress.flush()
      }
    },

    'redis.exec': async (input, ctx) => {
      const { connectionId, consoleId, writable, line } = validateExec(input)
      const parsed = tokenize(line)
      if (!parsed.ok) throw new RpcError('SYNTAX', parsed.error)
      if (parsed.args.length === 0) throw new RpcError('INVALID_INPUT', 'Type a command to run.')

      // The console enforces its own lock: a command that may change data never leaves while it is locked.
      const command = describeCommand(parsed.args)
      if (!writable && !isReadSafe(command.kind)) {
        throw new RpcError(
          'READ_ONLY',
          command.kind === 'unknown'
            ? `The console is read-only, and DBIDE doesn’t know whether ${command.name || 'that command'} changes data. Unlock writes in the toolbar to run it.`
            : `The console is read-only, so ${command.name} can’t run. Unlock writes in the toolbar to continue.`,
        )
      }

      const { config, secrets: saved } = await loadConnection(connectionId)
      const key = consoleKey(consoleId)
      consoleConnections.set(consoleId, connectionId)
      const open = await sessions.open(key, config, saved, ctx.signal, { readOnly: !writable })
      // A console's connection lives as long as the window that opened it.
      if (!watchedConsoles.has(consoleId)) {
        watchedConsoles.add(consoleId)
        ctx.portSignal.addEventListener(
          'abort',
          () => {
            watchedConsoles.delete(consoleId)
            consoleConnections.delete(consoleId)
            void sessions.close(key)
          },
          { once: true },
        )
      }
      if (open.session.info.readOnly === writable) await open.session.setReadOnly?.(!writable)
      explainWeakReadOnly(ctx, config, open.session)
      if (!open.session.redis) {
        throw new RpcError('NOT_SUPPORTED', 'This connection is not a Redis server.')
      }
      try {
        return await open.session.redis.exec(parsed.args, ctx.signal)
      } catch (error) {
        // A command that was cancelled took its connection with it.
        if (ctx.signal.aborted) await sessions.close(key)
        await dropIfDead(key, error)
        throw error
      }
    },

    'redis.consoleClose': async (input) => {
      const consoleId = validateConsoleId(input)
      consoleConnections.delete(consoleId)
      watchedConsoles.delete(consoleId)
      await sessions.close(consoleKey(consoleId))
    },

    'schema.databases': async (input, ctx) => {
      const { connectionId } = validateRedisTarget({ ...(input as object), db: 0 })
      const { session } = await connectionSession(connectionId, ctx)
      if (!session.databaseNames) return []
      try {
        return await session.databaseNames(ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'schema.detail': async (input, ctx) => {
      const { connectionId, database } = (input ?? {}) as {
        connectionId?: unknown
        database?: unknown
      }
      if (
        typeof connectionId !== 'string' ||
        typeof database !== 'string' ||
        !connectionId ||
        !database
      ) {
        throw new RpcError('INVALID_INPUT', 'Name a connection and a database.')
      }
      const { session } = await connectionSession(connectionId, ctx)
      if (!session.schemaDetail) return { database, tables: [], foreignKeys: [] }
      try {
        return await session.schemaDetail(database, ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'schema.columns': async (input, ctx) => {
      const { connectionId, database, tables } = (input ?? {}) as {
        connectionId?: unknown
        database?: unknown
        tables?: unknown
      }
      if (
        typeof connectionId !== 'string' ||
        typeof database !== 'string' ||
        !connectionId ||
        !database ||
        !Array.isArray(tables) ||
        tables.length === 0 ||
        tables.length > 200 ||
        !tables.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 256)
      ) {
        throw new RpcError('INVALID_INPUT', 'Name a connection, a database and up to 200 tables.')
      }
      const { session } = await connectionSession(connectionId, ctx)
      if (!session.tableColumns) return { tables: [], foreignKeys: [] }
      try {
        return await session.tableColumns(database, tables as string[], ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'schema.fields': async (input, ctx) => {
      const { connectionId, database, collection } = validateSampleFields(input)
      const { session } = await connectionSession(connectionId, ctx)
      if (!session.sampleFields) return []
      try {
        return await session.sampleFields(database, collection, ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'query.run': async (input, ctx) => {
      const params = validateRunParams(input)
      const { config, secrets: saved } = await loadConnection(params.connectionId)
      const key = scriptKey(params.scriptId)
      scriptConnections.set(params.scriptId, params.connectionId)

      const recorder = new RunRecorder(
        history,
        {
          connectionId: config.id,
          connectionName: config.name,
          environment: config.environment,
          database: params.database,
          scriptId: params.scriptId,
        },
        { enabled: () => settings.getAll().recordHistory, onRecorded: announceHistory },
      )

      let open
      try {
        open = await sessions.open(key, config, saved, ctx.signal, { readOnly: params.readOnly })
      } catch (error) {
        const code =
          typeof (error as { code?: unknown } | null)?.code === 'string'
            ? (error as { code: string }).code
            : null
        const message = error instanceof Error ? error.message : String(error)
        ctx.emit(CoreEvents.queryEvent, {
          runId: params.runId,
          statement: 0,
          event: { type: 'error', code, message },
        })
        recorder.recordFailure(params.statements[0]!, code, message)
        return { outcome: 'error', statementsRun: 0 }
      }

      // What the script's earlier runs held is not shown anywhere any more.
      spill.dropOtherRuns(params.scriptId, params.runId)

      // A script's connection lives as long as the window that opened it.
      if (!watchedScripts.has(params.scriptId)) {
        watchedScripts.add(params.scriptId)
        ctx.portSignal.addEventListener(
          'abort',
          () => {
            watchedScripts.delete(params.scriptId)
            scriptConnections.delete(params.scriptId)
            spill.dropScript(params.scriptId)
            void sessions.close(key)
          },
          { once: true },
        )
      }

      if (open.session.info.readOnly !== params.readOnly) {
        await open.session.setReadOnly?.(params.readOnly)
      }
      explainWeakReadOnly(ctx, config, open.session)

      const allowances = new Map<number, RowAllowance>()
      runs.set(params.runId, allowances)
      try {
        const result = await runStatements({
          session: open.session,
          runId: params.runId,
          statements: params.statements,
          database: params.database,
          pageSize: params.pageSize,
          signal: ctx.signal,
          emit: (message) => {
            ctx.emit(CoreEvents.queryEvent, message)
            recorder.observe(message)
          },
          onAllowance: (statement, allowance) => allowances.set(statement, allowance),
          ...(config.engine === 'mongodb' ? { residentRows: DOCUMENT_RESIDENT_ROWS } : {}),
          spill: {
            append: (resultKey, first, rows) =>
              spill.append(
                { script: params.scriptId, run: params.runId, key: resultKey },
                first,
                rows,
              ),
          },
        })
        if (result.errorCode && DEAD_SESSION_CODES.has(result.errorCode)) {
          await sessions.close(key)
        }
        return { outcome: result.outcome, statementsRun: result.statementsRun }
      } finally {
        runs.delete(params.runId)
      }
    },

    'query.more': ({ runId, statement, rows }) => {
      runs.get(runId)?.get(statement)?.grant(rows)
    },

    'results.fetch': async (input) => {
      const { key, from, count } = validateFetch(input)
      return spill.fetch(key, from, count)
    },

    'results.stats': async (input) => {
      const { key, from, count, columns } = validateStats(input)
      const { totals, partial } = spill.totals(key, from, count, columns)
      return { ...totals, partial }
    },

    'tables.describe': async ({ connectionId, schema, table }, ctx) => {
      if (typeof schema !== 'string' || typeof table !== 'string' || !schema || !table) {
        throw new RpcError('INVALID_INPUT', 'Name a schema and a table.')
      }
      const { session } = await connectionSession(connectionId, ctx)
      if (!session.describeTable) {
        throw new RpcError('NOT_SUPPORTED', 'This engine can’t describe tables yet.')
      }
      try {
        return await session.describeTable(schema, table, ctx.signal)
      } catch (error) {
        await dropIfDead(connectionKey(connectionId), error)
        throw error
      }
    },

    'edits.apply': async ({ connectionId, scriptId, batch: input }, ctx) => {
      const batch = validateEditBatch(input)
      const { config, secrets: saved } = await loadConnection(connectionId)

      // The script that showed these rows decides whether writing is allowed.
      const script = sessions.peek(scriptKey(scriptId))
      if (!script) {
        throw new RpcError('NOT_FOUND', 'Run the query again before editing its rows.')
      }
      if (script.session.info.readOnly) {
        throw new RpcError('READ_ONLY', 'This script is read-only. Unlock writes to edit rows.')
      }

      // A private connection, so a transaction the user has open in the script is never touched.
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: false,
        signal: ctx.signal,
      })
      try {
        if (!session.applyEdits) {
          throw new RpcError('NOT_SUPPORTED', 'This engine can’t edit rows yet.')
        }
        return await session.applyEdits(batch, ctx.signal)
      } finally {
        await session.close()
      }
    },

    'documents.apply': async ({ connectionId, scriptId, batch: input }, ctx) => {
      const batch = validateDocumentBatch(input)
      const { config, secrets: saved } = await loadConnection(connectionId)

      // The script that showed these documents decides whether writing is allowed.
      const script = sessions.peek(scriptKey(scriptId))
      if (!script) {
        throw new RpcError('NOT_FOUND', 'Run the query again before editing its documents.')
      }
      if (script.session.info.readOnly) {
        throw new RpcError(
          'READ_ONLY',
          'This script is read-only. Unlock writes to edit documents.',
        )
      }

      // A private connection, so a change never waits behind a result the script is still streaming.
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: false,
        signal: ctx.signal,
      })
      try {
        if (!session.applyDocumentEdits) {
          throw new RpcError('NOT_SUPPORTED', 'This engine can’t edit documents.')
        }
        return await session.applyDocumentEdits(batch, ctx.signal)
      } finally {
        await session.close()
      }
    },

    'scripts.setReadOnly': async ({ scriptId, readOnly }) => {
      if (typeof scriptId !== 'string' || typeof readOnly !== 'boolean') {
        throw new RpcError('INVALID_INPUT', 'Name a script and say whether it is read-only.')
      }
      // A script that has not run yet has no session; its first run applies the lock.
      const open = sessions.peek(scriptKey(scriptId))
      if (open && open.session.info.readOnly !== readOnly) {
        await open.session.setReadOnly?.(readOnly)
      }
    },

    'scripts.close': async ({ scriptId }) => {
      scriptConnections.delete(scriptId)
      watchedScripts.delete(scriptId)
      spill.dropScript(scriptId)
      await sessions.close(scriptKey(scriptId))
    },

    'scripts.list': () => scripts.list(),

    'scripts.create': async (input) => {
      const params = validateNewScript(input)
      // What the script is written in follows from the connection it runs on.
      const engine = params.connectionId ? connections.get(params.connectionId)?.engine : undefined
      const created = await scripts.create({
        ...params,
        ...(engine ? { language: scriptLanguageOf(engine) } : {}),
      })
      deps.notify(CoreEvents.scriptsChanged)
      return created
    },

    'scripts.read': async (input) => scripts.read(validateScriptId(input)),

    'scripts.save': async (input) => {
      const { id, content, label } = validateScriptSave(input)
      return scripts.save(id, content, label)
    },

    'scripts.update': async (input) => {
      const { id, ...patch } = validateScriptUpdate(input)
      const updated = await scripts.update(id, patch)
      deps.notify(CoreEvents.scriptsChanged)
      return updated
    },

    'scripts.rename': async (input) => {
      const id = validateScriptId(input)
      const name = (input as { name?: unknown }).name
      if (typeof name !== 'string') throw new RpcError('INVALID_INPUT', 'Give the script a name.')
      const renamed = await scripts.rename(id, name)
      deps.notify(CoreEvents.scriptsChanged)
      return renamed
    },

    'scripts.duplicate': async (input) => {
      const copy = await scripts.duplicate(validateScriptId(input))
      deps.notify(CoreEvents.scriptsChanged)
      return copy
    },

    'scripts.delete': async (input) => {
      const id = validateScriptId(input)
      scriptConnections.delete(id)
      watchedScripts.delete(id)
      spill.dropScript(id)
      await sessions.close(scriptKey(id))
      await scripts.remove(id)
      deps.notify(CoreEvents.scriptsChanged)
    },

    'scripts.import': async () => {
      const paths = await files.chooseOpenPaths({
        filterName: 'Script files',
        extensions: ['sql', 'mongodb', 'js', 'txt'],
      })
      if (paths.length === 0) return { imported: [], failed: [] }
      const result = await scripts.importFiles(paths)
      if (result.imported.length > 0) deps.notify(CoreEvents.scriptsChanged)
      return result
    },

    'scripts.reveal': async (input) => {
      const id = (input as { id?: unknown } | null)?.id
      await files.reveal(
        id === null || id === undefined ? scripts.dir : scripts.scriptPath(validateScriptId(input)),
      )
    },

    'scripts.setOpen': async (input) => {
      const { ids, active } = validateOpenScripts(input)
      scripts.setOpen(ids, active)
    },

    'scripts.history': async (input) => scripts.history(validateScriptId(input)),

    'scripts.revision': async (input) => {
      const revisionId = (input as { revisionId?: unknown }).revisionId
      if (typeof revisionId !== 'number' || !Number.isInteger(revisionId)) {
        throw new RpcError('INVALID_INPUT', 'Pick a version.')
      }
      return scripts.revision(validateScriptId(input), revisionId)
    },

    'history.list': async (input) => history.list(validateHistoryQuery(input)),

    'history.delete': async ({ id }) => {
      if (typeof id !== 'number' || !Number.isInteger(id)) {
        throw new RpcError('INVALID_INPUT', 'Pick an entry.')
      }
      history.delete(id)
      deps.notify(CoreEvents.historyChanged)
    },

    'history.clear': async (input) => {
      const connectionId = (input as { connectionId?: unknown } | null)?.connectionId
      if (connectionId !== undefined && typeof connectionId !== 'string') {
        throw new RpcError('INVALID_INPUT', 'Pick a connection.')
      }
      history.clear(connectionId)
      deps.notify(CoreEvents.historyChanged)
    },

    'export.run': async (input, ctx) => {
      const params = validateExportParams(input)

      // Only a query that reads can be exported, and it runs on a connection that can't write.
      const statements = splitStatements(params.sql)
      if (statements.length !== 1) {
        throw new RpcError('INVALID_INPUT', 'Export one statement at a time.')
      }
      const sql = statements[0]!.text
      if (
        classifyStatement(sql).kind !== 'read' ||
        /\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(maskSql(sql))
      ) {
        throw new RpcError('NOT_A_QUERY', 'Only a query that reads data can be exported.')
      }

      const { config, secrets: saved } = await loadConnection(params.connectionId)
      const format = exportFormat(params.format)
      const path = await files.chooseSavePath({
        defaultName: params.compress ? `${params.fileName}.gz` : params.fileName,
        filterName: params.compress ? `${format.filter}, gzipped` : format.filter,
        extension: params.compress ? 'gz' : format.extension,
      })
      ctx.signal.throwIfAborted()
      if (path === null) return { status: 'dismissed' }

      const startedAt = performance.now()
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: true,
        signal: ctx.signal,
      })
      const sink = fileSink(path, { gzip: params.compress })
      try {
        const { rows, bytes } = await exportQuery({
          session,
          sql,
          database: params.database,
          format: params.format,
          options: params.options,
          sink,
          signal: ctx.signal,
          onProgress: (progress) =>
            ctx.emit(CoreEvents.exportProgress, { exportId: params.exportId, ...progress }),
        })
        await sink.finish()
        exportedFiles.add(path)
        return {
          status: 'saved',
          path,
          rows,
          // A compressed file is smaller than the text that went into it; the size shown is the file's.
          bytes: params.compress ? (await stat(path)).size : bytes,
          durationMs: Math.round(performance.now() - startedAt),
        }
      } catch (error) {
        await sink.abort()
        throw error
      } finally {
        await session.close()
      }
    },

    'import.choose': async () => {
      const [path] = await files.chooseOpenPaths({
        filterName: 'CSV, TSV or JSON',
        extensions: ['csv', 'tsv', 'tab', 'txt', 'json', 'ndjson', 'jsonl'],
      })
      if (!path) return null
      importFiles.add(path)
      return { path, name: basename(path), size: (await stat(path)).size }
    },

    'import.preview': async (input) => {
      const { path, source } = validateImportInput(input)
      if (!importFiles.has(path)) throw new RpcError('INVALID_INPUT', 'Choose the file first.')
      const records = await openRecords(path, source)
      const rows: (string | null)[][] = []
      let more = false
      for await (const row of records.rows()) {
        if (rows.length >= INFERENCE_ROWS) {
          more = true
          break
        }
        rows.push(row)
      }
      return {
        columns: records.columns,
        rows: rows.slice(0, PREVIEW_ROWS),
        types: records.columns.map((_, i) => inferColumnType(rows.map((r) => r[i] ?? null))),
        sampled: rows.length,
        more,
      }
    },

    'import.run': async (input, ctx) => {
      const params = (input ?? {}) as Record<string, unknown>
      const { path, source } = validateImportInput(input)
      if (!importFiles.has(path)) throw new RpcError('INVALID_INPUT', 'Choose the file first.')
      const { importId, connectionId, database, table } = params
      if (
        typeof importId !== 'string' ||
        typeof connectionId !== 'string' ||
        typeof database !== 'string' ||
        typeof table !== 'string' ||
        table === '' ||
        database === ''
      ) {
        throw new RpcError('INVALID_INPUT', 'Choose a database and a table.')
      }
      const create = params.create === null || params.create === undefined ? null : params.create
      const validName = (n: unknown): n is string =>
        typeof n === 'string' && n !== '' && n.length <= 64
      if (
        create !== null &&
        (!Array.isArray(create) ||
          create.length === 0 ||
          create.some(
            (c) =>
              !validName((c as { name?: unknown }).name) ||
              typeof (c as { type?: unknown }).type !== 'string' ||
              !/^[A-Za-z]+(\(\d+(,\d+)?\))?$/.test((c as { type: string }).type),
          ))
      ) {
        throw new RpcError('INVALID_INPUT', 'The new table’s columns are not valid.')
      }
      const mapping = params.mapping
      if (
        !Array.isArray(mapping) ||
        mapping.length === 0 ||
        mapping.some(
          (m) =>
            !Number.isInteger((m as { source?: unknown }).source) ||
            !validName((m as { target?: unknown }).target),
        )
      ) {
        throw new RpcError(
          'INVALID_INPUT',
          'Match at least one column of the file to a column of the table.',
        )
      }
      const { config, secrets: saved } = await loadConnection(connectionId)
      if (config.engine !== 'mysql') {
        throw new RpcError('UNSUPPORTED', 'Only a MySQL table can be imported into.')
      }
      if (ENVIRONMENT_POLICIES[config.environment].readOnlyByDefault && params.confirmed !== true) {
        throw new RpcError(
          'FORBIDDEN',
          `${config.name} is a ${ENVIRONMENT_POLICIES[config.environment].label.toLowerCase()} connection. Confirm that rows may be added to it.`,
        )
      }
      const records = await openRecords(path, source)
      const startedAt = performance.now()
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: false,
        signal: ctx.signal,
      })
      try {
        const { rows } = await importRows({
          session,
          database,
          table,
          create: create as { name: string; type: string }[] | null,
          mapping: mapping as { source: number; target: string }[],
          records,
          emptyAsNull: params.emptyAsNull === true,
          skipDuplicates: params.skipDuplicates === true,
          signal: ctx.signal,
          onProgress: (done) => ctx.emit(CoreEvents.importProgress, { importId, rows: done }),
        })
        return { rows, durationMs: Math.round(performance.now() - startedAt) }
      } finally {
        await session.close()
      }
    },

    'query.explain': async (input, ctx) => {
      const params = (input ?? {}) as Record<string, unknown>
      if (typeof params.connectionId !== 'string' || typeof params.sql !== 'string') {
        throw new RpcError('INVALID_INPUT', 'Pick a connection and a statement.')
      }
      const database = typeof params.database === 'string' ? params.database : null
      const analyze = params.analyze === true
      const statements = splitStatements(params.sql)
      if (statements.length !== 1) {
        throw new RpcError('INVALID_INPUT', 'Explain one statement at a time.')
      }
      const sql = statements[0]!.text
      // A plan of a change shows the same steps without running it; running one to time it is not allowed.
      const kind = classifyStatement(sql).kind
      if (kind !== 'read' && (analyze || kind !== 'write')) {
        throw new RpcError(
          'NOT_A_QUERY',
          analyze
            ? 'Only a query that reads data can be run to be timed.'
            : 'Only a query, or an INSERT, UPDATE or DELETE, has a plan.',
        )
      }
      if (/^\s*EXPLAIN\b/i.test(sql)) {
        throw new RpcError('INVALID_INPUT', 'That statement is already an EXPLAIN.')
      }
      const { config, secrets: saved } = await loadConnection(params.connectionId)
      if (config.engine !== 'mysql') {
        throw new RpcError('UNSUPPORTED', 'Only MySQL can show a query plan.')
      }
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: true,
        signal: ctx.signal,
      })
      const first = async (text: string): Promise<string | null> => {
        const results = session.execute(
          { text, ...(database ? { target: database } : {}) },
          ctx.signal,
        )
        const iterator = results[Symbol.asyncIterator]()
        try {
          for (;;) {
            const next = await iterator.next()
            if (next.done) return null
            if (next.value.kind === 'rows') {
              const cell = next.value.rows[0]?.[0]
              return cell instanceof Uint8Array
                ? new TextDecoder().decode(cell)
                : cell === null || cell === undefined
                  ? null
                  : String(cell)
            }
          }
        } finally {
          await iterator.return?.().catch(() => undefined)
        }
      }
      try {
        return analyze
          ? { json: null, text: await first(`EXPLAIN ANALYZE ${sql}`) }
          : { json: await first(`EXPLAIN FORMAT=JSON ${sql}`), text: null }
      } finally {
        await session.close()
      }
    },

    'export.dump': async (input, ctx) => {
      const params = validateDumpParams(input)
      const { config, secrets: saved } = await loadConnection(params.connectionId)
      if (config.engine !== 'mysql') {
        throw new RpcError('UNSUPPORTED', 'Only a MySQL database can be written as a SQL file.')
      }
      const path = await files.chooseSavePath({
        defaultName: params.compress ? `${params.fileName}.gz` : params.fileName,
        filterName: params.compress ? 'SQL, gzipped' : 'SQL file',
        extension: params.compress ? 'gz' : 'sql',
      })
      ctx.signal.throwIfAborted()
      if (path === null) return { status: 'dismissed' }

      const startedAt = performance.now()
      const session = await drivers.get(config.engine).connect({
        config,
        secrets: saved,
        endpoint: { host: config.host, port: config.port },
        readOnly: true,
        signal: ctx.signal,
      })
      const sink = fileSink(path, { gzip: params.compress })
      try {
        const detail = await session.schemaDetail?.(params.database, ctx.signal)
        if (!detail) throw new RpcError('UNSUPPORTED', 'This connection can’t list its tables.')
        const wanted = params.tables ? new Set(params.tables) : null
        const tables = detail.tables
          .filter((t) => !wanted || wanted.has(t.name))
          .map((t) => ({ name: t.name, view: t.view }))
        if (wanted && tables.length !== wanted.size) {
          throw new RpcError('NOT_FOUND', 'One of the tables is not in that database any more.')
        }
        const done = await dumpDatabase({
          session,
          database: params.database,
          tables,
          structure: params.structure,
          data: params.data,
          drop: params.drop,
          rowsPerInsert: params.rowsPerInsert,
          sink,
          signal: ctx.signal,
          onProgress: (progress) =>
            ctx.emit(CoreEvents.exportProgress, { exportId: params.exportId, ...progress }),
        })
        await sink.finish()
        exportedFiles.add(path)
        return {
          status: 'saved',
          path,
          rows: done.rows,
          bytes: params.compress ? (await stat(path)).size : done.bytes,
          durationMs: Math.round(performance.now() - startedAt),
          tables: done.tables,
        }
      } catch (error) {
        await sink.abort()
        throw error
      } finally {
        await session.close()
      }
    },

    'export.reveal': async ({ path }) => {
      if (typeof path !== 'string' || !exportedFiles.has(path)) {
        throw new RpcError('NOT_FOUND', 'That file wasn’t exported in this session.')
      }
      await files.reveal(path)
    },
  }
}
