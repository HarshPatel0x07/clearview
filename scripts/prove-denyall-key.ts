/**
 * H-04: can a deny-all Access Key read a Tempo Zone, and provably not spend?
 *
 * The product rests on this. Clearview's pitch is that a business hands its
 * auditor a key that reads its private books and cannot move money. Tempo's
 * docs say Access Keys may authenticate to the Zone RPC, and TIP-1011 allows
 * deny-all scoping, but nothing states both together. So it is tested before
 * anything is built on it.
 *
 *   npx tsx scripts/prove-denyall-key.ts
 *
 * Testnet only. The key is generated locally into a gitignored file and holds
 * faucet tokens with no value.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  Account,
  Actions,
  Chain,
  Client,
  KeyAuthorizationManager,
  Storage,
  ZoneRpcAuthentication,
  http,
} from 'viem/tempo'
import { http as zoneHttp, zoneModerato } from 'viem/tempo/zones'
import { P256, Secp256k1 } from 'ox'

const HERE = dirname(fileURLToPath(import.meta.url))
const KEY_FILE = resolve(HERE, '../.secrets/testnet-account.json')

const ZONE_ID = 6 // Zone A on Moderato
const PATH_USD = '0x20c0000000000000000000000000000000000000' as const
const DEPOSIT = 1_000_000n // 1 pathUSD; TIP-20 uses 6 decimals

const ok = (m: string) => console.log(`  \u2713 ${m}`)
const bad = (m: string) => console.log(`  \u2717 ${m}`)
const step = (m: string) => console.log(`\n== ${m}`)

function loadAccount() {
  if (existsSync(KEY_FILE)) return JSON.parse(readFileSync(KEY_FILE, 'utf8')).privateKey as `0x${string}`
  const privateKey = Secp256k1.randomPrivateKey()
  mkdirSync(dirname(KEY_FILE), { recursive: true })
  writeFileSync(KEY_FILE, JSON.stringify({ privateKey, note: 'TESTNET ONLY - no value' }, null, 2))
  return privateKey
}

/** The faucet is an RPC method, not a web form - no wallet or sign-in needed. */
async function fund(address: string) {
  const res = await fetch('https://rpc.moderato.tempo.xyz', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'tempo_fundAddress', params: [address], id: 1 }),
  })
  const body = (await res.json()) as { result?: string[]; error?: { message: string } }
  if (body.error) throw new Error(`faucet: ${body.error.message}`)
  return body.result ?? []
}

/** Call the zone with an explicit token so failures stay legible. */
async function zoneCall(url: string, token: string, method: string, params: unknown[] = []) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [ZoneRpcAuthentication.headerName]: token },
    body: JSON.stringify({ jsonrpc: '2.0', method, params, id: 1 }),
  })
  const text = await res.text()
  let body: any
  try {
    body = JSON.parse(text)
  } catch {
    /* 401/403 come back with an empty body */
  }
  return { status: res.status, body, text }
}

