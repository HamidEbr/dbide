import { CoreEvents } from '@shared/api'
import { DEFAULT_PAGE_SIZE, type QueryEventMessage } from '@shared/query'
import { RpcError } from '@shared/rpc'
import { coreLink } from '@/ipc/link'
import { useData } from '@/state/data'
import { useGuard } from '@/state/guard'
import { useScripts, type RunState, type ScriptRun, type StatementRun } from '@/state/scripts'
import { evaluateRun } from './guard'
import { RowStore, type RowBacking } from './grid/row-store'
import { pullLiveText, saveNow } from './persistence'

/** Which script each run belongs to, so streamed events find their tab. */
const routes = new Map<string, string>()
/** The call in flight for each script. Aborting it cancels the run. */
const controllers = new Map<string, AbortController>()

/** How long a cancelled run may take to report back before the UI stops waiting. */
const CANCEL_GRACE_MS = 8000

const isTerminal = (statement: StatementRun): boolean =>
  statement.status === 'done' ||
  statement.status === 'error' ||
  statement.status === 'cancelled' ||
  statement.status === 'skipped'

/** Fetching and summing the rows of one result that the core holds. */
function heldRows(key: string): RowBacking {
  return {
    fetch: (from, count) => coreLink.call('results.fetch', { key, from, count }),
    stats: (from, count, columns) => coreLink.call('results.stats', { key, from, count, columns }),
  }
}

function newStatement(index: number, sql: string): StatementRun {
  return {
    index,
    sql,
    status: 'queued',
    resultSets: [],
    ok: null,
    error: null,
    durationMs: null,
    truncated: false,
  }
}

function replaceStatement(
  run: ScriptRun,
  index: number,
  update: (statement: StatementRun) => StatementRun,
): ScriptRun {
  return {
    ...run,
    statements: run.statements.map((s) => (s.index === index ? update(s) : s)),
  }
}

/** Anything that never started is skipped, not left looking like it is still waiting. */
function settle(run: ScriptRun, state: RunState): ScriptRun {
  return {
    ...run,
    state,
    statements: run.statements.map((s) =>
      s.status === 'queued' ? { ...s, status: 'skipped' as const } : s,
    ),
  }
}

export function isBusy(run: ScriptRun | null): boolean {
  return run?.state === 'running' || run?.state === 'cancelling'
}

function applyEvent(message: QueryEventMessage): void {
  const scriptId = routes.get(message.runId)
  if (!scriptId) return
  const { patchRun } = useScripts.getState()
  const { event, statement: index } = message

  // Rows go straight into the store; React state only changes when something visible does.
  if (event.type === 'rows' || event.type === 'spilled') {
    const run = useScripts.getState().scripts[scriptId]?.run
    if (run?.runId !== message.runId) return
    const sets = run.statements[index]?.resultSets
    const store = sets?.[sets.length - 1]?.store
    if (event.type === 'rows') store?.append(event.rows)
    else store?.appendSpilled(event.count)
    return
  }

  patchRun(scriptId, message.runId, (run) => {
    const touched = replaceStatement(run, index, (s) => {
      switch (event.type) {
        case 'start':
          return { ...s, status: 'running' }
        case 'columns': {
          // Unique across runs and scripts: staged edits and the inspector are keyed by this. It is
          // also how the core knows the rows it holds for the result.
          const id = `${message.runId}:${index}.${s.resultSets.length}`
          return {
            ...s,
            resultSets: [
              ...s.resultSets,
              { id, columns: event.columns, store: new RowStore(undefined, heldRows(id)) },
            ],
          }
        }
        case 'paused':
          return { ...s, status: 'paused' }
        case 'ok':
          return {
            ...s,
            ok: {
              affectedRows: event.affectedRows,
              insertId: event.insertId,
              message: event.message,
              warnings: event.warnings,
            },
          }
        case 'done':
          return {
            ...s,
            status: 'done',
            durationMs: event.durationMs,
            truncated: event.truncated === true,
          }
        case 'error':
          return { ...s, status: 'error', error: { code: event.code, message: event.message } }
        case 'cancelled':
          return { ...s, status: 'cancelled' }
        default:
          return s
      }
    })
    // A cancel that has been acknowledged ends the run right away.
    if (event.type === 'cancelled') return settle(touched, 'cancelled')
    if (event.type === 'error') return settle(touched, 'error')
    return touched
  })
}

/** Starts listening for streamed query events. Call once at startup. */
export function initRuns(): void {
  coreLink.on(CoreEvents.queryEvent, (payload) => applyEvent(payload as QueryEventMessage))
}

function finish(
  scriptId: string,
  runId: string,
  outcome: 'completed' | 'cancelled' | 'error',
): void {
  useScripts.getState().patchRun(scriptId, runId, (run) => {
    // Events already set a more precise state for errors and cancels; only fill in the rest.
    if (run.state === 'cancelled' || run.state === 'error') return settle(run, run.state)
    return settle(run, outcome)
  })
}

