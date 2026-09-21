import { defineConfig } from 'vitest/config'

// Separate from vite.config.ts on purpose. That file sets `root: 'ui'` so the
// dashboard builds, and vitest reads the same config by default - which made
// it look inside ui/ and report "no test files found" while the README
// claimed 43. The tests live at the repository root and this keeps them there.
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
})
