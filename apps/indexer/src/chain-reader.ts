import type { Address, Hex } from 'viem';
import {
  BaseError,
  BlockNotFoundError,
  ContractFunctionRevertedError,
  ContractFunctionZeroDataError,
  createPublicClient,
  fallback,
  http,
  parseAbi,
  TransactionReceiptNotFoundError,
} from 'viem';
import { base } from 'viem/chains';

import type { RawLog } from '@stockpair/core';

export type BlockHeader = { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint };

/** The minimal chain surface the indexer needs; tests provide an in-memory implementation. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<BlockHeader>;
  /** Like getBlock, but null when the node has no such block yet instead of an error. */
  findBlock(number: bigint): Promise<BlockHeader | null>;
  /**
   * A block with the sender of each of its transactions, keyed by lowercase hash. A swap's trader is
   * its transaction's sender; reading the block costs one request however many swaps it holds.
   */
  getBlockWithSenders(number: bigint): Promise<{ block: BlockHeader; senders: Map<Hex, Address> }>;
  getLogs(filter: {
    address?: Address | Address[];
    topics?: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  readFeed(feed: Address): Promise<{ answer: bigint; updatedAt: bigint } | null>;
  /** Whether the factory currently accepts launches against this stock. */
  readStockEnabled(factory: Address, stock: Address): Promise<boolean | null>;
  /**
   * A mined transaction's logs, from its receipt, or null when the node has no receipt for it. The
   * three reads below are how the indexer checks its deployment list against the chain; each one
   * throws on a transport failure, so an RPC hiccup is retried instead of read as a real answer.
   */
  getTransactionLogs(hash: Hex): Promise<RawLog[] | null>;
  /** `launchOf(token).creator` on a factory: the zero address when it did not launch the token, null when the call reverted or nothing is deployed there. */
  readLaunchCreator(factory: Address, token: Address): Promise<Address | null>;
  /** The hook a factory is wired to, or null when the call reverted or nothing is deployed there. */
  readFactoryHook(factory: Address): Promise<Address | null>;
}

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]);

const factoryStockAbi = parseAbi([
  'struct Stock { address feed; bool enabled; uint8 decimals; string symbol; }',
  'function stockInfo(address stock) view returns (Stock)',
]);

// The same on every factory deployed so far.
const factoryLaunchAbi = parseAbi([
  'struct Launch { address stock; address creator; int24 tickLower; int24 tickUpper; uint128 liquidity; uint64 launchedAt; uint160 openingSqrtPriceX96; uint256 stockUsd8; }',
  'function launchOf(address token) view returns (Launch)',
  'function hook() view returns (address)',
]);

/** The chain answered: the call reverted, or there is no contract code to call. Not a transport error. */
function answeredWithoutResult(error: unknown): boolean {
  return (
    error instanceof BaseError &&
    error.walk((e) => e instanceof ContractFunctionRevertedError || e instanceof ContractFunctionZeroDataError) !== null
  );
}

export function createChainReader(rpcUrls: readonly string[]): ChainReader {
  const client = createPublicClient({
    chain: base,
    transport: fallback(
      rpcUrls.map((url) => http(url, { batch: true, retryCount: 2, timeout: 15_000 })),
      { rank: false },
    ),
  });
  // The stock registry reads (a feed and an enabled flag per stock, every minute) go through
  // Multicall3: issued together they leave as one eth_call instead of one each, which the RPC bills
  // as one call. Only those reads use it; the deployment checks keep their plain calls, whose
  // revert and no-code answers they tell apart.
  const registryClient = createPublicClient({
    chain: base,
    batch: { multicall: { batchSize: 16_384, wait: 16 } },
    transport: fallback(
      rpcUrls.map((url) => http(url, { retryCount: 2, timeout: 15_000 })),
      { rank: false },
    ),
  });
  const header = (block: { number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }): BlockHeader => ({
    number: block.number,
    hash: block.hash,
    parentHash: block.parentHash,
    timestamp: block.timestamp,
  });

  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getBlock(number) {
      return header(await client.getBlock({ blockNumber: number }));
    },
    async findBlock(number) {
      try {
        return header(await client.getBlock({ blockNumber: number }));
      } catch (error) {
        if (error instanceof BaseError && error.walk((e) => e instanceof BlockNotFoundError)) return null;
        throw error;
      }
    },
    async getBlockWithSenders(number) {
      const block = await client.getBlock({ blockNumber: number, includeTransactions: true });
      return {
        block: header(block),
        senders: new Map(block.transactions.map((tx) => [tx.hash.toLowerCase() as Hex, tx.from])),
      };
    },
    async getLogs(filter) {
      const logs = await client.request({
        method: 'eth_getLogs',
        params: [
          {
            ...(filter.address ? { address: filter.address } : {}),
            ...(filter.topics ? { topics: filter.topics } : {}),
            fromBlock: `0x${filter.fromBlock.toString(16)}`,
            toBlock: `0x${filter.toBlock.toString(16)}`,
          } as never,
        ],
      });
      return (logs as Array<Record<string, unknown>>).map((log) => ({
        address: log.address as Address,
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
        blockNumber: BigInt(log.blockNumber as string),
        blockHash: log.blockHash as Hex,
        transactionHash: log.transactionHash as Hex,
        logIndex: Number(log.logIndex as string),
      }));
    },
    async readStockEnabled(factory, stock) {
      try {
        const info = await registryClient.readContract({ address: factory, abi: factoryStockAbi, functionName: 'stockInfo', args: [stock] });
        return info.feed === '0x0000000000000000000000000000000000000000' ? null : info.enabled;
      } catch {
        return null;
      }
    },
    async getTransactionLogs(hash) {
      try {
        const receipt = await client.getTransactionReceipt({ hash });
        return receipt.logs.map((log) => ({
          address: log.address,
          topics: log.topics as [Hex, ...Hex[]],
          data: log.data,
          blockNumber: log.blockNumber,
          blockHash: log.blockHash,
          transactionHash: log.transactionHash,
          logIndex: log.logIndex,
        }));
      } catch (error) {
        if (error instanceof BaseError && error.walk((e) => e instanceof TransactionReceiptNotFoundError)) return null;
        throw error;
      }
    },
    async readLaunchCreator(factory, token) {
      try {
        const launch = await client.readContract({ address: factory, abi: factoryLaunchAbi, functionName: 'launchOf', args: [token] });
        return launch.creator;
      } catch (error) {
        if (answeredWithoutResult(error)) return null;
        throw error;
      }
    },
    async readFactoryHook(factory) {
      try {
        return await client.readContract({ address: factory, abi: factoryLaunchAbi, functionName: 'hook' });
      } catch (error) {
        if (answeredWithoutResult(error)) return null;
        throw error;
      }
    },
    async readFeed(feed) {
      try {
        const [, answer, , updatedAt] = await registryClient.readContract({
          address: feed,
          abi: feedAbi,
          functionName: 'latestRoundData',
        });
        return { answer, updatedAt };
      } catch {
        return null;
      }
    },
  };
}
