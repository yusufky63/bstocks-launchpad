import {
  decodeEventLog,
  parseAbiItem,
  toEventSelector,
  type Address,
  type Hex,
  type Log,
} from 'viem';

import { stockPairFactoryAbi, stockPairHookAbi } from './abi/stockpair';
import { ERC20_TRANSFER_TOPIC, UNISWAP_V4_SWAP_TOPIC } from './chain';

/**
 * Uniswap v4 PoolManager Swap. amount0/amount1 are the swapper's balance deltas:
 * negative means the swapper paid that currency into the pool, positive means received.
 * They reflect the pool math only; hook fees are charged on top (see FeeCharged).
 */
export const poolManagerSwapEvent = parseAbiItem(
  'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee)',
);

export const erc20TransferEvent = parseAbiItem(
  'event Transfer(address indexed from, address indexed to, uint256 value)',
);

export type RawLog = Pick<Log, 'address' | 'topics' | 'data'> & {
  blockNumber: bigint | null;
  transactionHash: Hex | null;
  logIndex: number | null;
  blockHash?: Hex | null;
};

export type LaunchedEvent = {
  token: Address;
  creator: Address;
  stock: Address;
  poolId: Hex;
  sqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  stockUsd8: bigint;
  name: string;
  symbol: string;
  contractURI: string;
};

export type SwapEvent = {
  poolId: Hex;
  sender: Address;
  amount0: bigint;
  amount1: bigint;
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  fee: number;
};

export type TransferEvent = { from: Address; to: Address; value: bigint };

export type FeeChargedEvent = {
  poolId: Hex;
  stock: Address;
  amount: bigint;
  creatorAmount: bigint;
  platformAmount: bigint;
  feeBps: bigint;
};

export type FeesClaimedEvent = { stock: Address; account: Address; amount: bigint };

/** The creator's buy inside launchAndBuy. `fee` is the whole hook fee; 70% of it is the creator's. */
export type CreatorBoughtEvent = {
  token: Address;
  creator: Address;
  poolId: Hex;
  stockIn: bigint;
  fee: bigint;
  tokensOut: bigint;
};

/** Always the log right after its Launched, in the same transaction. */
export type MetadataEditableEvent = { token: Address; creator: Address };

export type ContractURIChangedEvent = { token: Address; creator: Address; contractURI: string };

export type MetadataLockedEvent = { token: Address; creator: Address };

const launchedEvent = stockPairFactoryAbi.find(
  (item) => item.type === 'event' && item.name === 'Launched',
);
const feeChargedEvent = stockPairHookAbi.find(
  (item) => item.type === 'event' && item.name === 'FeeCharged',
);
const feesClaimedEvent = stockPairHookAbi.find(
  (item) => item.type === 'event' && item.name === 'FeesClaimed',
);
const creatorBoughtEvent = stockPairFactoryAbi.find(
  (item) => item.type === 'event' && item.name === 'CreatorBought',
);
const metadataEditableEvent = stockPairFactoryAbi.find(
  (item) => item.type === 'event' && item.name === 'MetadataEditable',
);
const contractURIChangedEvent = stockPairFactoryAbi.find(
  (item) => item.type === 'event' && item.name === 'ContractURIChanged',
);
const metadataLockedEvent = stockPairFactoryAbi.find(
  (item) => item.type === 'event' && item.name === 'MetadataLocked',
);

function topic0(log: RawLog): Hex | undefined {
  return log.topics[0];
}

export const LAUNCHED_TOPIC = topicOf(launchedEvent);
export const FEE_CHARGED_TOPIC = topicOf(feeChargedEvent);
export const FEES_CLAIMED_TOPIC = topicOf(feesClaimedEvent);
export const CREATOR_BOUGHT_TOPIC = topicOf(creatorBoughtEvent);
export const METADATA_EDITABLE_TOPIC = topicOf(metadataEditableEvent);
export const CONTRACT_URI_CHANGED_TOPIC = topicOf(contractURIChangedEvent);
export const METADATA_LOCKED_TOPIC = topicOf(metadataLockedEvent);

function topicOf(item: unknown): Hex {
  return toEventSelector(item as never);
}

