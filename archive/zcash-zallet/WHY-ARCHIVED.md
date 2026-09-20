# Why this is archived

This directory holds the first implementation of Clearview, built against Zcash.

It works, it is tested, and it cannot run — because the wallet underneath it cannot create an
account.

## What happened

The thesis was: given a Zcash **viewing key** and no spending authority, reconstruct complete
auditable books. Zcash supports this at protocol level ([ZIP 316] unified viewing keys), and the
implementation here reflects that: 17 tests, classification of receipts, payments and change, and
reconciliation of the derived balance against the node's own.

Two platform facts ended it.

**`zcashd` reached End of Life on 2026-07-18.** Its automatic End-of-Support halt triggered at
block height 3417100; every `zcashd` 6.20.0 node shut down and refuses to restart. The original
implementation targeted its RPC, verified against the 6.12.2 documentation. The documentation was
accurate. The daemon was dead.

**Its successor cannot create accounts.** The supported stack is Zebra + Zallet. On
`zallet v0.1.0-beta.3`, queried directly with valid cookie credentials:

| Method | With no arguments | With real arguments |
|---|---|---|
| `z_getnewaccount` | `-32602 Invalid params` | **closes the connection** |
| `z_listaccounts` | — | **closes the connection** |
| `z_listtransactions` | — | **closes the connection** |

The methods are implemented and validate their input; they fail when asked to do the work. And it
is a closed loop: **Zallet's sync does not advance on an empty wallet, and account creation
crashes**, so no order of operations produces a usable wallet.

Worth stating clearly: the parts the thesis depended on — `z_importviewingkey`,
`z_exportviewingkey`, `z_viewtransaction`, `z_getbalanceforaccount` — all exist and answer
correctly. The idea was executable. The wallet beneath it is not, yet.

## Kept, not deleted

Three reasons.

1. It is a **real upstream bug report** waiting to be filed, with precise reproduction.
2. The **classification model and reconciliation design** moved to Tempo unchanged. Because the
   RPC layer was an injectable protocol rather than a concrete client, **17 tests survived the
   platform change untouched** — the single best engineering decision in the project.
3. Deleting it would hide the most instructive part of the work. The root cause was verifying a
   platform's **API surface** and never its **runtime**. Everything about ZIP 316 and the RPC
   schemas was correct, and none of it mattered.

## What replaced it

Clearview on **Tempo**, at the repository root. Tempo Zones make balances and history invisible to
the public chain, and `AccountKeychain` deny-all Access Keys ([TIP-1011]) grant read access without
spend authority — **revocable, expiring and auditable**, which Zcash viewing keys are not.

[ZIP 316]: https://zips.z.cash/zip-0316
[TIP-1011]: https://github.com/tempoxyz/tempo/blob/main/tips/tip-1011.md
