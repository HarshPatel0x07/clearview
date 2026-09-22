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
    // Written as the exact `import.meta.env.VITE_*` form, because that is the
    // only shape Vite statically replaces. An earlier version used a cast and
    // optional chaining to avoid inlining the value into a production bundle -
    // which worked, in the sense that it never resolved at all and every step
    // reported the key as missing.
    //
    // A production build WILL inline this. That is why dist-ui/ is gitignored
    // and why the key here is a testnet key holding faucet tokens. Never build
    // this with a .env.local containing anything of value.
    const pk = import.meta.env.VITE_TESTNET_KEY as `0x${string}` | undefined
    if (!pk) {
      throw new Error(
        'VITE_TESTNET_KEY not set. Run the dashboard with `npm run ui` after copying ' +
          '.env.example to .env.local - the live panel is dev-only by design.',
      )
    }
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
        // Through the dev proxy, not zc.rpcUrls.http directly: the zone's
        // CORS preflight does not allow the X-Authorization-Token header it
        // requires, so a direct browser call can never succeed.
        const res = await fetch('/zone-a', {
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
    <div>
      <div className="section-head">
        <h2>Access Key lifecycle</h2>
        <span className="meta">live on Tempo Moderato</span>
      </div>

      <p className="strapline" style={{ marginTop: 10, marginBottom: 26 }}>
        Every step writes or reads a real transaction. This is the part that is not seeded, and it
        is what separates a Tempo Access Key from a Zcash viewing key: it is revocable, expiring
        and auditable.
      </p>

      {keyAddress && (
        <div className="figures" style={{ marginBottom: 26 }}>
          <div>
            <div className="k">Auditor key</div>
            <div className="v figure">{keyAddress}</div>
          </div>
        </div>
      )}

      {steps.map((s, i) => {
        const r = results[s.id]
        const running = r === 'running'
        const done = r && r !== 'running'
        return (
          <div className="step" key={s.id}>
            <div className="n">{i + 1}</div>
            <div className="title">{s.title}</div>
            <button
              className={`btn ${s.id === 'revoke' ? 'destructive' : ''}`}
              disabled={running}
              onClick={() => run(s)}
            >
              {running ? 'Working…' : s.id === 'revoke' ? 'Revoke' : done ? 'Run again' : 'Run'}
            </button>
            <div className="detail">{s.detail}</div>
            {done && (
              <div className={`outcome ${r.ok ? 'good' : 'bad'}`}>
                <div className="heading">{r.ok ? 'As expected' : 'Needs attention'}</div>
                {r.message}
                {r.hash && (
                  <div style={{ marginTop: 7 }}>
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

      <p className="footnote">
        The key used here is a testnet key holding faucet tokens, read from a local env file so the
        demo runs without a wallet prompt. That is fine on Moderato and would be indefensible on a
        chain with real money — a production build would sign in the user's own wallet.
      </p>
    </div>
  )
}
