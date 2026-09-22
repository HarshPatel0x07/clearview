import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const repoRoot = dirname(fileURLToPath(import.meta.url))

// The UI is a rendering layer over `src/`. Nothing in `ui/` may contain ledger
// logic - that lives in src/ledger.ts and src/report.ts, is pure, and is
// covered by 43 tests. Keeping the boundary honest is what stops the dashboard
// quietly growing a second, untested implementation of the books.
export default defineConfig({
  root: 'ui',
  // envDir defaults to `root`, and is itself resolved RELATIVE to `root`.
  // With root: 'ui' that means both the default and a literal '.' point at
  // ui/ - so .env.local at the repository root was silently ignored and every
  // Access Key step reported the key as missing. An absolute path removes the
  // ambiguity entirely.
  envDir: repoRoot,
  plugins: [react()],
  server: {
    port: 5173,
    open: true,
    // The Zone RPC requires an `X-Authorization-Token` header but its CORS
    // preflight only allows `Content-Type, Authorization`. A browser therefore
    // blocks every zone call before it is sent, which surfaces as a bare
    // "Failed to fetch". Proxying makes the request same-origin so no
    // preflight happens. Reported upstream; remove this when it is fixed.
    proxy: {
      '/zone-a': {
        target: 'https://rpc-zone-a.testnet.tempo.xyz',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/zone-a/, ''),
      },
    },
  },
  build: { outDir: '../dist-ui', emptyOutDir: true },
})
