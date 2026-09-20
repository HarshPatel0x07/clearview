#!/usr/bin/env python3
"""Seed the Z3 regtest chain with a believable nonprofit ledger.

Talks to the Z3 rpc-router, which forwards each method to Zebra (node) or
Zallet (wallet) automatically. Replaces the old zcash-cli script: zcashd is
End of Life and no longer part of the stack.

Produces exactly the shape Clearview must classify - donations received, a
vendor payment out, and the change that returns - then exports the viewing key
and prints the command to prove the thesis against it.

    python scripts/seed_regtest.py
    python scripts/seed_regtest.py --rpc-url http://127.0.0.1:8181
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clearview.models import to_zec  # noqa: E402
from clearview.rpc import RPCError, ZcashClient  # noqa: E402

DONATIONS = [
    ("2.5", "Donation - Q3 appeal"),
    ("1.0", "Monthly giving"),
    ("0.25", "Anonymous gift"),
]
VENDOR_PAYMENT = ("0.75", "Invoice 2026-114 - venue hire")


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def hex_memo(text: str) -> str:
    return text.encode().hex()


def wait_for_operation(rpc: ZcashClient, opid: str, timeout: int = 180) -> dict:
    """z_sendmany and z_shieldcoinbase are asynchronous; poll to completion."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        results = rpc.call("z_getoperationstatus", [opid])
        if not results:
            time.sleep(2)
            continue
        status = results[0].get("status")
        if status == "success":
            return rpc.call("z_getoperationresult", [opid])[0]
        if status == "failed":
            detail = results[0].get("error", {})
            raise RuntimeError(f"operation {opid} failed: {detail}")
        time.sleep(2)
    raise TimeoutError(f"operation {opid} did not finish within {timeout}s")


def mine(rpc: ZcashClient, blocks: int) -> None:
    """regtest only produces blocks on demand."""
    rpc.call("generate", blocks)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--rpc-url", default="http://127.0.0.1:8181",
                   help="Z3 rpc-router (default: %(default)s)")
    p.add_argument("--rpc-user")
    p.add_argument("--rpc-password")
    p.add_argument("--account-name", default="clearview-demo")
    args = p.parse_args()

    rpc = ZcashClient(args.rpc_user, args.rpc_password, url=args.rpc_url)

    step("checking the stack")
    try:
        info = rpc.call("getblockchaininfo")
        print(f"    Zebra  : {info.get('chain')} chain at height {info.get('blocks')}")
    except (RPCError, RuntimeError) as err:
        print(f"Cannot reach Zebra via the router: {err}", file=sys.stderr)
        print("Is the stack up?  cd ~/z3 && docker compose --env-file .env.regtest ps",
              file=sys.stderr)
        return 2
    try:
        rpc.call("getwalletinfo")
        print("    Zallet : responding")
    except (RPCError, RuntimeError) as err:
        print(f"Router reached Zebra but not Zallet: {err}", file=sys.stderr)
        return 2

    step("creating the organisation's account")
    # Zallet requires an account name, unlike zcashd.
    try:
        account = rpc.call("z_getnewaccount", args.account_name)
    except RPCError:
        account = rpc.call("z_getnewaccount")
    account_uuid = account.get("account_uuid")
    account_ref = account_uuid or account.get("account")
    print(f"    account: {account_ref}")

    addr_info = rpc.call("z_getaddressforaccount", account_ref)
    zaddr = addr_info["address"]
    print(f"    address: {zaddr}")

    step("mining to maturity (coinbase needs 100 confirmations)")
    mine(rpc, 105)
    print(f"    height : {rpc.call('getblockchaininfo')['blocks']}")

    step("shielding coinbase into the account")
    shield = rpc.call("z_shieldcoinbase", "*", zaddr)
    opid = shield.get("opid") if isinstance(shield, dict) else shield
    wait_for_operation(rpc, opid)
    mine(rpc, 3)
    print("    shielded")

    def send(amount: str, memo: str) -> None:
        recipients = [{"address": zaddr, "amount": float(amount), "memo": hex_memo(memo)}]
        # Zallet: fee must be null (ZIP 317 always). Privacy policy must permit
        # the revealed amounts that shielding to one's own address implies.
        result = rpc.call("z_sendmany", zaddr, recipients, 1, None, "AllowRevealedAmounts")
        opid_ = result.get("opid") if isinstance(result, dict) else result
        wait_for_operation(rpc, opid_)
        mine(rpc, 1)
        print(f"    {amount:>5} ZEC  \"{memo}\"")

    step("seeding the ledger")
    for amount, memo in DONATIONS:
        send(amount, memo)
    send(*VENDOR_PAYMENT)

    step("balance according to the node")
    balance = rpc.call("z_getbalanceforaccount", account_ref, 1)
    for pool, detail in (balance.get("pools") or {}).items():
        print(f"    {pool:<12} {to_zec(int(detail.get('valueZat', 0)))}")

    step("viewing key - this is what the auditor receives")
    viewing_key = rpc.call("z_exportviewingkey", zaddr)
    print(f"\n{viewing_key}\n")
    print("It carries NO spending authority.")

    print("\n" + "=" * 78)
    print("Now prove the thesis against real chain data:\n")
    print("python scripts/prove_spine.py \\")
    print(f"  --rpc-url {args.rpc_url} \\")
    print(f"  --viewing-key '{viewing_key}' \\")
    print(f"  --address '{zaddr}' \\")
    print(f"  --account '{account_ref}'")
    print("=" * 78)
    return 0


if __name__ == "__main__":
    sys.exit(main())
