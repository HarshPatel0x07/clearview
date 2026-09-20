#!/usr/bin/env bash
# Bring up the Z3 stack (Zebra + Zallet) on a local regtest network.
#
# zcashd is END OF LIFE. Its automatic End-of-Support halt was reached on
# 2026-07-18 at block height 3417100; every zcashd 6.20.0 node shut down and
# refuses to restart, and it does not support NU6.3. The supported stack is
# Zebra (full node) + Zallet (wallet), orchestrated by ZcashFoundation/z3.
#
# regtest on this stack starts in seconds: instant blocks, no peers, no sync.
set -euo pipefail

Z3_DIR="${HOME}/z3"

echo "==> cloning the Z3 stack (Zebra + Zallet)"
if [ ! -d "$Z3_DIR" ]; then
  git clone --depth 1 https://github.com/ZcashFoundation/z3.git "$Z3_DIR"
fi

echo "==> pulling images (no build step needed)"
cd "$Z3_DIR"
docker compose --env-file .env.regtest pull 2>/dev/null || \
  echo "    (pull deferred - run it inside \$HOME/z3 once Docker is ready)"

cat <<'EOF'

==> ready

Start the regtest stack:

    cd ~/z3
    docker compose --env-file .env.regtest up -d
    docker compose --env-file .env.regtest ps

Then seed a demo ledger and export the viewing key:

    cd /workspaces/clearview
    bash regtest/seed-demo.sh

Clearview itself needs no node to run its tests:

    python -m unittest discover -s tests
    python scripts/prove_spine.py --mock

IMPORTANT: use the `zallet-zaino` binary for regtest. The default
`zebra-state` backend does not support regtest - it reads a co-located
zebrad's state directly and requires zebrad built with the non-default
`indexer` feature. The `zaino` backend talks to Zebra over JSON-RPC in
separate containers and is the one that supports regtest (zallet#538).
EOF
