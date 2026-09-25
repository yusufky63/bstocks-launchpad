import {
  BASE_CONTRACTS,
} from '@stockpair/core';
import {
  holderConcentration,
  listHolders,
  listPendingAlerts,
  markAlertsSent,
  readAlertMark,
  readMarket,
  setAlertMark,
  tokenLifetime,
  tokenPeakInStock,
  type AlertRow,
  type Db,
  type MarketRow,
} from '@stockpair/core/db';

import type { AlertsConfig } from './config';
import {
  isLaunchBuy,
  isNewHigh,
  judgeTrade,
  nextMilestone,
  toLaunch,
  toLinks,
  toMarket,
  type Market,
  type TradePayload,
} from './policy';
import {
  athPost,
  digestPost,
  launchPost,
  milestonePost,
  shortAddress,
  tradePost,
  trim,
  type Post,
  type Snapshot,
  type TokenFacts,
} from './render';
import type { Telegram } from './telegram';

/** How many outbox rows to consider in one pass. Everything unread stays for the next one. */
const BATCH = 200;

export type DispatchResult = {
  considered: number;
  posted: number;
  skipped: number;
  collapsed: boolean;
  deferred: number;
};

type Log = (message: string, fields?: Record<string, unknown>) => void;

export type DispatchDeps = {
  db: Db;
  telegram: Telegram;
  config: AlertsConfig;
  log?: Log;
  /** Injected so a test can resolve names without a network. */
  resolveName?: (address: string) => Promise<string>;
};

/** A post, the row that produced it, and anything to record once it is actually out. */
type Planned = { post: Post; alertId: string; symbol: string; onSent?: () => Promise<void> };

/**
 * What this pass has already decided to say, which the database does not know yet.
 *
 * Milestone marks are written after a post goes out, not before, so two trades on the same token
 * in one batch would both look at a mark of zero and both plan the same "passed $10K". This is the
 * memory between them.
 */
type Planning = { mcap: Map<string, number>; ath: Map<string, number> };

/**
 * Turns a wallet into whatever a person would recognise it as.
 *
 * The site already resolves and caches Basenames behind `/api/names`, including the forward check
 * that makes a reverse record safe to display. Reimplementing that here would mean a second cache
 * and a second chance to show a name somebody claimed but does not own.
 */
async function basename(appUrl: string, address: string): Promise<string> {
  try {
    const response = await fetch(`${appUrl}/api/names?a=${address}`, { signal: AbortSignal.timeout(5_000) });
    if (!response.ok) return shortAddress(address);
    const body = (await response.json()) as { names?: Record<string, string | null> };
    return body.names?.[address.toLowerCase()] ?? shortAddress(address);
  } catch {
    return shortAddress(address);
  }
}

const SUPPLY_RAW = 10n ** 27n;

/** What is actually held: the fixed supply less the pool's locked position and the launch dust. */
function circulatingOf(c: { pool_raw: string; burned_raw: string }): number {
  return Number(SUPPLY_RAW) - Number(c.pool_raw) - Number(c.burned_raw);
}

function facts(row: MarketRow, market: Market): TokenFacts {
  return {
    token: market.token,
    name: market.name,
    symbol: market.symbol,
    stockSymbol: market.stockSymbol,
    stockAddress: row.stock,
  };
}

/**
 * Everything a card shows, gathered in one place.
 *
 * Three extra queries per post, which is affordable because posts are rare by design — and the
 * alternative is a card that says a price and nothing else, which is the difference between a
 * channel people follow and one they scroll past.
 */
async function snapshot(
  row: MarketRow,
  market: Market,
  deps: DispatchDeps,
  name: (address: string) => Promise<string>,
): Promise<Snapshot> {
  const { db } = deps;
  const life = await tokenLifetime(db, market.token);
  const holders = await listHolders(db, market.token, 8);
  const concentration = await holderConcentration(db, market.token, BASE_CONTRACTS.poolManager);
  const peakInStock = await tokenPeakInStock(db, market.token);

  // The pool custodies the locked supply and the burn address holds the launch dust; neither is a
  // holder, and listing them as the top two would say nothing about distribution.
  const skip = new Set([BASE_CONTRACTS.poolManager.toLowerCase(), '0x000000000000000000000000000000000000dead']);
  const topHolders = holders
    .filter((h) => !skip.has(h.holder.toLowerCase()))
    .slice(0, 5)
    .map((h) => ({ address: h.holder, sharePercent: circulatingOf(concentration) > 0 ? (Number(h.balance_raw) / circulatingOf(concentration)) * 100 : 0 }));

  // Everything on this line is a share of what is actually held, not of the fixed billion. Most of
  // the supply sits in the pool, so against the billion every holder reads as a fraction of a
  // percent while the concentration figure beside them reads as 62% — two denominators, one line.
  const circulating = Number(SUPPLY_RAW) - Number(concentration.pool_raw) - Number(concentration.burned_raw);
  const topShare = circulating > 0 ? (Number(concentration.top10_raw) / circulating) * 100 : null;

  // Priced at today's stock quote, because the peak is the token's own: it says how high this
  // token ever went against NVDAc, not what NVDA was worth on the day it happened.
  const peakUsd = peakInStock !== null && market.stockUsd !== null ? peakInStock * market.stockUsd * 1_000_000_000 : null;
  // Equal to the current FDV it is not a fact, it is the same number twice.
  const ath = peakUsd !== null && market.fdvUsd !== null && peakUsd >= market.fdvUsd * 1.05 ? peakUsd : null;

  return {
    priceUsd: market.priceUsd,
    fdvUsd: market.fdvUsd,
    athUsd: ath,
    volume24hUsd: market.volume24hUsd,
    change24hPercent: market.change24hPercent,
    buys24h: Number(life.buys_24h),
    sells24h: Number(life.sells_24h),
    holders: market.holders,
    topHolders,
    topShare,
    launchedAt: new Date(row.launched_at).toISOString(),
    creator: row.creator,
    creatorName: await name(row.creator),
    ...toLinks(row),
    poolId: market.poolId,
  };
}

