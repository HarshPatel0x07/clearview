# Bringing up zcashd in regtest

zcashd does **not** run on Windows (Zcash docs: *"We do not currently support Zcashd & Zcash-cli on
Windows"*; Windows is Tier 3, no official binaries). Use WSL2 or a Linux VM.

**regtest is a private local chain** — blocks mined on demand, instantly. No peers, no initial
block download, no faucet, no sync wait, and it avoids the OOM that kills zcashd on 4GB machines
during IBD (`zcash/zcash#5936`), because regtest never performs one.

---

## Option A — WSL2 (needs admin once)

In an **administrator** PowerShell:

```powershell
wsl --install -d Ubuntu
```

Reboot when prompted. Then set a Linux username/password when Ubuntu first opens.

## Option B — any Ubuntu VM or VPS

Skip to the next section. Everything below runs inside Linux.

---

## Install zcashd (Debian/Ubuntu, officially supported)

```bash
sudo apt-get update && sudo apt-get install -y apt-transport-https wget gnupg2

wget -qO - https://apt.z.cash/zcash.asc | gpg --import
gpg --export 3FE63B67F85EA808DE9B880E6DEF3BAF272766C0 \
  | sudo tee /usr/share/keyrings/zcash.gpg > /dev/null
echo "deb [signed-by=/usr/share/keyrings/zcash.gpg] https://apt.z.cash/ bookworm main" \
  | sudo tee /etc/apt/sources.list.d/zcash.list

sudo apt-get update && sudo apt-get install -y zcash
zcash-fetch-params            # one-time, downloads the proving parameters
```

Verify the key fingerprint against https://z.cash/download.html before trusting it. If the release
codename differs on your distro, substitute it for `bookworm`.

## Configure and start

```bash
mkdir -p ~/.zcash
cp /path/to/clearview/regtest/zcash.conf ~/.zcash/zcash.conf
# edit rpcpassword first
zcashd -daemon
zcash-cli getblockchaininfo        # expect "chain": "regtest"
```

## Seed a demo chain

```bash
# Coinbase needs 100 confirmations before it can be spent.
zcash-cli generate 101

# A shielded account and address for the organisation being audited.
ACCOUNT=$(zcash-cli z_getnewaccount | python3 -c "import sys,json;print(json.load(sys.stdin)['account'])")
ZADDR=$(zcash-cli z_getaddressforaccount $ACCOUNT | python3 -c "import sys,json;print(json.load(sys.stdin)['address'])")
echo "org address: $ZADDR"

# Move funds from the transparent coinbase into the shielded pool.
TADDR=$(zcash-cli getnewaddress)
zcash-cli z_shieldcoinbase "*" "$ZADDR"
zcash-cli generate 5

# Donations, with memos - these become the ledger.
zcash-cli z_sendmany "$ZADDR" \
  '[{"address":"'"$ZADDR"'","amount":2.5,"memo":"'$(echo -n "Donation - Q3 appeal" | xxd -p | tr -d '\n')'"}]'
zcash-cli generate 1
```

Check progress with `zcash-cli z_getoperationstatus` — `z_sendmany` is asynchronous.

## Export the viewing key — the whole point

```bash
zcash-cli z_exportviewingkey "$ZADDR"
```

That string is what gets handed to the auditor. **It carries no spending authority.**

## Run Clearview against it

```bash
python scripts/prove_spine.py \
  --rpc-user clearview --rpc-password <yours> --network regtest \
  --viewing-key <uview1...> --address <ztestsapling1...>
```

Success looks like the `--mock` output: every receipt, payment and change entry classified, a
running balance, and `RECONCILED` against `z_getbalanceforviewingkey`.

### Reaching WSL from Windows

zcashd binds `127.0.0.1` inside WSL2, which Windows can usually reach on the same address. If not,
run the script inside WSL, or add `rpcbind=0.0.0.0` plus `rpcallowip=<windows-ip>` — acceptable
only on a throwaway regtest chain, never on a node holding real funds.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Cannot reach zcashd` | Is `zcashd -daemon` running? Check `~/.zcash/regtest/debug.log` |
| `z_sendmany` seems to hang | It is async. Poll `zcash-cli z_getoperationstatus` |
| Amounts never confirm | regtest only mines when told: `zcash-cli generate 1` |
| `could not load param file` | Run `zcash-fetch-params` |
| Killed during startup | Only expected during IBD, which regtest avoids. Check available RAM |
