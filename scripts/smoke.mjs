// Boots the built app in smoke mode and exits with its status. Run `pnpm build` first
// (or just `pnpm smoke`). On Linux CI wrap it in `xvfb-run -a`.
//
// It launches the app twice on the same data folder. The first launch runs every check; the
// second shows that what the first left behind (open tabs, scripts, history) comes back.
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import electron from 'electron'

// `--app <executable>` tests a packaged build instead of the sources, e.g.
// `pnpm smoke --app release/mac-arm64/DBIDE.app/Contents/MacOS/DBIDE` after `pnpm package`.
const appFlag = process.argv.indexOf('--app')
const appPath = appFlag === -1 ? undefined : resolve(process.argv[appFlag + 1] ?? '')

// `--shots <dir>` also saves a screenshot of each main screen, e.g. as a CI artifact.
const shotsFlag = process.argv.indexOf('--shots')
const shotsDir = shotsFlag === -1 ? undefined : resolve(process.argv[shotsFlag + 1] ?? '.shots')

const userData = mkdtempSync(join(tmpdir(), 'dbide-smoke-'))
// Where the app's file dialogs answer from: exports land here, imports are read from `import/`.
const filesDir = join(userData, 'files')
mkdirSync(join(filesDir, 'import'), { recursive: true })
writeFileSync(join(filesDir, 'import', 'legacy-report.sql'), "SELECT 'imported' AS source;\r\n")
writeFileSync(join(filesDir, 'import', 'notes.txt'), '-- notes\nSELECT 2;\n')
writeFileSync(join(filesDir, 'import', 'broken.sql'), Buffer.from([0x53, 0xe9, 0x6c, 0xff, 0xfe]))

const timeoutMs = 120_000

function launch(phase) {
  return new Promise((done) => {
    const child = spawn(
      appPath ?? String(electron),
      [...(appPath ? [] : ['.']), ...(process.platform === 'linux' ? ['--no-sandbox'] : [])],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          DBIDE_SMOKE: '1',
          DBIDE_DEMO_ENGINE: '1',
          DBIDE_USER_DATA: userData,
          DBIDE_SMOKE_FILES_DIR: filesDir,
          DBIDE_SMOKE_PHASE: phase,
          ELECTRON_ENABLE_LOGGING: '1',
          ...(shotsDir && phase === 'main' ? { DBIDE_SMOKE_SHOTS: shotsDir } : {}),
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
      console.error(`SMOKE FAILED: no result after ${timeoutMs / 1000}s (${phase})`)
      child.kill('SIGKILL')
    }, timeoutMs)

    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      done(signal ? 1 : (code ?? 1))
    })
  })
}

let code = await launch('main')
// Screenshots leave their own tabs open, so the restart check only makes sense without them.
if (code === 0 && !shotsDir) {
  console.log('SMOKE restarting the app on the same data')
  code = await launch('restart')
}
rmSync(userData, { recursive: true, force: true })
process.exit(code)
