"""Fake zcashd, returning responses shaped exactly like the real RPC.

Schemas transcribed from the Zcash 6.12.2 RPC docs:
  * z_listreceivedbyaddress - pool, txid, amount, amountZat, memo, memoStr,
    confirmations, blockheight, blockindex, blocktime, outindex, change
  * z_viewtransaction       - txid, spends[], outputs[] with pool, address,
    outgoing, walletInternal, value, valueZat, memo, memoStr
  * z_getbalanceforviewingkey - {"pools": {<pool>: {"valueZat": n}}, ...}

Getting these shapes right is the point: the logic is verified now, and only the
HTTP transport stays unproven until a node exists.
"""

from __future__ import annotations

from typing import Any

ZADDR = "ztestsapling1audit0000000000000000000000000000000000000000000000000000000000000000000000"
UFVK = "uviewtest1clearview00000000000000000000000000000000000000000000000000000000000000000000"
# An imported viewing key becomes a Zallet account identified by UUID; the
# account-scoped balance method is what reconciliation uses (zallet#74).
ACCOUNT_UUID = "6f1f1f3a-0d2c-4e5b-9a77-1b2c3d4e5f60"

# An empty Zcash memo: 0xF6 followed by zero padding.
EMPTY_MEMO = "f6" + "00" * 511


def _memo(text: str) -> dict[str, str]:
    return {"memo": text.encode().hex() + "00" * (512 - len(text.encode())), "memoStr": text}


class FakeZcashRPC:
    """Implements the `ZcashRPC` protocol with canned, schema-accurate data.

    Scenario: a nonprofit receives three donations, pays one vendor, and gets
    change back. 2.5 + 1.0 + 0.25 received, 0.75 paid out.
    """

    def __init__(self, received: list[dict] | None = None,
                 transactions: dict[str, dict] | None = None,
                 balance: dict | None = None) -> None:
        self.received = received if received is not None else DEFAULT_RECEIVED
        self.transactions = transactions if transactions is not None else DEFAULT_TRANSACTIONS
        self.balance = balance if balance is not None else DEFAULT_BALANCE
        self.calls: list[tuple[str, tuple[Any, ...]]] = []

    def call(self, method: str, *params: Any) -> Any:
        self.calls.append((method, params))
        if method == "z_listtransactions":
            return [{"txid": t} for t in self.transactions]
        if method == "z_viewtransaction":
            return self.transactions.get(params[0], {"txid": params[0], "spends": [], "outputs": []})
        if method == "z_getbalanceforaccount":
            return self.balance
        if method == "z_importviewingkey":
            return {"type": "sapling", "address": ZADDR}
        raise AssertionError(f"unexpected RPC call: {method}")


DEFAULT_RECEIVED: list[dict] = [
    {
        "pool": "orchard",
        "txid": "aa" * 32,
        "amount": 2.5,
        "amountZat": 250_000_000,
        **_memo("Donation - Q3 appeal"),
        "confirmations": 40,
        "blockheight": 100,
        "blockindex": 1,
        "blocktime": 1_758_000_000,
        "outindex": 0,
        "change": False,
    },
    {
        "pool": "orchard",
        "txid": "bb" * 32,
        "amount": 1.0,
        "amountZat": 100_000_000,
        **_memo("Monthly giving"),
        "confirmations": 30,
        "blockheight": 110,
        "blockindex": 2,
        "blocktime": 1_758_100_000,
        "outindex": 0,
        "change": False,
    },
    {
        # Change returning from the vendor payment in tx cc.
        "pool": "orchard",
        "txid": "cc" * 32,
        "amount": 2.7499,
        "amountZat": 274_990_000,
        "memo": EMPTY_MEMO,
        "confirmations": 20,
        "blockheight": 120,
        "blockindex": 1,
        "blocktime": 1_758_200_000,
        "outindex": 1,
        "change": True,
    },
    {
        "pool": "sapling",
        "txid": "dd" * 32,
        "amount": 0.25,
        "amountZat": 25_000_000,
        **_memo("Anonymous gift"),
        "confirmations": 5,
        "blockheight": 130,
        "blockindex": 3,
        "blocktime": 1_758_300_000,
        "outindex": 0,
        "change": False,
    },
]

DEFAULT_TRANSACTIONS: dict[str, dict] = {
    "aa" * 32: {"txid": "aa" * 32, "confirmations": 40, "blockindex": 100,
                "blocktime": 1_758_000_000, "spends": [], "outputs": [
        {"pool": "orchard", "action": 0, "address": ZADDR, "outgoing": False,
         "walletInternal": False, "value": 2.5, "valueZat": 250_000_000,
         "account_uuid": ACCOUNT_UUID, **_memo("Donation - Q3 appeal")},
    ]},
    "bb" * 32: {"txid": "bb" * 32, "confirmations": 30, "blockindex": 110,
                "blocktime": 1_758_100_000, "spends": [], "outputs": [
        {"pool": "orchard", "action": 0, "address": ZADDR, "outgoing": False,
         "walletInternal": False, "value": 1.0, "valueZat": 100_000_000,
         "account_uuid": ACCOUNT_UUID, **_memo("Monthly giving")},
    ]},
    # The vendor payment: one outgoing output, one change output.
    # Zallet adds top-level status/confirmations/blockhash/blockindex/blocktime/
    # fee/account_uuid, so block metadata arrives here rather than being joined
    # from the receipt.
    "cc" * 32: {
        "txid": "cc" * 32,
        "status": "mined",
        "confirmations": 20,
        "blockhash": "0" * 64,
        "blockindex": 120,
        "blocktime": 1_758_200_000,
        "version": 5,
        "expiryheight": 140,
        "fee": 0.0001,
        "generated": False,
        "spends": [
            {"pool": "orchard", "action": 0, "txidPrev": "aa" * 32, "actionPrev": 0,
             "address": ZADDR, "value": 3.5, "valueZat": 350_000_000,
             "account_uuid": ACCOUNT_UUID},
        ],
        "outputs": [
            {"pool": "orchard", "action": 0, "address": "ztestsapling1vendor000000000000000000",
             "outgoing": True, "walletInternal": False, "value": 0.75, "valueZat": 75_000_000,
             **_memo("Invoice 2026-114 - venue hire")},
            {"pool": "orchard", "action": 1, "outgoing": False, "walletInternal": True,
             "value": 2.7499, "valueZat": 274_990_000, "memo": EMPTY_MEMO,
             "account_uuid": ACCOUNT_UUID},
            # Zallet includes transparent outputs and omits `outgoing` when the
            # output is neither ours nor in a wallet-funded transaction. A missing
            # flag must not be read as a payment.
            {"pool": "transparent", "tOut": 0, "address": "tmUnrelated0000000000000000000000",
             "value": 0.01, "valueZat": 1_000_000},
        ],
    },
    "dd" * 32: {"txid": "dd" * 32, "confirmations": 5, "blockindex": 130,
                "blocktime": 1_758_300_000, "spends": [], "outputs": [
        {"pool": "sapling", "output": 0, "address": ZADDR, "outgoing": False,
         "walletInternal": False, "value": 0.25, "valueZat": 25_000_000,
         "account_uuid": ACCOUNT_UUID, **_memo("Anonymous gift")},
    ]},
}

# 2.5 + 1.0 + 0.25 received, minus 0.75 paid = 3.0 ZEC.
DEFAULT_BALANCE: dict = {
    "pools": {
        "orchard": {"valueZat": 275_000_000},
        "sapling": {"valueZat": 25_000_000},
    },
    "minimum_confirmations": 1,
}
