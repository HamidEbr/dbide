import { ENVIRONMENT_POLICIES, type Environment } from '@shared/environment'
import { classifyMongo } from '@shared/mongo/lang'
import type { ScriptLanguage } from '@shared/scripts'
import { classifyStatement, isReadOnlySafe, type StatementKind } from '@shared/sql'

export type GuardVerdict =
  | { action: 'allow' }
  /** Not sent at all: a write on a connection that is still read-only. */
  | { action: 'block'; message: string }
  /** Ask first. `typedName` means the user must type the connection's name to continue. */
  | { action: 'confirm'; reasons: string[]; typedName: boolean }

const KIND_LABEL: Record<StatementKind, string> = {
  read: 'a read',
  write: 'a data change',
  ddl: 'a schema change',
  admin: 'an admin command',
  transaction: 'a transaction command',
  session: 'a session command',
  unknown: 'this statement',
}

/**
 * Decides whether a run may go ahead. Read-only is also enforced by the server; blocking here
 * as well means the statement never leaves the app, and the message says how to proceed.
 */
export function evaluateRun(
  statements: string[],
  options: { environment: Environment; writable: boolean; language?: ScriptLanguage },
): GuardVerdict {
  const infos = statements.map(options.language === 'mongodb' ? classifyMongo : classifyStatement)

  if (!options.writable) {
    const offending = infos.find((info) => !isReadOnlySafe(info))
    if (offending) {
      return {
        action: 'block',
        message: `This connection is read-only, so ${KIND_LABEL[offending.kind]} can’t run. Unlock writes in the toolbar to continue.`,
      }
    }
  }

  const policy = ENVIRONMENT_POLICIES[options.environment]
  const destructive = infos.filter((info) => info.destructive)
  const writesOnGuardedConnection =
    policy.confirmBeforeExecute && infos.some((info) => !isReadOnlySafe(info))

  if (destructive.length === 0 && !writesOnGuardedConnection) return { action: 'allow' }

  const reasons = destructive.map((info) => info.reason!)
  if (reasons.length === 0) reasons.push(`This is a ${policy.label.toLowerCase()} connection.`)
  return {
    action: 'confirm',
    reasons: [...new Set(reasons)],
    typedName: destructive.length > 0 && policy.confirmDestructive,
  }
}
