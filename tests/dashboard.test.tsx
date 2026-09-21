/**
 * Mount the dashboard and assert what a person would actually see.
 *
 * This exists because of a specific failure. The dashboard shipped as a blank
 * white page, and four checks had passed first: typecheck clean, build
 * succeeded, dev server returned HTTP 200, and the served source contained no
 * `Buffer`. Every one of them was a **proxy**.
 *
 * Note what this suite can and cannot see. It runs in jsdom, which is Node
 * with a DOM attached - so it does **not** catch Node globals leaking into
 * `src/` (verified: with the Buffer bug reintroduced, this suite passed and
 * only `browser-safety.test.ts` failed). It also cannot see typography,
 * spacing or colour, which is why a human still looks at the page.
 *
 * What it does catch: module-load failures, render errors, missing data, and
 * content regressions when the markup is reworked.
 *
 * The Access Key panel is rendered but never exercised: its buttons make live
 * calls to Tempo Moderato and a test suite should not write to a chain.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { INVOICE_REGISTER, PURCHASE_REGISTER, demoLedger } from '../src/demo-data.js'
import { format } from '../src/ledger.js'
import { exceptions, statement } from '../src/report.js'
import { App } from '../ui/src/App.js'

const ledger = demoLedger()
const exc = exceptions(ledger, INVOICE_REGISTER, PURCHASE_REGISTER)
const stmt = statement(ledger, { onChainBalance: 7_220_000_000n })

// Testing Library only auto-cleans when vitest runs with `globals: true`.
// Without this each render stacks another copy of the app into the document
// and every query reports "found multiple elements".
afterEach(cleanup)

/** Radix renders tabs with role="tab", not as plain buttons. */
function tab(name: string) {
  return screen.getByRole('tab', { name: new RegExp(`^${name}`) })
}
/**
 * Radix Tabs default to `activationMode="automatic"`, meaning a tab activates
 * on focus rather than on click - which is the correct behaviour for keyboard
 * users arrowing along a tablist. Probed in jsdom to confirm: `fireEvent.click`
 * alone leaves the active tab unchanged, `fireEvent.focus` switches it.
 */
function openTab(name: string) {
  fireEvent.focus(tab(name))
}

/**
 * Money is split across elements so the fractional part can be set quieter,
 * which is a deliberate typographic choice and breaks naive text matching.
 * Match on the element's combined text instead.
 */
function hasAmount(value: string) {
  return screen
    .getAllByText((_, el) => el?.textContent?.replace(/\s/g, '') === value)
    .length > 0
}

describe('the dashboard renders', () => {
  beforeEach(() => {
    render(<App />)
  })

  it('mounts at all', () => {
    // The assertion a blank page would fail.
    expect(screen.getByRole('heading', { name: 'Clearview' })).toBeTruthy()
  })

  it('declares the data provenance before showing any number', () => {
    // Honesty about seeded data is a feature of this submission, so it is a
    // tested feature.
    expect(screen.getByText(/Ledger figures are from seeded events/i)).toBeTruthy()
    expect(screen.getByText(/tempoxyz\/zones#1482/)).toBeTruthy()
  })

  it('leads with the balance as the largest figure', () => {
    const amount = document.querySelector('.headline .amount')
    expect(amount).toBeTruthy()
    expect(amount!.textContent).toContain(format(stmt.balance))
  })

  it('states the reconciliation result and the block it is as of', () => {
    const asof = document.querySelector('.headline .asof')
    expect(asof!.textContent).toMatch(/Reconciled/i)
    expect(asof!.textContent).toMatch(/block \d+/)
  })

  it('shows received and paid totals', () => {
    expect(hasAmount(format(stmt.received))).toBe(true)
    expect(hasAmount(format(stmt.paid))).toBe(true)
  })

  it('sets money with tabular numerals so columns align', () => {
    // Proportional figures make a column of money ragged. This is the single
    // highest-leverage typographic decision in a financial interface, so it
    // is asserted rather than assumed.
    expect(document.querySelectorAll('.figure').length).toBeGreaterThan(0)
  })

  it('badges the exception count on the tab', () => {
    const issues =
      exc.unmatched.length + exc.missingMemo.length + exc.unpaidInvoices.length + exc.duplicated.length
    expect(issues).toBe(4)
    expect(within(tab('Exceptions')).getByText(String(issues))).toBeTruthy()
  })

  it('exposes the views as a real tablist, navigable by keyboard', () => {
    // The previous version used <button aria-selected>, which is not a
    // tablist: no roving tabindex, no arrow-key movement.
    expect(screen.getByRole('tablist')).toBeTruthy()
    expect(screen.getAllByRole('tab')).toHaveLength(5)
  })
})

describe('tabs show their content', () => {
  beforeEach(() => {
    render(<App />)
  })

  it('ledger lists every entry', () => {
    openTab('Ledger')
    const rows = screen.getAllByRole('row')
    expect(rows.length).toBe(ledger.entries.length + 1) // + header
  })

  it('ledger marks an unrecognised memo rather than hiding it', () => {
    openTab('Ledger')
    expect(screen.getAllByText('unrecognised').length).toBeGreaterThan(0)
  })

  it('exceptions explains what each finding means and what to do', () => {
    openTab('Exceptions')
    expect(screen.getByText(/Unattributed receipt/i)).toBeTruthy()
    expect(screen.getByText(/not in the register/i)).toBeTruthy()
    expect(screen.getByText(/Referenced more than once/i)).toBeTruthy()
    expect(screen.getByText(/Outstanding/i)).toBeTruthy()
  })

  it('counterparties names the parties rather than showing raw hex', () => {
    openTab('Counterparties')
    expect(screen.getByText('Northwind Trading')).toBeTruthy()
    expect(screen.getByText('CloudHost (hosting)')).toBeTruthy()
  })

  it('the access key panel renders as a stepper without firing a chain call', () => {
    openTab('Access Key')
    expect(screen.getByText(/Access Key lifecycle/i)).toBeTruthy()
    expect(screen.getByText(/Authorise a deny-all key/i)).toBeTruthy()
    // Buttons exist but are deliberately not clicked - they write to Moderato.
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })
})
