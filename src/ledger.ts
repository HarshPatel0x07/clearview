/**
 * Reconstruct a reconciled ledger from a Tempo Zone, using read-only access.
 *
 * This is the product thesis: given a key that can read and provably cannot
 * spend, produce complete auditable books for payments that are invisible to
 * the public chain.
 *
 * Zone RPC scopes `eth_getLogs` to TIP-20 events where the authenticated
 * account is a party, so the classification falls out of the event itself:
 *
 * ```
 *   to   === account   ->  RECEIPT   (money arrived)
 *   from === account   ->  PAYMENT   (money left)
 *   Mint                ->  DEPOSIT  (entered the zone)
 *   Burn                ->  WITHDRAWAL (left the zone)
 * ```
 *
 * `TransferWithMemo` carries a 32-byte memo that Tempo documents as being for
 * "payment references, invoice IDs, order numbers" — so invoice matching is
 * what the field exists for, not something bolted on.
 *
 * Amounts are integer base units throughout. TIP-20 uses **6 decimals**, not
 * 18; formatting happens only for display.
 */

export const DECIMALS = 6

export type Direction = 'receipt' | 'payment' | 'deposit' | 'withdrawal' | 'internal'

export type LedgerEntry = {
  txHash: `0x${string}`
  logIndex: number
  blockNumber: bigint
  direction: Direction
  token: `0x${string}`
  amount: bigint
  counterparty: `0x${string}` | null
  /** Decoded memo, when the event carried one. */
  memo: string | null
  /** Raw 32-byte memo, kept so an auditor can verify the decoding. */
  memoRaw: `0x${string}` | null
}

export type Ledger = {
  account: `0x${string}`
  entries: LedgerEntry[]
}

/** Effect of an entry on the account balance. Internal transfers net to zero. */
export function signedAmount(entry: LedgerEntry): bigint {
  switch (entry.direction) {
    case 'receipt':
    case 'deposit':
      return entry.amount
    case 'payment':
    case 'withdrawal':
      return -entry.amount
    default:
      return 0n
  }
}

/** Render base units for display. Never used for arithmetic. */
export function format(amount: bigint, decimals = DECIMALS): string {
  const negative = amount < 0n
  const abs = negative ? -amount : amount
  const unit = 10n ** BigInt(decimals)
  const whole = abs / unit
  const frac = (abs % unit).toString().padStart(decimals, '0')
  return `${negative ? '-' : ''}${whole}.${frac}`
}

/**
 * Decode a 32-byte memo into text.
 *
 * Memos are fixed-width and right-padded with zero bytes. A memo holding an
 * invoice reference is text; one holding a hash is not, so anything that does
 * not decode to printable characters is left as null and the raw bytes are
 * preserved for the auditor to inspect.
 */
export function decodeMemo(raw: string | null | undefined): string | null {
  if (!raw || raw === '0x') return null
  const hex = raw.startsWith('0x') ? raw.slice(2) : raw
  const bytes = hex.match(/.{2}/g) ?? []
  const text = bytes
    .map((b) => Number.parseInt(b, 16))
    .filter((b) => b !== 0)
    .map((b) => String.fromCharCode(b))
    .join('')
  if (!text.trim()) return null
  // Printable ASCII only; anything else is a hash or binary payload.
  return /^[\x20-\x7E]+$/.test(text) ? text.trim() : null
}

type RawLog = {
  transactionHash: `0x${string}`
  logIndex: number | bigint
  blockNumber: bigint | number
  address: `0x${string}`
  eventName?: string
  args?: Record<string, unknown>
}

/**
 * Classify one decoded TIP-20 log for `account`.
 *
 * Returns null when the log does not affect the account. The zone already
 * filters to events where we are a party, but a self-transfer appears as both
 * sides, so membership is decided explicitly rather than assumed.
 */
