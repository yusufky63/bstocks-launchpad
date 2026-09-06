import { readDeployment, type StockPairDeployment } from '@stockpair/core';

/** Browser-safe configuration derived from NEXT_PUBLIC_* variables at build time. */
export const publicEnv = {
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === 'production' ? 'https://launchpad.basestocks.finance' : 'http://localhost:3000'),
  ipfsGateway: (process.env.NEXT_PUBLIC_IPFS_GATEWAY ?? 'https://gateway.pinata.cloud').replace(/\/$/u, ''),
  deployment: readDeployment(
    {
      NEXT_PUBLIC_STOCKPAIR_FACTORY: process.env.NEXT_PUBLIC_STOCKPAIR_FACTORY,
      NEXT_PUBLIC_STOCKPAIR_HOOK: process.env.NEXT_PUBLIC_STOCKPAIR_HOOK,
      NEXT_PUBLIC_STOCKPAIR_ROUTER: process.env.NEXT_PUBLIC_STOCKPAIR_ROUTER,
      NEXT_PUBLIC_STOCKPAIR_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_STOCKPAIR_DEPLOY_BLOCK,
    },
    'NEXT_PUBLIC_STOCKPAIR',
  ),
  alchemyKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY ?? '',
  /** WalletConnect (Reown) project id; when set it enables the mobile-wallet connector. */
  walletConnectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? '',
} as const;

export function requireDeployment(): StockPairDeployment {
  if (!publicEnv.deployment) {
    throw new Error('Launchpad contracts are not configured (NEXT_PUBLIC_STOCKPAIR_*).');
  }
  return publicEnv.deployment;
}

export function ipfsToHttp(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) return `${publicEnv.ipfsGateway}/ipfs/${uri.slice(7)}`;
  if (uri.startsWith('https://')) return uri;
  return null;
}
