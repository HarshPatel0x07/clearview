#!/usr/bin/env bash
# Install zcashd and prepare a regtest node inside the dev container.
#
# regtest is a private local chain: blocks are mined on demand, there is no
# initial block download, and therefore none of the memory pressure that
# OOM-kills zcashd on small machines during IBD (zcash/zcash#5936).
set -euo pipefail

echo "==> installing zcashd from the official apt repository"
sudo apt-get update -qq
sudo apt-get install -y -qq apt-transport-https wget gnupg2 xxd >/dev/null

# Key fingerprint per https://z.cash/download.html - verify if it ever changes.
ZCASH_KEY="3FE63B67F85EA808DE9B880E6DEF3BAF272766C0"
wget -qO - https://apt.z.cash/zcash.asc | gpg --import 2>/dev/null
gpg --export "$ZCASH_KEY" | sudo tee /usr/share/keyrings/zcash.gpg >/dev/null
echo "deb [signed-by=/usr/share/keyrings/zcash.gpg] https://apt.z.cash/ bookworm main" \
  | sudo tee /etc/apt/sources.list.d/zcash.list >/dev/null

sudo apt-get update -qq
sudo apt-get install -y -qq zcash

echo "==> fetching proving parameters (one-time, ~1.6GB)"
zcash-fetch-params

echo "==> writing regtest config"
mkdir -p "$HOME/.zcash"
if [ ! -f "$HOME/.zcash/zcash.conf" ]; then
  # Random local-only RPC password; this chain holds nothing of value.
  RPCPW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 24)"
  sed "s/CHANGE_ME_local_only/${RPCPW}/" regtest/zcash.conf > "$HOME/.zcash/zcash.conf"
  echo "    rpcpassword written to ~/.zcash/zcash.conf"
fi

cat <<'EOF'

==> ready

  zcashd -daemon                     start the node
  zcash-cli getblockchaininfo        expect  "chain": "regtest"
  bash regtest/seed-demo.sh          mine blocks, shield funds, send memos
  python scripts/prove_spine.py --mock    works right now, no node needed

Credentials are in ~/.zcash/zcash.conf
EOF
