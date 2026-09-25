import { beforeEach, describe, expect, it } from 'vitest';

import {
  createEmbeddedDb,
  enqueueAlerts,
  insertLaunch,
  insertSwap,
  listPendingAlerts,
  migrate,
  readAlertMark,
  updateLaunchMetadata,
  upsertBlock,
  upsertStockQuote,
  upsertTokenProfile,
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
  minTradeFloorUsd: 100,
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
    // 1e-8 NVDAc a token, so $0.00000225 at $224.69: well under the last trade below.
    openingSqrtPriceX96: (1n << 96n) / 1_000_000_000n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
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

function tradeAlert(stockRaw: string, over: Record<string, unknown> = {}) {
  return {
    kind: 'trade' as const,
    token: TOKEN,
    blockNumber: BLOCK,
    payload: {
      side: 'buy', amountTokenRaw: (10n ** 24n).toString(), amountStockRaw: stockRaw,
      priceTokenInStock: '0.000000049', trader: TRADER, txHash: '0xs1', logIndex: 0,
      blockTime: '2026-09-11T00:00:00Z', stockDecimals: 8, stockUsd8: '22469000000',
      ...over,
    },
  };
}

/** A launch as the indexer queues it now: its own opening price, the creator's buy, the profile choice. */
function launchAlert(over: Record<string, unknown> = {}) {
  return {
    kind: 'launch' as const,
    token: TOKEN,
    blockNumber: BLOCK,
    payload: {
      name: 'StockPair', symbol: 'STOCK', creator: CREATOR, stock: NVDAc, stockUsd8: '22469000000',
      txHash: '0xt1', launchedAt: '2026-09-05T12:00:00.000Z',
      openingPriceUsd: 0.0000052,
      creatorBuy: { stockInRaw: '211000000', feeRaw: '2110000', tokensOutRaw: (434n * 10n ** 23n).toString(), supplyBps: 434 },
      metadataEditable: true,
      ...over,
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
    // What a launch card carries, which is not what a trade card carries.
    expect(telegram.sent[0]?.text).toContain('Opens at');
    expect(telegram.sent[0]?.text).toContain('>NVDAc</a>');
    expect(telegram.sent[0]?.text).not.toContain('holders');
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // The market row is read at send time, and its last price is the one after the creator's buy.
  it("announces the launch's own opening price, buy and profile choice from what was queued", async () => {
    await enqueueAlerts(db, [launchAlert()]);

    expect((await dispatchOnce(deps())).posted).toBe(1);
    const text = telegram.sent[0]?.text ?? '';
    expect(text).toContain('Opens at $0.00000520 · 💎 FDV $5.2K');
    expect(text).not.toContain('$0.00001101');
    expect(text).toContain('Creator bought 4.34% of supply at launch (2.11 NVDAc ≈ $474.10)');
    expect(text).toContain('✏️ Profile editable by the creator');
  });

  // A row the indexer queued before it sent any of that is still in the outbox after a deploy.
  it('still renders a launch queued before the indexer sent its opening price', async () => {
    await enqueueAlerts(db, [{
      kind: 'launch', token: TOKEN, blockNumber: BLOCK,
      payload: { name: 'StockPair', symbol: 'STOCK', creator: CREATOR, stock: NVDAc, stockUsd8: '22469000000', txHash: '0xt1' },
    }]);

    expect((await dispatchOnce(deps())).posted).toBe(1);
    const text = telegram.sent[0]?.text ?? '';
    // Worked out from the launch row, not taken from the last trade.
    expect(text).toContain('Opens at $0.00000225 · 💎 FDV $2.2K');
    expect(text).not.toContain('$0.00001101');
    expect(text).not.toContain('Creator bought');
    expect(text).not.toContain('editable');
  });

  // Set at launch through the create form, or in an editable token's onchain profile; both land on
  // the launch row. Web and X already fell back to it and Telegram did not.
  it("links the launch's own Telegram on every card when there is no signed profile", async () => {
    await updateLaunchMetadata(
      db, TOKEN,
      { description: null, imageUri: null, website: 'https://stockpair.test', twitter: null, telegram: 'https://t.me/stockpair' },
      'ipfs://x',
    );
    await enqueueAlerts(db, [launchAlert(), tradeAlert('500000000')]);

    expect((await dispatchOnce(deps())).posted).toBe(2);
    expect(telegram.sent).toHaveLength(2);
    for (const { text } of telegram.sent) {
      expect(text).toContain('<a href="https://t.me/stockpair">TG</a>');
      expect(text).toContain('<a href="https://stockpair.test">Web</a>');
    }
  });

  it("prefers a signed profile's Telegram on a token whose profile is fixed onchain", async () => {
    await updateLaunchMetadata(
      db, TOKEN,
      { description: null, imageUri: null, website: null, twitter: null, telegram: 'https://t.me/stockpair' },
      'ipfs://x',
    );
    await upsertTokenProfile(db, {
      token: TOKEN, description: null, imageUri: null, website: null, twitter: null, telegram: 'https://t.me/signed',
      signer: CREATOR, signature: '0xsig', issuedAt: new Date('2026-09-10T00:00:00Z'),
    });
    await enqueueAlerts(db, [tradeAlert('500000000')]);

    await dispatchOnce(deps());
    expect(telegram.sent[0]?.text).toContain('<a href="https://t.me/signed">TG</a>');
    expect(telegram.sent[0]?.text).not.toContain('t.me/stockpair');
  });

  // Changed onchain only, which the indexer writes to the launch row; the token page ignores a
  // signed profile for it, and so does the channel.
  it('links only the onchain profile of a token whose profile is editable', async () => {
    await db.query('UPDATE launches SET metadata_editable = true WHERE token = $1', [TOKEN]);
    await updateLaunchMetadata(
      db, TOKEN,
      { description: null, imageUri: null, website: 'https://onchain.test', twitter: null, telegram: 'https://t.me/onchain' },
      'ipfs://x',
    );
    await upsertTokenProfile(db, {
      token: TOKEN, description: null, imageUri: null, website: 'https://signed.test', twitter: 'https://x.com/signed',
      telegram: 'https://t.me/signed', signer: CREATOR, signature: '0xsig', issuedAt: new Date('2026-09-10T00:00:00Z'),
    });
    await enqueueAlerts(db, [launchAlert()]);

    await dispatchOnce(deps());
    const text = telegram.sent[0]?.text ?? '';
    expect(text).toContain('<a href="https://t.me/onchain">TG</a>');
    expect(text).toContain('<a href="https://onchain.test">Web</a>');
    for (const signed of ['t.me/signed', 'signed.test', 'x.com/signed']) expect(text).not.toContain(signed);
  });

  // Only the indexer migrates, and a card read on a database it has not reached yet fails; the
  // rows have to still be there once it has.
  it('keeps every row queued on a database the indexer has not migrated yet', async () => {
    await enqueueAlerts(db, [launchAlert(), tradeAlert('500000000')]);
    await db.exec('DROP TABLE metadata_updates CASCADE');

    expect(await dispatchOnce(deps())).toMatchObject({ considered: 2, posted: 0, deferred: 2 });
    expect(telegram.sent).toHaveLength(0);
    expect(await listPendingAlerts(db)).toHaveLength(2);
  });

  // It is already a line on the launch card; a trade post as well says the same thing twice.
  it("does not post the creator's buy in the launch transaction as a trade", async () => {
    await enqueueAlerts(db, [launchAlert(), tradeAlert('500000000', { launchBuy: true }), tradeAlert('500000000', { launchBuy: false })]);

    const result = await dispatchOnce(deps());
    expect(result).toMatchObject({ considered: 3, posted: 2, skipped: 1, deferred: 0 });
    expect(telegram.sent.filter((s) => s.text.includes('BUY'))).toHaveLength(1);
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // Skipped whole, milestone included: the next real trade is the one that announces the level.
  it('leaves the milestone for a later trade when the launch buy is all there is', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000', { launchBuy: true })]);

    expect(await dispatchOnce(deps())).toMatchObject({ considered: 1, posted: 0, skipped: 1 });
    expect(telegram.sent).toHaveLength(0);
    expect(await readAlertMark(db, TOKEN, 'mcap')).toBeNull();
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // A creator with an editable profile could otherwise post to the channel at will.
  it('stays silent about a kind of row it does not announce', async () => {
    await enqueueAlerts(db, [{ kind: 'profile' as never, token: TOKEN, blockNumber: BLOCK, payload: { contractUri: 'ipfs://y' } }]);

    expect(await dispatchOnce(deps())).toMatchObject({ considered: 1, posted: 0, skipped: 1 });
    expect(telegram.sent).toHaveLength(0);
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

    // One post per row, so the retry sends exactly one thing and the channel never sees the same
    // trade twice.
    const second = await dispatchOnce(deps());
    expect(second.posted).toBe(1);
    expect(telegram.sent).toHaveLength(1);
    expect(await listPendingAlerts(db)).toHaveLength(0);
  });

  // A message Telegram will never accept must not sit at the head of the queue forever.
  it('drops a row Telegram permanently refuses rather than wedging behind it', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000'), tradeAlert('600000000')]);
    telegram.outcomes = [{ ok: false, retriable: false, reason: 'Bad Request' }];

    const result = await dispatchOnce(deps());
    expect(result.deferred).toBe(0);
    // The refused post is gone; the one behind it still went out.
    expect(telegram.sent.filter((s) => s.text.includes('BUY'))).toHaveLength(1);
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
    // The level is said on the trade card rather than in a post of its own.
    expect(telegram.sent.some((s) => s.text.includes('Carried it past'))).toBe(true);
  });

  it('says nothing twice about the same level', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000')]);
    await dispatchOnce(deps());
    const first = telegram.sent.filter((s) => s.text.includes('Carried it past')).length;

    await enqueueAlerts(db, [tradeAlert('500000000')]);
    await dispatchOnce(deps());
    expect(telegram.sent.filter((s) => s.text.includes('Carried it past'))).toHaveLength(first);
  });

  // A digest Telegram will never accept used to mark nothing, so the same batch was rebuilt and
  // refused on every pass for ever.
  it('does not wedge the queue on a digest Telegram permanently refuses', async () => {
    await enqueueAlerts(db, Array.from({ length: 40 }, () => tradeAlert('500000000')));
    telegram.outcomes = [{ ok: false, retriable: false, reason: 'Bad Request' }];

    const result = await dispatchOnce(deps());
    expect(result.collapsed).toBe(true);
    expect(result.posted).toBe(0);
    expect(await listPendingAlerts(db, 100)).toHaveLength(0);
  });

  it('keeps a digest queued when Telegram might still take it', async () => {
    await enqueueAlerts(db, Array.from({ length: 40 }, () => tradeAlert('500000000')));
    telegram.outcomes = [{ ok: false, retriable: true, reason: 'network' }];

    await dispatchOnce(deps());
    expect(await listPendingAlerts(db, 100)).toHaveLength(40);
  });

  // Deciding reads the database. A read that failed once will usually succeed next pass, and
  // marking the row dealt with would throw the alert away for a reason that had nothing to do
  // with it.
  it('leaves a row queued when deciding it throws', async () => {
    await enqueueAlerts(db, [tradeAlert('500000000')]);
    const broken = {
      ...deps(),
      resolveName: async () => {
        throw new Error('the name service is down');
      },
    };

    const result = await dispatchOnce(broken);
    expect(result.deferred).toBe(1);
    expect(telegram.sent).toHaveLength(0);
    expect(await listPendingAlerts(db)).toHaveLength(1);

    // And it recovers on its own once the read works again.
    expect((await dispatchOnce(deps())).posted).toBe(1);
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
