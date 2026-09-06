import { cookieStorage, createConfig, createStorage, fallback, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { baseAccount, injected } from 'wagmi/connectors';

import { publicEnv } from './env';

export const WAGMI_STORAGE_KEY = 'stockpair-wallet';

let cached: ReturnType<typeof createConfig> | null = null;

export function getWagmiConfig() {
  if (cached) return cached;
  const alchemyRpc = publicEnv.alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${publicEnv.alchemyKey}` : null;
  cached = createConfig({
    chains: [base],
    connectors: [baseAccount({ appName: 'StockPair' }), injected()],
    multiInjectedProviderDiscovery: true,
    ssr: true,
    storage: createStorage({ key: WAGMI_STORAGE_KEY, storage: cookieStorage }),
    transports: {
      [base.id]: fallback([
        ...(alchemyRpc ? [http(alchemyRpc, { batch: true, retryCount: 2, timeout: 8_000 })] : []),
        http('https://base-rpc.publicnode.com', { batch: true, retryCount: 2, timeout: 8_000 }),
        http('https://mainnet.base.org', { batch: true, retryCount: 1, timeout: 8_000 }),
      ]),
    },
  });
  return cached;
}

declare module 'wagmi' {
  interface Register {
    config: ReturnType<typeof getWagmiConfig>;
  }
}
