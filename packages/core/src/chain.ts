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

type Env = Readonly<Record<string, string | undefined>>;
type DeploymentPrefix = 'STOCKPAIR' | 'NEXT_PUBLIC_STOCKPAIR';

function isContractAddress(value: unknown): value is Address {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(value) && value !== ZERO;
}

/** The single `*_FACTORY`, `*_HOOK` and `*_ROUTER` keys every deployment used before the list. */
function readSingleDeployment(env: Env, prefix: DeploymentPrefix): StockPairDeployment | null {
  const factory = env[`${prefix}_FACTORY`]?.trim();
  const hook = env[`${prefix}_HOOK`]?.trim();
  const router = env[`${prefix}_ROUTER`]?.trim();
  const block = (env[`${prefix}_DEPLOY_BLOCK`] ?? env.STOCKPAIR_DEPLOY_BLOCK ?? '0').trim();
  if (!isContractAddress(factory) || !isContractAddress(hook) || !isContractAddress(router)) return null;
  return Object.freeze({ factory, hook, router, deployBlock: BigInt(/^\d+$/u.test(block) ? block : '0') });
}

function parseDeployBlock(value: unknown): bigint | null {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  if (typeof value === 'string' && /^\d+$/u.test(value.trim())) return BigInt(value.trim());
  return null;
}

/** Why a `<prefix>_DEPLOYMENTS` list was refused, naming the entry at fault. */
export class DeploymentListError extends Error {
  override name = 'DeploymentListError';
}

/**
 * Every StockPair deployment, oldest first, or a DeploymentListError saying why the list is refused.
 * The indexer uses this so it can stop with the reason; everything else uses `readDeployments`.
 *
 * Reads `<prefix>_DEPLOYMENTS`, a JSON array of `{factory, hook, router, deployBlock}` ordered oldest
 * to newest. Without it, falls back to the single `<prefix>_FACTORY`, `_HOOK` and `_ROUTER` keys.
 * One bad entry, a repeated factory or hook, or an out-of-order block refuses the whole list instead
 * of skipping the entry: a list that quietly lost an old deployment would stop its tokens quoting and
 * indexing.
 */
export function parseDeployments(env: Env, prefix: DeploymentPrefix = 'STOCKPAIR'): readonly StockPairDeployment[] {
  const key = `${prefix}_DEPLOYMENTS`;
  const raw = env[key]?.trim();
  if (!raw) {
    const single = readSingleDeployment(env, prefix);
    return Object.freeze(single ? [single] : []);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new DeploymentListError(`${key} is not valid JSON.`);
  }
  if (!Array.isArray(parsed)) throw new DeploymentListError(`${key} must be a JSON array, oldest deployment first.`);
  const out: StockPairDeployment[] = [];
  const seen = new Set<string>();
  (parsed as unknown[]).forEach((entry, i) => {
    const at = `${key}[${i}]`;
    if (typeof entry !== 'object' || entry === null) throw new DeploymentListError(`${at} is not an object.`);
    const { factory, hook, router, deployBlock } = entry as Record<string, unknown>;
    const block = parseDeployBlock(deployBlock);
    if (!isContractAddress(factory) || !isContractAddress(hook) || !isContractAddress(router) || block === null) {
      throw new DeploymentListError(`${at} needs factory, hook and router addresses and a whole-number deployBlock.`);
    }
    const previous = out.at(-1);
    if (previous && block < previous.deployBlock) {
      throw new DeploymentListError(
        `${at} has deployBlock ${block}, before the entry above it (${previous.deployBlock}); the list goes oldest first.`,
      );
    }
    // A hook belongs to exactly one factory, so either one appearing twice is a copy-paste slip.
    for (const address of [factory, hook]) {
      if (seen.has(address.toLowerCase())) throw new DeploymentListError(`${at} repeats ${address}; each factory and hook is listed once.`);
      seen.add(address.toLowerCase());
    }
    out.push(Object.freeze({ factory, hook, router, deployBlock: block }));
  });
  return Object.freeze(out);
}

/**
 * Every StockPair deployment, oldest first. Earlier factories and hooks stay live after a new
 * deployment -- their tokens keep trading, earning fees and claiming -- so indexing, pool keys and
 * claims need all of them, while only the newest takes new launches. A refused list reads as none.
 */
export function readDeployments(env: Env, prefix: DeploymentPrefix = 'STOCKPAIR'): readonly StockPairDeployment[] {
  try {
    return parseDeployments(env, prefix);
  } catch (error) {
    if (error instanceof DeploymentListError) return Object.freeze([]);
    throw error;
  }
}

/** The newest deployment: the one new launches go to. Returns null until deployed. */
export function readDeployment(env: Env, prefix: DeploymentPrefix = 'STOCKPAIR'): StockPairDeployment | null {
  return readDeployments(env, prefix).at(-1) ?? null;
}

/** The deployment whose factory, hook or router is `address` (any case), or null for a stranger. */
export function findDeployment(
  deployments: readonly StockPairDeployment[],
  address: string | null | undefined,
): StockPairDeployment | null {
  if (!address) return null;
  const wanted = address.toLowerCase();
  return (
    deployments.find((d) => [d.factory, d.hook, d.router].some((a) => a.toLowerCase() === wanted)) ?? null
  );
}

export const UNISWAP_V4_SWAP_TOPIC =
  '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f' as const;
export const ERC20_TRANSFER_TOPIC =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef' as const;
