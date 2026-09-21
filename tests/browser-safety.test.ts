import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

/**
 * `src/` is imported by the CLI, the tests **and the dashboard**. A Node global
 * in there throws at module load in a browser, and the symptom is a blank white
 * page with the real error only in the console - which is exactly what
 * `Buffer.from` in demo-data.ts produced.
 *
 * Node-only code belongs in `scripts/`, which the browser never loads.
 */
const NODE_ONLY = [
  { pattern: /\bBuffer\s*\./, name: 'Buffer' },
  { pattern: /\bprocess\s*\.\s*(env|argv|cwd)/, name: 'process' },
  { pattern: /\brequire\s*\(/, name: 'require()' },
  { pattern: /from\s+['"]node:/, name: "node: import" },
]

const files = readdirSync('src')
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ name: f, code: readFileSync(join('src', f), 'utf8') }))

describe('src/ must stay browser-safe', () => {
  it('has files to check', () => {
    expect(files.length).toBeGreaterThan(0)
  })

  for (const file of files) {
    for (const { pattern, name } of NODE_ONLY) {
      it(`${file.name} does not use ${name}`, () => {
        // Strip comments first - the fix for this very bug documents `Buffer`
        // in a doc comment, and a guard that cannot survive its own
        // explanation is not much of a guard.
        const code = file.code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/(^|[^:])\/\/.*$/gm, '$1')
        expect(pattern.test(code)).toBe(false)
      })
    }
  }
})
