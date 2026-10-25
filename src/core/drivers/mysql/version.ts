/** Which server is on the other end, as far as the version string says. */
export interface ServerVersion {
  flavor: 'mysql' | 'mariadb'
  major: number
  minor: number
  patch: number
  /** The text the server sent, for showing to a person. */
  text: string
}

/**
 * Reads the string `SELECT VERSION()` returns: `5.7.44-log`, `8.4.13`, `10.11.6-MariaDB-1:10.11.6+maria`.
 * A MariaDB server can announce itself as `5.5.5-10.11.6-MariaDB` in its greeting; `VERSION()` does not,
 * but the prefix is dropped here too. Returns null for text that holds no version number.
 */
export function parseServerVersion(text: string): ServerVersion | null {
  const mariadb = /mariadb/i.test(text)
  const stripped = mariadb ? text.replace(/^5\.5\.5-/, '') : text
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(stripped.trim())
  if (!match) return null
  return {
    flavor: mariadb ? 'mariadb' : 'mysql',
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3] ?? 0),
    text,
  }
}

/** Whether `version` is at least `major.minor.patch`. */
export function atLeast(version: ServerVersion, major: number, minor = 0, patch = 0): boolean {
  if (version.major !== major) return version.major > major
  if (version.minor !== minor) return version.minor > minor
  return version.patch >= patch
}

/** The oldest MySQL the driver speaks to: 5.5.3 is where `utf8mb4`, which every connection uses, arrived. */
export const OLDEST_MYSQL = '5.5.3'

/** An explanation when the server is too old to use, or null when it is fine. Unknown versions pass. */
export function unsupportedReason(version: ServerVersion | null): string | null {
  if (!version) return null
  // Every MariaDB release has utf8mb4. Only MySQL 5.5.0 to 5.5.2 and older lack it.
  if (version.flavor === 'mysql' && !atLeast(version, 5, 5, 3)) {
    return `This server is MySQL ${version.text}. DBIDE works with MySQL ${OLDEST_MYSQL} and newer, and with MariaDB.`
  }
  return null
}