export function classify(log: RawLog, account: `0x${string}`): LedgerEntry | null {
  const args = log.args ?? {}
  const from = (args.from as `0x${string}` | undefined)?.toLowerCase()
  const to = (args.to as `0x${string}` | undefined)?.toLowerCase()
  const self = account.toLowerCase()
  const amount = BigInt((args.value ?? args.amount ?? 0n) as bigint)
  const memoRaw = (args.memo as `0x${string}` | undefined) ?? null

  const base = {
    txHash: log.transactionHash,
    logIndex: Number(log.logIndex),
    blockNumber: BigInt(log.blockNumber),
    token: log.address,
    amount,
    memo: decodeMemo(memoRaw),
    memoRaw,
  }

  switch (log.eventName) {
    case 'Mint':
      return to === self ? { ...base, direction: 'deposit', counterparty: null } : null
    case 'Burn':
      return from === self ? { ...base, direction: 'withdrawal', counterparty: null } : null
    case 'Transfer':
    case 'TransferWithMemo': {
      // A transfer to oneself moves nothing; recording it as a receipt would
      // invent income.
      if (from === self && to === self) {
        return { ...base, direction: 'internal', counterparty: account }
      }
      if (to === self) return { ...base, direction: 'receipt', counterparty: (args.from as `0x${string}`) ?? null }
      if (from === self) return { ...base, direction: 'payment', counterparty: (args.to as `0x${string}`) ?? null }
      return null
    }
    default:
      return null
  }
}

/** Build a ledger from decoded logs, oldest first. */
export function buildLedger(logs: RawLog[], account: `0x${string}`): Ledger {
  const entries = logs
    .map((log) => classify(log, account))
    .filter((e): e is LedgerEntry => e !== null)
    .sort((a, b) =>
      a.blockNumber === b.blockNumber
        ? a.logIndex - b.logIndex
        : a.blockNumber < b.blockNumber
          ? -1
          : 1,
    )
  return { account, entries }
}

export function balanceOf(ledger: Ledger, token?: `0x${string}`): bigint {
  return ledger.entries
    .filter((e) => !token || e.token.toLowerCase() === token.toLowerCase())
    .reduce((sum, e) => sum + signedAmount(e), 0n)
}

export function totals(ledger: Ledger, token?: `0x${string}`) {
  const scoped = ledger.entries.filter(
    (e) => !token || e.token.toLowerCase() === token.toLowerCase(),
  )
  const sum = (d: Direction) =>
    scoped.filter((e) => e.direction === d).reduce((s, e) => s + e.amount, 0n)
  return {
    received: sum('receipt'),
    paid: sum('payment'),
    deposited: sum('deposit'),
    withdrawn: sum('withdrawal'),
    balance: scoped.reduce((s, e) => s + signedAmount(e), 0n),
  }
}

/** Each entry paired with the balance immediately after it. */
export function runningBalance(ledger: Ledger): Array<[LedgerEntry, bigint]> {
  let balance = 0n
  return ledger.entries.map((e) => {
    balance += signedAmount(e)
    return [e, balance] as [LedgerEntry, bigint]
  })
}

export type Reconciliation = {
  derived: bigint
  onChain: bigint
  difference: bigint
  reconciled: boolean
}

/**
 * Prove the books against the chain.
 *
 * An audit tool that cannot detect its own drift is worse than none, so the
 * reconstructed balance is always compared with the balance the zone reports
 * for the account.
 */
export function reconcile(ledger: Ledger, onChain: bigint, token?: `0x${string}`): Reconciliation {
  const derived = balanceOf(ledger, token)
  return {
    derived,
    onChain,
    difference: derived - onChain,
    reconciled: derived === onChain,
  }
}

export type InvoiceMatch = {
  entry: LedgerEntry
  invoice: string | null
}

/**
 * Match payments to an invoice register via the memo field.
 *
 * Unmatched entries are returned with `invoice: null` rather than dropped —
 * a reconciliation that silently discards what it cannot explain is not a
 * reconciliation.
 */
export function matchInvoices(ledger: Ledger, invoices: readonly string[]): InvoiceMatch[] {
  const index = new Map(invoices.map((i) => [i.toLowerCase(), i]))
  return ledger.entries.map((entry) => {
    if (!entry.memo) return { entry, invoice: null }
    const memo = entry.memo.toLowerCase()
    const exact = index.get(memo)
    if (exact) return { entry, invoice: exact }
    // Memos usually carry the reference inside a longer human sentence.
    const contained = invoices.find((i) => memo.includes(i.toLowerCase()))
    return { entry, invoice: contained ?? null }
  })
}
