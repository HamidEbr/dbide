// Runs the real app against a real MySQL or MariaDB server. Needs a server whose user can create and
// drop databases:
//
//   DBIDE_TEST_MYSQL_URL=mysql://root:secret@127.0.0.1:3306 pnpm smoke:live
//
// It seeds a `dbide_live` schema (50 customers, 300,000 orders whose values follow a formula), boots the
// built app without the demo engine, drives it through the same stores the UI uses, reads the exported
// files back from disk, and drops the schema again.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import electron from 'electron'
import mysql from 'mysql2/promise'

const url = process.env.DBIDE_TEST_MYSQL_URL
if (!url) {
  console.error('Set DBIDE_TEST_MYSQL_URL, e.g. mysql://root:secret@127.0.0.1:3306')
  process.exit(2)
}
const parsed = new URL(url)
const target = {
  host: parsed.hostname,
  port: Number(parsed.port || 3306),
  user: decodeURIComponent(parsed.username || 'root'),
  password: decodeURIComponent(parsed.password),
}

const ORDERS = 300_000
const pad = (n) => String(n).padStart(2, '0')

/** JSON columns came with MySQL 5.7.8. Before that, and on MariaDB, the column holds plain text. */
function hasJsonType(version) {
  if (/mariadb/i.test(version)) return false
  const [, major, minor, patch] = /^(\d+)\.(\d+)\.(\d+)/.exec(version) ?? []
  return (
    Number(major) > 5 ||
    (Number(major) === 5 && (Number(minor) > 7 || (Number(minor) === 7 && Number(patch) >= 8)))
  )
}

async function seed() {
  const db = await mysql.createConnection({ ...target, multipleStatements: true })
  const [[{ version }]] = await db.query('SELECT VERSION() AS version')
  const metaType = hasJsonType(String(version)) ? 'JSON' : 'LONGTEXT'
  await db.query('DROP DATABASE IF EXISTS dbide_live')
  await db.query('CREATE DATABASE dbide_live CHARACTER SET utf8mb4')
  await db.query('USE dbide_live')
  await db.query(`
    CREATE TABLE customers (
      id INT PRIMARY KEY AUTO_INCREMENT,
      name VARCHAR(100) NOT NULL,
      email VARCHAR(100) NOT NULL
    );
    CREATE TABLE orders (
      id BIGINT PRIMARY KEY AUTO_INCREMENT,
      customer_id INT NOT NULL,
      total DECIMAL(12,2) NOT NULL,
      status VARCHAR(20) NOT NULL,
      placed_at DATETIME NOT NULL,
      meta ${metaType} NULL,
      note TEXT NULL,
      token BLOB NULL,
      INDEX by_customer (customer_id),
      CONSTRAINT fk_orders_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
    );
    CREATE TABLE nopk (a INT, b VARCHAR(10));
    INSERT INTO nopk VALUES (1, 'one'), (2, 'two'), (3, 'three');
    CREATE VIEW paid_orders AS SELECT id, total FROM orders WHERE status = 'paid';
  `)
  const customers = Array.from(
    { length: 50 },
    (_, i) => `(${i + 1}, 'customer ${i + 1}', 'c${i + 1}@example.com')`,
  )
  await db.query(`INSERT INTO customers VALUES ${customers.join(',')}`)

  // Every value follows a formula in `i`, so a check can say exactly what a row holds.
  for (let start = 0; start < ORDERS; start += 5000) {
    const rows = []
    for (let i = start; i < Math.min(ORDERS, start + 5000); i++) {
      const total = (((i * 37) % 100000) / 100).toFixed(2)
      const status = ['new', 'paid', 'shipped'][i % 3]
      const placed = `2026-03-${pad((i % 28) + 1)} ${pad(i % 24)}:${pad(i % 60)}:00`
      const meta = i % 5 === 0 ? 'NULL' : `'{"i": ${i}}'`
      const note = i % 3 === 0 ? 'NULL' : `'note ${i}'`
      const token = i % 4 === 0 ? "UNHEX('DEADBEEF')" : 'NULL'
      rows.push(
        `(${i + 1}, ${(i % 50) + 1}, ${total}, '${status}', '${placed}', ${meta}, ${note}, ${token})`,
      )
    }
    await db.query(`INSERT INTO orders VALUES ${rows.join(',')}`)
  }
  await db.end()
}

async function drop() {
  const db = await mysql.createConnection(target)
  await db.query('DROP DATABASE IF EXISTS dbide_live')
  await db.end()
}

console.log(`SMOKE seeding ${target.host}:${target.port}`)
await seed()

const userData = mkdtempSync(join(tmpdir(), 'dbide-live-'))
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
        DBIDE_SMOKE_PHASE: 'live',
        DBIDE_SMOKE_MYSQL: JSON.stringify(target),
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

await drop().catch((error) => console.error(`SMOKE could not drop dbide_live: ${error.message}`))
rmSync(userData, { recursive: true, force: true })
process.exit(code)
