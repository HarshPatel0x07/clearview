# Clearview

**Give your accountant a key to your private books that provably cannot spend a penny — and take it back when the audit ends.**

Tempo Zones make a business's balances and transaction history invisible to the public chain. That
is the point of them. But the accountant, the auditor and the tax office still need to see the
books, and the only way to show them today is to hand over the key that also moves the money.

Clearview closes that gap. A business authorises a **deny-all Access Key** — one that can
authenticate to the Zone RPC and is scoped to call nothing at all — and Clearview turns that
read-only access into reconciled books: every receipt and payment classified, memos matched to
invoices, exceptions surfaced, a CSV an accountant can open, and a balance proved against the
chain.

When the engagement ends, the key is revoked on-chain.

---

## What is live, and what is not

Stated up front, because finding it out later would be worse.

| | Status |
|---|---|
| **Deny-all Access Key authorised on-chain** | **Live on Tempo Moderato**, real transaction hashes |
| **Zone accepts a token signed by that key** | **Live** — returns 403, not the 401 an unauthenticated call gets, so the signature verifies |
| Funding, approvals, keychain calls | **Live** |
| Reading the books from a Zone | **Blocked** — see below |
| The ledger, statement, CSV, exceptions | **Working**, on seeded data |

The blocker is a single upstream bug: **depositing into a Zone reverts with no reason string**, so
there are no funds in the zone and nothing to read. Filed as
[tempoxyz/zones#1482](https://github.com/tempoxyz/zones/issues/1482) with a full reproduction and
eight ruled-out hypotheses.

The seeded events have **identical shapes to what `eth_getLogs` returns from a Zone**, so the code
path is the same. When the deposit works, only the data source changes.

The half that is blocked is the books. The half that already works on-chain is the differentiating
claim — a read-only key that is **revocable, expiring and auditable**.

---

## Run it

```bash
npm install
npm run demo
```

One command prints the ledger, the statement, the exception report and the reconciliation, and
writes `clearview-ledger.csv`.

```
deposited into zone            2000.000000
received                       7150.000000
paid out                       1430.000000
withdrawn from zone             500.000000
------------------------------------------------------------------
balance                        7220.000000

exceptions: 4
  1 payment(s) with an unrecognised memo
  1 payment(s) with no memo
  1 invoice(s) with no matching payment: INV-2026-095
  invoice INV-2026-093 referenced by 2 payments

==================================================================
RECONCILED  ledger 7220.000000 = chain 7220.000000
==================================================================
```

### The dashboard

```bash
cp .env.example .env.local     # add a testnet key for the live Access Key panel
npm run ui
```

Five views: **Statement** with the reconciliation, **Ledger** with running balance and matched
invoices, **Exceptions**, **Counterparties**, and **Access Key** — which runs live against
Moderato and writes real transactions.

The Access Key tab is the demo. Grant a deny-all key, watch the zone verify its signature, watch
a transfer signed by that same key get refused, then revoke it on-chain.

It works under `npm run ui` only, not in a built bundle. That is deliberate — the key is read in
a way Vite will not inline, because a key baked into shipped JavaScript is a key published, and a
demo convenience is not worth that even on a testnet.

### Checking the claims in this file

```bash
npm run verify   # typecheck + 69 tests + the demo + the UI build, one gate
npm run prove    # the deny-all key, live against Tempo Moderato
```

Every number above is printed by one of those commands, and `verify` **checks this file against
reality** — it fails if the test count here disagrees with the suite.

That check exists because the number drifted four times: once to zero when a config change
redirected the runner, twice when new tests were added, and once to an empty string when it was
parsed from output containing ANSI escapes. It is the most checkable claim in this README, which
is why it must not be wrong.

---

## Why the exception report is the product

A reconciliation that produces a tidy total and hides what it could not explain is worse than no
reconciliation, because it invites trust it has not earned.

The demo dataset is therefore deliberately imperfect, and the four exceptions above are real
findings, not decoration:

- **A client paid with no memo.** The most common reason books cannot be reconciled automatically
- **A memo quotes an invoice that is not in the register** — a typo, or money meant for somebody else
- **One invoice was paid in two instalments.** Possibly fine, possibly billed twice; a human must look
- **An invoice nobody paid**

Two guards exist because both would corrupt the books silently rather than loudly:

- A **transfer to our own address** is classified `internal` and nets to zero. Counting it as
  income would inflate revenue
- A memo whose bytes are not printable is **left undecoded**, with the raw value preserved, so a
  hash in the memo field is never displayed as though it were text

And the registers are **separate**. Invoices we issued are matched against money in; our suppliers'
references against money out. Conflating them turned every ordinary vendor payment into a false
exception — three of six, before it was fixed. An exception list with false entries trains the
reader to ignore it.

---

## How it works on Tempo

Zone RPC scopes `eth_getLogs` to TIP-20 events where the authenticated account is a party, so
classification falls out of the event itself:

```
to   === account   ->  RECEIPT        Mint  ->  entered the zone
from === account   ->  PAYMENT        Burn  ->  left the zone
```

**`TransferWithMemo` carries a 32-byte memo** that Tempo's own documentation describes as holding
*"payment references, invoice IDs, order numbers"* — explicitly *for reconciliation*. So invoice
matching is what the field exists for, not a feature bolted on top.

Amounts are **integer base units at 6 decimals** throughout, never floats. The export writes
decimal strings so a spreadsheet cannot reinterpret them.

### The key that cannot spend

```ts
await Actions.accessKey.authorizeSync(client, {
  accessKey,
  expiry,
  scopes: [],   // allowAnyCalls = false, empty allowlist
  limits: [],   // enforceLimits = true, no token may be spent
})
```

**Both empty lists are required.** With `scopes: []` alone the node rejects the authorization as
`admin-signed key authorization account mismatch`, because an empty scope list without an empty
limit list matches the *admin* key shape ([TIP-1049](https://tips.sh/1049)). This is undocumented;
[tempoxyz/docs#888](https://github.com/tempoxyz/docs/pull/888) is an open PR adding it.

### Better than a viewing key

| | Zcash viewing key | Tempo deny-all Access Key |
|---|---|---|
| Revocable after sharing | **No** — permanent once disclosed | **Yes**, on-chain |
| Time-limited | No | **Yes**, `expiry` |
| Grant is auditable | No | **Yes**, `KeyAuthorized` / `KeyRevoked` events |

Clearview began as a Zcash project. It moved to Tempo when `zcashd` proved to be end-of-life and
its successor could not create an account
([zcash/zallet#708](https://github.com/zcash/zallet/issues/708), where the reproduction is ours).
The earlier implementation is preserved under `archive/zcash-zallet/` with a note on why. The
classification and reconciliation logic transferred unchanged, because the RPC layer was always an
injectable protocol rather than a concrete client.

---

## Layout

```
src/ledger.ts      classification, reconciliation, memo decoding, invoice matching
src/report.ts      statement, CSV, exception report
src/demo-data.ts   a month of trading, in real TIP-20 event shapes
ui/                dashboard - a rendering layer only, no ledger logic
scripts/demo.ts    the whole product in one command
scripts/prove-denyall-key.ts   the deny-all key, live against Moderato
tests/             69 tests: ledger, reports, a dashboard render test, and a
                   static scan keeping src/ free of Node globals
TEMPO-FINDINGS.md  eleven undocumented behaviours found while building
archive/           the Zcash implementation, and why it was abandoned
```

`TEMPO-FINDINGS.md` is worth a look if you build on Zones. It records, among others, that
`getPortalAddress` and `encryptDepositPayload` take positional arguments, that passing an explicit
`portalAddress` to `getEncryptionKey` makes it fail with an ABI dump, that account `sign()` takes
`{ hash }` and not `{ payload }`, and that `zone(n)` resolves to mainnet while `zoneModerato(n)` is
testnet.

## Licence

MIT