async function startRun(scriptId: string, statements: string[]): Promise<void> {
  const script = useScripts.getState().scripts[scriptId]
  if (!script || isBusy(script.run)) return

  // The text that is being run is kept in local history, so it can always be found again.
  const text = pullLiveText(scriptId)
  void saveNow(scriptId, { label: 'run', ...(text === undefined ? {} : { text }) })

  const runId = crypto.randomUUID()
  const controller = new AbortController()
  controllers.set(scriptId, controller)
  routes.set(runId, scriptId)
  useScripts.getState().patch(scriptId, {
    run: {
      runId,
      state: 'running',
      statements: statements.map((sql, index) => newStatement(index, sql)),
    },
  })

  try {
    const result = await coreLink.call(
      'query.run',
      {
        runId,
        scriptId,
        connectionId: script.connectionId,
        database: script.database,
        readOnly: !script.writable,
        statements,
        pageSize: DEFAULT_PAGE_SIZE,
      },
      { signal: controller.signal },
    )
    finish(scriptId, runId, result.outcome)
  } catch (error) {
    if (error instanceof RpcError && error.code === 'ABORTED') {
      // The core reports the cancel through an event; if it never does, stop waiting.
      setTimeout(() => {
        useScripts.getState().patchRun(scriptId, runId, (run) => {
          if (run.state !== 'cancelling') return run
          const allDone = run.statements.every(isTerminal)
          return settle(
            {
              ...run,
              statements: run.statements.map((s) =>
                s.status === 'running' || s.status === 'paused'
                  ? { ...s, status: 'cancelled' as const }
                  : s,
              ),
            },
            allDone ? 'completed' : 'cancelled',
          )
        })
      }, CANCEL_GRACE_MS)
    } else {
      const message = error instanceof Error ? error.message : String(error)
      const code = error instanceof RpcError ? error.code : null
      useScripts.getState().patchRun(scriptId, runId, (run) =>
        settle(
          replaceStatement(run, run.statements.find((s) => !isTerminal(s))?.index ?? 0, (s) => ({
            ...s,
            status: 'error',
            error: { code, message },
          })),
          'error',
        ),
      )
    }
  } finally {
    if (controllers.get(scriptId) === controller) controllers.delete(scriptId)
    // Late events from a cancelled run may still arrive; keep their route for a while.
    setTimeout(() => routes.delete(runId), CANCEL_GRACE_MS * 2)
  }
}

/** Checks the run against the connection's safeguards, asks if needed, then runs it. */
export async function requestRun(scriptId: string, statements: string[]): Promise<void> {
  const script = useScripts.getState().scripts[scriptId]
  const connection = useData.getState().connections.find((c) => c.id === script?.connectionId)
  if (!script || !connection || statements.length === 0 || isBusy(script.run)) return

  const verdict = evaluateRun(statements, {
    environment: connection.environment,
    writable: script.writable,
    language: script.language,
  })

  if (verdict.action === 'block') {
    // Never sent: show it as the result, where the user is already looking.
    useScripts.getState().patch(scriptId, {
      run: {
        runId: crypto.randomUUID(),
        state: 'error',
        statements: statements.map((sql, index) =>
          index === 0
            ? {
                ...newStatement(index, sql),
                status: 'error' as const,
                error: { code: 'READ_ONLY', message: verdict.message },
              }
            : { ...newStatement(index, sql), status: 'skipped' as const },
        ),
      },
    })
    return
  }

  if (verdict.action === 'confirm') {
    const confirmed = await useGuard.getState().ask({
      connectionName: connection.name,
      environment: connection.environment,
      statements,
      reasons: verdict.reasons,
      typedName: verdict.typedName,
    })
    if (!confirmed) return
  }

  await startRun(scriptId, statements)
}

export function cancelRun(scriptId: string): void {
  const script = useScripts.getState().scripts[scriptId]
  const controller = controllers.get(scriptId)
  if (!script?.run || !controller || script.run.state !== 'running') return
  useScripts
    .getState()
    .patchRun(scriptId, script.run.runId, (run) => ({ ...run, state: 'cancelling' }))
  controller.abort()
}

/** Asks a paused statement for more rows. */
export function loadMore(scriptId: string, statement: number, rows: number | 'all'): void {
  const run = useScripts.getState().scripts[scriptId]?.run
  if (!run || run.statements[statement]?.status !== 'paused') return
  useScripts
    .getState()
    .patchRun(scriptId, run.runId, (r) =>
      replaceStatement(r, statement, (s) => ({ ...s, status: 'running' })),
    )
  coreLink.call('query.more', { runId: run.runId, statement, rows }).catch(() => undefined)
}
