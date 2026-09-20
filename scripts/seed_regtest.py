#!/usr/bin/env python3
"""Seed the Z3 regtest chain with a believable nonprofit ledger.

Talks to the Z3 rpc-router, which forwards each method to Zebra (node) or
Zallet (wallet). zcashd is End of Life and is not part of this stack.

Funding on regtest works by pointing Zebra's `miner_address` at the wallet's
own Unified Address. Zebra pays the block reward to a single receiver,
preferring Orchard, so the coinbase lands directly in the shielded account and
no separate shielding step is needed. Because that address only exists after
the account does, the script configures Zebra and restarts it mid-run.

    python scripts/seed_regtest.py
    python scripts/seed_regtest.py --z3-dir ~/z3 --rpc-url http://127.0.0.1:8181
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clearview.models import to_zec  # noqa: E402
from clearview.rpc import RPCError, ZcashClient  # noqa: E402

DONATIONS = [(2.5, "Donation - Q3 appeal"),
             (1.0, "Monthly giving"),
             (0.25, "Anonymous gift")]
VENDOR_PAYMENT = (0.75, "Invoice 2026-114 - venue hire")

# Coinbase needs 100 confirmations before it can be spent.
COINBASE_MATURITY = 100


def step(msg: str) -> None:
    print(f"\n==> {msg}", flush=True)


def info(msg: str) -> None:
    print(f"    {msg}", flush=True)


def read_cookie() -> str:
    """Read Zallet's RPC cookie out of its Docker volume.

    The Zallet image is distroless - no shell, no `cat` - so `docker exec` will
    not work; mount the volume into a helper container instead.

    Doing this here rather than relying on an exported shell variable matters:
    an empty credential makes Zallet answer 401 with an **empty body**, which
    looks exactly like a crashed handler. That cost us a day.
    """
    result = subprocess.run(
        ["docker", "run", "--rm", "-v", "z3-regtest-zallet:/data",
         "busybox", "cat", "/data/.cookie"],
        capture_output=True, text=True,
    )
    cookie = result.stdout.strip()
    if ":" not in cookie:
        raise RuntimeError(
            "could not read Zallet's RPC cookie from the z3-regtest-zallet volume. "
            f"docker said: {result.stderr.strip() or '(nothing)'}"
        )
    return cookie


def compose(z3_dir: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["docker", "compose", "--env-file", ".env.regtest", *args],
        cwd=z3_dir, capture_output=True, text=True,
    )


def sync_gap(rpc: ZcashClient) -> int | None:
    """How many blocks the wallet is behind, or None if it is caught up.

    `getwalletstatus` is the documented way to ask, but it closes the
    connection on this build. `z_getnotescount` answers instead: while the
    wallet is behind it returns error -10 whose message states the gap, and
    once caught up it returns a normal result. So a working method is used to
    read the state that the broken one was meant to report.
    """
    try:
        rpc.call("z_getnotescount")
        return None
    except RPCError as err:
        if err.code != -10:
            raise
        match = re.search(r"(\d+)\s+blocks? behind", err.message)
        return int(match.group(1)) if match else -1


def wait_for_sync(rpc: ZcashClient, timeout: int = 240, quiet: bool = False) -> None:
    """Block until the wallet has caught up, reporting the gap as it closes."""
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        gap = sync_gap(rpc)
        if gap is None:
            if not quiet:
                info("wallet synced")
            return
        if gap != last and not quiet:
            info(f"wallet {gap} block(s) behind the tip")
            last = gap
        time.sleep(2)
    raise TimeoutError(
        f"wallet stayed {last} block(s) behind for {timeout}s. On an empty wallet "
        "Zallet's sync does not advance; creating an account should unblock it."
    )


def wait_for_wallet(rpc: ZcashClient, timeout: int = 180, quiet: bool = False) -> None:
    """Wait until the wallet has caught up with the node.

    `getwalletstatus` is the documented way to compare `wallet_tip` with
    `node_tip`, but it returns a 502 through the rpc-router on the pinned
    Zallet build. So it is treated as best-effort: if it is unavailable, fall
    back to polling a method that does work, which at least proves the wallet
    is answering before we rely on it.
    """
    deadline = time.time() + timeout
    used_status = True
    while time.time() < deadline:
        try:
            status = rpc.call("getwalletstatus")
        except (RPCError, RuntimeError):
            used_status = False
            break
        wallet_tip = (status.get("wallet_tip") or {}).get("height", status.get("wallet_tip"))
        node_tip = (status.get("node_tip") or {}).get("height", status.get("node_tip"))
        if wallet_tip is not None and wallet_tip == node_tip:
            if not quiet:
                info(f"wallet synced at height {wallet_tip}")
            return
        if not quiet:
            info(f"syncing... wallet {wallet_tip} / node {node_tip}")
        time.sleep(2)

    if used_status:
        raise TimeoutError(f"wallet did not reach the node tip within {timeout}s")

    # Fallback: getwalletstatus is unusable on this build.
    while time.time() < deadline:
        try:
            rpc.call("z_listaccounts")
            if not quiet:
                info("wallet responding (getwalletstatus unavailable on this build)")
            # Scanning lags block arrival slightly; give it a moment to settle.
            time.sleep(3)
            return
        except (RPCError, RuntimeError) as err:
            last = err
            time.sleep(2)
    raise TimeoutError(f"wallet never answered within {timeout}s. last error: {last}")


def wait_for_operation(rpc: ZcashClient, opid: str, timeout: int = 300) -> dict:
    """z_sendmany is asynchronous; poll to completion."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        results = rpc.call("z_getoperationstatus", [opid])
        if results:
            status = results[0].get("status")
            if status == "success":
                return rpc.call("z_getoperationresult", [opid])[0]
            if status == "failed":
                raise RuntimeError(f"{opid} failed: {results[0].get('error')}")
        time.sleep(2)
    raise TimeoutError(f"{opid} did not finish within {timeout}s")


