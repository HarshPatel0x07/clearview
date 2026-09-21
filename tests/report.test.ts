import { describe, expect, it } from 'vitest'

import { buildLedger } from '../src/ledger.js'
import { exceptions, renderStatement, statement, toCsv, toJson } from '../src/report.js'

const ACCOUNT = '0xb4BB1aF3c66381EbA6d7FbDA4e8184AeEC759e68' as const
const DONOR = '0x1111111111111111111111111111111111111111' as const
const VENDOR = '0x2222222222222222222222222222222222222222' as const
const PATH_USD = '0x20c0000000000000000000000000000000000000' as const

const memo = (text: string) =>
  `0x${Buffer.from(text, 'ascii').toString('hex').padEnd(64, '0')}` as `0x${string}`

const log = (eventName: string, args: Record<string, unknown>, blockNumber: bigint) => ({
  transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as `0x${string}`,
  logIndex: 0,
  blockNumber,
  address: PATH_USD,
  eventName,
  args,
})

const LEDGER = buildLedger(
  [
    log('Mint', { to: ACCOUNT, value: 100_000_000n }, 1n),
    log('TransferWithMemo', { from: DONOR, to: ACCOUNT, value: 2_500_000n, memo: memo('INV-001') }, 2n),
    log('TransferWithMemo', { from: ACCOUNT, to: VENDOR, value: 750_000n, memo: memo('INV-002 venue') }, 3n),
    // A memo that matches nothing in the register.
    log('TransferWithMemo', { from: DONOR, to: ACCOUNT, value: 500_000n, memo: memo('random note') }, 4n),
    // No memo at all.
    log('Transfer', { from: DONOR, to: ACCOUNT, value: 250_000n }, 5n),
    // A second payment quoting INV-002 - a duplicate, or a split.
    log('TransferWithMemo', { from: ACCOUNT, to: VENDOR, value: 100_000n, memo: memo('INV-002') }, 6n),
  ],
  ACCOUNT,
)

const INVOICES = ['INV-001', 'INV-002', 'INV-003']

describe('CSV export', () => {
  const csv = toCsv(LEDGER, { invoices: INVOICES })
  const lines = csv.split('\n')

  it('emits a header and one row per entry', () => {
    expect(lines[0]).toContain('block,tx_hash,direction,amount')
    expect(lines).toHaveLength(LEDGER.entries.length + 1)
  })

  it('writes amounts as decimal strings, not floats', () => {
    // Holding money as integers is pointless if the export hands a spreadsheet
    // something it will reinterpret.
    expect(csv).toContain('2.500000')
    expect(csv).not.toMatch(/\b2\.5\b/)
  })

  it('carries a running balance', () => {
    expect(csv).toContain('100.000000') // after the mint
    expect(csv).toContain('102.400000') // final: 100 + 2.5 - 0.75 + 0.5 + 0.25 - 0.1
  })

  it('resolves the invoice for a memo embedded in longer text', () => {
    const row = lines.find((l) => l.includes('INV-002 venue'))
    expect(row).toContain('INV-002')
  })

  it('quotes memos containing commas or quotes', () => {
    const tricky = buildLedger(
      [log('TransferWithMemo', { from: DONOR, to: ACCOUNT, value: 1n, memo: memo('a,b "c"') }, 1n)],
      ACCOUNT,
    )
    const out = toCsv(tricky)
    expect(out).toContain('"a,b ""c"""')
    // One header line and one data line - the comma must not split the row.
    expect(out.split('\n')).toHaveLength(2)
  })
})

describe('statement', () => {
  const s = statement(LEDGER, { onChainBalance: 102_400_000n })

  it('separates receipts, payments and zone movements', () => {
    expect(s.received).toBe(3_250_000n)
    expect(s.paid).toBe(850_000n)
    expect(s.deposited).toBe(100_000_000n)
    expect(s.balance).toBe(102_400_000n)
  })

  it('reconciles against the chain', () => {
    expect(s.reconciliation?.reconciled).toBe(true)
    expect(s.reconciliation?.difference).toBe(0n)
  })

  it('reports drift rather than hiding it', () => {
    const drifted = statement(LEDGER, { onChainBalance: 1n })
    expect(drifted.reconciliation?.reconciled).toBe(false)
    expect(renderStatement(drifted)).toContain('DRIFT')
  })

  it('omits reconciliation when no chain balance is supplied', () => {
    expect(statement(LEDGER).reconciliation).toBeNull()
  })

  it('aggregates counterparties', () => {
    const vendor = s.counterparties.find((c) => c.address === VENDOR.toLowerCase())
    expect(vendor?.paid).toBe(850_000n)
    const donor = s.counterparties.find((c) => c.address === DONOR.toLowerCase())
    expect(donor?.received).toBe(3_250_000n)
  })

  it('handles an empty ledger without throwing', () => {
    const empty = statement(buildLedger([], ACCOUNT), { onChainBalance: 0n })
    expect(empty.entryCount).toBe(0)
    expect(empty.opened).toBeNull()
    expect(empty.reconciliation?.reconciled).toBe(true)
  })
})

describe('exceptions', () => {
  const exc = exceptions(LEDGER, INVOICES)

  it('flags an incoming payment whose memo matches no invoice we issued', () => {
    expect(exc.unmatched.map((m) => m.entry.memo)).toContain('random note')
  })

  it('does not flag an outgoing payment quoting a supplier reference', () => {
    // Our register holds invoices we issued. A payment to a vendor quoting
    // their number is normal, and calling it an exception trains the reader
    // to ignore the list.
    const withSupplier = exceptions(LEDGER, INVOICES, ['INV-2026-088'])
    expect(withSupplier.unmatched.every((m) => m.entry.direction === 'receipt')).toBe(true)
  })

  it('only counts sales invoices as unpaid', () => {
    const withSupplier = exceptions(LEDGER, INVOICES, ['SUP-1'])
    expect(withSupplier.unpaidInvoices).not.toContain('SUP-1')
  })

  it('flags payments with no memo', () => {
    expect(exc.missingMemo).toHaveLength(1)
    expect(exc.missingMemo[0]!.amount).toBe(250_000n)
  })

  it('flags invoices nothing paid', () => {
    expect(exc.unpaidInvoices).toEqual(['INV-003'])
  })

  it('flags an invoice referenced twice', () => {
    // Either a duplicate payment or a split; both need a human to look.
    const dup = exc.duplicated.find((d) => d.invoice === 'INV-002')
    expect(dup?.entries).toHaveLength(2)
  })

  it('ignores zone deposits, which carry no invoice', () => {
    expect(exc.missingMemo.some((e) => e.direction === 'deposit')).toBe(false)
  })
})

describe('rendering', () => {
  it('surfaces the exception count in the text statement', () => {
    const text = renderStatement(statement(LEDGER, { onChainBalance: 102_400_000n }), exceptions(LEDGER, INVOICES))
    expect(text).toContain('RECONCILED')
    expect(text).toContain('exceptions:')
    expect(text).toContain('INV-003')
  })

  it('serialises bigints as strings in JSON', () => {
    const json = toJson(statement(LEDGER, { onChainBalance: 102_400_000n }))
    expect(() => JSON.parse(json)).not.toThrow()
    expect(JSON.parse(json).statement.balance).toBe('102400000')
  })
})