export function decodeLaunched(log: RawLog): LaunchedEvent | null {
  if (topic0(log) !== LAUNCHED_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairFactoryAbi,
    eventName: 'Launched',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const a = decoded.args;
  return {
    token: a.token,
    creator: a.creator,
    stock: a.stock,
    poolId: a.poolId,
    sqrtPriceX96: a.sqrtPriceX96,
    tickLower: a.tickLower,
    tickUpper: a.tickUpper,
    liquidity: a.liquidity,
    stockUsd8: a.stockUsd8,
    name: a.name,
    symbol: a.symbol,
    contractURI: a.contractURI,
  };
}

export function decodeSwap(log: RawLog): SwapEvent | null {
  if (topic0(log) !== UNISWAP_V4_SWAP_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: [poolManagerSwapEvent],
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const a = decoded.args;
  return {
    poolId: a.id,
    sender: a.sender,
    amount0: a.amount0,
    amount1: a.amount1,
    sqrtPriceX96: a.sqrtPriceX96,
    liquidity: a.liquidity,
    tick: a.tick,
    fee: a.fee,
  };
}

export function decodeTransfer(log: RawLog): TransferEvent | null {
  if (topic0(log) !== ERC20_TRANSFER_TOPIC || log.topics.length !== 3) return null;
  const decoded = decodeEventLog({
    abi: [erc20TransferEvent],
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return { from: decoded.args.from, to: decoded.args.to, value: decoded.args.value };
}

export function decodeFeeCharged(log: RawLog): FeeChargedEvent | null {
  if (topic0(log) !== FEE_CHARGED_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairHookAbi,
    eventName: 'FeeCharged',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const a = decoded.args;
  return {
    poolId: a.poolId,
    stock: a.stock,
    amount: a.amount,
    creatorAmount: a.creatorAmount,
    platformAmount: a.platformAmount,
    feeBps: a.feeBps,
  };
}

export function decodeFeesClaimed(log: RawLog): FeesClaimedEvent | null {
  if (topic0(log) !== FEES_CLAIMED_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairHookAbi,
    eventName: 'FeesClaimed',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return { stock: decoded.args.stock, account: decoded.args.account, amount: decoded.args.amount };
}

export function decodeCreatorBought(log: RawLog): CreatorBoughtEvent | null {
  if (topic0(log) !== CREATOR_BOUGHT_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairFactoryAbi,
    eventName: 'CreatorBought',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const a = decoded.args;
  return {
    token: a.token,
    creator: a.creator,
    poolId: a.poolId,
    stockIn: a.stockIn,
    fee: a.fee,
    tokensOut: a.tokensOut,
  };
}

export function decodeMetadataEditable(log: RawLog): MetadataEditableEvent | null {
  if (topic0(log) !== METADATA_EDITABLE_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairFactoryAbi,
    eventName: 'MetadataEditable',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return { token: decoded.args.token, creator: decoded.args.creator };
}

export function decodeContractURIChanged(log: RawLog): ContractURIChangedEvent | null {
  if (topic0(log) !== CONTRACT_URI_CHANGED_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairFactoryAbi,
    eventName: 'ContractURIChanged',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  const a = decoded.args;
  return { token: a.token, creator: a.creator, contractURI: a.contractURI };
}

export function decodeMetadataLocked(log: RawLog): MetadataLockedEvent | null {
  if (topic0(log) !== METADATA_LOCKED_TOPIC) return null;
  const decoded = decodeEventLog({
    abi: stockPairFactoryAbi,
    eventName: 'MetadataLocked',
    data: log.data,
    topics: log.topics as [Hex, ...Hex[]],
  });
  return { token: decoded.args.token, creator: decoded.args.creator };
}

/**
 * Interprets a Swap on a launch pool from the launched token's point of view.
 * side = buy when the swapper received the token.
 */
export function classifySwap(
  swap: SwapEvent,
  tokenIsCurrency0: boolean,
): { side: 'buy' | 'sell'; amountTokenRaw: bigint; amountStockRaw: bigint } {
  const tokenDelta = tokenIsCurrency0 ? swap.amount0 : swap.amount1;
  const stockDelta = tokenIsCurrency0 ? swap.amount1 : swap.amount0;
  const abs = (v: bigint) => (v < 0n ? -v : v);
  return {
    side: tokenDelta > 0n ? 'buy' : 'sell',
    amountTokenRaw: abs(tokenDelta),
    amountStockRaw: abs(stockDelta),
  };
}
