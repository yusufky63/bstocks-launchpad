import type { Address, Hex } from 'viem';
import { createPublicClient, fallback, http, parseAbi } from 'viem';
import { base } from 'viem/chains';

import type { RawLog } from '@stockpair/core';

/** The minimal chain surface the indexer needs; tests provide an in-memory implementation. */
export interface ChainReader {
  getBlockNumber(): Promise<bigint>;
  getBlock(number: bigint): Promise<{ number: bigint; hash: Hex; parentHash: Hex; timestamp: bigint }>;
  getLogs(filter: {
    address?: Address | Address[];
    topics?: (Hex | Hex[] | null)[];
    fromBlock: bigint;
    toBlock: bigint;
  }): Promise<RawLog[]>;
  getTransactionSender(hash: Hex): Promise<Address | null>;
  readFeed(feed: Address): Promise<{ answer: bigint; updatedAt: bigint } | null>;
  /** Whether the factory currently accepts launches against this stock. */
  readStockEnabled(factory: Address, stock: Address): Promise<boolean | null>;
}

const feedAbi = parseAbi([
  'function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)',
]);

const factoryStockAbi = parseAbi([
  'struct Stock { address feed; bool enabled; uint8 decimals; string symbol; }',
  'function stockInfo(address stock) view returns (Stock)',
]);

export function createChainReader(rpcUrls: readonly string[]): ChainReader {
  const client = createPublicClient({
    chain: base,
    transport: fallback(
      rpcUrls.map((url) => http(url, { batch: true, retryCount: 2, timeout: 15_000 })),
      { rank: false },
    ),
  });
  const senderCache = new Map<Hex, Address | null>();

  return {
    getBlockNumber: () => client.getBlockNumber(),
    async getBlock(number) {
      const block = await client.getBlock({ blockNumber: number });
      return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
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
    async getTransactionSender(hash) {
      const cached = senderCache.get(hash);
      if (cached !== undefined) return cached;
      try {
        const tx = await client.getTransaction({ hash });
        senderCache.set(hash, tx.from);
        if (senderCache.size > 5_000) senderCache.clear();
        return tx.from;
      } catch {
        return null;
      }
    },
    async readStockEnabled(factory, stock) {
      try {
        const info = await client.readContract({ address: factory, abi: factoryStockAbi, functionName: 'stockInfo', args: [stock] });
        return info.feed === '0x0000000000000000000000000000000000000000' ? null : info.enabled;
      } catch {
        return null;
      }
    },
    async readFeed(feed) {
      try {
        const [, answer, , updatedAt] = await client.readContract({
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
