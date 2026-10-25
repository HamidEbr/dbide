import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/** The OS-backed encryption the store relies on. Electron's `safeStorage` in production. */
export interface Cipher {
  isAvailable(): boolean
  encrypt(plain: string): Buffer
  decrypt(encrypted: Buffer): string
}

/**
 * Passwords and passphrases, encrypted with the OS keychain (Keychain, DPAPI, libsecret).
 * Only ciphertext reaches the disk. When the OS offers no real keychain the store reports
 * itself unavailable instead of quietly falling back to plain text.
 */
export class SecretStore {
  constructor(
    private readonly file: string,
    private readonly cipher: Cipher,
  ) {}

  available(): boolean {
    return this.cipher.isAvailable()
  }

  get(key: string): string | null {
    const encoded = this.read()[key]
    if (encoded === undefined) return null
    return this.cipher.decrypt(Buffer.from(encoded, 'base64'))
  }

  set(key: string, value: string): void {
    this.requireAvailable()
    const all = this.read()
    all[key] = this.cipher.encrypt(value).toString('base64')
    this.write(all)
  }

  delete(key: string): void {
    const all = this.read()
    if (!(key in all)) return
    delete all[key]
    this.write(all)
  }

  private requireAvailable(): void {
    if (!this.available()) throw new Error('No system keychain is available')
  }

  private read(): Record<string, string> {
    if (!existsSync(this.file)) return {}
    try {
      return JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, string>
    } catch {
      // An unreadable file must not wipe secrets by being overwritten on the next write.
      throw new Error(`Secret store at ${this.file} is corrupt`)
    }
  }

  /** Write to a temp file and rename, so a crash never leaves a half-written store. */
  private write(all: Record<string, string>): void {
    mkdirSync(dirname(this.file), { recursive: true })
    const temp = `${this.file}.tmp`
    writeFileSync(temp, JSON.stringify(all), { mode: 0o600 })
    renameSync(temp, this.file)
    try {
      chmodSync(this.file, 0o600)
    } catch {
      // chmod is a no-op on some Windows file systems.
    }
  }
}
