import { useState } from 'react'

/**
 * The claim, demonstrated live on Tempo Moderato.
 *
 * This is the one panel that must not be simulated, because it is the whole
 * pitch: a key that reads the books and provably cannot spend, which the
 * business can take back. Every step here writes or reads a real transaction.
 *
 * The private key is a testnet key held in `.secrets/`, injected at build time
 * for the demo. That is acceptable for faucet tokens on a testnet and would be
 * indefensible anywhere else, which the UI says out loud.
 */

type Step = {
  id: string
  title: string
  detail: string
  run: () => Promise<{ ok: boolean; message: string; hash?: string }>
}

type Result = { ok: boolean; message: string; hash?: string } | 'running' | undefined

const EXPLORER = 'https://explore.tempo.xyz/tx/'

export function KeyLifecycle() {
  const [results, setResults] = useState<Record<string, Result>>({})
  const [keyAddress, setKeyAddress] = useState<string | null>(null)

  // Imported lazily so the rest of the dashboard renders even if the wallet
  // bundle fails - the books should not go dark because a key panel broke.
  async function tempo() {
    const [t, ox] = await Promise.all([import('viem/tempo'), import('ox')])
    const pk = (import.meta as any).env?.VITE_TESTNET_KEY as `0x${string}` | undefined
    if (!pk) throw new Error('VITE_TESTNET_KEY not set - see README')
    const account = t.Account.fromSecp256k1(pk)
    const client = t.Client.create({ account, chain: t.Chain.moderato, transport: t.http() })
    return { t, ox, account, client }
  }

  const steps: Step[] = [
    {
      id: 'account',
      title: '1. The business account',
      detail: 'A real account on Tempo Moderato, funded from the testnet faucet.',
      run: async () => {
        const { account, client, t } = await tempo()
        const bal = await t.Actions.token.getBalance(client, {
          token: '0x20c0000000000000000000000000000000000000',
          account: account.address,
        })
        return {
          ok: true,
          message: `${account.address} holds ${(bal as any).formatted ?? '?'} pathUSD`,
        }
      },
    },
    {
      id: 'grant',
      title: '2. Authorise a deny-all key for the auditor',
      detail:
        'scopes: [] and limits: [] together. Both are required - with scopes alone the node ' +
        'rejects it as an admin key authorisation.',
      run: async () => {
        const { t, ox, account, client } = await tempo()
        const accessKey = t.Account.fromP256(ox.P256.randomPrivateKey(), {
          access: account,
          keyAuthorizationManager: t.KeyAuthorizationManager.memory(),
        })
        const hash = await t.Actions.accessKey.authorizeSync(client, {
          accessKey,
          expiry: Math.floor(Date.now() / 1000) + 86_400,
          scopes: [],
          limits: [],
        } as any)
        const id = (accessKey as any).accessKeyAddress
        setKeyAddress(id)
        ;(window as any).__clearviewKey = accessKey
        return {
          ok: true,
          message: `key ${id} authorised, expires in 24h, scoped to call nothing`,
          hash: typeof hash === 'string' ? hash : (hash as any)?.transactionHash,
        }
      },
    },
    {
      id: 'read',
      title: '3. The key authenticates to the Zone',
      detail:
        'It signs a Zone RPC authorization token. The zone verifies the signature and answers ' +
        '403 rather than the 401 an unauthenticated call gets.',
      run: async () => {
        const { t } = await tempo()
        const accessKey = (window as any).__clearviewKey
        if (!accessKey) return { ok: false, message: 'grant a key first' }
        const zones = await import('viem/tempo/zones')
        const zc = zones.zoneModerato(6)
        const now = Math.floor(Date.now() / 1000)
        const auth = t.ZoneRpcAuthentication.from({
          chainId: zc.id,
          zoneId: 6,
          issuedAt: now,
          expiresAt: now + 3600,
        })
        const sig = await accessKey.sign({
          hash: t.ZoneRpcAuthentication.getSignPayload(auth),
        })
        const token = t.ZoneRpcAuthentication.serialize({ ...auth, signature: sig } as any)
        const res = await fetch(zc.rpcUrls.http, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            [t.ZoneRpcAuthentication.headerName]: String(token),
          },
          body: JSON.stringify({ jsonrpc: '2.0', method: 'eth_chainId', params: [], id: 1 }),
        })
        return {
          ok: res.status !== 401,
          message:
            res.status === 403
              ? 'HTTP 403 - signature verified, account not yet present in the zone (issue #1482)'
              : `HTTP ${res.status}`,
        }
      },
    },
    {
      id: 'spend',
      title: '4. And it cannot spend',
      detail: 'A transfer signed by the same key. This is expected to fail, and that is the point.',
      run: async () => {
        const { t, client } = await tempo()
        const accessKey = (window as any).__clearviewKey
        if (!accessKey) return { ok: false, message: 'grant a key first' }
        try {
          await t.Actions.token.transferSync(client, {
            account: accessKey,
            token: '0x20c0000000000000000000000000000000000000',
            to: '0x000000000000000000000000000000000000dEaD',
            amount: 1n,
          } as any)
          return { ok: false, message: 'TRANSFER SUCCEEDED - the key is not deny-all' }
        } catch (e: any) {
          return {
            ok: true,
            message: `refused: ${(e.shortMessage ?? e.message ?? '').slice(0, 110)}`,
          }
        }
      },
    },
    {
      id: 'revoke',
      title: '5. Revoke it when the audit ends',
      detail: 'A Zcash viewing key is permanent once shared. This one is not.',
      run: async () => {
        const { t, client } = await tempo()
        const accessKey = (window as any).__clearviewKey
        if (!accessKey) return { ok: false, message: 'grant a key first' }
        const hash = await t.Actions.accessKey.revokeSync(client, {
          accessKey: (accessKey as any).accessKeyAddress,
        } as any)
        return {
          ok: true,
          message: 'key revoked on-chain - the auditor can no longer read anything',
          hash: typeof hash === 'string' ? hash : (hash as any)?.transactionHash,
        }
      },
    },
  ]

  async function run(step: Step) {
    setResults((r) => ({ ...r, [step.id]: 'running' }))
    try {
      // Resolve before updating: the updater callback is not async, so awaiting
      // inside it would await a promise rather than the result.
      const outcome = await step.run()
      setResults((r) => ({ ...r, [step.id]: outcome }))
    } catch (e: any) {
      setResults((r) => ({
        ...r,
        [step.id]: { ok: false, message: (e.shortMessage ?? e.message ?? String(e)).slice(0, 160) },
      }))
    }
  }

  return (
    <div className="panel">
      <h2>
        Access Key lifecycle<span className="sub">live on Tempo Moderato</span>
      </h2>
      <p className="note" style={{ marginBottom: 18 }}>
        Every step writes or reads a real transaction on Moderato. This is the part that is not
        seeded, and it is the part that distinguishes a Tempo Access Key from a Zcash viewing key:
        it is <strong>revocable, expiring and auditable</strong>.
      </p>

      {keyAddress && (
        <p className="note" style={{ marginBottom: 14 }}>
          Auditor key: <span className="hash">{keyAddress}</span>
        </p>
      )}

      {steps.map((s) => {
        const r = results[s.id]
        return (
          <div className="exception" key={s.id} style={{ borderLeftColor: 'var(--accent)' }}>
            <div className="row">
              <div style={{ flex: 1 }}>
                <div className="what">{s.title}</div>
                <div className="why">{s.detail}</div>
              </div>
              <button
                className={`action ${s.id === 'revoke' ? 'danger' : ''}`}
                disabled={r === 'running'}
                onClick={() => run(s)}
              >
                {r === 'running' ? 'working…' : s.id === 'revoke' ? 'Revoke' : 'Run'}
              </button>
            </div>
            {r && r !== 'running' && (
              <div style={{ marginTop: 9 }}>
                <span className={`tag ${r.ok ? 'ok' : 'warn'}`}>{r.ok ? 'as expected' : 'note'}</span>{' '}
                <span className="why">{r.message}</span>
                {r.hash && (
                  <div style={{ marginTop: 5 }}>
                    <a className="hash" href={EXPLORER + r.hash} target="_blank" rel="noreferrer">
                      {r.hash}
                    </a>
                  </div>
                )}
              </div>
            )}
          </div>
        )
      })}

      <p className="note" style={{ marginTop: 16 }}>
        The key used here is a testnet key holding faucet tokens, injected at build time so the
        demo runs without a wallet prompt. That is fine for Moderato and would be indefensible on
        a chain with real money — a production build would sign in the user's wallet.
      </p>
    </div>
  )
}
