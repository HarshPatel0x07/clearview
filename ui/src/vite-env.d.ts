/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Testnet key for the live Access Key panel. Faucet tokens only. */
  readonly VITE_TESTNET_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
