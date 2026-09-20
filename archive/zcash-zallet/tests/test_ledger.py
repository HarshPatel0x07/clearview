"""Tests for ledger reconstruction from a viewing key.

Run: python -m unittest discover -s tests -v
"""

from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from clearview.ledger import build_ledger, reconcile  # noqa: E402
from clearview.models import Direction, to_zec  # noqa: E402
from tests.fixtures import ACCOUNT_UUID, UFVK, ZADDR, FakeZcashRPC  # noqa: E402


class TestLedgerReconstruction(unittest.TestCase):
    def setUp(self) -> None:
        self.rpc = FakeZcashRPC()
        self.ledger = build_ledger(self.rpc, UFVK, ACCOUNT_UUID)

    def test_finds_every_receipt(self) -> None:
        receipts = [e for e in self.ledger.entries if e.direction is Direction.RECEIPT]
        self.assertEqual(len(receipts), 3)
        self.assertEqual(self.ledger.total_received_zat, 375_000_000)

    def test_separates_change_from_revenue(self) -> None:
        """Change must not inflate revenue, but must still be recorded."""
        change = [e for e in self.ledger.entries if e.direction is Direction.CHANGE]
        self.assertEqual(len(change), 1)
        self.assertEqual(change[0].amount_zat, 274_990_000)
        # Change nets to zero against the balance.
        self.assertEqual(change[0].signed_zat, 0)
        # ...and is excluded from received totals.
        self.assertNotIn(274_990_000, [e.amount_zat for e in self.ledger.entries
                                       if e.direction is Direction.RECEIPT])

    def test_finds_outgoing_payment(self) -> None:
        payments = [e for e in self.ledger.entries if e.direction is Direction.PAYMENT]
        self.assertEqual(len(payments), 1)
        self.assertEqual(payments[0].amount_zat, 75_000_000)
        self.assertEqual(payments[0].memo, "Invoice 2026-114 - venue hire")
        self.assertEqual(payments[0].signed_zat, -75_000_000)

    def test_balance_is_receipts_minus_payments(self) -> None:
        # 3.75 received - 0.75 paid = 3.0 ZEC
        self.assertEqual(self.ledger.balance_zat, 300_000_000)
        self.assertEqual(to_zec(self.ledger.balance_zat), "3.00000000")

    def test_decodes_memos_and_ignores_empty_padding(self) -> None:
        memos = {e.memo for e in self.ledger.entries if e.memo}
        self.assertIn("Donation - Q3 appeal", memos)
        self.assertIn("Anonymous gift", memos)
        # The 0xf6-padded empty memo on the change output must not appear.
        self.assertFalse(any(m and m.startswith("f6") for m in memos))

    def test_tracks_pools_separately(self) -> None:
        pools = self.ledger.by_pool()
        self.assertEqual(pools["sapling"], 25_000_000)
        # orchard: 250m + 100m received, -75m paid, change nets zero
        self.assertEqual(pools["orchard"], 275_000_000)

    def test_entries_are_chronological(self) -> None:
        heights = [e.block_height for e in self.ledger.sorted_entries()]
        self.assertEqual(heights, sorted(h for h in heights if h is not None))

    def test_running_balance_never_goes_negative(self) -> None:
        for entry, balance in self.ledger.running_balance():
            self.assertGreaterEqual(balance, 0, f"negative after {entry.txid[:8]}")

    def test_output_without_outgoing_flag_is_not_a_payment(self) -> None:
        """Zallet omits `outgoing` for outputs that are not ours in txs we did not fund.

        A missing flag must read as 'not our payment', never as one.
        """
        payments = [e for e in self.ledger.entries if e.direction is Direction.PAYMENT]
        self.assertNotIn("transparent", [p.pool for p in payments])
        self.assertEqual(len(payments), 1)

    def test_payment_inherits_block_metadata(self) -> None:
        """z_viewtransaction omits height/time, so it must be joined from the receipt."""
        payment = next(e for e in self.ledger.entries if e.direction is Direction.PAYMENT)
        self.assertEqual(payment.block_height, 120)
        self.assertIsNotNone(payment.timestamp)

    def test_no_spending_key_is_ever_requested(self) -> None:
        """The core claim: books are built with view-only access."""
        forbidden = {"z_exportkey", "dumpprivkey", "z_importkey", "z_sendmany", "signrawtransaction"}
        used = {method for method, _ in self.rpc.calls}
        self.assertEqual(used & forbidden, set())


