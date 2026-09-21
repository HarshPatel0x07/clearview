import { describe, expect, it } from 'vitest'

import {
  balanceOf,
  buildLedger,
  classify,
  decodeMemo,
  encodeMemo,
  format,
  matchInvoices,
  reconcile,
  runningBalance,
  signedAmount,
  totals,
} from '../src/ledger.js'

const ACCOUNT = '0xb4BB1aF3c66381EbA6d7FbDA4e8184AeEC759e68' as const
const DONOR = '0x1111111111111111111111111111111111111111' as const
const VENDOR = '0x2222222222222222222222222222222222222222' as const
const PATH_USD = '0x20c0000000000000000000000000000000000000' as const

// The production encoder, so the fixtures exercise the shipped code path
// rather than a Buffer-based lookalike that only works in Node.
const memo = encodeMemo

const log = (
  eventName: string,
  args: Record<string, unknown>,
  blockNumber = 1n,
  logIndex = 0,
) => ({
  transactionHash: `0x${blockNumber.toString(16).padStart(64, '0')}` as `0x${string}`,
  logIndex,
  blockNumber,
  address: PATH_USD,
  eventName,
  args,
})

/** A nonprofit: deposit in, three donations, one vendor payment. */
const LOGS = [
  log('Mint', { to: ACCOUNT, value: 100_000_000n }, 1n),
  log('TransferWithMemo', { from: DONOR, to: ACCOUNT, value: 2_500_000n, memo: memo('Donation - Q3 appeal') }, 2n),
  log('TransferWithMemo', { from: DONOR, to: ACCOUNT, value: 1_000_000n, memo: memo('INV-2026-114') }, 3n),
  log('TransferWithMemo', { from: ACCOUNT, to: VENDOR, value: 750_000n, memo: memo('INV-2026-114 venue hire') }, 4n),
  log('Transfer', { from: DONOR, to: ACCOUNT, value: 250_000n }, 5n),
]

describe('classification', () => {
  it('reads a receipt when the account is the recipient', () => {
    const e = classify(LOGS[1]!, ACCOUNT)!
    expect(e.direction).toBe('receipt')
    expect(e.amount).toBe(2_500_000n)
    expect(e.counterparty).toBe(DONOR)
  })

  it('reads a payment when the account is the sender', () => {
    const e = classify(LOGS[3]!, ACCOUNT)!
    expect(e.direction).toBe('payment')
    expect(e.counterparty).toBe(VENDOR)
    expect(signedAmount(e)).toBe(-750_000n)
  })

  it('treats Mint as entering the zone and Burn as leaving', () => {
    expect(classify(LOGS[0]!, ACCOUNT)!.direction).toBe('deposit')
    const burn = classify(log('Burn', { from: ACCOUNT, value: 5_000_000n }), ACCOUNT)!
    expect(burn.direction).toBe('withdrawal')
    expect(signedAmount(burn)).toBe(-5_000_000n)
  })

  it('does not invent income from a self-transfer', () => {
    const e = classify(log('Transfer', { from: ACCOUNT, to: ACCOUNT, value: 9n }), ACCOUNT)!
    expect(e.direction).toBe('internal')
    expect(signedAmount(e)).toBe(0n)
  })

  it('ignores a transfer between two other parties', () => {
    expect(classify(log('Transfer', { from: DONOR, to: VENDOR, value: 1n }), ACCOUNT)).toBeNull()
  })

  it('ignores event types that are not value movements', () => {
    expect(classify(log('Approval', { owner: ACCOUNT, spender: VENDOR, value: 1n }), ACCOUNT)).toBeNull()
  })

  it('matches addresses case-insensitively', () => {
    const e = classify(log('Transfer', { from: DONOR, to: ACCOUNT.toLowerCase(), value: 5n }), ACCOUNT)
    expect(e?.direction).toBe('receipt')
  })
})

