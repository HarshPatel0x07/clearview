#!/usr/bin/env bash
# Seed a regtest chain with a believable nonprofit ledger, then export the
# viewing key that Clearview reads.
#
# Produces: three donations with memos, one vendor payment, and the change
# that comes back - which is exactly the classification Clearview must get
# right (receipt / payment / change).
set -euo pipefail

cli() { zcash-cli "$@"; }
hexmemo() { printf '%s' "$1" | xxd -p | tr -d '\n'; }

wait_for_op() {
  local opid="$1"
  for _ in $(seq 1 60); do
    local status
    status=$(cli z_getoperationstatus "[\"$opid\"]" | python3 -c \
      "import sys,json;print(json.load(sys.stdin)[0]['status'])")
    case "$status" in
      success) return 0 ;;
      failed)  cli z_getoperationresult "[\"$opid\"]"; return 1 ;;
    esac
    sleep 2
  done
  echo "timed out waiting for operation $opid" >&2
  return 1
}

echo "==> mining 101 blocks (coinbase needs 100 confirmations to mature)"
cli generate 101 >/dev/null

echo "==> creating the organisation's shielded account"
ACCOUNT=$(cli z_getnewaccount | python3 -c "import sys,json;print(json.load(sys.stdin)['account'])")
ZADDR=$(cli z_getaddressforaccount "$ACCOUNT" | python3 -c "import sys,json;print(json.load(sys.stdin)['address'])")

echo "==> shielding coinbase into the account"
OPID=$(cli z_shieldcoinbase "*" "$ZADDR" | python3 -c "import sys,json;print(json.load(sys.stdin)['opid'])")
wait_for_op "$OPID"
cli generate 3 >/dev/null

send_with_memo() {
  local amount="$1" memo="$2"
  local opid
  opid=$(cli z_sendmany "$ZADDR" \
    "[{\"address\":\"$ZADDR\",\"amount\":$amount,\"memo\":\"$(hexmemo "$memo")\"}]" \
    1 null 'AllowRevealedAmounts' \
    | tr -d '"')
  wait_for_op "$opid"
  cli generate 1 >/dev/null
  echo "    sent $amount ZEC  -  \"$memo\""
}

echo "==> seeding the ledger"
send_with_memo 2.5  "Donation - Q3 appeal"
send_with_memo 1.0  "Monthly giving"
send_with_memo 0.75 "Invoice 2026-114 - venue hire"
send_with_memo 0.25 "Anonymous gift"

echo
echo "==> viewing key - this is what gets handed to the auditor"
VK=$(cli z_exportviewingkey "$ZADDR" | tr -d '"')
echo "$VK"
echo
echo "It carries NO spending authority."
echo
RPCPW=$(grep '^rpcpassword=' "$HOME/.zcash/zcash.conf" | cut -d= -f2)
cat <<EOF
==> now run Clearview against it

python scripts/prove_spine.py \\
  --rpc-user clearview --rpc-password '$RPCPW' --network regtest \\
  --viewing-key '$VK' \\
  --address '$ZADDR'
EOF
