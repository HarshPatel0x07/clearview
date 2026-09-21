import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// The UI is a rendering layer over `src/`. Nothing in `ui/` may contain ledger
// logic - that lives in src/ledger.ts and src/report.ts, is pure, and is
// covered by 43 tests. Keeping the boundary honest is what stops the dashboard
// quietly growing a second, untested implementation of the books.
export default defineConfig({
  root: 'ui',
  plugins: [react()],
  server: { port: 5173, open: true },
  build: { outDir: '../dist-ui', emptyOutDir: true },
})
