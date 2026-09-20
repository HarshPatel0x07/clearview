# Running Clearview against a real node — step by step

Every command below runs **inside the Codespace terminal**, not on Windows. Nothing here touches
your laptop.

`zcashd` is [End of Life](https://z.cash/support/zcashd-deprecation/) — its nodes halted on
2026-07-18 and refuse to restart. The supported stack is **Zebra** (node) + **Zallet** (wallet),
orchestrated by [ZcashFoundation/z3](https://github.com/ZcashFoundation/z3). On **regtest** it
starts in seconds: instant blocks, no peers, no sync, no faucet.

---

## Step 0 — Rebuild the Codespace

The devcontainer changed, so the old container has the dead zcashd setup in it.

1. Open <https://github.com/HarshPatel0x07/clearview>
2. **Code** → **Codespaces** tab → click your existing codespace to open it
3. Press **F1** (or `Ctrl+Shift+P`) → type **"Rebuild Container"** → **Codespaces: Rebuild
   Container**
4. Confirm. It takes 3–5 minutes

If you'd rather start clean: delete the old codespace from the Codespaces tab and create a new one.

**Check it worked** — in the Codespace terminal:

```bash
docker --version
```

Docker must be present; the devcontainer now requests docker-in-docker. If that command fails, the
rebuild didn't pick up the new config — re-run step 3.

---

## Step 1 — Confirm Clearview itself works

Before involving a node at all:

```bash
cd /workspaces/clearview
python -m unittest discover -s tests
python scripts/prove_spine.py --mock
```

Expect **16 tests OK**, then a reconciled ledger table. This proves the container is sane and
separates "environment broken" from "node broken" later.

---

## Step 2 — First-time Z3 setup

The devcontainer already cloned Z3 to `~/z3`. **This init script is required** — `docker compose
up` alone is not enough.

```bash
cd ~/z3
./scripts/regtest-init.sh
```

It does six things: copies the per-network config templates, generates Zallet's encryption
identity, injects the Zallet RPC password hash, starts Zebra in regtest with Canopy at height 1 and
NU5–NU6.3 at height 2, mines 2 blocks to activate Ironwood, then initialises the Zallet wallet.

Takes a few minutes. The rpc-router **builds from source on first run**; Zebra and Zallet use
pre-built images.

---

## Step 3 — Start the stack

```bash
cd ~/z3
docker compose --env-file .env.regtest up -d
docker compose --env-file .env.regtest ps
```

Every service should read `running` or `healthy`. If one is restarting:

```bash
docker compose --env-file .env.regtest logs --tail=50 zallet
```

### Endpoints

| Service | URL | Use |
|---|---|---|
| **rpc-router** | `http://localhost:8181` | **What Clearview talks to.** Routes each method to Zebra or Zallet automatically |
| Zebra RPC | `http://localhost:29232` | Direct node access |
| Zallet RPC | `http://localhost:50232` | Direct wallet access |
| Zaino gRPC | `localhost:28137` | lightwalletd-compatible; needs `--profile indexer` |

Default rpc-router password is `zebra`, overridable with `Z3_REGTEST_RPC_ROUTER_PASSWORD`.

**Check the router is up:**

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"getblockchaininfo","params":[],"id":1}' \
  http://127.0.0.1:8181
```

Expect JSON with `"chain":"regtest"`. Then confirm the wallet answers too:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"getwalletinfo","params":[],"id":2}' \
  http://127.0.0.1:8181
```

Two different services behind one port — that is the router doing its job.

---

## Step 4 — Seed a demo ledger

```bash
cd /workspaces/clearview
python scripts/seed_regtest.py
```

It talks to the rpc-router, creates an account, mines to maturity, shields the coinbase, sends
four memo'd payments, then prints **the viewing key plus the exact command for step 5**.

`z_sendmany` and `z_shieldcoinbase` are asynchronous, so the script polls `z_getoperationstatus`.
Apparent hanging is normal; regtest only mines when told.

The old `seed-demo.sh` used `zcash-cli` and has been removed - zcashd is not part of this stack.

---

## Step 5 — The moment of truth

Paste the command the seed script printed. It looks like:

```bash
python scripts/prove_spine.py \
  --rpc-url http://127.0.0.1:8181 \
  --viewing-key 'uview1...' \
  --address 'ztestsapling1...' \
  --account '<account-uuid>'
```

Success is the same table as `--mock`, but built from a real chain: every receipt, payment and
change entry classified, a running balance, and **RECONCILED** at the bottom.

That is the thesis proven. Week 1 done.

---

## Traps worth knowing

**Use the `zallet-zaino` binary for regtest.** The default `zebra-state` backend does **not**
support regtest — it reads a co-located zebrad's state directly and needs zebrad compiled with the
non-default `indexer` feature. Z3's regtest overlay handles this, but if you run Zallet by hand,
this is the mistake to avoid (zallet#538).

**Zallet is beta (v0.1.0-beta.3).** Expect rough edges. Some viewing-key RPCs only landed recently
— `z_importviewingkey` merged 2026-07-26, and the published status matrix still lists it as "not yet
implemented". Trust the running node over the docs.

**`z_getbalanceforviewingkey` no longer exists.** Zallet replaces it with
`z_getbalanceforaccount`, because an imported viewing key becomes an account with a UUID
(zallet#74). That is why `--account` is a separate flag.

**JSON-RPC 2.0, not 1.0.** zcashd spoke 1.0; the Z3 router and Zallet use 2.0. Clearview's client
sends 2.0.

## Stop the codespace when you finish

**Codespaces tab → `...` → Stop codespace.** Free quota is 120 core-hours/month, which is 60 hours
on a 2-core machine. It auto-stops after 30 minutes idle, but leaving it running overnight is how
the quota disappears.

## If step 5 fails

Send me the error plus the raw RPC response:

```bash
curl -s -X POST -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"z_listaccounts","params":[],"id":1}' \
  http://127.0.0.1:8181
```

The classification logic is unlikely to be wrong — 16 tests cover it. What can differ is field
names or shapes, which is parsing, and quick to fix.
