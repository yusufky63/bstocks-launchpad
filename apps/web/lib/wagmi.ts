import { cookieStorage, createConfig, createStorage, fallback, http, type CreateConnectorFn } from 'wagmi';
import { base } from 'wagmi/chains';
import { baseAccount, injected, walletConnect } from 'wagmi/connectors';

import { publicEnv } from './env';

export const WAGMI_STORAGE_KEY = 'stockpair-wallet';

type KeyValueStorage = { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void };

function browserLocalStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // A frame refused storage throws on the property access itself.
    return null;
  }
}

/**
 * Where wagmi keeps the connected wallet. The cookie comes first: the server reads it to render the
 * connected state on the site's own pages. A widget in another site's iframe is usually refused
 * that cookie (a Lax cookie is never set in a cross-site frame), and without a second copy it forgot
 * the wallet on every load; the frame's own localStorage keeps one. Either store may be refused, and
 * a refused store only costs the reconnect.
 */
export function walletStorage(cookies: KeyValueStorage = cookieStorage, local: () => Storage | null = browserLocalStorage): KeyValueStorage {
  const guard = (run: () => void) => {
    try {
      run();
    } catch {
      /* storage refused */
    }
  };
  return {
    getItem(key) {
      let value: string | null = null;
      guard(() => {
        value = cookies.getItem(key);
      });
      if (value !== null) return value;
      guard(() => {
        value = local()?.getItem(key) ?? null;
      });
      return value;
    },
    setItem(key, value) {
      guard(() => cookies.setItem(key, value));
      guard(() => local()?.setItem(key, value));
    },
    removeItem(key) {
      guard(() => cookies.removeItem(key));
      guard(() => local()?.removeItem(key));
    },
  };
}

let cached: ReturnType<typeof createConfig> | null = null;

export function getWagmiConfig() {
  if (cached) return cached;
  const alchemyRpc = publicEnv.alchemyKey ? `https://base-mainnet.g.alchemy.com/v2/${publicEnv.alchemyKey}` : null;
  // Base Account (passkey, works on mobile web), any injected extension, and — when a WalletConnect
  // project id is set — QR / deep-link into a mobile wallet like MetaMask, Trust or Rainbow.
  const connectors: CreateConnectorFn[] = [baseAccount({ appName: 'BStocks Launchpad' }), injected()];
  if (publicEnv.walletConnectId) {
    connectors.push(
      walletConnect({
        projectId: publicEnv.walletConnectId,
        showQrModal: true,
        metadata: {
          name: 'BStocks Launchpad',
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
    storage: createStorage({ key: WAGMI_STORAGE_KEY, storage: walletStorage() }),
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
