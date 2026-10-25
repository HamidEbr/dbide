// Runs the real app against Redis.
//
//   pnpm smoke:redis                       against an in-memory stand-in (nothing needs to be installed)
//   DBIDE_TEST_REDIS_URL=redis://127.0.0.1:6379 pnpm smoke:redis
//                                          against a real server (Redis, or Valkey)
//
// It seeds what it needs (strings, a hash, a list, a set, a sorted set, a stream with a group and 1,200 more
// keys) through the app's own calls, drives the app, and removes everything again. Every key is prefixed
// `dbide-smoke-` and made unique per run, and nothing here flushes a database.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'

const url = process.env.DBIDE_TEST_REDIS_URL
const env = {}
if (url) {
  const parsed = new URL(url)
  env.DBIDE_SMOKE_REDIS = JSON.stringify({
    host: parsed.hostname,
    port: Number(parsed.port || 6379),
    ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
    fake: false,
  })
}

const userData = mkdtempSync(join(tmpdir(), 'dbide-redis-'))
const filesDir = join(userData, 'files')
mkdirSync(filesDir, { recursive: true })

const code = await new Promise((done) => {
  const child = spawn(
    String(electron),
    ['.', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        ...env,
        DBIDE_SMOKE: '1',
        DBIDE_SMOKE_PHASE: 'redis',
        DBIDE_USER_DATA: userData,
        DBIDE_SMOKE_FILES_DIR: filesDir,
        ELECTRON_ENABLE_LOGGING: '1',
      },
    },
  )
  const forward = (chunk) => {
    for (const line of String(chunk).split('\n')) {
      if (line.startsWith('SMOKE ') || /\b(error|exception)\b/i.test(line)) console.log(line)
    }
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  const timer = setTimeout(() => {
    console.error('SMOKE FAILED: no result after 300s')
    child.kill('SIGKILL')
  }, 300_000)
  child.on('exit', (exitCode, signal) => {
    clearTimeout(timer)
    done(signal ? 1 : (exitCode ?? 1))
  })
})

rmSync(userData, { recursive: true, force: true })
process.exit(code)
