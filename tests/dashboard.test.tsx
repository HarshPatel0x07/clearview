/**
 * Mount the dashboard and assert what a person would actually see.
 *
 * This exists because of a specific failure. The dashboard shipped as a blank
 * white page, and four checks had passed first: typecheck clean, build
 * succeeded, dev server returned HTTP 200, and the served source contained no
 * `Buffer`. Every one of them was a **proxy**. The module threw at load, React
 * never mounted, and nothing in that list could tell the difference.
 *
 * A test that renders the component catches the whole class of module-load and
 * render failures by construction, rather than one known instance by regex.
 *
 * The Access Key panel is rendered but never exercised: its buttons make live
 * calls to Tempo Moderato and a test suite should not write to a chain.
 */

import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { App } from '../ui/src/App.js'
import { INVOICE_REGISTER, PURCHASE_REGISTER, demoLedger } from '../src/demo-data.js'
import { exceptions } from '../src/report.js'

const ledger = demoLedger()
const exc = exceptions(ledger, INVOICE_REGISTER, PURCHASE_REGISTER)

// Testing Library only auto-cleans when vitest runs with `globals: true`.
// Without this each render stacks another copy of the app into the document
// and every query reports "found multiple elements".
afterEach(cleanup)

function tab(name: string) {
  return screen.getByRole('button', { name: new RegExp(`^${name}`) })
}

/** Click through Testing Library so React flushes the state update. A bare
 *  element.click() dispatches the event but leaves the render un-awaited. */
function openTab(name: string) {
  fireEvent.click(tab(name))
}

describe('the dashboard renders', () => {
  beforeEach(() => {
    render(<App />)
  })

  it('mounts at all', () => {
    // The assertion the blank page would have failed.
    expect(screen.getByRole('heading', { name: 'Clearview' })).toBeTruthy()
  })

  it('states that the data is seeded before showing any number', () => {
    // Honesty is a feature of this submission, so it is a tested feature.
    const banner = screen.getByText(/Ledger data is seeded/i)
    expect(banner).toBeTruthy()
    expect(screen.getByText(/tempoxyz\/zones#1482/)).toBeTruthy()
  })

  it('shows the reconciled balance on the statement', () => {
    expect(screen.getByText('7220.000000')).toBeTruthy()
    expect(screen.getByText('RECONCILED')).toBeTruthy()
  })

  it('shows received and paid totals', () => {
    expect(screen.getByText('7150.000000')).toBeTruthy()
    expect(screen.getByText('1430.000000')).toBeTruthy()
  })

  it('badges the exception count on the tab', () => {
    const issues =
      exc.unmatched.length + exc.missingMemo.length + exc.unpaidInvoices.length + exc.duplicated.length
    expect(issues).toBe(4)
    expect(within(tab('Exceptions')).getByText(String(issues))).toBeTruthy()
  })
})

describe('tabs show their content', () => {
  beforeEach(() => {
    render(<App />)
  })

  it('ledger lists every entry', () => {
    openTab('Ledger')
    // One header row plus one row per entry.
    const rows = screen.getAllByRole('row')
    expect(rows.length).toBe(ledger.entries.length + 1)
  })

  it('ledger marks an unrecognised memo rather than hiding it', () => {
    openTab('Ledger')
    expect(screen.getAllByText('unrecognised').length).toBeGreaterThan(0)
  })

  it('exceptions explains each finding', () => {
    openTab('Exceptions')
    expect(screen.getByText(/no matching payment/i)).toBeTruthy()
    expect(screen.getByText(/referenced by 2 payments/i)).toBeTruthy()
    expect(screen.getByText(/Quotes an invoice we did not issue/i)).toBeTruthy()
  })

  it('counterparties names the parties', () => {
    openTab('Counterparties')
    expect(screen.getByText('Northwind Trading')).toBeTruthy()
    expect(screen.getByText('CloudHost (hosting)')).toBeTruthy()
  })

  it('the access key panel renders without firing any chain call', () => {
    openTab('Access Key')
    expect(screen.getByText(/Access Key lifecycle/i)).toBeTruthy()
    expect(screen.getByText(/Authorise a deny-all key/i)).toBeTruthy()
    // Buttons exist but are deliberately not clicked - they write to Moderato.
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeTruthy()
  })
})
