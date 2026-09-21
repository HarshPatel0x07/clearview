import * as Tabs from '@radix-ui/react-tabs'
import { useMemo } from 'react'

import {
  INVOICE_REGISTER,
  ON_CHAIN_BALANCE,
  PURCHASE_REGISTER,
  demoLedger,
  label,
} from '../../src/demo-data.js'
import { format, matchInvoices, runningBalance, signedAmount } from '../../src/ledger.js'
import type { LedgerEntry } from '../../src/ledger.js'
import { exceptions, statement, toCsv } from '../../src/report.js'
import { KeyLifecycle } from './KeyLifecycle.js'

/** Split a figure so the fractional part can be set quieter than the whole. */
function Amount({ value, className = '' }: { value: bigint; className?: string }) {
  const [whole, frac] = format(value).split('.')
  return (
    <span className={`figure ${className}`}>
      {whole}
      <span style={{ color: 'var(--ink-tertiary)' }}>.{frac}</span>
    </span>
  )
}

export function App() {
  const ledger = useMemo(() => demoLedger(), [])
  const exc = useMemo(() => exceptions(ledger, INVOICE_REGISTER, PURCHASE_REGISTER), [ledger])
  const stmt = useMemo(() => statement(ledger, { onChainBalance: ON_CHAIN_BALANCE }), [ledger])
  const invoiceOf = useMemo(() => {
    const all = matchInvoices(ledger, [...INVOICE_REGISTER, ...PURCHASE_REGISTER])
    return new Map(all.map((m) => [`${m.entry.txHash}:${m.entry.logIndex}`, m.invoice]))
  }, [ledger])

  const issues =
    exc.unmatched.length + exc.missingMemo.length + exc.unpaidInvoices.length + exc.duplicated.length
  const reconciled = stmt.reconciliation?.reconciled ?? false

  function downloadCsv() {
    const csv = toCsv(ledger, { invoices: [...INVOICE_REGISTER, ...PURCHASE_REGISTER] })
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'clearview-ledger.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="wrap">
      <div className="masthead">
        <h1>Clearview</h1>
        <span className="account">
          {ledger.account.slice(0, 10)}…{ledger.account.slice(-6)}
        </span>
      </div>
      <p className="strapline">
        Books reconstructed from a read-only key. The auditor sees everything here and provably
        cannot move a penny.
      </p>

      <div className="provenance">
        <span className="marker">Provenance</span>
        <span>
          <strong>Ledger figures are from seeded events.</strong> Reading a live Tempo Zone needs
          funds inside the zone, and the deposit call reverts with no reason string —{' '}
          <a href="https://github.com/tempoxyz/zones/issues/1482" target="_blank" rel="noreferrer">
            tempoxyz/zones#1482
          </a>
          . Event shapes are identical to <code>eth_getLogs</code>, so only the source differs.{' '}
          <strong>The Access Key tab is live on Moderato</strong> and writes real transactions.
        </span>
      </div>

      <Tabs.Root defaultValue="statement">
        <Tabs.List className="tablist" aria-label="Views">
          <Tabs.Trigger className="tab" value="statement">
            Statement
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="ledger">
            Ledger
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="exceptions">
            Exceptions
            {issues > 0 && <span className="badge">{issues}</span>}
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="counterparties">
            Counterparties
          </Tabs.Trigger>
          <Tabs.Trigger className="tab" value="key">
            Access Key
          </Tabs.Trigger>
        </Tabs.List>

        {/* ---- statement: one number leads --------------------------------- */}
        <Tabs.Content value="statement">
          <div className="headline">
            <div className="label">Balance in zone</div>
            <div className="amount">
              {format(stmt.balance)}
              <span className="unit">pathUSD</span>
            </div>
            <div className="asof">
              {reconciled ? (
                <>
                  <span className="state">Reconciled</span> against the chain · as of block{' '}
                  {String(stmt.closed)}
                </>
              ) : (
                <>
                  <span className="state bad">Drift</span> of{' '}
                  {format(stmt.reconciliation?.difference ?? 0n)} · as of block {String(stmt.closed)}
                </>
              )}
            </div>
          </div>

          <div className="figures">
            <div>
              <div className="k">Deposited into zone</div>
              <div className="v">
                <Amount value={stmt.deposited} />
              </div>
            </div>
            <div>
              <div className="k">Received</div>
              <div className="v">
                <Amount value={stmt.received} />
              </div>
            </div>
            <div>
              <div className="k">Paid out</div>
              <div className="v">
                <Amount value={stmt.paid} />
              </div>
            </div>
            <div>
              <div className="k">Withdrawn</div>
              <div className="v">
                <Amount value={stmt.withdrawn} />
              </div>
            </div>
            <div>
              <div className="k">Entries</div>
              <div className="v figure">{stmt.entryCount}</div>
            </div>
            <div>
              <div className="k">Exceptions</div>
              <div className="v figure" style={{ color: issues ? 'var(--attention)' : undefined }}>
                {issues}
              </div>
            </div>
          </div>

          <p className="footnote">
            Every figure was derived from chain events alone. Nothing came from the business's own
            accounting system except the invoice register it is being checked against — which is
            the point. The books are rebuilt independently, then compared with the balance the
            chain reports; an audit tool that cannot detect its own drift is worse than none.
          </p>
        </Tabs.Content>

        {/* ---- ledger: a table, set properly ------------------------------- */}
        <Tabs.Content value="ledger">
          <div className="section-head">
            <h2>Ledger</h2>
            <span className="meta">
              {ledger.entries.length} entries · oldest first
              <button className="btn" style={{ marginLeft: 14 }} onClick={downloadCsv}>
                Export CSV
              </button>
            </span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Direction</th>
                <th>Counterparty</th>
                <th>Memo</th>
                <th>Invoice</th>
                <th className="right">Amount</th>
                <th className="right">Balance</th>
              </tr>
            </thead>
            <tbody>
              {runningBalance(ledger).map(([e, bal]) => (
                <LedgerRow
                  key={`${e.txHash}:${e.logIndex}`}
                  entry={e}
                  balance={bal}
                  invoice={invoiceOf.get(`${e.txHash}:${e.logIndex}`) ?? null}
                />
              ))}
            </tbody>
          </table>
        </Tabs.Content>

        {/* ---- exceptions: a work queue ------------------------------------ */}
        <Tabs.Content value="exceptions">
          <div className="section-head">
            <h2>Exceptions</h2>
            <span className="meta">{issues} needing a human</span>
          </div>

          {issues === 0 && (
            <div className="empty">
              Nothing to review. Every payment matched an invoice and the balance ties to the chain.
            </div>
          )}

          {exc.unmatched.map((m) => (
            <div className="queue-row" key={`${m.entry.txHash}:${m.entry.logIndex}`}>
              <div>
                <div className="kind">Unattributed receipt</div>
                <div className="what">
                  {label(m.entry.counterparty)} paid, quoting “{m.entry.memo}”
                </div>
              </div>
              <div className="amount figure">{format(m.entry.amount)}</div>
              <div className="action">
                That invoice is not in the register. Either a typo on the payer's side, or money
                intended for somebody else — confirm before recognising it as revenue.
              </div>
            </div>
          ))}

          {exc.missingMemo.map((e) => (
            <div className="queue-row" key={`${e.txHash}:${e.logIndex}`}>
              <div>
                <div className="kind">No reference</div>
                <div className="what">
                  {e.direction === 'receipt' ? 'Received from' : 'Paid to'}{' '}
                  {label(e.counterparty)} with no memo
                </div>
              </div>
              <div className="amount figure">{format(e.amount)}</div>
              <div className="action">
                Nothing to reconcile against. The most common reason books cannot be matched
                automatically — ask the counterparty which invoice it settles.
              </div>
            </div>
          ))}

          {exc.duplicated.map((d) => (
            <div className="queue-row" key={d.invoice}>
              <div>
                <div className="kind">Referenced more than once</div>
                <div className="what">
                  {d.invoice} cited by {d.entries.length} separate payments
                </div>
              </div>
              <div className="amount figure">
                {format(d.entries.reduce((s, e) => s + e.amount, 0n))}
              </div>
              <div className="action">
                Instalments against one invoice, or the same invoice paid twice. Check the invoice
                total against the sum above.
              </div>
            </div>
          ))}

          {exc.unpaidInvoices.map((i) => (
            <div className="queue-row" key={i}>
              <div>
                <div className="kind">Outstanding</div>
                <div className="what">{i} has no matching payment</div>
              </div>
              <div className="amount quiet">—</div>
              <div className="action">Issued, and nothing has arrived against it. Chase or write off.</div>
            </div>
          ))}
        </Tabs.Content>

        {/* ---- counterparties ---------------------------------------------- */}
        <Tabs.Content value="counterparties">
          <div className="section-head">
            <h2>Counterparties</h2>
            <span className="meta">{stmt.counterparties.length} parties</span>
          </div>
          <table>
            <thead>
              <tr>
                <th>Party</th>
                <th className="right">Received from</th>
                <th className="right">Paid to</th>
                <th className="right">Net</th>
              </tr>
            </thead>
            <tbody>
              {[...stmt.counterparties]
                .sort((a, b) => {
                  const av = a.received - a.paid
                  const bv = b.received - b.paid
                  const abs = (x: bigint) => (x < 0n ? -x : x)
                  return abs(bv) > abs(av) ? 1 : abs(bv) < abs(av) ? -1 : 0
                })
                .map((c) => {
                  const net = c.received - c.paid
                  return (
                    <tr key={c.address}>
                      <td>{label(c.address)}</td>
                      <td className="money">{c.received ? format(c.received) : '—'}</td>
                      <td className="money">{c.paid ? format(c.paid) : '—'}</td>
                      <td className={`money ${net > 0n ? 'pos' : net < 0n ? 'neg' : ''}`}>
                        {format(net)}
                      </td>
                    </tr>
                  )
                })}
            </tbody>
          </table>
        </Tabs.Content>

        <Tabs.Content value="key">
          <KeyLifecycle />
        </Tabs.Content>
      </Tabs.Root>
    </div>
  )
}

function LedgerRow({
  entry,
  balance,
  invoice,
}: {
  entry: LedgerEntry
  balance: bigint
  invoice: string | null
}) {
  const amt = signedAmount(entry)
  return (
    <tr>
      <td className="direction">{entry.direction}</td>
      <td>{label(entry.counterparty)}</td>
      <td className={entry.memo ? '' : 'quiet'}>
        {entry.memo ?? (entry.direction === 'internal' ? 'own address' : 'no memo')}
      </td>
      <td>
        {invoice ? (
          <span className="chip matched">{invoice}</span>
        ) : entry.memo && entry.direction === 'receipt' ? (
          <span className="chip flagged">unrecognised</span>
        ) : (
          <span className="chip">—</span>
        )}
      </td>
      {/* The sign carries direction as well as the colour, so the meaning
          survives for anyone who cannot distinguish the hues. */}
      <td className={`money ${amt > 0n ? 'pos' : amt < 0n ? 'neg' : 'quiet'}`}>{format(amt)}</td>
      <td className="money quiet">{format(balance)}</td>
    </tr>
  )
}
