// Runs the real app against a real MongoDB server. Needs a server whose user can create and drop
// databases:
//
//   DBIDE_TEST_MONGO_URL=mongodb://127.0.0.1:27017 pnpm smoke:mongo
//
// It seeds a `dbide_mongo_live` database (2,000 orders whose values follow a formula, and a view),
// boots the built app, drives it through the same stores the UI uses and through the DOM, and drops the
// database again. Set DBIDE_TEST_MONGO_RS=1 for a replica set reached through one address.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import { MongoClient } from 'mongodb'

const url = process.env.DBIDE_TEST_MONGO_URL
if (!url) {
  console.error('Set DBIDE_TEST_MONGO_URL, e.g. mongodb://127.0.0.1:27017')
  process.exit(2)
}
const parsed = new URL(url)
const target = {
  host: parsed.hostname,
  port: Number(parsed.port || 27017),
  ...(parsed.username ? { username: decodeURIComponent(parsed.username) } : {}),
  ...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
  options: process.env.DBIDE_TEST_MONGO_RS === '1' ? { directConnection: 'true' } : {},
}

const ORDERS = 2000

async function connect() {
  const client = new MongoClient(
    `mongodb://${target.host}:${target.port}/${process.env.DBIDE_TEST_MONGO_RS === '1' ? '?directConnection=true' : ''}`,
    target.username ? { auth: { username: target.username, password: target.password } } : {},
  )
  await client.connect()
  return client
}

async function seed() {
  const client = await connect()
  const db = client.db('dbide_mongo_live')
  await db.dropDatabase()
  const orders = db.collection('orders')
  // Every value follows a formula in `i`, so a check can say exactly what a document holds.
  const docs = Array.from({ length: ORDERS }, (_, i) => ({
    _id: i + 1,
    customer: (i % 50) + 1,
    status: ['new', 'paid', 'shipped'][i % 3],
    total: ((i * 37) % 100000) / 100 + 0.5,
    placed: new Date(Date.UTC(2026, 2, (i % 28) + 1, i % 24, i % 60)),
    tags: i % 2 === 0 ? ['a', 'b'] : ['a', 'b'].slice(0, 2),
    meta: { i, nested: { ok: true } },
    ...(i % 3 === 0 ? {} : { note: `note ${i}` }),
  }))
  await orders.insertMany(docs)
  await orders.createIndex({ status: 1 })
  await db.createCollection('paid_orders', {
    viewOn: 'orders',
    pipeline: [{ $match: { status: 'paid' } }],
  })
  await client.close()
}

async function drop() {
  const client = await connect()
  await client.db('dbide_mongo_live').dropDatabase()
  await client.close()
}

console.log(`SMOKE seeding ${target.host}:${target.port}`)
await seed()

const userData = mkdtempSync(join(tmpdir(), 'dbide-mongo-'))
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
        DBIDE_SMOKE: '1',
        DBIDE_SMOKE_PHASE: 'mongo',
        DBIDE_SMOKE_MONGO: JSON.stringify(target),
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

await drop().catch((error) =>
  console.error(`SMOKE could not drop dbide_mongo_live: ${error.message}`),
)
rmSync(userData, { recursive: true, force: true })
process.exit(code)
