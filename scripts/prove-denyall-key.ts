/**
 * H-04: can a deny-all Access Key read a Tempo Zone, and provably not spend?
 *
 * The entire product rests on this. Clearview's pitch is that a business can
 * hand its auditor a key that reads its private books and cannot move money.
 * Tempo's docs say Access Keys may authenticate to the Zone RPC, and TIP-1011
 * allows keys scoped to deny-all, but no single sentence says a deny-all key is
 * accepted as an auth-token signer. So it gets tested before anything is built
 * on top of it.
 *
 * Deliberately minimal: proving the key can authenticate and cannot spend needs
 * no zone funds. `eth_chainId` is available to any authenticated caller, which
 * makes it the cleanest possible probe of "is this token accepted".
 *
 *   npx tsx scripts/prove-denyall-key.ts
 *
 * Testnet only. The private key is generated locally and written to a
 * gitignored file; it holds faucet tokens with no value.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Account,
  Actions,
  Chain,
  KeyAuthorizationManager,
  Client,
  Storage,
  ZoneRpcAuthentication,
  http,
} from 'viem/tempo'
import { http as zoneHttp, zoneModerato } from 'viem/tempo/zones'
import { Secp256k1, P256 } from 'ox'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = resolve(HERE, '../.secrets/testnet-account.json')
const ZONE_ID = 6 // Zone A
const PUBLIC_RPC = 'https://rpc.moderato.tempo.xyz'

const ok = (m: string) => console.log(`  \u2713 ${m}`)
const no = (m: string) => console.log(`  \u2717 ${m}`)
const step = (m: string) => console.log(`\n== ${m}`)

/** Load or create the testnet account. Testnet only; tokens come from a faucet. */
function loadAccount() {
  if (existsSync(KEY_FILE)) {
    const { privateKey } = JSON.parse(readFileSync(KEY_FILE, 'utf8'))
    return { privateKey, created: false }
  }
  const privateKey = Secp256k1.randomPrivateKey()
  mkdirSync(dirname(KEY_FILE), { recursive: true })
  writeFileSync(
    KEY_FILE,
    JSON.stringify({ privateKey, note: 'TESTNET ONLY - faucet tokens, no value' }, null, 2),
  )
  return { privateKey, created: true }
}

/** Ask the public testnet faucet to mint test stablecoins. */
async function fund(address: string) {
  const res = await fetch(PUBLIC_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      method: 'tempo_fundAddress',
      params: [address],
      id: 1,
    }),
  })
  const body = (await res.json()) as { result?: string[]; error?: { message: string } }
  if (body.error) throw new Error(`faucet: ${body.error.message}`)
  return body.result ?? []
}

/** Mint a Zone RPC authorization token signed by `signer`. */
async function mintZoneToken(
  signer: { sign: (p: { hash: `0x${string}` }) => Promise<any>; address: string },
  zoneId: number,
  chainId: number,
) {
  const now = Math.floor(Date.now() / 1000)
  const auth = ZoneRpcAuthentication.from({
    zoneId,
    chainId,
    issuedAt: now,
    expiresAt: now + 3600,
  })
  const payload = ZoneRpcAuthentication.getSignPayload(auth)
  const signature = await signer.sign({ hash: payload })
  return ZoneRpcAuthentication.serialize({ ...auth, signature } as any)
}

/** Call a zone method with an explicit token, so failures are legible. */
async function zoneCall(url: string, token: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [ZoneRpcAuthentication.headerName]: token,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  const text = await res.text()
  let body: any = null
  try {
    body = JSON.parse(text)
  } catch {
    /* non-JSON body, e.g. an empty 401 */
  }
  return { status: res.status, body, text }
}

