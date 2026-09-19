"""Ledger types.

All amounts are integer **zatoshis** (1 ZEC = 100,000,000 zatoshi). Money is never
held as float; ZEC is only ever produced for display.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum

ZATOSHIS_PER_ZEC = 100_000_000


def to_zec(zat: int) -> str:
    """Render zatoshis as a fixed-precision ZEC string. Display only."""
    sign = "-" if zat < 0 else ""
    whole, frac = divmod(abs(zat), ZATOSHIS_PER_ZEC)
    return f"{sign}{whole}.{frac:08d}"


class Direction(str, Enum):
    """How an entry affects the account being audited.

    Mirrors the flags zcashd exposes on `z_viewtransaction` outputs:
      * `outgoing = true`  -> the output is not for a wallet address  -> PAYMENT
      * `walletInternal`   -> change returning to the account         -> CHANGE
      * neither            -> a receipt                               -> RECEIPT
    """

    RECEIPT = "receipt"
    PAYMENT = "payment"
    CHANGE = "change"


@dataclass(frozen=True)
class LedgerEntry:
    txid: str
    direction: Direction
    pool: str
    amount_zat: int
    address: str | None = None
    memo: str | None = None
    block_height: int | None = None
    block_time: int | None = None
    confirmations: int | None = None
    output_index: int | None = None

    @property
    def signed_zat(self) -> int:
        """Effect on the account balance. Change is internal and nets to zero."""
        if self.direction is Direction.RECEIPT:
            return self.amount_zat
        if self.direction is Direction.PAYMENT:
            return -self.amount_zat
        return 0

    @property
    def timestamp(self) -> datetime | None:
        if self.block_time is None:
            return None
        return datetime.fromtimestamp(self.block_time, tz=timezone.utc)


@dataclass
class Ledger:
    """A reconciled account history, reconstructed from a viewing key alone."""

    viewing_key: str
    entries: list[LedgerEntry] = field(default_factory=list)

    def sorted_entries(self) -> list[LedgerEntry]:
        """Chronological. Unconfirmed entries (no height) sort last."""
        return sorted(
            self.entries,
            key=lambda e: (
                e.block_height if e.block_height is not None else 1 << 62,
                e.output_index or 0,
                e.txid,
            ),
        )

    @property
    def total_received_zat(self) -> int:
        return sum(e.amount_zat for e in self.entries if e.direction is Direction.RECEIPT)

    @property
    def total_paid_zat(self) -> int:
        return sum(e.amount_zat for e in self.entries if e.direction is Direction.PAYMENT)

    @property
    def balance_zat(self) -> int:
        return sum(e.signed_zat for e in self.entries)

    def by_pool(self) -> dict[str, int]:
        pools: dict[str, int] = {}
        for entry in self.entries:
            pools[entry.pool] = pools.get(entry.pool, 0) + entry.signed_zat
        return pools

    def running_balance(self) -> list[tuple[LedgerEntry, int]]:
        """Each entry paired with the balance immediately after it."""
        balance = 0
        rows = []
        for entry in self.sorted_entries():
            balance += entry.signed_zat
            rows.append((entry, balance))
        return rows
