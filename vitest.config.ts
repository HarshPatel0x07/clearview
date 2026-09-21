import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose. That file sets `root: 'ui'` so the
// dashboard builds, and vitest reads the same config by default - which made it
// look inside ui/ and report "no test files found" while the README claimed 43.
//
// `environment: 'jsdom'` is what lets tests/dashboard.test.tsx mount the real
// component. The blank-page bug passed typecheck, build, an HTTP 200 and a
// source scan; only rendering it would have failed.
export default defineConfig({
  plugins: [react()],
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environment: 'jsdom',
    // NOTE: jsdom is Node with a DOM attached, not a browser. Buffer and
    // process remain defined, so a render test here CANNOT catch a Node-global
    // that would throw in a real browser. Verified by reintroducing the Buffer
    // bug: typecheck, vite build and the render suite all passed, and only the
    // static scan in browser-safety.test.ts failed.
    //
    // Stripping those globals in a setup file was tried and abandoned - jsdom
    // uses Buffer internally, so removing it kills the worker before any test
    // runs. The two suites are therefore layers, not alternatives:
    //   browser-safety.test.ts  -> Node globals reaching src/
    //   dashboard.test.tsx      -> render and logic failures
  },
})
