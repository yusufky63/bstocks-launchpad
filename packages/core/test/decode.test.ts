import { encodeAbiParameters, encodeEventTopics, toEventSelector, type AbiParameter, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';

import { stockPairFactoryAbi, stockPairHookAbi } from '../src/abi/stockpair';
import { UNISWAP_V4_SWAP_TOPIC } from '../src/chain';
import {
  classifySwap,
  CONTRACT_URI_CHANGED_TOPIC,
  CREATOR_BOUGHT_TOPIC,
  type RawLog,
  decodeContractURIChanged,
  decodeCreatorBought,
  decodeFeeCharged,
  decodeFeesClaimed,
  decodeLaunched,
  decodeMetadataEditable,
  decodeMetadataLocked,
  decodeSwap,
  decodeTransfer,
  FEE_CHARGED_TOPIC,
  FEES_CLAIMED_TOPIC,
  LAUNCHED_TOPIC,
  METADATA_EDITABLE_TOPIC,
  METADATA_LOCKED_TOPIC,
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

/**
 * A Launched log encoded with the factory ABI from before launchAndBuy (commit 89c664f), the one the
 * deployed factory and STOCK were built from. The event is byte-identical in the new factory, so the
 * same decoder must keep reading every earlier launch.
 */
const OLD_FACTORY_LAUNCHED: RawLog = {
  address: '0x888bc129704a4158c07614c234bb7eb8126aad47',
  topics: [
    '0x545827070fae462314f8e79f25d99f8e713bf3cecb38728eb4c4804e1e20d0a6',
    '0x000000000000000000000000b2000000000000000000000000000000000057c0',
    '0x00000000000000000000000078de409a6306550882328e2a67160471368387ff',
    '0x000000000000000000000000b20000000000000000000078ee7ce2fe4908108c',
  ],
  data: '0x5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a5a0000000000000000000000000000000003099528583f263f0a27b93f64977008fffffffffffffffffffffffffffffffffffffffffffffffffffffffffff276600000000000000000000000000000000000000000000000000000000000069e24000000000000000000000000000000000000000000000000054f6cc63fde588a00000000000000000000000000000000000000000000000000000004319e954e0000000000000000000000000000000000000000000000000000000000000120000000000000000000000000000000000000000000000000000000000000016000000000000000000000000000000000000000000000000000000000000001a0000000000000000000000000000000000000000000000000000000000000000953746f636b506169720000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000553544f434b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001a697066733a2f2f6261666b72656973746f636b70726f66696c65000000000000',
  blockNumber: 50_932_800n,
  transactionHash: '0x0a' as Hex,
  logIndex: 4,
};

const TOKEN = '0xb2000000000000000000000000000000000000e1';
const CREATOR = '0x1111111111111111111111111111111111111111';
const POOL_ID = `0x${'e1'.repeat(32)}` as Hex;

/** A factory log for `eventName` with the given indexed arguments and non-indexed values. */
function factoryLog(eventName: string, args: Record<string, unknown>, values: readonly unknown[]): RawLog {
  const event = stockPairFactoryAbi.find((i) => i.type === 'event' && i.name === eventName)!;
  const topics = encodeEventTopics({ abi: [event], eventName, args } as never) as [Hex, ...Hex[]];
  const nonIndexed = (event.inputs as readonly (AbiParameter & { indexed?: boolean })[]).filter((i) => !i.indexed);
  return {
    address: '0x1000000000000000000000000000000000000001',
    topics,
    data: encodeAbiParameters(nonIndexed, values as never),
    blockNumber: 51_000_000n,
    transactionHash: '0x0b' as Hex,
    logIndex: 7,
  };
}

describe('logs from every deployment', () => {
  it('keeps the topics of the events the earlier factory and hook emit', () => {
    expect(LAUNCHED_TOPIC).toBe('0x545827070fae462314f8e79f25d99f8e713bf3cecb38728eb4c4804e1e20d0a6');
    expect(FEE_CHARGED_TOPIC).toBe('0x8b0e4cf39120c70654d9e54bb37acd7e4b571480cac924f4d96ebaf14b35093d');
    expect(FEES_CLAIMED_TOPIC).toBe('0xfe3464cd748424446c37877c28ce5b700222c5bc9f90d908afcc4e5cb22707ff');
  });

  it('decodes a Launched log from the earlier factory', () => {
    const decoded = decodeLaunched(OLD_FACTORY_LAUNCHED);
    expect(decoded?.token.toLowerCase()).toBe('0xb2000000000000000000000000000000000057c0');
    expect(decoded?.creator.toLowerCase()).toBe('0x78de409a6306550882328e2a67160471368387ff');
    expect(decoded?.stock.toLowerCase()).toBe('0xb20000000000000000000078ee7ce2fe4908108c');
    expect(decoded).toMatchObject({
      poolId: `0x${'5a'.repeat(32)}`,
      sqrtPriceX96: 4_037_439_934_550_029_540_551_938_052_403_458_056n,
      tickLower: -887_200,
      tickUpper: 433_700,
      liquidity: 382_644_092_080_642_186n,
      stockUsd8: 18_012_345_678n,
      name: 'StockPair',
      symbol: 'STOCK',
      contractURI: 'ipfs://bafkreistockprofile',
    });
  });

  it('has the topics the new factory emits', () => {
    expect(CREATOR_BOUGHT_TOPIC).toBe('0x43d15e9d32712a10d4ab74467519cf3a13edcf6de23f4894edbb0abf319b9f65');
    expect(METADATA_EDITABLE_TOPIC).toBe('0x1241a65d78d66378b38c08d6c0fc8deaa8e6f592ffc4bfc685d51af653f1bb6f');
    expect(CONTRACT_URI_CHANGED_TOPIC).toBe('0xb23802208f960154d35feb1ddb4ed3718dd9ea1c6af17d702f83bb34f3c6ab4b');
    expect(METADATA_LOCKED_TOPIC).toBe('0x1653aa4ca9f980f3b8b3aaa209e5f5d445c8688450cd1bc630a19b5211679aa8');
  });

  it('decodes CreatorBought', () => {
    const log = factoryLog('CreatorBought', { token: TOKEN, creator: CREATOR, poolId: POOL_ID }, [
      10_000_000_000n,
      100_000_000n,
      26_945_165_397_030_207_059_716_699n,
    ]);
    const decoded = decodeCreatorBought(log);
    expect(decoded?.token.toLowerCase()).toBe(TOKEN);
    expect(decoded?.creator.toLowerCase()).toBe(CREATOR);
    expect(decoded).toMatchObject({
      poolId: POOL_ID,
      stockIn: 10_000_000_000n,
      fee: 100_000_000n,
      tokensOut: 26_945_165_397_030_207_059_716_699n,
    });
  });

  it('decodes MetadataEditable, ContractURIChanged and MetadataLocked', () => {
    const editable = decodeMetadataEditable(factoryLog('MetadataEditable', { token: TOKEN, creator: CREATOR }, []));
    expect(editable?.token.toLowerCase()).toBe(TOKEN);
    expect(editable?.creator.toLowerCase()).toBe(CREATOR);

    const changed = decodeContractURIChanged(
      factoryLog('ContractURIChanged', { token: TOKEN, creator: CREATOR }, ['ipfs://bafkreinewprofile']),
    );
    expect(changed?.token.toLowerCase()).toBe(TOKEN);
    expect(changed?.creator.toLowerCase()).toBe(CREATOR);
    expect(changed?.contractURI).toBe('ipfs://bafkreinewprofile');

    const locked = decodeMetadataLocked(factoryLog('MetadataLocked', { token: TOKEN, creator: CREATOR }, []));
    expect(locked?.token.toLowerCase()).toBe(TOKEN);
    expect(locked?.creator.toLowerCase()).toBe(CREATOR);
  });

  it('gives null for any topic that is not the decoder own', () => {
    const decoders = [
      decodeLaunched,
      decodeCreatorBought,
      decodeMetadataEditable,
      decodeContractURIChanged,
      decodeMetadataLocked,
      decodeFeeCharged,
      decodeFeesClaimed,
    ];
    const unknown: RawLog = { ...OLD_FACTORY_LAUNCHED, topics: [`0x${'00'.repeat(31)}01` as Hex] };
    const editable = factoryLog('MetadataEditable', { token: TOKEN, creator: CREATOR }, []);
    for (const decode of decoders) expect(decode(unknown)).toBeNull();
    // The token's own ContractURIUpdated() is not the factory's ContractURIChanged.
    expect(decodeContractURIChanged({ ...editable, topics: [toEventSelector('ContractURIUpdated()')] })).toBeNull();
    expect(decodeMetadataLocked(editable)).toBeNull();
    expect(decodeLaunched(editable)).toBeNull();
    expect(decodeCreatorBought(OLD_FACTORY_LAUNCHED)).toBeNull();
  });
});
