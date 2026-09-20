#!/usr/bin/env bash
# Which RPC methods does this stack actually serve?
#
# Zallet is young and the rpc-router is pinned to an older Zallet build, so some
# methods return 502 while others work. This prints the truth for the node in
# front of you, which beats trusting the published status matrix - that matrix
# still lists z_importviewingkey as unimplemented months after it merged.
#
#   bash scripts/probe_rpc.sh
#   bash scripts/probe_rpc.sh http://127.0.0.1:8181
#   bash scripts/probe_rpc.sh --direct     talk to Zallet, bypassing the router
#
# --direct matters: the rpc-router is built from z3's source, which pins an
# older Zallet. It routes by method name, so a method missing from its table
# returns "method not found" without Zallet ever being asked. That is
# indistinguishable from Zallet genuinely lacking the method - unless you ask
# Zallet yourself.
set -uo pipefail

URL="${1:-http://127.0.0.1:8181}"
AUTH=()

if [[ "${1:-}" == "--direct" ]]; then
  URL="http://127.0.0.1:50232"
  echo "Talking directly to Zallet at $URL (bypassing the rpc-router)"
  # Zallet writes a cookie credential on startup; use it rather than guessing
  # at the configured password.
  # The Zallet image is distroless - no shell, no cat - so read the cookie out
  # of its volume with a mounted helper container instead of docker exec.
  COOKIE=$(docker run --rm -v z3-regtest-zallet:/data busybox cat /data/.cookie 2>/dev/null | tr -d '
' || true)
  if [[ -n "$COOKIE" && "$COOKIE" == *:* ]]; then
    AUTH=(--user "$COOKIE")
    echo "Using the RPC cookie read from the z3-regtest-zallet volume"
  else
    echo "ERROR: could not read the RPC cookie. Without it Zallet returns 401" >&2
    echo "with an empty body, which is easy to mistake for a crash. Try:" >&2
    echo "  docker run --rm -v z3-regtest-zallet:/data busybox cat /data/.cookie" >&2
    exit 1
  fi
  echo
fi

# Methods Clearview needs, plus a few for comparison.
METHODS=(
  getblockchaininfo       # Zebra - proves the router reaches the node
  getinfo
  z_listaccounts          # wallet is answering at all
  getwalletstatus         # sync comparison; known to 502 on some builds
  z_getnotescount
  z_listunspent
  z_exportviewingkey      # Clearview: hand a key to the auditor
  z_importviewingkey      # Clearview: audit someone else's account
  z_listreceivedbyaddress # Clearview: receipts
  z_viewtransaction       # Clearview: classification - the critical one
  z_getbalanceforaccount  # Clearview: reconciliation
)

printf '%-26s %s\n' "METHOD" "RESULT"
printf '%-26s %s\n' "--------------------------" "----------------------------------------"

for m in "${METHODS[@]}"; do
  body=$(curl -s --max-time 15 -X POST -H "Content-Type: application/json" \
    -d "{\"jsonrpc\":\"2.0\",\"method\":\"$m\",\"params\":[],\"id\":1}" "$URL" 2>&1)

  if [[ -z "$body" ]]; then
    verdict="EMPTY BODY  <- usually 401: check credentials, not the method"
  elif [[ "$body" == *"Bad Gateway"* ]]; then
    verdict="502 BAD GATEWAY  <- broken on this build"
  elif [[ "$body" == *'"result"'* ]]; then
    verdict="OK"
  elif [[ "$body" == *"Method not found"* || "$body" == *-32601* ]]; then
    verdict="NOT IMPLEMENTED"
  elif [[ "$body" == *"Invalid params"* || "$body" == *-32602* ]]; then
    # The method exists and validated our (deliberately empty) arguments.
    verdict="OK (exists; needs params)"
  else
    verdict="$(printf '%s' "$body" | tr -d '\n' | cut -c1-58)"
  fi

  printf '%-26s %s\n' "$m" "$verdict"
done

cat <<'EOF'

How to read this:
  OK / needs params   usable - "needs params" just means we sent none
  NOT IMPLEMENTED     absent from this build
  502 BAD GATEWAY     the router could not get a response; broken here

Clearview needs z_viewtransaction, z_listreceivedbyaddress,
z_importviewingkey, z_exportviewingkey and z_getbalanceforaccount.
It does NOT need getwalletstatus.
EOF
