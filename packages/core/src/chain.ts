import type { Address } from 'viem';

export const BASE_CHAIN_ID = 8453 as const;

/** Uniswap v4 and Base-native contracts on Base mainnet. */
export const BASE_CONTRACTS = {
  poolManager: '0x498581fF718922c3f8e6A244956aF099B2652b2b',
  positionManager: '0x7C5f5A4bBd8fD63184577525326123B519429bDc',
  quoter: '0x0d5e0F971ED27FBfF6c2837bf31316121532048D',
  stateView: '0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71',
  universalRouter: '0x6fF5693b99212Da76ad316178A184AB56D299b43',
  permit2: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
  b20Factory: '0xB20f000000000000000000000000000000000000',
} as const satisfies Record<string, Address>;

export type StockPairDeployment = Readonly<{
  factory: Address;
  hook: Address;
  router: Address;
  deployBlock: bigint;
}>;

const ZERO = '0x0000000000000000000000000000000000000000';

/** Reads the deployed StockPair addresses from the environment. Returns null until deployed. */
export function readDeployment(
  env: Readonly<Record<string, string | undefined>>,
  prefix: 'STOCKPAIR' | 'NEXT_PUBLIC_STOCKPAIR' = 'STOCKPAIR',
): StockPairDeployment | null {
  const factory = env[`${prefix}_FACTORY`]?.trim();
  const hook = env[`${prefix}_HOOK`]?.trim();
  const router = env[`${prefix}_ROUTER`]?.trim();
  const block = (env[`${prefix}_DEPLOY_BLOCK`] ?? env.STOCKPAIR_DEPLOY_BLOCK ?? '0').trim();
  if (!factory || !hook || !router) return null;
  if ([factory, hook, router].some((a) => !/^0x[0-9a-fA-F]{40}$/u.test(a) || a === ZERO)) {
    return null;
  }
  return Object.freeze({
    factory: factory as Address,
    hook: hook as Address,
    router: router as Address,
    deployBlock: BigInt(/^\d+$/u.test(block) ? block : '0'),
  });
}

export const UNISWAP_V4_SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as const;
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
