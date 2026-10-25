import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'electron-vite'
import type { Plugin } from 'vite'

const alias = { '@shared': resolve('src/shared') }

/**
 * Production pages get a strict Content-Security-Policy. It is injected at build time only,
 * because the dev server needs inline scripts and a websocket for hot reload.
 */
function contentSecurityPolicy(): Plugin {
  const policy = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ')
  return {
    name: 'dbide:csp',
    apply: 'build',
    transformIndexHtml: (html) =>
      html.replace(
        '<!--csp-->',
        `<meta http-equiv="Content-Security-Policy" content="${policy}" />`,
      ),
  }
}

export default defineConfig({
  main: {
    resolve: { alias },
    build: {
      rollupOptions: {
        // The core utility process is its own entry next to the main process.
        input: {
          index: resolve('src/main/index.ts'),
          core: resolve('src/core/index.ts'),
        },
      },
    },
  },
  preload: {
    resolve: { alias },
    build: {
      rollupOptions: {
        input: { index: resolve('src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    resolve: { alias: { ...alias, '@': resolve('src/renderer/src') } },
    plugins: [react(), contentSecurityPolicy()],
    build: {
      // Never inline assets as data: URIs; the production CSP only allows files from the app itself.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolve('src/renderer/index.html'),
      },
    },
  },
})