/**
 * Decides what one queued row is worth saying, if anything. At most one post.
 *
 * It used to return several — a trade card, and a milestone card, and a high card, all carrying the
 * same row id. When a later one failed the row went back to the queue whole, and the next pass
 * re-sent the card that had already reached the channel. Nothing recorded which of a row's posts
 * had gone out, and a per-row `sent_at` cannot record it.
 *
 * One post per row removes that class of bug rather than patching it, and it is better reading
 * anyway: a buy that carries a token past $25K is one event, not two notifications.
 */
async function consider(alert: AlertRow, deps: DispatchDeps, planning: Planning): Promise<Planned | null> {
  const { db, config } = deps;
  const name = deps.resolveName ?? ((address: string) => basename(config.appUrl, address));
  const row = await readMarket(db, alert.token);
  // A launch whose row has gone is a launch that was reorged away between queueing and now.
  if (!row) return null;
  const market = toMarket(row);

  if (alert.kind === 'launch') {
    const snap = await snapshot(row, market, deps, name);
    const launch = toLaunch(row, alert.payload);
    return { alertId: alert.id, symbol: market.symbol, post: launchPost(config.appUrl, facts(row, market), snap, launch) };
  }

  // Anything else, profile edits and locks included, is dealt with silently. A creator with an
  // editable profile could otherwise post to the channel as often as they can pay for gas.
  if (alert.kind !== 'trade') return null;
  const payload = alert.payload as TradePayload | null;
  if (!payload || (payload.side !== 'buy' && payload.side !== 'sell')) return null;
  if (isLaunchBuy(payload)) return null;

  const verdict = judgeTrade(payload, market, config);

  // Both marks are read before the expensive part, because whether a card is worth gathering
  // depends on them. Reading the mcap mark as zero here made the gate true for every token over
  // $10K, which is every token worth alerting about — so the gate never saved a query.
  const mcapMark = await readAlertMark(db, alert.token, 'mcap');
  const announced = Math.max(Number(mcapMark?.value ?? 0), planning.mcap.get(alert.token) ?? 0);
  const level = nextMilestone(market.fdvUsd, announced);

  // In stock terms, not dollars. The pair is the token against the stock, so a high measured in
  // USD announces "new high" on a day NVDA moved and the token did not.
  const athMark = await readAlertMark(db, alert.token, 'ath');
  const previousInStock = Math.max(Number(athMark?.value ?? 0), planning.ath.get(alert.token) ?? 0);
  const priceInStock = market.priceInStock;
  const newHigh = priceInStock !== null && previousInStock > 0 && isNewHigh(priceInStock, previousInStock);
  const raisesHigh = priceInStock !== null && priceInStock > previousInStock;

  if (!verdict.post && level === null && !newHigh) return null;

  if (level !== null) planning.mcap.set(alert.token, level);
  if (raisesHigh) planning.ath.set(alert.token, priceInStock);

  // Neither mark is written until the post is out. A level recorded before the send is skipped on
  // the retry, and a milestone announced to nobody cannot be caught up later.
  const onSent = async () => {
    if (level !== null) await setAlertMark(db, alert.token, 'mcap', String(level));
    if (raisesHigh) await setAlertMark(db, alert.token, 'ath', String(priceInStock));
  };

  const snap = await snapshot(row, market, deps, name);
  const extras = {
    milestone: level,
    newHighFrom: newHigh && priceInStock !== null ? previousInStock * (market.stockUsd ?? 0) * 1_000_000_000 : null,
  };

  if (verdict.post) {
    return {
      alertId: alert.id,
      symbol: market.symbol,
      onSent,
      post: tradePost(config.appUrl, facts(row, market), snap, {
        side: payload.side,
        valueUsd: verdict.valueUsd,
        stepUsd: verdict.stepUsd,
        amountStock: verdict.amountStock,
        amountToken: verdict.amountToken,
        trader: payload.trader,
        traderName: payload.trader ? await name(payload.trader) : 'unknown wallet',
        shareOfDay: verdict.shareOfDay,
        txHash: payload.txHash,
        ...extras,
      }),
    };
  }

  // A trade too small to announce can still carry a token past a level, and that is news even
  // though the trade is not.
  if (level !== null) {
    return {
      alertId: alert.id,
      symbol: market.symbol,
      onSent,
      post: milestonePost(config.appUrl, facts(row, market), snap, level),
    };
  }
  return {
    alertId: alert.id,
    symbol: market.symbol,
    onSent,
    post: athPost(config.appUrl, facts(row, market), snap, extras.newHighFrom ?? 0),
  };
}

