import 'server-only';

import { findStock } from '@stockpair/core';
import { creatorOverview, listActivity, listStocks, platformStats, type Db } from '@stockpair/core/db';

import { cached, TTL } from './cache.server';
import { ipfsToHttp } from './env';
import type { ActivityResponse, CreatorOverview, StatsResponse, StockFigure } from './types';

type Quotes = Map<string, { usd: number | null; decimals: number; symbol: string; ticker: string }>;

async function stockQuotes(db: Db): Promise<Quotes> {
  return cached('quotes', TTL.stocks, async () => {
    const rows = await listStocks(db);
    return new Map(rows.map((s) => [s.address, { usd: s.price_usd8 ? Number(s.price_usd8) / 1e8 : null, decimals: Number(s.decimals), symbol: s.symbol, ticker: s.ticker }]));
  });
}

function figure(quotes: Quotes, stock: string, raw: string): StockFigure {
  const q = quotes.get(stock);
  const decimals = q?.decimals ?? findStock(stock)?.decimals ?? 8;
  const amount = Number(raw) / 10 ** decimals;
  return { stock, symbol: q?.symbol ?? findStock(stock)?.symbol ?? stock.slice(0, 8), ticker: q?.ticker ?? findStock(stock)?.ticker ?? '?', amount, usd: q?.usd == null ? null : amount * q.usd };
}

/** Sums USD figures, staying null only when nothing could be priced. */
function sumUsd(items: { usd: number | null }[]): number | null {
  const priced = items.filter((i) => i.usd !== null);
  return priced.length === 0 && items.length > 0 ? null : priced.reduce((s, i) => s + (i.usd ?? 0), 0);
}

export async function readStats(db: Db): Promise<StatsResponse> {
  return cached('stats', TTL.stats, async () => {
    const [raw, quotes] = await Promise.all([platformStats(db), stockQuotes(db)]);
    const volumeByStock = raw.volume_by_stock.map((v) => {
      const all = figure(quotes, v.stock, v.amount_raw);
      const day = figure(quotes, v.stock, v.day_raw);
      return { ...all, dayAmount: day.amount, dayUsd: day.usd };
    });
    const feesByStock = raw.fees_by_stock.map((f) => {
      const total = figure(quotes, f.stock, f.amount_raw);
      return { ...total, creatorAmount: figure(quotes, f.stock, f.creator_raw).amount, platformAmount: figure(quotes, f.stock, f.platform_raw).amount };
    });
    const creatorFees = raw.fees_by_stock.map((f) => figure(quotes, f.stock, f.creator_raw));
    const platformFees = raw.fees_by_stock.map((f) => figure(quotes, f.stock, f.platform_raw));
    return {
      launches: raw.launches,
      launches24h: raw.launches_24h,
      creators: raw.creators,
      traders: raw.traders,
      swaps: raw.swaps,
      swaps24h: raw.swaps_24h,
      holders: raw.holders,
      firstLaunchAt: raw.first_launch_at ? new Date(raw.first_launch_at).toISOString() : null,
      volumeUsd: sumUsd(volumeByStock),
      volume24hUsd: sumUsd(volumeByStock.map((v) => ({ usd: v.dayUsd }))),
      feesUsd: sumUsd(feesByStock),
      creatorFeesUsd: sumUsd(creatorFees),
      platformFeesUsd: sumUsd(platformFees),
      volumeByStock,
      feesByStock,
      launchesByStock: raw.launches_by_stock,
      asOf: new Date().toISOString(),
    };
  });
}

export async function readActivity(db: Db, options: { limit?: number; token?: string; actor?: string } = {}): Promise<ActivityResponse> {
  const key = `activity:${options.token ?? ''}:${options.actor ?? ''}:${options.limit ?? 50}`;
  return cached(key, TTL.list, async () => {
    const [rows, quotes] = await Promise.all([listActivity(db, options), stockQuotes(db)]);
    return {
      items: rows.map((r) => {
        const q = quotes.get(r.stock);
        const decimals = Number(r.stock_decimals);
        const amountStock = r.amount_stock_raw === null ? null : Number(r.amount_stock_raw) / 10 ** decimals;
        return {
          kind: r.kind,
          at: new Date(r.at).toISOString(),
          txHash: r.tx_hash,
          token: r.token,
          name: r.name,
          symbol: r.symbol,
          imageUrl: ipfsToHttp(r.image_uri),
          stock: { address: r.stock, symbol: r.stock_symbol },
          actor: r.actor,
          side: r.side,
          amountToken: r.amount_token_raw === null ? null : Number(r.amount_token_raw) / 1e18,
          amountStock,
          amountUsd: amountStock === null || q?.usd == null ? null : amountStock * q.usd,
          isCreator: r.is_creator,
        };
      }),
      asOf: new Date().toISOString(),
    };
  });
}

export async function readCreatorOverview(db: Db, creator: string): Promise<CreatorOverview> {
  return cached(`creator:${creator}`, TTL.list, async () => {
    const [raw, quotes] = await Promise.all([creatorOverview(db, creator), stockQuotes(db)]);
    const volumeByStock = raw.volume_by_stock.map((v) => figure(quotes, v.stock, v.amount_raw));
    const feesByStock = raw.fees_by_stock.map((f) => figure(quotes, f.stock, f.amount_raw));
    return {
      tokens: raw.tokens,
      trades: raw.trades,
      uniqueTraders: raw.unique_traders,
      holders: raw.holders,
      firstLaunchAt: raw.first_launch_at ? new Date(raw.first_launch_at).toISOString() : null,
      volumeUsd: sumUsd(volumeByStock),
      feesEarnedUsd: sumUsd(feesByStock),
      volumeByStock,
      feesByStock,
    };
  });
}
