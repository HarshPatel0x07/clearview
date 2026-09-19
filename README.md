# Clearview

**Auditable books for private money.**

An organisation accepts Zcash shielded payments. Nothing is visible on-chain. It hands its
accountant a **viewing key — not a spending key** — and gets complete, reconciled books: every
receipt, payment and change output, classified, with a running balance that reconciles against the
chain.

Payer privacy is preserved. The organisation stays auditable. Spend authority never leaves the
treasury.

---

## Why this doesn't exist yet

Zcash solved selective disclosure at the protocol level. [ZIP 316][zip316] defines Unified Viewing
Keys, and `zcash_client_backend` is built around them — it "provides no facilities for the storage
of spending keys". View-only is the *intended* architecture, not a workaround.

What's missing is the product. Organisations don't avoid shielded payments because the
cryptography can't support an audit; they avoid them because nobody turned that capability into
books an accountant can use.

## How it works

Two RPCs do the work:

| RPC | Gives us |
|---|---|
| `z_listreceivedbyaddress` | Every note received: amount, memo, height, and a `change` flag |
| `z_viewtransaction` | Per-transaction shielded detail, whose outputs carry `outgoing` (not ours → a payment) and `walletInternal` (change) |
| `z_getbalanceforaccount` | The node's own balance, to reconcile against |

Built against the **Zebra + Zallet** stack. `zcashd` reached
[End of Life](https://z.cash/support/zcashd-deprecation/) on 2026-07-18 — its nodes halt and refuse
to restart — so tooling built on it no longer runs. Zallet keeps `z_viewtransaction` with richer
semantics, and replaces `z_getbalanceforviewingkey` with `z_getbalanceforaccount`, since an
imported viewing key becomes an account with a UUID.

Those two flags are the entire classification primitive:

```
outgoing = true      -> PAYMENT   (money left the account)
walletInternal       -> CHANGE    (internal, nets to zero)
neither              -> RECEIPT   (money arrived)
```

Receipts are taken from one source only, which is what stops them being double counted.
`reconcile()` then proves the reconstructed balance against `z_getbalanceforviewingkey` — an audit
tool that can't detect its own drift is worse than none.

## Try it without a node

```bash
python scripts/prove_spine.py --mock
```

```
  height  date        type     pool                 amount          balance
------------------------------------------------------------------------------
     100  2025-09-16  receipt  orchard         +2.50000000       2.50000000
            memo: Donation - Q3 appeal
     110  2025-09-17  receipt  orchard         +1.00000000       3.50000000
     120  2025-09-18  payment  orchard         -0.75000000       2.75000000
            memo: Invoice 2026-114 - venue hire
     120  2025-09-18  change   orchard         ~2.74990000       2.75000000
     130  2025-09-19  receipt  sapling         +0.25000000       3.00000000
------------------------------------------------------------------------------
RECONCILED: ledger 3.00000000 ZEC vs node 3.00000000 ZEC
```

## Against a real node

See [`regtest/setup.md`](regtest/setup.md). The [Z3 stack](https://github.com/ZcashFoundation/z3)
runs Zebra + Zallet under Docker Compose; on **regtest** it starts in seconds — instant blocks, no
peers, no sync, no faucet.

```bash
python scripts/prove_spine.py \
  --rpc-user clearview --rpc-password <pw> --network regtest \
  --viewing-key uview1... --address ztestsapling1...
```

## Tests

```bash
python -m unittest discover -s tests -v
```

16 tests, no dependencies. The RPC layer is injectable, so all bookkeeping logic is verified
against schema-accurate fixtures transcribed from the Zcash 6.12.2 RPC docs. One test asserts the
claim the product rests on: **no spending-key RPC is ever called.**

## Layout

```
clearview/rpc.py       JSON-RPC transport only
clearview/models.py    Ledger types. Amounts are integer zatoshis, never floats
clearview/ledger.py    Reconstruction and reconciliation - the thesis
scripts/prove_spine.py CLI proof
regtest/               Node config and setup
```

## Status

Week 1 of a hackathon build. The spine — viewing key in, reconciled ledger out — is implemented and
tested. Dashboard, CSV/P&L export and disclosure tiers come next.

[zip316]: https://zips.z.cash/zip-0316