/**
 * One pass: read what is queued, decide, send.
 *
 * Rows the channel has nothing to say about are marked sent immediately — "sent" here means "dealt
 * with", not "posted". A row is left pending only while Telegram might yet accept it, so a network
 * blip retries and a message Telegram will never accept does not wedge everything behind it.
 */
export async function dispatchOnce(deps: DispatchDeps): Promise<DispatchResult> {
  const { db, config, log = () => undefined } = deps;
  const pending = await listPendingAlerts(db, BATCH);
  if (pending.length === 0) return { considered: 0, posted: 0, skipped: 0, collapsed: false, deferred: 0 };

  const queued: Planned[] = [];
  const silent: string[] = [];
  let stuck = 0;
  const planning: Planning = { mcap: new Map(), ath: new Map() };
  for (const alert of pending) {
    try {
      const planned = await consider(alert, deps, planning);
      if (planned) queued.push(planned);
      else silent.push(alert.id);
    } catch (error) {
      // Left pending rather than marked sent. Deciding reads the database, and a read that failed
      // once will usually succeed on the next pass; marking it dealt with would throw the alert
      // away for a reason that had nothing to do with it. The loop continues, so a row that fails
      // every time is noisy in the log rather than a blockage.
      stuck += 1;
      log('alert deferred', { id: alert.id, error: error instanceof Error ? error.message : String(error) });
    }
  }
  await markAlertsSent(db, silent);

  // A restart after a long stop hands over an hour of history at once, because the indexer skips
  // its poll sleep while catching up. Replaying that one message at a time is how a channel gets
  // muted; one post says the same thing.
  if (queued.length > config.backlogLimit) {
    const launches = queued.filter((item) => item.post.preview !== null && item.post.preview !== undefined).length;
    const summary = digestPost(config.appUrl, {
      launches,
      trades: queued.length - launches,
      tokens: [...new Set(queued.map((item) => item.symbol))],
    });
    const sent = await send(summary, deps);
    // Tri-state, not truthiness. A digest Telegram will never accept used to mark nothing, so the
    // same batch was rebuilt and refused on every pass for ever; only a retriable failure should
    // leave the rows pending.
    if (sent !== null) {
      await markAlertsSent(db, pending.map((a) => a.id));
      if (sent) for (const item of queued) await item.onSent?.();
    }
    return {
      considered: pending.length,
      posted: sent ? 1 : 0,
      skipped: silent.length,
      collapsed: true,
      deferred: sent === null ? queued.length : stuck,
    };
  }

  let posted = 0;
  let done = 0;
  for (const item of queued) {
    const sent = await send(item.post, deps);
    // Retriable: stop the pass. Everything after this is still pending and the order in the
    // channel is the order it happened, which a partial pass would break.
    if (sent === null) break;
    if (sent) {
      posted += 1;
      await item.onSent?.();
    }
    // One row at a time, immediately. Batching this to the end of the pass meant a crash or a
    // SIGTERM after the eighth of ten posts re-sent all eight on the next start.
    await markAlertsSent(db, [item.alertId]);
    done += 1;
  }
  return {
    considered: pending.length,
    posted,
    skipped: silent.length,
    collapsed: false,
    deferred: queued.length - done + stuck,
  };
}

/** true sent, false permanently rejected, null worth trying again. */
async function send(post: Post, deps: DispatchDeps): Promise<boolean | null> {
  const { telegram, config, log = () => undefined } = deps;
  if (config.dryRun) {
    log('would post', { text: post.text });
    return true;
  }
  // Every post leaves through here, so this is the one place the length has to hold.
  const safe = trim(post);
  const result = await telegram.sendMessage(config.channelId, safe.text, {
    buttons: safe.buttons,
    preview: safe.preview,
  });
  if (result.ok) return true;
  log('post failed', { reason: result.reason, retriable: result.retriable });
  return result.retriable ? null : false;
}
