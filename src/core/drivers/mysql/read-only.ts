import { classifyStatement, isReadOnlySafe, maskSql } from '@shared/sql'

/** How a server without read-only transactions answers `SET SESSION TRANSACTION READ ONLY`. */
const NO_READ_ONLY_MODE = new Set([
  // 5.5 reads TRANSACTION as the name of a system variable ("Unknown system variable 'TRANSACTION'").
  'ER_UNKNOWN_SYSTEM_VARIABLE',
  // Older and other servers refuse the syntax outright.
  'ER_PARSE_ERROR',
])

/**
 * Turns the server's read-only mode on or off for the session. Returns false when the server has no such
 * mode (MySQL before 5.6.5), so the caller can guard writes itself. Any other failure is a real one and
 * is thrown.
 */
export async function setServerReadOnly(
  run: (sql: string) => Promise<unknown>,
  readOnly: boolean,
): Promise<boolean> {
  try {
    await run(`SET SESSION TRANSACTION READ ${readOnly ? 'ONLY' : 'WRITE'}`)
    return true
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code
    if (typeof code === 'string' && NO_READ_ONLY_MODE.has(code)) return false
    throw error
  }
}

/**
 * For a server that can not enforce read-only itself (MySQL older than 5.6.5 has no `READ ONLY`
 * transactions), the driver refuses anything that is not plainly a read before it is sent. It is the
 * same classification the window uses, applied again here so that nothing which skips the window's check
 * reaches the server. It can not see inside a stored function that a `SELECT` calls.
 *
 * Returns why a statement is refused, or null when it may go.
 */
export function appReadOnlyViolation(sql: string): string | null {
  const info = classifyStatement(sql)
  const masked = maskSql(sql)
  if (/\bINTO\s+(OUTFILE|DUMPFILE)\b/i.test(masked)) {
    return 'This statement writes a file on the server.'
  }
  if (!isReadOnlySafe(info)) {
    return info.kind === 'unknown'
      ? 'DBIDE can’t tell what this statement does.'
      : `This statement is ${info.kind === 'ddl' ? 'a schema change' : info.kind === 'write' ? 'a data change' : 'an administrative command'}.`
  }
  // Session settings are fine; settings for the whole server, and password changes, are not.
  if (/^\s*SET\s+(GLOBAL|PERSIST|PASSWORD)\b/i.test(masked)) {
    return 'This statement changes a setting for the whole server.'
  }
  return null
}
