import { cookieStorage, createConfig, createStorage, fallback, http, type CreateConnectorFn } from 'wagmi';
import { base } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';

import { publicEnv } from './env';

export const WAGMI_STORAGE_KEY = 'stockpair-wallet';

let cached: ReturnType<typeof createConfig> | null = null;

export function getWagmiConfig() {
  if (cached) return cached;
  const alchemyRpc = publicEnv.alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${publicEnv.alchemyKey}` : null;
  // Base Account (passkey, works on mobile web), any injected extension, and — when a WalletConnect
  // project id is set — QR / deep-link into a mobile wallet like MetaMask, Trust or Rainbow.
  const connectors: CreateConnectorFn[] = [baseAccount({ appName: 'BaseStocks Launchpad' }), injected()];
  if (publicEnv.walletConnectId) {
    connectors.push(
      walletConnect({
        projectId: publicEnv.walletConnectId,
        showQrModal: true,
        metadata: {
          name: 'BaseStocks Launchpad',
          description: 'Launch a token on Base that trades against a Coinbase tokenized stock.',
          url: publicEnv.appUrl,
          icons: [`${publicEnv.appUrl}/icon.svg`],
        },
      }),
    );
  }
  cached = createConfig({
    chains: [base],
    connectors,
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
