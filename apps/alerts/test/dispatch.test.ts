import { beforeEach, describe, expect, it } from 'vitest';

import {
  createEmbeddedDb,
  enqueueAlerts,
  insertLaunch,
  insertSwap,
  listPendingAlerts,
  migrate,
  readAlertMark,
  upsertBlock,
  upsertStockQuote,
  type Db,
} from '@stockpair/core/db';
import { BASE_STOCKS } from '@stockpair/core';

import type { AlertsConfig } from '../src/config';
import { dispatchOnce } from '../src/dispatch';
import type { SendResult, Telegram } from '../src/telegram';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
const CREATOR = '0x1111111111111111111111111111111111111111';
const TRADER = '0x2222222222222222222222222222222222222222';
const BLOCK = 50_900_010n;

/** Records what would have gone out, and can be told to fail. */
class FakeTelegram {
  sent: { text: string; buttons: unknown }[] = [];
  outcomes: SendResult[] = [];

  async sendMessage(_chat: string, text: string, options: { buttons?: unknown } = {}): Promise<SendResult> {
    const outcome = this.outcomes.shift();
    if (outcome && !outcome.ok) return outcome;
    this.sent.push({ text, buttons: options.buttons });
    return { ok: true, messageId: this.sent.length };
  }
}

const CONFIG: AlertsConfig = Object.freeze({
  databaseUrl: 'memory',
  botToken: 'x'.repeat(20),
  channelId: '-1001234567890',
  appUrl: 'https://launchpad.basestocks.finance',
  pollMs: 5_000,
  minTradeUsd: 500,
  minTradeShare: 0.15,
  backlogLimit: 8,
  healthPort: 8789,
  dryRun: false,
});

let db: Db;
let telegram: FakeTelegram;

