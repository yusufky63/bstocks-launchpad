import 'server-only';

import type { Address } from 'viem';

import { findStock } from '@stockpair/core';
import { listHoldings, listMarkets, listSwaps, type Db } from '@stockpair/core/db';

import { API_BUDGET_MS, cached, TTL, withTimeout } from './cache.server';
import { toMarketView, type MarketView } from './market-view';
import { readClaimable } from './onchain.server';
import { readCreatorOverview } from './stats.server';
import { readStocksResponse } from './stocks.server';
import type { CreatorOverview } from './types';

export type WalletSummary = {
  wallet: string;
  created: MarketView[];
  holdings: { token: string; name: string; symbol: string; imageUrl: string | null; stock: string; stockSymbol: string; balance: number; balanceRaw: string; priceUsd: number | null; valueUsd: number | null }[];
  holdingsUsd: number | null;
  createdFdvUsd: number | null;
  /** Null when the chain read failed: unknown, not "nothing to claim". */
  claimable: { stock: string; symbol: string; ticker: string; amount: number; amountRaw: string; usd: number | null; hook: string }[] | null;
  /** Hooks whose balances could not be read just now; `claimable` lists only the ones that answered. */
  claimableUnreadHooks: string[];
  /** Null while any hook is unread: a total of the ones that answered would understate it. */
  claimableUsd: number | null;
  recentSwaps: { txHash: string; token: string; name: string; symbol: string; side: 'buy' | 'sell'; amountToken: number; amountStock: number; amountUsd: number | null; stockSymbol: string; blockTime: string; isCreator: boolean }[];
  creator: CreatorOverview;
};

/**
 * Null means the read did not finish in time. Without this guard a stalled query or RPC call left
 * the request hanging until the platform killed it, which is the one outcome worse than an error.
 */
export async function readWalletSummary(db: Db, wallet: string): Promise<WalletSummary | null> {
  return withTimeout(
    cached(`wallet:${wallet}`, TTL.list, async () => {
    const now = new Date();
    const [createdRows, holdingRows, swaps, claimableRaw, creator, stocks] = await Promise.all([
      listMarkets(db, { creator: wallet, limit: 200 }),
      listHoldings(db, wallet),
      listSwaps(db, { trader: wallet, limit: 100 }),
      readClaimable(wallet as Address).catch(() => null),
      readCreatorOverview(db, wallet),
      readStocksResponse(),
    ]);
    // Stock prices are a lookup here, not the subject: if the registry read timed out the wallet
    // still renders, with USD figures falling back to null rather than the page failing.
    const stockRows = stocks?.stocks ?? [];
    const stockUsd = new Map(stockRows.map((s) => [s.address, s.priceUsd]));
    const stockSymbol = new Map(stockRows.map((s) => [s.address, s.symbol]));
    const stockDecimals = new Map(stockRows.map((s) => [s.address, s.decimals]));

    // Prices for held tokens (and for the trades list) come from the same market rows the lists use.
    const heldTokens = holdingRows.map((h) => h.token);
    const swappedTokens = swaps.map((s) => s.token);
    const priced = await listMarkets(db, { tokens: [...new Set([...heldTokens, ...swappedTokens])], limit: 200 });
    const markets = new Map([...createdRows, ...priced].map((row) => [row.token, toMarketView(row, now)]));

    const created = createdRows.map((row) => toMarketView(row, now));
    const holdings = holdingRows.map((row) => {
      const market = markets.get(row.token) ?? null;
      const balance = Number(row.balance_raw) / 1e18;
      const priceUsd = market?.priceUsd ?? null;
      return {
        token: row.token,
        name: row.name,
        symbol: row.symbol,
        imageUrl: market?.imageUrl ?? null,
        stock: row.stock,
        stockSymbol: stockSymbol.get(row.stock) ?? findStock(row.stock)?.symbol ?? '',
        balance,
        balanceRaw: row.balance_raw,
        priceUsd,
        valueUsd: priceUsd === null ? null : balance * priceUsd,
      };
    });
    const claimableUnreadHooks: string[] = claimableRaw?.unreadHooks ?? [];
    const claimable = claimableRaw === null ? null : claimableRaw.balances.map((c) => {
      const decimals = stockDecimals.get(c.stock.toLowerCase()) ?? findStock(c.stock)?.decimals ?? 8;
      const amount = Number(c.amountRaw) / 10 ** decimals;
      const usd = stockUsd.get(c.stock.toLowerCase()) ?? null;
      return { stock: c.stock, symbol: c.symbol, ticker: findStock(c.stock)?.ticker ?? c.symbol.replace(/c$/u, ''), amount, amountRaw: c.amountRaw, usd: usd === null ? null : amount * usd, hook: c.hook };
    });
    const sum = (items: { valueUsd?: number | null; usd?: number | null }[], key: 'valueUsd' | 'usd') => {
      const values = items.map((i) => i[key] ?? null).filter((v): v is number => v !== null);
      return values.length === 0 && items.length > 0 ? null : values.reduce((s, v) => s + v, 0);
    };
    return {
      wallet,
      created,
      holdings,
      holdingsUsd: sum(holdings, 'valueUsd'),
      createdFdvUsd: created.length ? created.reduce((s, m) => s + (m.fdvUsd ?? 0), 0) : null,
      claimable,
      claimableUnreadHooks,
      claimableUsd: claimable === null || claimableUnreadHooks.length > 0 ? null : sum(claimable, 'usd'),
      recentSwaps: swaps.map((row) => {
        const market = markets.get(row.token);
        const decimals = market?.stock.decimals ?? stockDecimals.get(market?.stock.address ?? '') ?? 8;
        const amountStock = Number(row.amount_stock_raw) / 10 ** decimals;
        const usd = market?.stockUsd ?? null;
        return {
          txHash: row.tx_hash,
          token: row.token,
          name: market?.name ?? row.token.slice(0, 10),
          symbol: market?.symbol ?? '',
          side: row.side,
          amountToken: Number(row.amount_token_raw) / 1e18,
          amountStock,
          amountUsd: usd === null ? null : amountStock * usd,
          stockSymbol: market?.stock.symbol ?? '',
          blockTime: new Date(row.block_time).toISOString(),
          isCreator: row.is_creator,
        };
      }),
      creator,
    };
    }),
    API_BUDGET_MS,
    null,
  );
}
