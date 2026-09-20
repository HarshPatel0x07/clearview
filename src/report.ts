/**
 * Turn a reconciled ledger into the artefacts an accountant actually asks for.
 *
 * This is the half of Clearview that is ordinary and unglamorous, and it is the
 * half that decides whether the tool is usable. A viewing key that produces a
 * list of hex strings is a demo; one that produces a statement, a CSV that opens
 * in Excel, and an exception list is a product.
 *
 * Three outputs:
 *
 *   `toCsv`        - every entry, one row, with the memo and matched invoice
 *   `statement`    - the summary an accountant reads first, reconciled
 *   `exceptions`   - what does not tie out, which is the part that gets looked at
 */

import {
  type InvoiceMatch,
  type Ledger,
  type LedgerEntry,
  type Reconciliation,
  balanceOf,
  format,
  matchInvoices,
  runningBalance,
  signedAmount,
  totals,
} from './ledger.js'

const CSV_COLUMNS = [
  'block',
  'tx_hash',
  'direction',
  'amount',
  'signed_amount',
  'running_balance',
  'token',
  'counterparty',
  'memo',
  'invoice',
] as const

/** Quote a CSV field. Memos are free text and will contain commas and quotes. */
function csvCell(value: string | null): string {
  if (value === null || value === '') return ''
  const needsQuoting = /[",\n\r]/.test(value)
  return needsQuoting ? `"${value.replace(/"/g, '""')}"` : value
}

export type CsvOptions = {
  /** Invoice references to match memos against. */
  invoices?: readonly string[]
}

/**
 * Export the ledger as CSV.
 *
 * Amounts are written as decimal strings rather than numbers so a spreadsheet
 * cannot silently reinterpret them as floats — the whole point of holding money
 * as integers is lost if the export undoes it.
 */
export function toCsv(ledger: Ledger, options: CsvOptions = {}): string {
  const matches = matchInvoices(ledger, options.invoices ?? [])
  const invoiceFor = new Map(
    matches.map((m) => [`${m.entry.txHash}:${m.entry.logIndex}`, m.invoice]),
  )

  const rows = runningBalance(ledger).map(([entry, balance]) =>
    [
      String(entry.blockNumber),
      entry.txHash,
      entry.direction,
      format(entry.amount),
      format(signedAmount(entry)),
      format(balance),
      entry.token,
      entry.counterparty ?? '',
      csvCell(entry.memo),
      csvCell(invoiceFor.get(`${entry.txHash}:${entry.logIndex}`) ?? null),
    ].join(','),
  )

  return [CSV_COLUMNS.join(','), ...rows].join('\n')
}

export type Statement = {
  account: `0x${string}`
  entryCount: number
  opened: bigint | null
  closed: bigint | null
  received: bigint
  paid: bigint
  deposited: bigint
  withdrawn: bigint
  balance: bigint
  reconciliation: Reconciliation | null
  counterparties: Array<{ address: string; received: bigint; paid: bigint }>
}

/** Build the summary an accountant reads before anything else. */
export function statement(
  ledger: Ledger,
  options: { onChainBalance?: bigint; token?: `0x${string}` } = {},
): Statement {
  const t = totals(ledger, options.token)
  const scoped = options.token
    ? ledger.entries.filter((e) => e.token.toLowerCase() === options.token!.toLowerCase())
    : ledger.entries

  const byCounterparty = new Map<string, { received: bigint; paid: bigint }>()
  for (const entry of scoped) {
    if (!entry.counterparty) continue
    const key = entry.counterparty.toLowerCase()
    const row = byCounterparty.get(key) ?? { received: 0n, paid: 0n }
    if (entry.direction === 'receipt') row.received += entry.amount
    if (entry.direction === 'payment') row.paid += entry.amount
    byCounterparty.set(key, row)
  }

  return {
    account: ledger.account,
    entryCount: scoped.length,
    opened: scoped.length ? scoped[0]!.blockNumber : null,
    closed: scoped.length ? scoped[scoped.length - 1]!.blockNumber : null,
    received: t.received,
    paid: t.paid,
    deposited: t.deposited,
    withdrawn: t.withdrawn,
    balance: t.balance,
    reconciliation:
      options.onChainBalance === undefined
        ? null
        : {
            derived: t.balance,
            onChain: options.onChainBalance,
            difference: t.balance - options.onChainBalance,
            reconciled: t.balance === options.onChainBalance,
          },
    counterparties: [...byCounterparty.entries()]
      .map(([address, v]) => ({ address, ...v }))
      .sort((a, b) => (b.received + b.paid > a.received + a.paid ? 1 : -1)),
  }
}

export type Exceptions = {
  /** Payments and receipts whose memo matched no known invoice. */
  unmatched: InvoiceMatch[]
  /** Entries carrying no memo at all, so nothing to reconcile against. */
  missingMemo: LedgerEntry[]
  /** Invoices in the register that no payment references. */
  unpaidInvoices: string[]
  /** Invoices referenced by more than one entry - a duplicate payment, or a split. */
  duplicated: Array<{ invoice: string; entries: LedgerEntry[] }>
}

/**
 * Everything that does not tie out.
 *
 * An audit tool earns its place by surfacing the awkward cases, not by
 * presenting a tidy total. A clean statement with a silent exception list is
 * worse than no statement.
 */
export function exceptions(ledger: Ledger, invoices: readonly string[]): Exceptions {
  const matches = matchInvoices(ledger, invoices)
  const valueMoving = matches.filter(
    (m) => m.entry.direction === 'receipt' || m.entry.direction === 'payment',
  )

  const seen = new Map<string, LedgerEntry[]>()
  for (const m of valueMoving) {
    if (!m.invoice) continue
    seen.set(m.invoice, [...(seen.get(m.invoice) ?? []), m.entry])
  }

  return {
    unmatched: valueMoving.filter((m) => m.invoice === null && m.entry.memo !== null),
    missingMemo: valueMoving.filter((m) => m.entry.memo === null).map((m) => m.entry),
    unpaidInvoices: invoices.filter((i) => !seen.has(i)),
    duplicated: [...seen.entries()]
      .filter(([, entries]) => entries.length > 1)
      .map(([invoice, entries]) => ({ invoice, entries })),
  }
}

/** Render the statement as plain text, for the console and for the demo video. */
export function renderStatement(s: Statement, exc?: Exceptions): string {
  const line = '-'.repeat(66)
  const row = (label: string, value: string) => `${label.padEnd(24)}${value.padStart(18)}`

  const out = [
    '='.repeat(66),
    'CLEARVIEW  -  books reconstructed from a read-only key',
    '='.repeat(66),
    `account   ${s.account}`,
    `entries   ${s.entryCount}` + (s.opened !== null ? `   blocks ${s.opened}-${s.closed}` : ''),
    '',
    row('deposited into zone', format(s.deposited)),
    row('received', format(s.received)),
    row('paid out', format(s.paid)),
    row('withdrawn from zone', format(s.withdrawn)),
    line,
    row('balance', format(s.balance)),
  ]

  if (s.counterparties.length) {
    out.push('', 'counterparties:')
    for (const c of s.counterparties.slice(0, 8)) {
      out.push(
        `  ${c.address.slice(0, 10)}...${c.address.slice(-6)}  ` +
          `in ${format(c.received).padStart(14)}   out ${format(c.paid).padStart(14)}`,
      )
    }
  }

  if (exc) {
    const issues =
      exc.unmatched.length + exc.missingMemo.length + exc.unpaidInvoices.length + exc.duplicated.length
    out.push('', `exceptions: ${issues === 0 ? 'none' : issues}`)
    if (exc.unmatched.length) out.push(`  ${exc.unmatched.length} payment(s) with an unrecognised memo`)
    if (exc.missingMemo.length) out.push(`  ${exc.missingMemo.length} payment(s) with no memo`)
    if (exc.unpaidInvoices.length)
      out.push(`  ${exc.unpaidInvoices.length} invoice(s) with no matching payment: ${exc.unpaidInvoices.join(', ')}`)
    for (const d of exc.duplicated)
      out.push(`  invoice ${d.invoice} referenced by ${d.entries.length} payments`)
  }

  if (s.reconciliation) {
    const r = s.reconciliation
    out.push(
      '',
      '='.repeat(66),
      r.reconciled
        ? `RECONCILED  ledger ${format(r.derived)} = chain ${format(r.onChain)}`
        : `DRIFT  ledger ${format(r.derived)} vs chain ${format(r.onChain)}  (${format(r.difference)})`,
      '='.repeat(66),
    )
    if (!r.reconciled) {
      out.push(
        '',
        'The books disagree with the chain. That is the tool working, not failing;',
        'an audit tool that cannot detect its own drift is worse than none.',
      )
    }
  }

  return out.join('\n')
}

/** Export the statement as JSON, for a machine-readable disclosure package. */
export function toJson(s: Statement, exc?: Exceptions): string {
  return JSON.stringify(
    { statement: s, exceptions: exc ?? null },
    (_key, value) => (typeof value === 'bigint' ? value.toString() : value),
    2,
  )
}