def set_miner_address(z3_dir: Path, address: str) -> None:
    """Point Zebra's coinbase at the wallet's Unified Address, then restart it.

    z3 configures Zebra by **environment variable**, not by the TOML file:
    `.env.regtest` ships `ZEBRA_MINING__MINER_ADDRESS` set to a transparent
    address that is not in our wallet. The env var wins over
    `config/regtest/zebra.toml`, so editing the TOML has no effect - the
    variable has to be replaced.

    Zebra accepts a Unified Address here and pays the reward to a single
    receiver, preferring Orchard, so the coinbase lands straight in the
    shielded account.
    """
    env_file = z3_dir / ".env.regtest"
    if not env_file.exists():
        raise FileNotFoundError(f"{env_file} not found")

    text = env_file.read_text()
    key = "ZEBRA_MINING__MINER_ADDRESS"
    if re.search(rf"^{key}=", text, re.M):
        current = re.search(rf"^{key}=(.*)$", text, re.M).group(1).strip()
        if current == address:
            info("miner address already points at this account")
            return
        # Keep the shipped value visible rather than silently discarding it.
        text = re.sub(rf"^{key}=.*$",
                      f"# clearview: was {current}\n{key}={address}", text, flags=re.M)
    else:
        text = text.rstrip() + f"\n{key}={address}\n"
    env_file.write_text(text)
    info(f"{key} -> {address[:30]}...")

    result = compose(z3_dir, "up", "-d", "zebra")
    if result.returncode != 0:
        raise RuntimeError(f"failed to recreate Zebra:\n{result.stderr}")
    info("Zebra recreated with the new miner address")


