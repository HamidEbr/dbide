// Runs the real app against RabbitMQ's management API.
//
//   pnpm smoke:rabbitmq                    against an in-memory stand-in (nothing needs to be installed)
//   DBIDE_TEST_RABBITMQ_URL=amqp://guest:guest@127.0.0.1:5672 DBIDE_TEST_RABBITMQ_MANAGEMENT_PORT=15672 pnpm smoke:rabbitmq
//                                          against a real broker (the management plugin must be on)
//
// It seeds what it needs (an exchange, two queues, 26 messages) through the app's own calls, drives the
// app, and removes everything again. Names are prefixed `dbide-smoke-` and made unique per run.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'

const url = process.env.DBIDE_TEST_RABBITMQ_URL
const env = {}
if (url) {
  const parsed = new URL(url)
  env.DBIDE_SMOKE_RABBIT = JSON.stringify({
    host: parsed.hostname,
    port: Number(parsed.port || 5672),
    managementPort: Number(process.env.DBIDE_TEST_RABBITMQ_MANAGEMENT_PORT || 15672),
    username: decodeURIComponent(parsed.username || 'guest'),
    password: decodeURIComponent(parsed.password || 'guest'),
    fake: false,
  })
}

const userData = mkdtempSync(join(tmpdir(), 'dbide-rabbit-'))
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
        DBIDE_SMOKE_PHASE: 'rabbitmq',
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
    console.error('SMOKE FAILED: no result after 240s')
    child.kill('SIGKILL')
  }, 240_000)
  child.on('exit', (exitCode, signal) => {
    clearTimeout(timer)
    done(signal ? 1 : (exitCode ?? 1))
  })
})

rmSync(userData, { recursive: true, force: true })
process.exit(code)
