"""Reconstruct a reconciled ledger from a Zcash viewing key.

This is the whole product thesis in one module: given a viewing key and no
spending authority, produce complete, auditable books.

Three Zallet RPCs do the work:

* ``z_importviewingkey`` - give the wallet view-only authority over an account.
* ``z_listtransactions`` - account-scoped transaction listing. This replaces
  zcashd's ``z_listreceivedbyaddress``, which Zallet does not implement.
* ``z_viewtransaction`` - per-transaction detail. Its ``outputs[]`` carry the
  flags that make classification possible.

Classification follows Zallet's own semantics:

===========================  ==========================================
``outgoing = true``          the output left the wallet -> PAYMENT
``walletInternal = true``    change returning to the account -> CHANGE
an ``account_uuid`` we own   money arrived -> RECEIPT
none of the above            not ours; ignore
===========================  ==========================================

That last row matters. Zallet includes transparent inputs and outputs, and
**omits** ``outgoing`` for outputs that are neither ours nor in a transaction
we funded. Treating a missing flag as a receipt would silently invent income,
so membership is decided by ``account_uuid`` rather than by absence.

Because transactions are enumerated once and detailed once, an entry cannot be
counted twice - which the previous two-source design had to guard against.
"""

from __future__ import annotations

from .models import Direction, Ledger, LedgerEntry
from .rpc import ZcashRPC


def _memo_of(item: dict) -> str | None:
    """Prefer the decoded UTF-8 memo; fall back to hex, ignoring empty padding."""
    text = item.get("memoStr")
    if text and text.strip("\x00").strip():
        return text.strip("\x00").strip()
    raw = item.get("memo")
    # An empty Zcash memo is 0xF6 followed by zero padding.
    if raw and raw.strip("0") and not raw.startswith("f6"):
        return raw
    return None


def _amount_zat(item: dict) -> int:
    """Zallet reports valueZat; some payloads only carry a decimal `value`."""
    if "valueZat" in item:
        return int(item["valueZat"])
    if "amountZat" in item:
        return int(item["amountZat"])
    return int(round(float(item.get("value", item.get("amount", 0))) * 100_000_000))


def _classify(output: dict, owned: set[str]) -> Direction | None:
    """Decide what an output means for the account, or None if it is not ours."""
    if output.get("outgoing"):
        return Direction.PAYMENT
    if output.get("walletInternal"):
        return Direction.CHANGE
    # Ours only if Zallet attributes it to an account we hold a key for. An
    # absent `outgoing` flag is not evidence of a receipt.
    account = output.get("account_uuid")
    if account is not None and (not owned or account in owned):
        return Direction.RECEIPT
    if account is None and not owned:
        # No account attribution available at all (older builds): fall back to
        # treating an addressed, non-outgoing output as a receipt.
        return Direction.RECEIPT if output.get("address") else None
    return None


def list_transaction_ids(rpc: ZcashRPC, account: str | None = None) -> list[str]:
    """Every transaction the wallet knows about for `account`.

    ``z_listtransactions`` is marked experimental upstream, so the txid is read
    defensively: entries may be plain strings or objects.
    """
    entries = rpc.call("z_listtransactions", account) if account else rpc.call("z_listtransactions")
    txids = []
    for entry in entries or []:
        if isinstance(entry, str):
            txids.append(entry)
        elif isinstance(entry, dict):
            txid = entry.get("txid") or entry.get("transaction_id")
            if txid:
                txids.append(txid)
    # Preserve first-seen order while removing duplicates.
    return list(dict.fromkeys(txids))


def entries_in_transaction(
    rpc: ZcashRPC, txid: str, owned: set[str] | None = None
) -> list[LedgerEntry]:
    """Every ledger entry contained in one transaction."""
    detail = rpc.call("z_viewtransaction", txid)
    owned = owned or set()
    entries = []

    for index, output in enumerate(detail.get("outputs", [])):
        direction = _classify(output, owned)
        if direction is None:
            continue
        entries.append(
            LedgerEntry(
                txid=detail.get("txid", txid),
                direction=direction,
                pool=output.get("pool", "unknown"),
                amount_zat=_amount_zat(output),
                address=output.get("address"),
                memo=_memo_of(output),
                # Zallet returns block metadata on z_viewtransaction itself.
                block_height=detail.get("blockindex"),
                block_time=detail.get("blocktime"),
                confirmations=detail.get("confirmations"),
                output_index=output.get("output", output.get("action", index)),
            )
        )
    return entries


def build_ledger(
    rpc: ZcashRPC,
    viewing_key: str,
    account: str | None = None,
    owned_accounts: set[str] | None = None,
) -> Ledger:
    """Build a full ledger for `account`, which the viewing key can observe.

    The viewing key must already be imported (``z_importviewingkey``) so the
    wallet can decrypt the relevant notes. No spending key is ever required.
    """
    owned = owned_accounts or ({account} if account else set())
    ledger = Ledger(viewing_key=viewing_key)
    for txid in list_transaction_ids(rpc, account):
        ledger.entries.extend(entries_in_transaction(rpc, txid, owned))
    return ledger


def reconcile(rpc: ZcashRPC, ledger: Ledger, account: str, minconf: int = 1) -> dict:
    """Check the ledger against the node's own balance for the account.

    The point of an audit tool is that its books can be *proved* against the
    chain, so this compares the reconstructed balance to the node's and reports
    any drift.

    Uses ``z_getbalanceforaccount``. zcashd's ``z_getbalanceforviewingkey`` is
    **not planned** in Zallet: an imported viewing key becomes an account with a
    UUID, so the account-scoped method covers it (zallet#74).
    """
    reported = rpc.call("z_getbalanceforaccount", account, minconf)
    node_total = sum(
        int(pool.get("valueZat", 0)) for pool in (reported.get("pools") or {}).values()
    )
    derived = ledger.balance_zat
    return {
        "node_balance_zat": node_total,
        "ledger_balance_zat": derived,
        "difference_zat": derived - node_total,
        "reconciled": derived == node_total,
        "pools_reported": reported.get("pools", {}),
    }
