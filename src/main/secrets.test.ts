import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SecretStore, type Cipher } from './secrets'

/** Reversible, but not plain text, so a test can tell ciphertext from the secret itself. */
const rot13Cipher = (available = true): Cipher => ({
  isAvailable: () => available,
  encrypt: (plain) =>
    Buffer.from(
      plain.replace(/[a-z]/gi, (c) =>
        String.fromCharCode(
          ((c.charCodeAt(0) - (c < 'a' ? 65 : 97) + 13) % 26) + (c < 'a' ? 65 : 97),
        ),
      ),
    ),
  decrypt: (encrypted) =>
    encrypted
      .toString()
      .replace(/[a-z]/gi, (c) =>
        String.fromCharCode(
          ((c.charCodeAt(0) - (c < 'a' ? 65 : 97) + 13) % 26) + (c < 'a' ? 65 : 97),
        ),
      ),
})

describe('SecretStore', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dbide-secrets-'))
    file = join(dir, 'nested', 'secrets.json')
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('round-trips a secret', () => {
    const store = new SecretStore(file, rot13Cipher())
    store.set('conn:1:password', 'hunter2')
    expect(store.get('conn:1:password')).toBe('hunter2')
  })

  it('never writes the secret to disk in plain text', () => {
    new SecretStore(file, rot13Cipher()).set('k', 'hunter2')
    expect(readFileSync(file, 'utf8')).not.toContain('hunter2')
  })

  it('returns null for a missing key and survives a missing file', () => {
    const store = new SecretStore(file, rot13Cipher())
    expect(store.get('nope')).toBeNull()
    store.delete('nope')
  })

  it('deletes a secret', () => {
    const store = new SecretStore(file, rot13Cipher())
    store.set('k', 'v')
    store.delete('k')
    expect(store.get('k')).toBeNull()
  })

  it('refuses to store anything when no real keychain exists', () => {
    const store = new SecretStore(file, rot13Cipher(false))
    expect(store.available()).toBe(false)
    expect(() => store.set('k', 'v')).toThrow(/keychain/)
  })

  it('refuses to overwrite a corrupt store instead of wiping the secrets in it', () => {
    new SecretStore(file, rot13Cipher()).set('k', 'v')
    writeFileSync(file, '{not json')
    const store = new SecretStore(file, rot13Cipher())
    expect(() => store.set('other', 'x')).toThrow(/corrupt/)
    expect(readFileSync(file, 'utf8')).toBe('{not json')
  })
})
