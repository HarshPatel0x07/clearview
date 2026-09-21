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
  server: { port: 5173, open: true },
  build: { outDir: '../dist-ui', emptyOutDir: true },
})
