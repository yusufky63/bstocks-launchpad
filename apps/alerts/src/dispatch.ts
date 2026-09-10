import {
  listPendingAlerts,
  markAlertsSent,
  readAlertMark,
  readMarket,
  setAlertMark,
  type AlertRow,
  type Db,
} from '@stockpair/core/db';

import type { AlertsConfig } from './config';
import { judgeTrade, nextMilestone, isNewHigh, toMarket, type Market, type TradePayload } from './policy';
import {
  athPost,
  digestPost,
  launchPost,
  milestonePost,
  shortAddress,
  tradePost,
  type Post,
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
type Planning = { mcap: Map<string, number> };

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

function facts(market: Market): TokenFacts {
  return { token: market.token, name: market.name, symbol: market.symbol, stockSymbol: market.stockSymbol };
}

/**
 * Decides what one queued row is worth saying, if anything.
 *
 * A trade can produce two posts: a buy that crosses a market cap level is both a large trade and a
 * milestone, and the milestone is the part people forward.
 */
async function consider(alert: AlertRow, deps: DispatchDeps, planning: Planning): Promise<Planned[]> {
  const { db, config } = deps;
  const name = deps.resolveName ?? ((address: string) => basename(config.appUrl, address));
  const row = await readMarket(db, alert.token);
  // A launch whose row has gone is a launch that was reorged away between queueing and now.
  if (!row) return [];
  const market = toMarket(row);
  const planned: Planned[] = [];

  if (alert.kind === 'launch') {
    const creator = await name(row.creator);
    return [
      {
        alertId: alert.id,
        symbol: market.symbol,
        post: launchPost(config.appUrl, facts(market), { creator, fdvUsd: market.fdvUsd, poolId: market.poolId }),
      },
    ];
  }

  if (alert.kind !== 'trade') return [];
  const payload = alert.payload as TradePayload | null;
  if (!payload || (payload.side !== 'buy' && payload.side !== 'sell')) return [];

  const verdict = judgeTrade(payload, market, config);
  if (verdict.post) {
    const trader = payload.trader ? await name(payload.trader) : 'unknown wallet';
    planned.push({
      alertId: alert.id,
      symbol: market.symbol,
      post: tradePost(config.appUrl, facts(market), {
        side: payload.side,
        valueUsd: verdict.valueUsd,
        stepUsd: verdict.stepUsd,
        amountStock: verdict.amountStock,
        amountToken: verdict.amountToken,
        trader,
        shareOfDay: verdict.shareOfDay,
        fdvUsd: market.fdvUsd,
        change24h: market.change24hPercent,
        poolId: market.poolId,
      }),
    });
  }

  // Milestones ride on trades because a market cap only moves when somebody trades. Checking here
  // rather than on a timer means no separate sweep over every token that ever launched.
  //
  // The mark is written in onSent, not now: a level recorded before the post goes out would be
  // skipped on the retry, and a milestone announced to nobody is the one kind of alert that cannot
  // be caught up later.
  const mcapMark = await readAlertMark(db, alert.token, 'mcap');
  const announced = Math.max(Number(mcapMark?.value ?? 0), planning.mcap.get(alert.token) ?? 0);
  const level = nextMilestone(market.fdvUsd, announced);
  if (level !== null) {
    planning.mcap.set(alert.token, level);
    planned.push({
      alertId: alert.id,
      symbol: market.symbol,
      post: milestonePost(config.appUrl, facts(market), {
        level,
        holders: market.holders,
        trades: market.trades,
        poolId: market.poolId,
      }),
      onSent: () => setAlertMark(db, alert.token, 'mcap', String(level)),
    });
  }

  // The high-water mark moves whether or not it is announced — it is a record of the price, not of
  // a message. Only a gain worth reading about becomes a post.
  const athMark = await readAlertMark(db, alert.token, 'ath');
  const previous = Number(athMark?.value ?? 0);
  if (market.priceUsd !== null && market.priceUsd > previous) {
    await setAlertMark(db, alert.token, 'ath', String(market.priceUsd));
    if (previous > 0 && isNewHigh(market.priceUsd, previous)) {
      planned.push({
        alertId: alert.id,
        symbol: market.symbol,
        post: athPost(config.appUrl, facts(market), { priceUsd: market.priceUsd, previousUsd: previous, poolId: market.poolId }),
      });
    }
  }

  return planned;
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
  const planning: Planning = { mcap: new Map() };
  for (const alert of pending) {
    let planned: Planned[] = [];
    try {
      planned = await consider(alert, deps, planning);
    } catch (error) {
      log('alert skipped', { id: alert.id, error: error instanceof Error ? error.message : String(error) });
    }
    if (planned.length === 0) silent.push(alert.id);
    else queued.push(...planned);
  }
  await markAlertsSent(db, silent);

  // A restart after a long stop hands over an hour of history at once, because the indexer skips
  // its poll sleep while catching up. Replaying that one message at a time is how a channel gets
  // muted; one post says the same thing.
  if (queued.length > config.backlogLimit) {
    const launches = pending.filter((a) => a.kind === 'launch').length;
    const summary = digestPost(config.appUrl, {
      launches,
      trades: queued.length - launches,
      // Which tokens, not just how many things happened: a count alone tells a reader nothing
      // about whether it is worth scrolling back.
      tokens: [...new Set(queued.map((item) => item.symbol))],
    });
    const sent = await send(summary, deps);
    if (sent) {
      await markAlertsSent(db, pending.map((a) => a.id));
      for (const item of queued) await item.onSent?.();
    }
    return {
      considered: pending.length,
      posted: sent ? 1 : 0,
      skipped: silent.length,
      collapsed: true,
      deferred: sent ? 0 : queued.length,
    };
  }

  let posted = 0;
  const done = new Set<string>();
  const failed = new Set<string>();
  for (const item of queued) {
    // Everything else this row wanted to say is already deferred; do not post half of it.
    if (failed.has(item.alertId)) continue;
    const sent = await send(item.post, deps);
    if (sent === null) {
      failed.add(item.alertId);
      continue;
    }
    if (sent) {
      posted += 1;
      await item.onSent?.();
    }
    done.add(item.alertId);
  }
  // A row that failed anywhere stays pending in full, so its unsent posts get another chance.
  for (const id of failed) done.delete(id);
  await markAlertsSent(db, [...done]);
  return {
    considered: pending.length,
    posted,
    skipped: silent.length,
    collapsed: false,
    deferred: failed.size,
  };
}

/** true sent, false permanently rejected, null worth trying again. */
async function send(post: Post, deps: DispatchDeps): Promise<boolean | null> {
  const { telegram, config, log = () => undefined } = deps;
  if (config.dryRun) {
    log('would post', { text: post.text });
    return true;
  }
  const result = await telegram.sendMessage(config.channelId, post.text, {
    buttons: post.buttons,
    preview: post.preview,
  });
  if (result.ok) return true;
  log('post failed', { reason: result.reason, retriable: result.retriable });
  return result.retriable ? null : false;
}
