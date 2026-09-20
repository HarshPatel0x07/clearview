"""Minimal zcashd JSON-RPC client.

Deliberately dependency-free and transport-only: it makes calls and surfaces
errors. All bookkeeping logic lives in `ledger.py` against the `ZcashRPC`
protocol, so that logic is fully testable without a running node.
"""

from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from typing import Any, Protocol

# Z3 exposes explicit, globally unique host ports so mainnet, testnet and
# regtest can all run at once. The rpc-router is the usual target: it forwards
# each method to Zebra or Zallet based on the method name.
Z3_REGTEST_PORTS = {
    "router": 8181,   # JSON-RPC router (Zebra + Zallet) - use this
    "zebra": 29232,   # direct Zebra JSON-RPC
    "zallet": 50232,  # direct Zallet JSON-RPC
    "zaino": 28137,   # lightwalletd-compatible gRPC, `indexer` profile
}

# Defaults point at the Z3 regtest router rather than the dead zcashd ports.
DEFAULT_PORTS = {"mainnet": 8181, "testnet": 8181, "regtest": 8181}


class RPCError(RuntimeError):
    """zcashd returned a JSON-RPC error object."""

    def __init__(self, code: int, message: str) -> None:
        super().__init__(f"zcashd RPC error {code}: {message}")
        self.code = code
        self.message = message


class ZcashRPC(Protocol):
    """The surface `ledger.py` depends on. Real client and fakes both satisfy it."""

    def call(self, method: str, *params: Any) -> Any: ...


class ZcashClient:
    """JSON-RPC client for a zcashd node."""

    def __init__(
        self,
        user: str | None = None,
        password: str | None = None,
        host: str = "127.0.0.1",
        port: int | None = None,
        network: str = "regtest",
        timeout: int = 60,
        url: str | None = None,
    ) -> None:
        # `url` wins, so callers can point straight at the Z3 rpc-router, which
        # forwards each method to Zebra or Zallet as appropriate.
        self.url = url or f"http://{host}:{port or DEFAULT_PORTS[network]}/"
        self._auth = (
            base64.b64encode(f"{user}:{password}".encode()).decode()
            if user is not None and password is not None
            else None
        )
        self.timeout = timeout
        self._id = 0

    def call(self, method: str, *params: Any) -> Any:
        self._id += 1
        # JSON-RPC 2.0. zcashd spoke 1.0; the Z3 rpc-router and Zallet use 2.0.
        payload = json.dumps(
            {"jsonrpc": "2.0", "id": self._id, "method": method, "params": list(params)}
        ).encode()

        headers = {"Content-Type": "application/json"}
        if self._auth:
            headers["Authorization"] = f"Basic {self._auth}"

        req = urllib.request.Request(self.url, data=payload, headers=headers)

        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as resp:
                body = json.loads(resp.read().decode())
        except urllib.error.HTTPError as err:
            # zcashd returns 500 with a JSON-RPC error body for application errors.
            raw = err.read().decode(errors="replace")
            try:
                body = json.loads(raw)
            except json.JSONDecodeError:
                raise RPCError(err.code, raw.strip() or err.reason) from err
        except urllib.error.URLError as err:
            raise RuntimeError(
                f"Cannot reach zcashd at {self.url} - is the node running? ({err.reason})"
            ) from err

        if body.get("error"):
            err_obj = body["error"]
            raise RPCError(err_obj.get("code", -1), err_obj.get("message", "unknown"))
        return body.get("result")

    @classmethod
    def from_cookie(cls, cookie: str, port: int = 50232, host: str = "127.0.0.1",
                    **kwargs: Any) -> "ZcashClient":
        """Build a client from Zallet's generated RPC cookie.

        Zallet writes `__cookie__:<secret>` to `{datadir}/.cookie` on startup.
        Under Z3 that file lives in a Docker volume and the image is
        distroless - no shell - so read it with a mounted helper container:

            docker run --rm -v z3-regtest-zallet:/data busybox cat /data/.cookie

        Prefer talking to Zallet directly over going through the Z3
        rpc-router: the router is built against an older Zallet and returns
        "method not found" for methods missing from its own table, even when
        the wallet implements them. Observed 2026-09-20 -
        `z_importviewingkey` and `z_exportviewingkey` both work when asked
        directly and both appear absent through the router.
        """
        user, _, password = cookie.strip().partition(":")
        return cls(user, password, host=host, port=port, **kwargs)

    # ---- convenience wrappers, named after the RPC methods they call ----

    def getblockchaininfo(self) -> dict:
        return self.call("getblockchaininfo")

    def z_importviewingkey(
        self, vkey: str, rescan: str = "whenkeyisnew", start_height: int = 0
    ) -> Any:
        """Import a viewing key. `rescan` is one of 'yes' | 'no' | 'whenkeyisnew'."""
        return self.call("z_importviewingkey", vkey, rescan, start_height)

    def z_getbalanceforviewingkey(self, fvk: str, minconf: int = 1) -> dict:
        return self.call("z_getbalanceforviewingkey", fvk, minconf)

    def z_listtransactions(self, account: str | None = None) -> list:
        """Account-scoped transaction listing.

        Zallet's replacement for zcashd's `z_listreceivedbyaddress`, which it
        does not implement. Marked experimental upstream.
        """
        return self.call("z_listtransactions", account) if account \
            else self.call("z_listtransactions")

    def z_viewtransaction(self, txid: str) -> dict:
        return self.call("z_viewtransaction", txid)

    def z_listaddresses(self, include_watchonly: bool = True) -> list[str]:
        return self.call("z_listaddresses", include_watchonly)
