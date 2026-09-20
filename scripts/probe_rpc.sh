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
set -uo pipefail

URL="${1:-http://127.0.0.1:8181}"

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
    verdict="NO RESPONSE"
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