function deps(over: Partial<AlertsConfig> = {}) {
  return {
    db,
    telegram: telegram as unknown as Telegram,
    config: { ...CONFIG, ...over },
    // No network in a test, and no wall-clock wait on a name lookup that cannot answer.
    resolveName: async (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`,
  };
}

async function seed(): Promise<void> {
  await upsertBlock(db, { number: BLOCK, hash: '0xb1', parentHash: '0xb0', timestamp: new Date('2026-09-05T12:00:00Z') });
  await insertLaunch(db, {
    token: TOKEN, stock: NVDAc, creator: CREATOR, poolId: `0x${'ab'.repeat(32)}`,
    tokenIsCurrency0: true, name: 'StockPair', symbol: 'STOCK', contractUri: 'ipfs://x',
    openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
    stockUsd8: 22_469_000_000n, blockNumber: BLOCK, blockHash: '0xb1', txHash: '0xt1',
    logIndex: 0, launchedAt: new Date('2026-09-05T12:00:00Z'),
  });
  await upsertStockQuote(db, {
    stock: NVDAc, priceUsd8: 22_469_000_000n,
    feedUpdatedAt: new Date('2026-09-11T00:00:00Z'), observedAt: new Date('2026-09-11T00:00:00Z'), observedBlock: BLOCK,
  });
  // One trade on the books, so the token has a price and a day's volume to compare against.
  await insertSwap(db, {
    txHash: '0xs1', logIndex: 0, token: TOKEN, poolId: `0x${'ab'.repeat(32)}`, side: 'buy',
    sender: TRADER, trader: TRADER, amountTokenRaw: 10n ** 24n, amountStockRaw: 100_000_000n,
    priceTokenInStock: '0.000000049', sqrtPriceX96: 1n, liquidity: 10n ** 20n, tick: 0,
    feeStockRaw: 1_000_000n, blockNumber: BLOCK, blockHash: '0xb1', blockTime: new Date(),
  });
}

function tradeAlert(stockRaw: string) {
  return {
    kind: 'trade' as const,
    token: TOKEN,
    blockNumber: BLOCK,
    payload: {
      side: 'buy', amountTokenRaw: (10n ** 24n).toString(), amountStockRaw: stockRaw,
      priceTokenInStock: '0.000000049', trader: TRADER, txHash: '0xs1', logIndex: 0,
      blockTime: '2026-09-11T00:00:00Z', stockDecimals: 8, stockUsd8: '22469000000',
    },
  };
}

describe('a dispatch pass', () => {
  beforeEach(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    telegram = new FakeTelegram();
    await seed();
  });

  it('posts a launch and clears the queue', async () => {
    await enqueueAlerts(db, [{ kind: 'launch', token: TOKEN, blockNumber: BLOCK, payload: {} }]);

    const result = await dispatchOnce(deps());
    expect(result).toMatchObject({ considered: 1, posted: 1, collapsed: false, deferred: 0 });
    expect(telegram.sent[0]?.text).toContain('🆕');
    expect(telegram.sent[0]?.text).toContain('StockPair');
    // The card the post carries, not just the headline.
    expect(telegram.sent[0]?.text).toContain('holders');
    expect(telegram.sent[0]?.text).toContain('>NVDAc</a>');
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  it('posts a large trade and stays silent about a small one', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000'), tradeAlert('100000')]);

    const result = await dispatchOnce(deps());
    expect(result.considered).toBe(2);
    expect(telegram.sent.filter((s) => s.text.includes('BUY'))).toHaveLength(1);
    // Both rows are dealt with: "sent" means considered, not necessarily posted.
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // The indexer skips its poll sleep while catching up, so a restart after a long stop can hand
  // over an hour of history at once.
  it('collapses a backlog into one post instead of replaying it', async () => {
    await enqueueAlerts(db, Array.from({ length: 40 }, () => tradeAlert('500000000')));

    const result = await dispatchOnce(deps());
    expect(result.collapsed).toBe(true);
    expect(telegram.sent).toHaveLength(1);
    expect(telegram.sent[0]?.text).toContain('While the channel was quiet');
    // Which tokens, not just how many things happened.
    expect(telegram.sent[0]?.text).toContain('$STOCK');
    expect(await listPendingAlerts(db, 100)).toHaveLength(0);
  });

  it('leaves a row queued when Telegram might yet take it', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000')]);
    telegram.outcomes = [{ ok: false, retriable: true, reason: 'network' }];

    const first = await dispatchOnce(deps());
    expect(first).toMatchObject({ posted: 0, deferred: 1 });
    expect(await listPendingAlerts(db)).toHaveLength(1);

    // The retry sends everything that row wanted to say: the trade, and the market cap level it
    // crossed on the way.
    const second = await dispatchOnce(deps());
    expect(second.posted).toBe(2);
    expect(telegram.sent.map((s) => s.text.includes('passed'))).toEqual([false, true]);
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // A message Telegram will never accept must not sit at the head of the queue forever.
  it('drops a row Telegram permanently refuses rather than wedging behind it', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000'), tradeAlert('600000000')]);
    telegram.outcomes = [{ ok: false, retriable: false, reason: 'Bad Request' }];

    const result = await dispatchOnce(deps());
    expect(result.deferred).toBe(0);
    // The refused post is gone; everything behind it still went out, and the level is announced
    // exactly once even though two trades in this batch both crossed it.
    expect(telegram.sent.filter((s) => s.text.includes('BUY'))).toHaveLength(1);
    expect(telegram.sent.filter((s) => s.text.includes('passed'))).toHaveLength(1);
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  it('records a milestone only once it has actually been announced', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000')]);
    telegram.outcomes = [{ ok: false, retriable: true, reason: 'network' }];

    await dispatchOnce(deps());
    // The post never went out, so nothing may be marked as announced — otherwise the retry would
    // skip it and the milestone would be lost for good.
    expect(await readAlertMark(db, TOKEN, 'mcap')).toBeNull();

    await dispatchOnce(deps());
    expect(await readAlertMark(db, TOKEN, 'mcap')).not.toBeNull();
    expect(telegram.sent.some((s) => s.text.includes('passed'))).toBe(true);
  });

  it('says nothing twice about the same level', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000')]);
    await dispatchOnce(deps());
    const first = telegram.sent.filter((s) => s.text.includes('passed')).length;

    await enqueueAlerts(db, [tradeAlert('500000000')]);
    await dispatchOnce(deps());
    expect(telegram.sent.filter((s) => s.text.includes('passed'))).toHaveLength(first);
  });

  it('has nothing to do on an empty queue', async () => {
    expect(await dispatchOnce(deps())).toMatchObject({ considered: 0, posted: 0 });
    expect(telegram.sent).toHaveLength(0);
  });

  it('renders without sending when it is told to run dry', async () => {
    await enqueueAlerts(db, [{ kind: 'launch', token: TOKEN, blockNumber: BLOCK, payload: {} }]);
    const result = await dispatchOnce(deps({ dryRun: true }));
    expect(result.posted).toBe(1);
    expect(telegram.sent).toHaveLength(0);
  });

  // A row queued for a launch that the chain then reorged away has nothing behind it.
  it('drops an announcement whose token is gone', async () => {
    await enqueueAlerts(db, [{ kind: 'launch', token: '0xb200000000000000000000000000000000000bbb', blockNumber: BLOCK, payload: {} }]);
    const result = await dispatchOnce(deps());
    expect(result).toMatchObject({ posted: 0, skipped: 1 });
    expect(telegram.sent).toHaveLength(0);
  });
});