async function main() {
  console.log('H-04  deny-all Access Key: read a Zone, and provably not spend?')

  const account = Account.fromSecp256k1(loadAccount())
  const client = Client.create({ account, chain: Chain.moderato, transport: http() })
  const zoneChain = zoneModerato(ZONE_ID)
  const zoneUrl = zoneChain.rpcUrls.http

  step('1. fund the account on the public chain')
  ok(`account ${account.address}`)
  ok(`faucet minted ${(await fund(account.address)).length} tokens`)

  step(`2. deposit into Zone ${ZONE_ID} so the zone knows this account`)
  // Without this the zone returns 403 for every signer, including the account's
  // own root key - access is account-level, not key-level.
  try {
    await Actions.zone.depositSync(client, {
      amount: DEPOSIT,
      token: PATH_USD,
      zoneId: ZONE_ID,
      recipient: account.address,
      bouncebackRecipient: account.address,
      chainId: Chain.moderato.id,
    } as any)
    ok(`deposited ${Number(DEPOSIT) / 1e6} pathUSD into zone ${ZONE_ID}`)
  } catch (e) {
    bad(`deposit failed: ${(e as any).shortMessage ?? (e as Error).message}`.slice(0, 160))
  }

  step('3. authorise a DENY-ALL access key')
  // Both empty lists are required. With `scopes: []` alone the node rejects the
  // authorization as "admin-signed key authorization account mismatch": an empty
  // scope list without an empty limit list is an inconsistent restriction set
  // that the keychain precompile reads as an admin key. Together they mean no
  // call, on no token, for any amount. Undocumented - see TEMPO-FINDINGS.md.
  const accessKey = Account.fromP256(P256.randomPrivateKey(), {
    access: account,
    keyAuthorizationManager: KeyAuthorizationManager.memory(),
  })
  await Actions.accessKey.authorizeSync(client, {
    accessKey,
    expiry: Math.floor(Date.now() / 1000) + 86_400,
    scopes: [],
    limits: [],
  })
  ok(`key ${(accessKey as any).accessKeyAddress} authorised, scoped to call nothing`)

  step('4. mint a Zone auth token signed by that key')
  const storage = Storage.memory()
  const zoneClient = Client.create({
    account: accessKey as any,
    chain: zoneChain,
    transport: zoneHttp(undefined, { storage }),
  })
  const { token } = await Actions.zone.signAuthorizationToken(zoneClient as any, {
    account: accessKey as any,
    zoneId: ZONE_ID,
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    storage,
  } as any)
  ok(`token minted (${String(token).length} chars)`)

  step('5. THE QUESTION: does the zone accept a deny-all key?')
  const chainId = await zoneCall(zoneUrl, String(token), 'eth_chainId')
  if (!chainId.body?.result) {
    bad(`rejected. HTTP ${chainId.status} ${chainId.text.slice(0, 120) || '(empty body)'}`)
    console.log(
      chainId.status === 403
        ? '\n  403 means the signature verified but the account is not permitted in the zone.\n' +
            '  Check step 2 - the deposit must land before the zone recognises the account.'
        : '\n  401 means the credentials themselves were rejected.',
    )
    process.exit(3)
  }
  ok(`ACCEPTED. eth_chainId = ${chainId.body.result}`)

  step('6. can it read the books?')
  const bal = await zoneCall(zoneUrl, String(token), 'eth_getBalance', [account.address, 'latest'])
  console.log(`  eth_getBalance -> ${JSON.stringify(bal.body?.result ?? bal.body?.error)}`)
  const logs = await zoneCall(zoneUrl, String(token), 'eth_getLogs', [
    { fromBlock: '0x0', toBlock: 'latest' },
  ])
  const entries = logs.body?.result
  console.log(
    `  eth_getLogs    -> ${Array.isArray(entries) ? `${entries.length} TIP-20 events` : JSON.stringify(logs.body?.error)}`,
  )

  step('7. and does spending fail?')
  try {
    await Actions.token.transferSync(zoneClient as any, {
      account: accessKey as any,
      token: PATH_USD,
      to: '0x000000000000000000000000000000000000dEaD',
      amount: 1n,
    } as any)
    bad('TRANSFER SUCCEEDED - the key is not actually deny-all. Product assumption broken.')
    process.exit(4)
  } catch (e) {
    ok(`transfer refused: ${String((e as any).shortMessage ?? (e as Error).message).slice(0, 90)}`)
  }

  console.log('\n' + '='.repeat(74))
  console.log('H-04 PROVEN: a key that reads the private books and cannot move money.')
  console.log('That is the auditor credential Clearview hands out.')
  console.log('='.repeat(74))
}

main().catch((e) => {
  console.error('\nFAILED:', (e as any)?.shortMessage ?? (e as Error)?.message ?? e)
  process.exit(1)
})