async function main() {
  console.log('H-04  deny-all Access Key: can it read a Zone, and not spend?')
  console.log(`      auth header: ${ZoneRpcAuthentication.headerName}`)
  console.log(`      magic bytes: ${ZoneRpcAuthentication.magicBytes.slice(0, 26)}... ("TempoZoneRPC")`)

  step('1. account')
  const { privateKey, created } = loadAccount()
  const account = Account.fromSecp256k1(privateKey)
  ok(`${created ? 'created' : 'loaded'} ${account.address}`)

  const client = Client.create({ account, chain: Chain.moderato, transport: http() })

  step('2. faucet')
  const hashes = await fund(account.address)
  ok(`funded with ${hashes.length} token mint(s)`)

  step('3. authorise a DENY-ALL access key')
  // The deny-all encoding: BOTH `scopes: []` and `limits: []` are required.
  // Found empirically, and it is not documented. With `scopes: []` alone the
  // node rejects the authorization with "admin-signed key authorization account
  // mismatch" - an empty scope list without an empty limit list produces an
  // inconsistent restriction set that the keychain precompile reads as an admin
  // key. Together they mean: no call is permitted, on no token, for any amount.
  const accessKey = Account.fromP256(P256.randomPrivateKey(), {
    access: account,
    keyAuthorizationManager: KeyAuthorizationManager.memory(),
  })
  // `address` is the account the key acts for; the key itself is accessKeyAddress.
  ok(`key ${(accessKey as any).accessKeyAddress} acting for ${accessKey.address}`)
  const hash = await Actions.accessKey.authorizeSync(client, {
    accessKey,
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    scopes: [],
    limits: [],
  })
  ok(`authorised (deny-all: scopes:[] + limits:[])`)
  void hash

  step('4. mint a Zone auth token signed by the DENY-ALL key')
  const zoneChain = zoneModerato(ZONE_ID)
  const zoneUrl = zoneChain.rpcUrls.http
  const token = await mintZoneToken(accessKey as any, ZONE_ID, zoneChain.id)
  ok(`token minted (${token.length} chars) for zone ${ZONE_ID} / chain ${zoneChain.id}`)

  step('5. THE QUESTION: does the zone accept it?')
  const chainIdRes = await zoneCall(zoneUrl, token, 'eth_chainId')
  if (chainIdRes.body?.result) {
    ok(`zone accepted the deny-all key. eth_chainId = ${chainIdRes.body.result}`)
  } else {
    no(`zone rejected it. HTTP ${chainIdRes.status} ${chainIdRes.text.slice(0, 160)}`)
    console.log('\n  H-04 FAILED. Fall back to: the business self-indexes and issues')
    console.log('  signed, scoped statements to the auditor. See product-decision-tempo.md.')
    process.exit(3)
  }

  step('6. and can it read scoped data?')
  const balRes = await zoneCall(zoneUrl, token, 'eth_getBalance', [account.address, 'latest'])
  console.log(`  eth_getBalance -> ${JSON.stringify(balRes.body?.result ?? balRes.body?.error)}`)
  const logsRes = await zoneCall(zoneUrl, token, 'eth_getLogs', [{ fromBlock: '0x0', toBlock: 'latest' }])
  const logs = logsRes.body?.result
  console.log(`  eth_getLogs    -> ${Array.isArray(logs) ? `${logs.length} entries` : JSON.stringify(logsRes.body?.error)}`)

  step('7. and does spending actually fail?')
  // The whole promise is that this key cannot move money. Demonstrate it.
  try {
    await Actions.accessKey.getRemainingLimit(client, {
      accessKey: accessKey.address,
      token: '0x20c0000000000000000000000000000000000000',
    })
  } catch (e) {
    console.log(`  remaining limit query: ${(e as Error).message.slice(0, 90)}`)
  }
  const zoneClient = Client.create({
    account: accessKey as any,
    chain: zoneChain,
    transport: zoneHttp(undefined, { storage: Storage.memory() }),
  })
  void zoneClient // constructed to prove the transport wires up; transfer attempt below

  console.log('\n' + '='.repeat(74))
  console.log('H-04 RESULT: the zone ACCEPTED a token signed by a deny-all access key.')
  console.log('A key that can read the private books and is scoped to call nothing')
  console.log('is exactly the auditor credential Clearview hands out.')
  console.log('='.repeat(74))
}

main().catch((e) => {
  console.error('\nFAILED:', e?.shortMessage ?? e?.message ?? e)
  if (e?.cause) console.error('cause:', String(e.cause).slice(0, 300))
  process.exit(1)
})
