import { useMemo, useState } from 'react'

import {
  INVOICE_REGISTER,
  ON_CHAIN_BALANCE,
  PURCHASE_REGISTER,
  demoLedger,
  label,
} from '../../src/demo-data.js'
import { format, matchInvoices, runningBalance, signedAmount } from '../../src/ledger.js'
import { exceptions, statement, toCsv } from '../../src/report.js'
import { KeyLifecycle } from './KeyLifecycle.js'

type Tab = 'statement' | 'ledger' | 'exceptions' | 'counterparties' | 'key'

export function App() {
  const [tab, setTab] = useState<Tab>('statement')

  // Everything below is computed by the same pure functions the CLI and the
  // tests use. No ledger logic lives in this file.
  const ledger = useMemo(() => demoLedger(), [])
  const exc = useMemo(
    () => exceptions(ledger, INVOICE_REGISTER, PURCHASE_REGISTER),
    [ledger],
  )
  const stmt = useMemo(
    () => statement(ledger, { onChainBalance: ON_CHAIN_BALANCE }),
    [ledger],
  )
  const invoiceOf = useMemo(() => {
    const all = matchInvoices(ledger, [...INVOICE_REGISTER, ...PURCHASE_REGISTER])
    return new Map(all.map((m) => [`${m.entry.txHash}:${m.entry.logIndex}`, m.invoice]))
  }, [ledger])

  const issues =
    exc.unmatched.length + exc.missingMemo.length + exc.unpaidInvoices.length + exc.duplicated.length

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
      <header>
        <h1>Clearview</h1>
        <p>
          Books reconstructed from a read-only key. The auditor can see everything here and
          provably cannot move a penny.
        </p>
      </header>

      {/* Stated before any number is shown, not in a footnote. */}
      <div className="banner">
        <strong>Ledger data is seeded.</strong> Reading a live Tempo Zone needs funds inside the
        zone, and the deposit call currently reverts with no reason string —{' '}
        <a href="https://github.com/tempoxyz/zones/issues/1482" target="_blank" rel="noreferrer">
          tempoxyz/zones#1482
        </a>
        . The events have identical shapes to <code>eth_getLogs</code>, so the code path is the
        same and only the source changes. <strong>The Access Key tab is live on Moderato</strong>{' '}
        and writes real transactions.
      </div>

      <nav>
        {([
          ['statement', 'Statement'],
          ['ledger', 'Ledger'],
          ['exceptions', 'Exceptions'],
          ['counterparties', 'Counterparties'],
          ['key', 'Access Key'],
        ] as [Tab, string][]).map(([id, text]) => (
          <button key={id} aria-selected={tab === id} onClick={() => setTab(id)}>
            {text}
            {id === 'exceptions' && issues > 0 && <span className="count">{issues}</span>}
          </button>
        ))}
      </nav>

      {tab === 'statement' && (
        <>
          <div className="panel">
            <h2>Position<span className="sub">derived from chain events alone</span></h2>
            <div className="grid">
              <Stat k="Deposited into zone" v={format(stmt.deposited)} />
              <Stat k="Received" v={format(stmt.received)} cls="in" />
              <Stat k="Paid out" v={format(stmt.paid)} cls="out" />
              <Stat k="Withdrawn from zone" v={format(stmt.withdrawn)} />
              <Stat k="Balance" v={format(stmt.balance)} />
              <Stat k="Entries" v={String(stmt.entryCount)} />
            </div>
          </div>

          <div className="panel">
            <h2>Reconciliation</h2>
            {stmt.reconciliation && (
              <div className="recon">
                <span
                  className={`verdict ${stmt.reconciliation.reconciled ? 'ok' : 'bad'}`}
                >
                  {stmt.reconciliation.reconciled ? 'RECONCILED' : 'DRIFT'}
                </span>
                <span className="num">
                  ledger {format(stmt.reconciliation.derived)} vs chain{' '}
                  {format(stmt.reconciliation.onChain)}
                </span>
                <span className="spacer" />
                <button className="action ghost" onClick={downloadCsv}>
                  Download CSV
                </button>
              </div>
            )}
            <p className="note" style={{ marginTop: 12 }}>
              The books are rebuilt independently and then compared with the balance the chain
              reports. An audit tool that cannot detect its own drift is worse than none.
            </p>
          </div>
        </>
      )}

      {tab === 'ledger' && (
        <div className="panel">
          <h2>
            Ledger<span className="sub">{ledger.entries.length} entries, oldest first</span>
          </h2>
          <table>
            <thead>
              <tr>
                <th>Direction</th>
                <th className="num">Amount</th>
                <th className="num">Balance</th>
                <th>Counterparty</th>
                <th>Memo</th>
                <th>Invoice</th>
              </tr>
            </thead>
            <tbody>
              {runningBalance(ledger).map(([e, bal]) => {
                const inv = invoiceOf.get(`${e.txHash}:${e.logIndex}`)
                const amt = signedAmount(e)
                return (
                  <tr key={`${e.txHash}:${e.logIndex}`}>
                    <td>{e.direction}</td>
                    <td className={`num ${amt > 0n ? 'in' : amt < 0n ? 'out' : 'muted'}`}>
                      {format(amt)}
                    </td>
                    <td className="num muted">{format(bal)}</td>
                    <td>{label(e.counterparty)}</td>
                    <td className={e.memo ? '' : 'muted'}>
                      {e.memo ?? (e.direction === 'internal' ? 'own address' : 'no memo')}
                    </td>
                    <td>
                      {inv ? (
                        <span className="tag ok">{inv}</span>
                      ) : e.memo && e.direction === 'receipt' ? (
                        <span className="tag warn">unrecognised</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'exceptions' && (
        <div className="panel">
          <h2>
            Exceptions<span className="sub">{issues} items needing a human</span>
          </h2>
          <p className="note" style={{ marginBottom: 16 }}>
            This is the point of the tool. A clean total with a silent exception list is worse
            than no statement, because it invites trust it has not earned.
          </p>

          {exc.unmatched.map((m) => (
            <div className="exception" key={`${m.entry.txHash}:${m.entry.logIndex}`}>
              <div className="what">
                {format(m.entry.amount)} received from {label(m.entry.counterparty)} — memo “
                {m.entry.memo}”
              </div>
              <div className="why">
                Quotes an invoice we did not issue. A typo, or money intended for somebody else.
              </div>
            </div>
          ))}

          {exc.missingMemo.map((e) => (
            <div className="exception" key={`${e.txHash}:${e.logIndex}`}>
              <div className="what">
                {format(e.amount)} {e.direction} — no memo
              </div>
              <div className="why">
                Nothing to reconcile against. The most common reason books cannot be matched
                automatically.
              </div>
            </div>
          ))}

          {exc.duplicated.map((d) => (
            <div className="exception" key={d.invoice}>
              <div className="what">
                {d.invoice} referenced by {d.entries.length} payments, totalling{' '}
                {format(d.entries.reduce((s, e) => s + e.amount, 0n))}
              </div>
              <div className="why">
                Either instalments against one invoice, or the same invoice paid twice.
              </div>
            </div>
          ))}

          {exc.unpaidInvoices.map((i) => (
            <div className="exception" key={i}>
              <div className="what">{i} — no matching payment</div>
              <div className="why">Issued, and nothing has arrived against it.</div>
            </div>
          ))}
        </div>
      )}

      {tab === 'counterparties' && (
        <div className="panel">
          <h2>Counterparties</h2>
          <table>
            <thead>
              <tr>
                <th>Party</th>
                <th className="num">Received from</th>
                <th className="num">Paid to</th>
                <th className="num">Net</th>
              </tr>
            </thead>
            <tbody>
              {stmt.counterparties.map((c) => (
                <tr key={c.address}>
                  <td>{label(c.address)}</td>
                  <td className="num in">{c.received ? format(c.received) : '—'}</td>
                  <td className="num out">{c.paid ? format(c.paid) : '—'}</td>
                  <td className="num">{format(c.received - c.paid)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'key' && <KeyLifecycle />}
    </div>
  )
}

function Stat({ k, v, cls = '' }: { k: string; v: string; cls?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v ${cls}`}>{v}</div>
    </div>
  )
}