def wait_for_zebra(rpc: ZcashClient, timeout: int = 120) -> int:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            return rpc.call("getblockchaininfo")["blocks"]
        except (RPCError, RuntimeError):
            time.sleep(2)
    raise TimeoutError("Zebra did not come back after restart")


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--rpc-url", default="http://127.0.0.1:8181")
    p.add_argument("--rpc-user")
    p.add_argument("--rpc-password")
    p.add_argument("--z3-dir", default=str(Path.home() / "z3"))
    p.add_argument("--account-name", default="clearview-demo")
    p.add_argument("--cookie", help="Zallet RPC cookie; read from the volume if omitted")
    args = p.parse_args()

    z3_dir = Path(args.z3_dir).expanduser()

    # Two endpoints on purpose:
    #   node   - Zebra, for `generate`, reached through the rpc-router
    #   wallet - Zallet directly, because the router reports methods as missing
    #            when they are absent from its own older routing table
    node = ZcashClient(args.rpc_user, args.rpc_password, url=args.rpc_url)
    wallet = ZcashClient.from_cookie(args.cookie or read_cookie())
    rpc = wallet  # wallet calls dominate

    step("checking the stack")
    try:
        chain = node.call("getblockchaininfo")
        info(f"Zebra  : {chain.get('chain')} chain at height {chain.get('blocks')}")
        info("Zallet : reached directly with its RPC cookie")
    except (RPCError, RuntimeError) as err:
        print(f"Cannot reach Zebra: {err}\n"
              f"Is the stack up?  cd {z3_dir} && docker compose --env-file .env.regtest ps",
              file=sys.stderr)
        return 2

    # Order matters. On an empty wallet Zallet's sync does not advance and its
    # account-enumeration methods (z_listaccounts, getwalletstatus,
    # z_listtransactions) close the connection. Creating an account first gives
    # the scanner something to look for.
    step("creating the organisation's account")
    account = wallet.call("z_getnewaccount", args.account_name)
    account_ref = account.get("account_uuid") or account.get("account")
    info(f"account: {account_ref}")

    zaddr = wallet.call("z_getaddressforaccount", account_ref)["address"]
    info(f"address: {zaddr}")

    step("pointing Zebra's coinbase at that address")
    set_miner_address(z3_dir, zaddr)
    wait_for_zebra(node)

    step(f"mining {COINBASE_MATURITY + 5} blocks so the reward matures")
    node.call("generate", COINBASE_MATURITY + 5)
    info(f"height : {node.call('getblockchaininfo')['blocks']}")
    wait_for_sync(wallet)

    balance = wallet.call("z_getbalanceforaccount", account_ref, 1)
    pools = balance.get("pools") or {}
    total = sum(int(v.get("valueZat", 0)) for v in pools.values())
    info(f"funded : {to_zec(total)} ZEC across {', '.join(pools) or 'no pools'}")
    if total == 0:
        print("\nThe account received no coinbase. Check Zebra picked up the miner "
              "address:\n  grep -A2 '\\[mining\\]' "
              f"{z3_dir}/config/regtest/zebra.toml", file=sys.stderr)
        return 1

    def send(amount: float, memo: str) -> None:
        recipients = [{"address": zaddr, "amount": amount, "memo": memo.encode().hex()}]
        try:
            result = wallet.call("z_sendmany", zaddr, recipients)
        except RPCError as err:
            # Shielded-to-self can still trip the default privacy policy.
            if "privacy" not in err.message.lower():
                raise
            result = wallet.call("z_sendmany", zaddr, recipients, None, None, "AllowRevealedAmounts")
        opid = result.get("opid") if isinstance(result, dict) else result
        wait_for_operation(rpc, opid)
        node.call("generate", 1)
        wait_for_sync(wallet, quiet=True)
        info(f'{amount:>5} ZEC  "{memo}"')

    step("seeding the ledger")
    for amount, memo in DONATIONS:
        send(amount, memo)
    send(*VENDOR_PAYMENT)

    step("balance according to the node")
    for pool, detail in ((wallet.call("z_getbalanceforaccount", account_ref, 1)
                          .get("pools")) or {}).items():
        info(f"{pool:<12} {to_zec(int(detail.get('valueZat', 0)))}")

    step("viewing key - this is what the auditor receives")
    viewing_key = wallet.call("z_exportviewingkey", zaddr)
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