describe('memo decoding', () => {
  it('strips the zero padding TIP-20 adds', () => {
    expect(decodeMemo(memo('INV-2026-114'))).toBe('INV-2026-114')
  })

  it('returns null for an empty memo', () => {
    expect(decodeMemo('0x' + '00'.repeat(32))).toBeNull()
    expect(decodeMemo('0x')).toBeNull()
    expect(decodeMemo(null)).toBeNull()
  })

  it('leaves binary memos undecoded rather than emitting mojibake', () => {
    // A hash in the memo field is not text and must not be shown as though it were.
    expect(decodeMemo('0x' + 'de'.repeat(32))).toBeNull()
  })

  it('keeps the raw bytes so an auditor can check the decoding', () => {
    const e = classify(LOGS[1]!, ACCOUNT)!
    expect(e.memoRaw).toBe(memo('Donation - Q3 appeal'))
  })
})

describe('ledger', () => {
  const ledger = buildLedger(LOGS, ACCOUNT)

  it('includes every entry that affects the account', () => {
    expect(ledger.entries).toHaveLength(5)
  })

  it('orders oldest first', () => {
    const blocks = ledger.entries.map((e) => e.blockNumber)
    expect(blocks).toEqual([...blocks].sort((a, b) => (a < b ? -1 : 1)))
  })

  it('totals receipts and payments separately', () => {
    const t = totals(ledger)
    expect(t.received).toBe(3_750_000n)
    expect(t.paid).toBe(750_000n)
    expect(t.deposited).toBe(100_000_000n)
  })

  it('balances to deposits plus receipts minus payments', () => {
    // 100 in + 3.75 received - 0.75 paid = 103.00
    expect(balanceOf(ledger)).toBe(103_000_000n)
    expect(format(balanceOf(ledger))).toBe('103.000000')
  })

  it('never goes negative on a well-formed history', () => {
    for (const [, balance] of runningBalance(ledger)) expect(balance >= 0n).toBe(true)
  })

  it('can scope to a single token', () => {
    const other = '0x20c0000000000000000000000000000000000001' as const
    expect(balanceOf(ledger, other)).toBe(0n)
    expect(balanceOf(ledger, PATH_USD)).toBe(103_000_000n)
  })
})

describe('reconciliation', () => {
  const ledger = buildLedger(LOGS, ACCOUNT)

  it('agrees with the chain when the books are right', () => {
    const r = reconcile(ledger, 103_000_000n)
    expect(r.reconciled).toBe(true)
    expect(r.difference).toBe(0n)
  })

  it('detects drift, which is the point of the tool', () => {
    const r = reconcile(ledger, 999n)
    expect(r.reconciled).toBe(false)
    expect(r.difference).toBe(103_000_000n - 999n)
  })
})

describe('invoice matching', () => {
  const ledger = buildLedger(LOGS, ACCOUNT)
  const matches = matchInvoices(ledger, ['INV-2026-114', 'INV-2026-115'])

  it('matches a memo that is exactly the invoice reference', () => {
    const m = matches.find((x) => x.entry.memo === 'INV-2026-114')
    expect(m?.invoice).toBe('INV-2026-114')
  })

  it('matches a reference embedded in a longer memo', () => {
    const m = matches.find((x) => x.entry.memo === 'INV-2026-114 venue hire')
    expect(m?.invoice).toBe('INV-2026-114')
  })

  it('reports unmatched entries rather than dropping them', () => {
    // Silently discarding what it cannot explain would not be a reconciliation.
    expect(matches).toHaveLength(ledger.entries.length)
    const unmatched = matches.filter((m) => m.invoice === null)
    expect(unmatched.length).toBeGreaterThan(0)
  })
})

describe('formatting', () => {
  it('renders 6 decimals, not 18', () => {
    expect(format(1_000_000n)).toBe('1.000000')
    expect(format(1n)).toBe('0.000001')
    expect(format(-750_000n)).toBe('-0.750000')
    expect(format(0n)).toBe('0.000000')
  })
})
