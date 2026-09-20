#!/usr/bin/env python3
"""Ask the running node which RPC methods it actually serves.

Replaces an earlier shell version. That script broke three separate ways in one
day - `docker exec cat` on a distroless image, CRLF line endings, and a bash
array expansion that silently dropped the credentials - and each failure looked
like a finding about Zallet rather than a bug in the probe. This version reuses
Clearview's own RPC client, so the tool under test is the code that matters.

Why this exists at all: documentation cannot be trusted here. Zallet's
published status matrix still lists `z_importviewingkey` as unimplemented
months after it merged, and the Z3 rpc-router reports methods as missing
whenever they are absent from its own older routing table. Only the node knows.

    python scripts/probe_rpc.py              # Zallet directly, via its cookie
    python scripts/probe_rpc.py --router     # through the Z3 rpc-router
    python scripts/probe_rpc.py --both       # compare the two
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clearview.rpc import RPCError, ZcashClient  # noqa: E402

# Methods Clearview depends on, plus a few for contrast.
METHODS = [
    ("getblockchaininfo", "Zebra - proves we reached the node at all"),
    ("z_listaccounts", "enumerate accounts"),
    ("getwalletstatus", "sync status (Clearview does not need it)"),
    ("z_getnotescount", "note counts"),
    ("z_listunspent", "unspent notes"),
    ("z_getnewaccount", "CREATE an account - the current blocker"),
    ("z_recoveraccounts", "re-create accounts from existing seeds"),
    ("z_exportviewingkey", "CLEARVIEW: produce a viewing key"),
    ("z_importviewingkey", "CLEARVIEW: import an auditor's key"),
    ("z_listtransactions", "CLEARVIEW: enumerate transactions"),
    ("z_viewtransaction", "CLEARVIEW: classify outputs"),
    ("z_getbalanceforaccount", "CLEARVIEW: reconcile"),
]

VOLUME = "z3-regtest-zallet"


def read_cookie(volume: str = VOLUME) -> str:
    """Read Zallet's RPC cookie from its Docker volume.

    The image is distroless, so `docker exec ... cat` fails; mount the volume
    into a helper container instead.
    """
    result = subprocess.run(
        ["docker", "run", "--rm", "-v", f"{volume}:/data", "busybox", "cat", "/data/.cookie"],
        capture_output=True, text=True,
    )
    cookie = result.stdout.strip()
    if ":" not in cookie:
        raise RuntimeError(
            f"could not read the RPC cookie from volume {volume}. "
            f"docker said: {result.stderr.strip() or '(nothing)'}"
        )
    return cookie


def classify(rpc: ZcashClient, method: str) -> str:
    """Call `method` with no arguments and interpret the outcome.

    Calling with no arguments is deliberate: a method that exists will complain
    about the arguments, which proves it is implemented without changing state.
    """
    try:
        rpc.call(method)
        return "OK"
    except RPCError as err:
        if err.code == -32601:
            return "NOT IMPLEMENTED"
        if err.code == -32602:
            return "OK (exists; needs params)"
        if err.code == -10:
            return f"OK (exists) - wallet state: {err.message[:58]}"
        if err.code in (401, 403):
            return "AUTH FAILED - credentials rejected"
        return f"error {err.code}: {err.message[:52]}"
    except RuntimeError as err:
        text = str(err)
        if "closed the connection" in text:
            return "CONNECTION CLOSED - broken on this build"
        if "Cannot reach" in text:
            return "UNREACHABLE"
        return text[:70]


def probe(label: str, rpc: ZcashClient) -> dict[str, str]:
    print(f"\n{label}")
    print("-" * 78)
    print(f"{'METHOD':<26} {'RESULT'}")
    results = {}
    for method, note in METHODS:
        verdict = classify(rpc, method)
        results[method] = verdict
        print(f"{method:<26} {verdict}")
        if note.startswith("CLEARVIEW") or "blocker" in note:
            print(f"{'':<26}   ^ {note}")
    return results


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--router", action="store_true", help="probe the Z3 rpc-router")
    p.add_argument("--both", action="store_true", help="probe both and compare")
    p.add_argument("--router-url", default="http://127.0.0.1:8181")
    p.add_argument("--zallet-port", type=int, default=50232)
    p.add_argument("--volume", default=VOLUME)
    args = p.parse_args()

    direct_results = router_results = None

    if not args.router or args.both:
        try:
            cookie = read_cookie(args.volume)
            print(f"Read the RPC cookie from volume {args.volume} "
                  f"(user '{cookie.split(':')[0]}')")
            direct = ZcashClient.from_cookie(cookie, port=args.zallet_port)
            direct_results = probe(
                f"ZALLET DIRECT  http://127.0.0.1:{args.zallet_port}", direct)
        except RuntimeError as err:
            print(f"Could not probe Zallet directly: {err}", file=sys.stderr)

    if args.router or args.both:
        router = ZcashClient(url=args.router_url)
        router_results = probe(f"VIA RPC-ROUTER  {args.router_url}", router)

    if direct_results and router_results:
        disagreements = [
            (m, direct_results[m], router_results[m])
            for m in direct_results
            if ("NOT IMPLEMENTED" in router_results[m])
            != ("NOT IMPLEMENTED" in direct_results[m])
        ]
        print("\nWHERE THE ROUTER DISAGREES WITH THE WALLET")
        print("-" * 78)
        if disagreements:
            for method, d, r in disagreements:
                print(f"{method:<26} direct: {d[:24]:<24} router: {r[:24]}")
            print("\nThe router routes by a table built against an older Zallet, so it\n"
                  "reports methods as missing that the wallet implements. Clearview\n"
                  "therefore talks to Zallet directly.")
        else:
            print("(none - the router agrees with the wallet on availability)")

    print("\nReading the results:")
    print("  OK / needs params        usable; 'needs params' just means we sent none")
    print("  OK (exists) - wallet...  implemented, but blocked by wallet state")
    print("  NOT IMPLEMENTED          absent from this build")
    print("  CONNECTION CLOSED        the method drops the connection; broken here")
    print("  AUTH FAILED              a credentials problem, not a missing method")
    return 0


if __name__ == "__main__":
    sys.exit(main())
