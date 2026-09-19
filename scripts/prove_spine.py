#!/usr/bin/env python3
"""Prove the Clearview thesis: a viewing key alone reconstructs auditable books.

This is the week 1 deliverable. Console output, no UI. Either the claim holds or
we pivot.

    # against canned data - works today, no node required
    python scripts/prove_spine.py --mock

    # against the Z3 stack (Zebra + Zallet) on regtest, via the rpc-router
    python scripts/prove_spine.py \
        --rpc-url http://127.0.0.1:8181 \
        --viewing-key uview1... --address ztestsapling1... --account <uuid>

If --viewing-key is given, it is imported first (z_importviewingkey), so the node
can decrypt the relevant notes. A spending key is never requested.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clearview.ledger import build_ledger, reconcile  # noqa: E402
from clearview.models import Direction, Ledger, to_zec  # noqa: E402
from clearview.rpc import RPCError, ZcashClient  # noqa: E402

BAR = "=" * 78
SYMBOL = {Direction.RECEIPT: "+", Direction.PAYMENT: "-", Direction.CHANGE: "~"}


def render(ledger: Ledger, recon: dict) -> None:
    print(BAR)
    print("CLEARVIEW - books reconstructed from a viewing key")
    print(BAR)
    print(f"viewing key : {ledger.viewing_key[:48]}...")
    print(f"entries     : {len(ledger.entries)}")
    print()

    print(f"{'height':>8}  {'date':<11} {'type':<8} {'pool':<10} {'amount':>16} {'balance':>16}")
    print("-" * 78)
    for entry, balance in ledger.running_balance():
        when = entry.timestamp.strftime("%Y-%m-%d") if entry.timestamp else "unconfirmed"
        height = entry.block_height if entry.block_height is not None else "-"
        amount = f"{SYMBOL[entry.direction]}{to_zec(entry.amount_zat)}"
        print(
            f"{height:>8}  {when:<11} {entry.direction.value:<8} {entry.pool:<10} "
            f"{amount:>16} {to_zec(balance):>16}"
        )
        if entry.memo:
            print(f"{'':>10}  memo: {entry.memo}")

    print("-" * 78)
    print(f"{'received':<22} {to_zec(ledger.total_received_zat):>16}")
    print(f"{'paid out':<22} {to_zec(ledger.total_paid_zat):>16}")
    print(f"{'balance':<22} {to_zec(ledger.balance_zat):>16}")
    print()
    print("by pool:")
    for pool, amount in sorted(ledger.by_pool().items()):
        print(f"  {pool:<12} {to_zec(amount):>16}")

    print()
    print(BAR)
    status = "RECONCILED" if recon["reconciled"] else "DRIFT DETECTED"
    print(f"{status}: ledger {to_zec(recon['ledger_balance_zat'])} ZEC "
          f"vs node {to_zec(recon['node_balance_zat'])} ZEC "
          f"(difference {to_zec(recon['difference_zat'])})")
    print(BAR)
    if not recon["reconciled"]:
        print("\nBooks disagree with the chain. That is the tool working, not failing -")
        print("an audit tool that cannot detect drift is worse than no tool.")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--mock", action="store_true", help="run against canned data, no node")
    p.add_argument("--rpc-user")
    p.add_argument("--rpc-password")
    p.add_argument("--rpc-url", help="full RPC URL, e.g. the Z3 router at http://127.0.0.1:8181")
    p.add_argument("--rpc-host", default="127.0.0.1")
    p.add_argument("--rpc-port", type=int)
    p.add_argument("--network", default="regtest", choices=["mainnet", "testnet", "regtest"])
    p.add_argument("--viewing-key", help="import this viewing key before reading")
    p.add_argument("--address", action="append", default=[], help="shielded address (repeatable)")
    p.add_argument("--account", help="account UUID for reconciliation (Zallet). Defaults to the viewing key")
    p.add_argument("--minconf", type=int, default=1)
    p.add_argument("--rescan-height", type=int, default=0)
    args = p.parse_args()

    if args.mock:
        sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
        from tests.fixtures import UFVK, ZADDR, FakeZcashRPC

        from tests.fixtures import ACCOUNT_UUID

        rpc, key, addresses = FakeZcashRPC(), UFVK, [ZADDR]
        args.account = args.account or ACCOUNT_UUID
        print("[mock mode - canned data, no node contacted]\n")
    else:
        if not args.address:
            p.error("at least one --address is required")
        rpc = ZcashClient(args.rpc_user, args.rpc_password, args.rpc_host,
                          args.rpc_port, args.network, url=args.rpc_url)
        key, addresses = args.viewing_key or "(not supplied)", args.address

        try:
            info = rpc.getblockchaininfo()
            print(f"connected: {info.get('chain')} chain at height {info.get('blocks')}\n")
        except (RPCError, RuntimeError) as err:
            print(f"Could not reach zcashd: {err}", file=sys.stderr)
            return 2

        if args.viewing_key:
            try:
                rpc.z_importviewingkey(args.viewing_key, "whenkeyisnew", args.rescan_height)
                print("viewing key imported (no spending key used)\n")
            except RPCError as err:
                # Re-importing an existing key is not an error worth stopping for.
                print(f"note: import returned '{err.message}' - continuing\n")

    try:
        ledger = build_ledger(rpc, key, addresses, args.minconf)
        recon = reconcile(rpc, ledger, args.account or key, args.minconf)
    except (RPCError, RuntimeError) as err:
        print(f"Failed while reading the chain: {err}", file=sys.stderr)
        return 1

    render(ledger, recon)
    return 0 if recon["reconciled"] else 3


if __name__ == "__main__":
    sys.exit(main())
