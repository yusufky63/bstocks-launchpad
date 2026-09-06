import { encodeAbiParameters, encodeEventTopics, type AbiParameter, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { stockPairFactoryAbi, stockPairHookAbi } from '../src/abi/stockpair';
import { UNISWAP_V4_SWAP_TOPIC } from '../src/chain';
import {
  classifySwap,
  type RawLog,
  decodeFeeCharged,
  decodeLaunched,
  decodeSwap,
  decodeTransfer,
  FEE_CHARGED_TOPIC,
  LAUNCHED_TOPIC,
} from '../src/decode';

/** Real Base mainnet log: tx 0x41c447a8… sold 3,684,952 tokens for 0.00827 ETH on pool 0x6d1644…. */
const REAL_SWAP_LOG: RawLog = {
  address: '0x498581ff718922c3f8e6a244956af099b2652b2b',
  topics: [
    UNISWAP_V4_SWAP_TOPIC,
    '0x6d1644cf4b01a1d859d553ccadc2405f619e6ef3eb8a2cadfc5490efeb923030',
    '0x000000000000000000000000fdf682f51fe81aa4898f0ae2163d8a55c127fbc7',
  ],
  data: '0x000000000000000000000000000000000000000000000000001d5e562eada1d9fffffffffffffffffffffffffffffffffffffffffffcf3ae5a0fe071cda0000000000000000000000000000000000000000052a0428c9613b0cbbc5d483fb2d8000000000000000000000000000000000000000000000a02da12eb8a8c3ea4be0000000000000000000000000000000000000000000000000000000000030a1f0000000000000000000000000000000000000000000000000000000000000000' as Hex,
  blockNumber: 50_188_335n,
  transactionHash: '0x41c447a8d2b0af17a3c526a0e2fc88fa00a37a7fbe8217d6ca74e06aa8efb627' as Hex,
  logIndex: 822,
};

describe('decodeSwap', () => {
  it('decodes a real PoolManager swap with swapper-perspective deltas', () => {
    const swap = decodeSwap(REAL_SWAP_LOG);
    expect(swap).not.toBeNull();
    expect(swap!.poolId).toBe('0x6d1644cf4b01a1d859d553ccadc2405f619e6ef3eb8a2cadfc5490efeb923030');
    expect(swap!.amount0).toBe(8_266_498_567_938_521n); // received ETH
    expect(swap!.amount1).toBe(-3_684_952_000_000_000_000_000_000n); // paid tokens
    expect(swap!.tick).toBe(199_199);
    expect(swap!.liquidity).toBe(47_276_272_197_874_011_251_902n);
    // token was currency1 in that pool: the swapper paid tokens, so it is a sell
    const classified = classifySwap(swap!, false);
    expect(classified.side).toBe('sell');
    expect(classified.amountTokenRaw).toBe(3_684_952_000_000_000_000_000_000n);
    expect(classified.amountStockRaw).toBe(8_266_498_567_938_521n);
  });

  it('ignores logs with other topics', () => {
    expect(decodeSwap({ ...REAL_SWAP_LOG, topics: [LAUNCHED_TOPIC] })).toBeNull();
  });
});

describe('decodeLaunched', () => {
  it('round-trips a synthesised Launched event', () => {
    const event = stockPairFactoryAbi.find((i) => i.type === 'event' && i.name === 'Launched')!;
    const args = {
      token: '0xb2000000000000000000000000000000000000aa',
      creator: '0x1111111111111111111111111111111111111111',
      stock: '0xb20000000000000000000078ee7ce2fE4908108C',
    } as const;
    const topics = encodeEventTopics({ abi: [event], eventName: 'Launched', args });
    const nonIndexed = (event.inputs as readonly (AbiParameter & { indexed?: boolean })[]).filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, [
      `0x${'cd'.repeat(32)}`,
      123_456_789n,
      -887_200,
      100,
      10n ** 20n,
      22_995_730_000n,
      'Test Token',
      'TEST',
      'ipfs://bafytest',
    ]);
    const decoded = decodeLaunched({
      address: '0x0000000000000000000000000000000000000001',
      topics: topics as [Hex, ...Hex[]],
      data,
      blockNumber: 1n,
      transactionHash: '0x01',
      logIndex: 0,
    });
    expect(decoded?.token.toLowerCase()).toBe('0xb2000000000000000000000000000000000000aa');
    expect(decoded?.creator.toLowerCase()).toBe('0x1111111111111111111111111111111111111111');
    expect(decoded?.stock.toLowerCase()).toBe('0xb20000000000000000000078ee7ce2fe4908108c');
    expect(decoded).toMatchObject({
      poolId: `0x${'cd'.repeat(32)}`,
      sqrtPriceX96: 123_456_789n,
      tickLower: -887_200,
      tickUpper: 100,
      liquidity: 10n ** 20n,
      stockUsd8: 22_995_730_000n,
      name: 'Test Token',
      symbol: 'TEST',
      contractURI: 'ipfs://bafytest',
    });
    expect(topics[0]).toBe(LAUNCHED_TOPIC);
  });
});

describe('decodeFeeCharged and decodeTransfer', () => {
  it('decodes FeeCharged', () => {
    const event = stockPairHookAbi.find((i) => i.type === 'event' && i.name === 'FeeCharged')!;
    const topics = encodeEventTopics({
      abi: [event],
      eventName: 'FeeCharged',
      args: { poolId: `0x${'cd'.repeat(32)}`, stock: '0xb20000000000000000000078ee7ce2fE4908108C' },
    });
    const nonIndexed = (event.inputs as readonly (AbiParameter & { indexed?: boolean })[]).filter((i) => !i.indexed);
    const data = encodeAbiParameters(nonIndexed, [1_000_000n, 700_000n, 300_000n, 100n]);
    const decoded = decodeFeeCharged({
      address: '0x0000000000000000000000000000000000000002',
      topics: topics as [Hex, ...Hex[]],
      data,
      blockNumber: 1n,
      transactionHash: '0x02',
      logIndex: 1,
    });
    expect(topics[0]).toBe(FEE_CHARGED_TOPIC);
    expect(decoded).toMatchObject({ amount: 1_000_000n, creatorAmount: 700_000n, platformAmount: 300_000n, feeBps: 100n });
  });

  it('decodes ERC-20 Transfer', () => {
    const decoded = decodeTransfer({
      address: '0xb2000000000000000000004bd87e2287886ec26f',
      topics: [
        '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
        '0x000000000000000000000000eaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac',
        '0x000000000000000000000000498581ff718922c3f8e6a244956af099b2652b2b',
      ],
      data: '0x000000000000000000000000000000000000000000030c51a5f01f8e32600000',
      blockNumber: 1n,
      transactionHash: '0x03',
      logIndex: 2,
    });
    expect(decoded?.from.toLowerCase()).toBe('0xeaa823ab4c4ee00283d8ed7be713ddf8a5ba0fac');
    expect(decoded?.to.toLowerCase()).toBe('0x498581ff718922c3f8e6a244956af099b2652b2b');
    expect(decoded?.value).toBe(3_684_952_000_000_000_000_000_000n);
  });
});
