# Tempo findings

Empirical notes from building against Tempo testnet. Recorded because two of these are
undocumented and cost real time to discover.

## The deny-all Access Key encoding requires BOTH empty lists

This is the important one, and it is not in the docs.

```ts
// FAILS: "Revm error: keychain validation failed:
//         admin-signed key authorization account mismatch"
await Actions.accessKey.authorizeSync(client, { accessKey, expiry, scopes: [] })

// WORKS
await Actions.accessKey.authorizeSync(client, { accessKey, expiry, scopes: [], limits: [] })
```

Isolated by testing variants against the live node:

| Authorization | Result |
|---|---|
| no `scopes` (unrestricted key) | **OK** |
| `scopes: []` | FAIL — admin-signed mismatch |
| `scopes: []`, `admin: false` | FAIL |
| **`scopes: []`, `limits: []`** | **OK** |
| `scopes: [Scopes.target(ZERO).any()]` | FAIL |

Reading: an empty scope list without an empty limit list produces an inconsistent restriction
set, which the keychain precompile interprets as an admin key — hence the "admin-signed" error,
which is misleading. Supplying both means *no call is permitted, on no token, for any amount*.

That is the credential Clearview hands an auditor: it can authenticate, and it can do nothing.

## An access key's `address` is the account it acts for

```ts
const accessKey = Account.fromP256(P256.randomPrivateKey(), { access: account })
accessKey.address            // -> the PARENT account's address
accessKey.accessKeyAddress   // -> the key's own identifier
```

Logging `.address` to identify a key is misleading; it prints the account. Use
`accessKeyAddress`.

## viem: zones live in the 3.x prerelease, not in "stable"

| Package | `./tempo/zones` export? | Published |
|---|---|---|
| `viem@2.56.8` (latest stable) | **no** | 2 days ago |
| `viem@3.0.0-next.10` | **yes** | 37 days ago |

Tempo's own documentation imports from `viem/tempo/zones`, which only the 3.x line provides.
Note the prerelease is also the *older* and therefore safer artifact under a
minimum-release-age policy.

Relevant exports: `Account`, `Actions`, `Chain`, `Client`, `Scopes`, `Storage`,
`ZoneRpcAuthentication`, and from `viem/tempo/zones`: `zoneModerato`, `zone`, `http`.

## `zone(n)` is mainnet; `zoneModerato(n)` is testnet

```ts
zone(6).rpcUrls          // { http: 'https://rpc-zone-006.tempo.xyz' }      id 421700006
zoneModerato(6).rpcUrls  // { http: 'https://rpc-zone-a.testnet.tempo.xyz' } (Zone A)
```

Also note `rpcUrls` is flat (`.http`), not viem's usual `.default.http[0]`.

## The faucet is an RPC method, not a web form

```bash
curl -X POST https://rpc.moderato.tempo.xyz -H 'Content-Type: application/json' \
  -d '{"jsonrpc":"2.0","method":"tempo_fundAddress","params":["0x…"],"id":1}'
```

Returns one transaction hash per token (pathUSD, AlphaUSD, BetaUSD, ThetaUSD). No wallet
connection, no sign-in, no geographic restriction — which matters when the alternative is a
gated web faucet.

## Zone RPC rejects everything unauthenticated

Even `eth_chainId` returns **HTTP 401** with an empty body (`x-upstream-id:
zone-005-sequencer-private`). An empty body is easy to mistake for a crash; it is an auth failure.

Auth token: `X-Authorization-Token`, magic bytes decode to `"TempoZoneRPC"`, version `0`,
29-byte field suffix. Fields are `{ chainId, zoneId, issuedAt, expiresAt }` plus a signature.
`ox` types them as *"short-lived, read-only credentials"*.

## TIP-20 tokens use 6 decimals

`zoneModerato(n).nativeCurrency` is `{ name: 'USD', symbol: 'USD', decimals: 6 }`. All amounts
are held as integer base units; 6 decimals, not 18.
