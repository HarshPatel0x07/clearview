/**
 * The whole product in one command: `npm run demo`
 *
 * Reconstructs a month of books from TIP-20 events, matches payments to
 * invoices, surfaces what does not tie out, reconciles against the chain, and
 * writes a CSV an accountant can open.
 *
 * The data is seeded. That is stated in the output rather than buried, because
 * the zone deposit needed to read live data currently reverts - tracked at
 * tempoxyz/zones#1482. The event shapes are identical to what `eth_getLogs`
 * returns from a Zone, so the code path is the same either way.
 */

import { writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  DEMO_EVENTS, INVOICE_REGISTER, ON_CHAIN_BALANCE, PURCHASE_REGISTER, demoLedger, label,
} from '../src/demo-data.js'
import { format, matchInvoices, runningBalance, signedAmount } from '../src/ledger.js'
import { exceptions, renderStatement, statement, toCsv } from '../src/report.js'

const rule = (c = '=') => console.log(c.repeat(78))

function main() {
  const ledger = demoLedger()
  const exc = exceptions(ledger, INVOICE_REGISTER, PURCHASE_REGISTER)
  const stmt = statement(ledger, { onChainBalance: ON_CHAIN_BALANCE })

  rule()
  console.log('CLEARVIEW  -  auditable books for private payments on Tempo')
  rule()
  console.log(`  ${DEMO_EVENTS.length} TIP-20 events  ->  ${ledger.entries.length} ledger entries`)
  console.log('  data: SEEDED. Live zone reads are blocked by tempoxyz/zones#1482.')
  console.log('        Event shapes match eth_getLogs exactly, so the code path is identical.')
  console.log()

  // ---- the ledger, as an accountant would read it -------------------------
  console.log('LEDGER')
  rule('-')
  console.log(
    `  ${'dir'.padEnd(11)}${'amount'.padStart(12)}${'balance'.padStart(13)}  ` +
    `${'counterparty'.padEnd(24)}memo`,
  )
  const matched = new Map(
    matchInvoices(ledger, [...INVOICE_REGISTER, ...PURCHASE_REGISTER]).map((m) => [`${m.entry.txHash}:${m.entry.logIndex}`, m.invoice]),
  )
  for (const [entry, balance] of runningBalance(ledger)) {
    const inv = matched.get(`${entry.txHash}:${entry.logIndex}`)
    const memo = entry.memo ?? (entry.direction === 'internal' ? '(own address)' : '(no memo)')
    const flag = entry.memo && !inv && entry.direction !== 'internal' ? '  <- unrecognised' : ''
    console.log(
      `  ${entry.direction.padEnd(11)}` +
      `${format(signedAmount(entry)).padStart(12)}` +
      `${format(balance).padStart(13)}  ` +
      `${label(entry.counterparty).padEnd(24)}${memo}${flag}`,
    )
  }

  // ---- the statement ------------------------------------------------------
  console.log()
  console.log(renderStatement(stmt, exc))

  // ---- exceptions, in detail ---------------------------------------------
  console.log()
  console.log('EXCEPTIONS IN DETAIL')
  rule('-')
  console.log('  These are the point of the tool. A clean total with a silent exception')
  console.log('  list is worse than no statement at all.')
  console.log()
  for (const m of exc.unmatched) {
    console.log(`  unrecognised memo   ${format(m.entry.amount).padStart(12)}  ` +
                `from ${label(m.entry.counterparty)}  "${m.entry.memo}"`)
  }
  for (const e of exc.missingMemo) {
    console.log(`  no memo             ${format(e.amount).padStart(12)}  ` +
                `${e.direction} ${e.direction === 'receipt' ? 'from' : 'to'} ${label(e.counterparty)}`)
  }
  for (const d of exc.duplicated) {
    const total = d.entries.reduce((s, e) => s + e.amount, 0n)
    console.log(`  paid twice          ${format(total).padStart(12)}  ` +
                `${d.invoice} across ${d.entries.length} payments`)
  }
  for (const i of exc.unpaidInvoices) {
    console.log(`  invoice unpaid                    ${i}`)
  }

  // ---- CSV ----------------------------------------------------------------
  const csv = toCsv(ledger, { invoices: [...INVOICE_REGISTER, ...PURCHASE_REGISTER] })
  const out = resolve(process.cwd(), 'clearview-ledger.csv')
  writeFileSync(out, csv, 'utf8')
  console.log()
  console.log(`  CSV written: ${out}  (${csv.split('\n').length - 1} rows)`)

  // ---- what an auditor is actually trusting -------------------------------
  console.log()
  rule()
  console.log('  Every figure above was derived from chain events alone. Nothing was')
  console.log('  taken from the business\'s own accounting system except the invoice')
  console.log('  register it is being checked against - which is the point.')
  rule()
}

main()
