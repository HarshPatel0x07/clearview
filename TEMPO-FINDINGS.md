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

## Account `sign()` takes `{ hash }`, not `{ payload }`

```ts
const payload = ZoneRpcAuthentication.getSignPayload(auth)
await accessKey.sign({ payload })      // throws: Cannot read properties of undefined (reading 'replace')
await accessKey.sign({ hash: payload }) // correct
```

The thrown error points into `ox/core/Hex.ts` and looks like a library fault. It is not: `hash`
is undefined, and `Hex` calls `.replace` on it. Root accounts tolerate `{ payload }`, access-key
accounts do not, which makes the mistake easy to miss until you use an access key.

An access key also needs a manager, or signing fails the same way:

```ts
Account.fromP256(P256.randomPrivateKey(), {
  access: account,
  keyAuthorizationManager: KeyAuthorizationManager.memory(),
})
```

The resulting envelope begins `0x04` followed by the **account** address, so it carries the
identity the zone resolves against.

## Zone access is account-level, not key-level — 401 vs 403 matters

Probing Zone A with three different signers:

| Signer | Result |
|---|---|
| main account root key | **HTTP 403** |
| unrestricted access key | **HTTP 403** |
| deny-all access key | **HTTP 403** |

Unauthenticated requests return **401**; these return **403**. So the token was parsed and the
signature verified, and access was then refused. The deny-all key is treated **exactly like the
account's own root key**, which is the useful part: the restriction is not what blocks the read.

What blocks it is that the account has no presence in the zone. It has never deposited, so the
zone does not recognise it. The next step is `Actions.zone.deposit*` from the public chain, then
retry — not more work on key scoping.

**Read 401 as "credentials rejected" and 403 as "credentials fine, account not permitted".**
Conflating them cost time here.

## Use `Actions.zone.signAuthorizationToken`, not a hand-rolled token

`ZoneRpcAuthentication` can be driven manually, but viem already does it and stores the result
where the zone `http` transport expects to find it:

```ts
const storage = Storage.memory()
const { token } = await Actions.zone.signAuthorizationToken(zoneClient, {
  account: accessKey, zoneId: 6, expiresAt: now + 3600, storage,
})
```

The transport reads the token from `Storage` and injects the header itself, so a client built with
`zoneHttp(undefined, { storage })` needs no manual header plumbing.

## Zone deposit: plain `deposit` reverts

Confirmed working first: the faucet mints (balance read back as `2999999.747506` pathUSD at 6
decimals), and `Actions.token.approveSync` against the Zone A portal
`0x7069DeC4E64Fd07334A0933eDe836C17259c9B23` succeeds.

`Actions.zone.depositSync` still reverts with "Execution reverted for an unknown reason", with and
without an explicit `portalAddress`.

### What has been ruled out

The encrypted path was the obvious candidate, and it is not the answer either. Everything
*around* the deposit works:

| Checked | Result |
|---|---|
| Portal contracts deployed | Yes — 10,318 bytes at both Zone A and Zone B portals |
| `getPortalAddress(chainId, zoneId)` | Works — **positional args**, not an object |
| `Actions.zone.getEncryptionKey(client, { zoneId })` | Works — `{ keyIndex: 0n, publicKey: { prefix: 3, x: '0x1151…' } }` |
| `Actions.token.approveSync` against the portal | Succeeds |
| `internal.encryptDepositPayload(...)` | Produces a payload — **positional args**: `(publicKey, recipient, sender, portalAddress, keyIndex, memo)` |
| `Actions.zone.depositSync` | **reverts** |
| `Actions.zone.encryptedDepositSync` | **reverts** |

And the revert is not specific to anything obvious — tried across **zone 6 and zone 7**, and
across **pathUSD and AlphaUSD**, all four revert with "Execution reverted for an unknown reason".

One gotcha worth recording separately: passing an explicit `portalAddress` to `getEncryptionKey`
makes it fail with an ABI dump. Omit it and let the registry resolve, and it works.

### Also ruled out: the chain ID

Tempo's docs give Zone A's chain ID as `4217000006`; `zoneModerato(6).id` returns `421700006` —
a digit shorter. Since the auth token embeds `chainId` for replay protection, a mismatch was a
plausible cause of the 403. It is not: tokens minted with `421700006`, `4217000006` **and** the
parent `42431` all return 403 identically.

### Where that leaves it

The 403 is account presence, and the deposit is the way to get it. What is not yet known is why a
deposit assembled from the library's own helpers reverts. The likely remaining causes, in order:

1. An argument the helpers expect to be derived differently (the revert carries no reason string,
   so this is guesswork without a trace).
2. Deposits gated on something not visible from the RPC — an allowlist, or a zone not open to
   arbitrary depositors on testnet.

### The documented signature reverts too

The official guide's example is far smaller than what I had been sending:

```ts
const { receipt } = await Actions.zone.depositSync(rootClient, {
  account: rootClient.account,
  amount: parseUnits('100', 6),
  token: pathUsd,
  zoneId: ZONE_A.id,
})
```

Four fields. `recipient`, `bouncebackRecipient`, `chainId`, `sender`, `portalAddress`, `encrypted`
and `keyIndex` are all derived by the library — and `encryptedDepositSync` takes the same four, so
calling `encryptDepositPayload` by hand is unnecessary.

**This exact form still reverts.** Also ruled out since:

* Allowance — re-approved the portal for 1,000,000 pathUSD; deposits of 100 and of 1 pathUSD both
  still revert, so it is not the fee-on-top-of-amount theory.
* Amount size — same revert at 100, 10 and 1 pathUSD.

### The remaining hypothesis

The interactive demo's **step 1** is *"Create or use a **passkey account** on the public chain"*,
and its **step 2** is *"**Authorize private reads in Zone A**"* — a distinct step before the
deposit in step 3.

So either zone deposits require a **passkey (P256/WebAuthn) account** rather than a plain
secp256k1 account, or the zone read authorization must be registered before a deposit is accepted.
A plain secp256k1 account is otherwise fully functional here — the faucet, `approve`,
`authorizeKey` and token minting all work with it — which is what makes this worth stating as a
hypothesis rather than a conclusion.

Tempo Labs invite design partners on Zones at `tempo.xyz/contact`. Given the revert carries no
reason string, asking is cheaper than continuing to vary arguments.

### Note for anyone reading this later

`parseUnits` is not exported from the `viem` root in `3.0.0-next.10`; importing it throws at module
load. Use integer base units directly (`100_000_000n` for 100 at 6 decimals).
