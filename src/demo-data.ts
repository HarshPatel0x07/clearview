/**
 * A month of trading for a small consultancy, as TIP-20 events.
 *
 * Shapes match the real logs `eth_getLogs` returns from a Tempo Zone exactly -
 * `Transfer`, `TransferWithMemo`, `Mint`, `Burn` with the same field names - so
 * the same `classify()` path serves this and live data. When the zone deposit
 * is unblocked, only the source changes.
 *
 * The dataset is deliberately imperfect. A demo where every payment matches an
 * invoice and the balance ties to the penny proves only that the happy path
 * works, which is the least interesting thing about an auditing tool. So it
 * contains, on purpose:
 *
 *   - a client who paid with no memo at all
 *   - a memo quoting an invoice that is not in the register
 *   - one invoice paid twice, in two instalments
 *   - an invoice nobody has paid
 *   - a transfer to ourselves, which must not be counted as income
 *
 * Those five are what the exception report exists to surface.
 */

import type { Ledger } from './ledger.js'
import { buildLedger } from './ledger.js'

export const ACCOUNT = '0xb4BB1aF3c66381EbA6d7FbDA4e8184AeEC759e68' as const
export const PATH_USD = '0x20c0000000000000000000000000000000000000' as const

/** Counterparties, named so a statement reads like a statement. */
export const PARTIES = {
  northwind: '0x1111111111111111111111111111111111111111',
  acme: '0x2222222222222222222222222222222222222222',
  belmont: '0x3333333333333333333333333333333333333333',
  cloudHost: '0x4444444444444444444444444444444444444444',
  designer: '0x5555555555555555555555555555555555555555',
} as const

export const LABELS: Record<string, string> = {
  [PARTIES.northwind.toLowerCase()]: 'Northwind Trading',
  [PARTIES.acme.toLowerCase()]: 'Acme Logistics',
  [PARTIES.belmont.toLowerCase()]: 'Belmont Group',
  [PARTIES.cloudHost.toLowerCase()]: 'CloudHost (hosting)',
  [PARTIES.designer.toLowerCase()]: 'J. Okafor (contractor)',
  [ACCOUNT.toLowerCase()]: 'us',
}

/**
 * Invoices **we issued**. Matched against money coming in.
 */
export const INVOICE_REGISTER = [
  'INV-2026-091',
  'INV-2026-092',
  'INV-2026-093',
  'INV-2026-094',
  'INV-2026-095',
] as const

/**
 * Our suppliers' references. Matched against money going out.
 *
 * Kept separate from the sales register because conflating the two turns every
 * ordinary supplier payment into a false exception.
 */
export const PURCHASE_REGISTER = [
  'CloudHost Sep',
  'JO-2026-14',
] as const

const usd = (amount: number): bigint => BigInt(Math.round(amount * 1_000_000))

/**
 * 32-byte right-padded memo, exactly as TIP-20 carries it.
 *
 * Hand-rolled rather than using `Buffer`, which is a Node global. This module
 * is imported by the dashboard as well as the CLI and the tests, and a
 * `Buffer` reference throws at module load in a browser - which renders a
 * blank page with the real error only visible in the console.
 */
function memo(text: string): `0x${string}` {
  let hex = ''
  for (const char of text) {
    const code = char.codePointAt(0)!
    if (code > 0x7f) throw new Error(`memo must be ASCII: ${text}`)
    hex += code.toString(16).padStart(2, '0')
  }
  if (hex.length > 64) throw new Error(`memo too long for 32 bytes: ${text}`)
  return `0x${hex.padEnd(64, '0')}` as `0x${string}`
}

type Event = {
  transactionHash: `0x${string}`
  logIndex: number
  blockNumber: bigint
  address: `0x${string}`
  eventName: string
  args: Record<string, unknown>
}

let cursor = 0
function event(eventName: string, args: Record<string, unknown>): Event {
  cursor += 1
  return {
    transactionHash: `0x${cursor.toString(16).padStart(64, '0')}` as `0x${string}`,
    logIndex: 0,
    blockNumber: BigInt(1000 + cursor * 7),
    address: PATH_USD,
    eventName,
    args,
  }
}

const received = (from: string, amount: number, note?: string) =>
  note
    ? event('TransferWithMemo', { from, to: ACCOUNT, value: usd(amount), memo: memo(note) })
    : event('Transfer', { from, to: ACCOUNT, value: usd(amount) })

const paid = (to: string, amount: number, note?: string) =>
  note
    ? event('TransferWithMemo', { from: ACCOUNT, to, value: usd(amount), memo: memo(note) })
    : event('Transfer', { from: ACCOUNT, to, value: usd(amount) })

/**
 * The month, in order.
 *
 * Totals, so the statement can be checked by hand rather than trusted:
 *   opening deposit          2,000.00
 *   received                 7,150.00
 *   paid out                 1,430.00
 *   withdrawn                  500.00
 *   -----------------------------------
 *   closing balance          7,220.00
 */
export const DEMO_EVENTS: Event[] = [
  // Working capital moved from the public chain into the zone.
  event('Mint', { to: ACCOUNT, value: usd(2_000) }),

  // Ordinary invoiced work, cleanly referenced.
  received(PARTIES.northwind, 1_800, 'INV-2026-091'),
  received(PARTIES.acme, 2_400, 'INV-2026-092 Q3 retainer'),

  // Hosting, a normal operating cost.
  paid(PARTIES.cloudHost, 180, 'CloudHost Sep'),

  // EXCEPTION: Belmont paid in two instalments against one invoice. Not
  // necessarily wrong - but a duplicate reference always needs a human.
  received(PARTIES.belmont, 600, 'INV-2026-093'),
  received(PARTIES.belmont, 650, 'INV-2026-093 balance'),

  // A subcontractor, invoiced to us.
  paid(PARTIES.designer, 1_250, 'JO-2026-14 design work'),

  // EXCEPTION: no memo at all. Real clients do this constantly and it is the
  // single most common reason books cannot be reconciled automatically.
  received(PARTIES.northwind, 950),

  // EXCEPTION: quotes an invoice that is not in our register. Either a typo,
  // or a payment meant for somebody else.
  received(PARTIES.acme, 400, 'INV-2026-088 adjustment'),

  // Moving funds between our own addresses. Must net to zero; counting it as
  // income would inflate revenue by 300.
  event('Transfer', { from: ACCOUNT, to: ACCOUNT, value: usd(300) }),

  received(PARTIES.belmont, 350, 'INV-2026-094'),

  // Cash taken back out to the public chain.
  event('Burn', { from: ACCOUNT, value: usd(500) }),
]

/** Balance the chain would report, for reconciliation. */
export const ON_CHAIN_BALANCE = usd(2_000 + 7_150 - 1_430 - 500)

export function demoLedger(): Ledger {
  return buildLedger(DEMO_EVENTS, ACCOUNT)
}

/** Human name for a counterparty, falling back to a short address. */
export function label(address: string | null): string {
  if (!address) return '-'
  return LABELS[address.toLowerCase()] ?? `${address.slice(0, 8)}…${address.slice(-4)}`
}
