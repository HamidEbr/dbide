import { createDecipheriv } from 'node:crypto'

/** The key DBeaver encrypts its saved logins with. It is the same in every installation and published in its source. */
const KEY = Buffer.from('babb4a9f774ab853c96c2d653dfde98b', 'hex')

export interface DbeaverLogin {
  user: string
  password: string
}

/**
 * The saved logins in a `credentials-config.json`, by DBeaver connection id: the database's own under `connection`,
 * and the SSH tunnel's under `ssh`. Null when the file is not one DBeaver wrote.
 */
export function decryptCredentials(
  file: Buffer,
): Record<string, { connection?: DbeaverLogin; ssh?: DbeaverLogin }> | null {
  if (file.length < 32) return null
  try {
    const decipher = createDecipheriv('aes-128-cbc', KEY, file.subarray(0, 16))
    const plain = Buffer.concat([decipher.update(file.subarray(16)), decipher.final()]).toString(
      'utf8',
    )
    const parsed = JSON.parse(plain) as Record<
      string,
      Record<string, { user?: string; password?: string }>
    >
    const out: Record<string, { connection?: DbeaverLogin; ssh?: DbeaverLogin }> = {}
    const login = (
      entry: { user?: string; password?: string } | undefined,
    ): DbeaverLogin | undefined =>
      entry && (entry.user || entry.password)
        ? { user: entry.user ?? '', password: entry.password ?? '' }
        : undefined
    for (const [id, entries] of Object.entries(parsed)) {
      const connection = login(entries['#connection'])
      const ssh = login(entries['network/ssh_tunnel'])
      out[id] = { ...(connection ? { connection } : {}), ...(ssh ? { ssh } : {}) }
    }
    return out
  } catch {
    return null
  }
}
