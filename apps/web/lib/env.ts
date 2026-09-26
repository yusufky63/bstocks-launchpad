import { readDeployments, type StockPairDeployment } from '@stockpair/core';

/**
 * Every deployment, oldest first. Next inlines NEXT_PUBLIC_* values only where the key is written
 * out in full, so each one is spelled out here rather than read from process.env as a whole.
 */
const deployments = readDeployments(
  {
    NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS: process.env.NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS,
    NEXT_PUBLIC_STOCKPAIR_FACTORY: process.env.NEXT_PUBLIC_STOCKPAIR_FACTORY,
    NEXT_PUBLIC_STOCKPAIR_HOOK: process.env.NEXT_PUBLIC_STOCKPAIR_HOOK,
    NEXT_PUBLIC_STOCKPAIR_ROUTER: process.env.NEXT_PUBLIC_STOCKPAIR_ROUTER,
    NEXT_PUBLIC_STOCKPAIR_DEPLOY_BLOCK: process.env.NEXT_PUBLIC_STOCKPAIR_DEPLOY_BLOCK,
  },
  'NEXT_PUBLIC_STOCKPAIR',
);

/** Browser-safe configuration derived from NEXT_PUBLIC_* variables at build time. */
export const publicEnv = {
  appUrl: (process.env.NEXT_PUBLIC_APP_URL?.trim() || (process.env.NODE_ENV === 'production' ? 'https://launchpad.basestocks.finance' : 'http://localhost:3000')).replace(/\/+$/u, ''),
  ipfsGateway: (process.env.NEXT_PUBLIC_IPFS_GATEWAY?.trim() || 'https://gateway.pinata.cloud').replace(/\/+$/u, ''),
  /** Every factory, hook and router still live, oldest first. Old tokens keep trading on theirs. */
  deployments,
  /** The deployment new launches go to. */
  newest: deployments.at(-1) ?? null,
  /** Same as `newest`, for pages that show one set of addresses. */
  deployment: deployments.at(-1) ?? null,
  alchemyKey: process.env.NEXT_PUBLIC_ALCHEMY_API_KEY?.trim() ?? '',
  /** WalletConnect (Reown) project id; when set it enables the mobile-wallet connector. */
  walletConnectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() ?? '',
  /** Base Builder Code (ERC-8021). The same code the trading app attributes to. */
  builderCode: process.env.NEXT_PUBLIC_BASE_BUILDER_CODE || 'bc_71vd6x2w',
  /** The alerts channel. Empty until one exists, which is what hides the links to it. */
  telegramChannel: process.env.NEXT_PUBLIC_TELEGRAM_CHANNEL?.trim() ?? '',
} as const;

export function requireDeployment(): StockPairDeployment {
  if (!publicEnv.newest) {
    throw new Error('Launchpad contracts are not configured (NEXT_PUBLIC_STOCKPAIR_*).');
  }
  return publicEnv.newest;
}

/**
 * A `.` or `..` path segment, plain or percent-encoded, or a backslash (which URL parsing treats as
 * a slash). The gateway URL is `<gateway>/ipfs/<rest>`, and fetch resolves such a segment before the
 * request goes out, so `ipfs://x/../../ipns/<name>` would load a mutable /ipns/ name instead.
 */
const ESCAPES_IPFS_PATH = /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)|\\/iu;

export function ipfsToHttp(uri: string | null | undefined): string | null {
  if (!uri) return null;
  if (uri.startsWith('ipfs://')) {
    const rest = uri.slice(7);
    return ESCAPES_IPFS_PATH.test(rest) ? null : `${publicEnv.ipfsGateway}/ipfs/${rest}`;
  }
  if (uri.startsWith('https://')) return uri;
  return null;
}
