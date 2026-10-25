// Starts the dev server with the in-memory demo engine in place of MySQL (see README).
// A script instead of an inline `VAR=1 cmd`, which Windows' cmd.exe does not understand.
import { spawn } from 'node:child_process'

const child = spawn('pnpm', ['exec', 'electron-vite', 'dev'], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
  env: { ...process.env, DBIDE_DEMO_ENGINE: '1' },
})
child.on('exit', (code) => process.exit(code ?? 0))