class TestReconciliation(unittest.TestCase):
    def test_reconciles_against_node_balance(self) -> None:
        rpc = FakeZcashRPC()
        ledger = build_ledger(rpc, UFVK, ACCOUNT_UUID)
        result = reconcile(rpc, ledger, ACCOUNT_UUID)
        self.assertTrue(result["reconciled"], result)
        self.assertEqual(result["difference_zat"], 0)
        self.assertEqual(result["node_balance_zat"], 300_000_000)

    def test_detects_drift(self) -> None:
        """A tool auditors rely on must notice when its books disagree with the chain."""
        rpc = FakeZcashRPC(balance={"pools": {"orchard": {"valueZat": 999}}})
        ledger = build_ledger(rpc, UFVK, ACCOUNT_UUID)
        result = reconcile(rpc, ledger, ACCOUNT_UUID)
        self.assertFalse(result["reconciled"])
        self.assertEqual(result["difference_zat"], 300_000_000 - 999)


class TestEdgeCases(unittest.TestCase):
    def test_empty_account(self) -> None:
        rpc = FakeZcashRPC(transactions={}, balance={"pools": {}})
        ledger = build_ledger(rpc, UFVK, ACCOUNT_UUID)
        self.assertEqual(ledger.entries, [])
        self.assertEqual(ledger.balance_zat, 0)
        self.assertTrue(reconcile(rpc, ledger, ACCOUNT_UUID)["reconciled"])

    def test_unconfirmed_entries_sort_last(self) -> None:
        """A transaction still in the mempool has no height and must sort last."""
        rpc = FakeZcashRPC(transactions={
            "ee" * 32: {"txid": "ee" * 32, "outputs": [
                {"pool": "orchard", "action": 0, "address": ZADDR, "valueZat": 1,
                 "account_uuid": ACCOUNT_UUID}]},
            "ff" * 32: {"txid": "ff" * 32, "blockindex": 5, "outputs": [
                {"pool": "orchard", "action": 0, "address": ZADDR, "valueZat": 2,
                 "account_uuid": ACCOUNT_UUID}]},
        }, balance={"pools": {}})
        ledger = build_ledger(rpc, UFVK, ACCOUNT_UUID)
        self.assertEqual(len(ledger.entries), 2)
        self.assertEqual(ledger.sorted_entries()[-1].txid, "ee" * 32)

    def test_output_belonging_to_another_account_is_ignored(self) -> None:
        """Zallet returns outputs we can see but do not own; they are not income."""
        rpc = FakeZcashRPC(transactions={
            "ab" * 32: {"txid": "ab" * 32, "blockindex": 7, "outputs": [
                {"pool": "orchard", "action": 0, "address": ZADDR, "valueZat": 500,
                 "account_uuid": ACCOUNT_UUID},
                {"pool": "orchard", "action": 1, "address": "zsomeoneelse",
                 "valueZat": 999, "account_uuid": "not-our-account"},
            ]},
        }, balance={"pools": {}})
        ledger = build_ledger(rpc, UFVK, ACCOUNT_UUID)
        self.assertEqual([e.amount_zat for e in ledger.entries], [500])

    def test_to_zec_formatting(self) -> None:
        self.assertEqual(to_zec(100_000_000), "1.00000000")
        self.assertEqual(to_zec(1), "0.00000001")
        self.assertEqual(to_zec(-75_000_000), "-0.75000000")
        self.assertEqual(to_zec(0), "0.00000000")


if __name__ == "__main__":
    unittest.main()
