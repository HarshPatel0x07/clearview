"""Reconstruct a reconciled ledger from a Zcash viewing key.

This is the whole product thesis in one module: given a viewing key and no
spending authority, produce complete, auditable books.

Two zcashd RPCs do the work:

* ``z_listreceivedbyaddress`` - every note received by a shielded address, with
  amount, memo, height and a ``change`` flag.
* ``z_viewtransaction`` - per-transaction shielded detail, whose ``outputs[]``
  carry ``outgoing`` (the output is *not* for a wallet address, i.e. a payment
  out) and ``walletInternal`` (change). Those two flags are the classification
  bookkeeping needs.

Receipts come from the first; payments and change come from the second. Taking
receipts from only one source is what keeps them from being double counted.
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


def receipts_for_address(rpc: ZcashRPC, address: str, minconf: int = 1) -> list[LedgerEntry]:
    """Every note received at `address`, as ledger entries.

    Outputs flagged ``change`` are recorded as CHANGE so they do not inflate
    revenue, but are kept so the books reconcile against on-chain reality.
    """
    entries = []
    for note in rpc.call("z_listreceivedbyaddress", address, minconf):
        is_change = bool(note.get("change"))
        entries.append(
            LedgerEntry(
                txid=note["txid"],
                direction=Direction.CHANGE if is_change else Direction.RECEIPT,
                pool=note.get("pool", "unknown"),
                amount_zat=int(note["amountZat"]),
                address=address,
                memo=_memo_of(note),
                block_height=note.get("blockheight"),
                block_time=note.get("blocktime"),
                confirmations=note.get("confirmations"),
                output_index=note.get("outindex", note.get("jsoutindex")),
            )
        )
    return entries


def payments_in_transaction(rpc: ZcashRPC, txid: str) -> list[LedgerEntry]:
    """Outbound payments in `txid`, from its shielded outputs.

    An output with ``outgoing = true`` went to an address outside the wallet,
    which is a payment. ``walletInternal`` marks change and is handled by
    `receipts_for_address`, so it is skipped here to avoid double counting.
    """
    detail = rpc.call("z_viewtransaction", txid)
    entries = []
    for output in detail.get("outputs", []):
        if not output.get("outgoing"):
            continue
        entries.append(
            LedgerEntry(
                txid=detail.get("txid", txid),
                direction=Direction.PAYMENT,
                pool=output.get("pool", "unknown"),
                amount_zat=int(output["valueZat"]),
                address=output.get("address"),
                memo=_memo_of(output),
                output_index=output.get("output", output.get("action")),
            )
        )
    return entries


def build_ledger(
    rpc: ZcashRPC,
    viewing_key: str,
    addresses: list[str],
    minconf: int = 1,
) -> Ledger:
    """Build a full ledger for `addresses`, which the viewing key can observe.

    The viewing key must already be imported (``z_importviewingkey``) so zcashd
    can decrypt the relevant notes. No spending key is ever required or used.
    """
    ledger = Ledger(viewing_key=viewing_key)

    for address in addresses:
        ledger.entries.extend(receipts_for_address(rpc, address, minconf))

    # Only transactions we can already see are worth asking about; payments are
    # discovered by re-examining those same transactions for outgoing outputs.
    seen_txids = {entry.txid for entry in ledger.entries}
    known_heights = {
        entry.txid: (entry.block_height, entry.block_time, entry.confirmations)
        for entry in ledger.entries
    }

    for txid in sorted(seen_txids):
        for payment in payments_in_transaction(rpc, txid):
            height, time, confs = known_heights.get(txid, (None, None, None))
            ledger.entries.append(
                LedgerEntry(
                    txid=payment.txid,
                    direction=payment.direction,
                    pool=payment.pool,
                    amount_zat=payment.amount_zat,
                    address=payment.address,
                    memo=payment.memo,
                    block_height=height,
                    block_time=time,
                    confirmations=confs,
                    output_index=payment.output_index,
                )
            )

    return ledger


def reconcile(rpc: ZcashRPC, ledger: Ledger, minconf: int = 1) -> dict:
    """Check the ledger against the node's own balance for the viewing key.

    The point of an audit tool is that its books can be *proved* against the
    chain, so this compares the reconstructed balance to
    ``z_getbalanceforviewingkey`` and reports any drift.
    """
    reported = rpc.call("z_getbalanceforviewingkey", ledger.viewing_key, minconf)
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
