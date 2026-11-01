'use client';

import { useQuery, useQueryClient, type UseQueryOptions } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';

import { eligibilityHeaders } from './eligibility';
import { markBurnsIndexed } from './pending-burns';
import { markIndexed } from './pending-trades';
import type { ActivityResponse, ApiErrorBody, BurnsResponse, CandlesResponse, HoldersResponse, MarketsResponse, QuoteView, StatsResponse, StocksResponse, SwapsResponse, TokenResponse } from './types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
    const err: ApiErrorBody['error'] = body && typeof body === 'object' && 'error' in body ? body.error : { code: 'HTTP_ERROR', message: `Request failed (${response.status}).` };
    throw new ApiError(err.code, err.message, response.status, err.details);
  }
  return body as T;
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', ...eligibilityHeaders() }, body: JSON.stringify(payload) });
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
    const err: ApiErrorBody['error'] = body && typeof body === 'object' && 'error' in body ? body.error : { code: 'HTTP_ERROR', message: `Request failed (${response.status}).` };
    throw new ApiError(err.code, err.message, response.status, err.details);
  }
  return body as T;
}

export const qk = {
  stocks: ['stocks'] as const,
  markets: (params: Record<string, string>) => ['markets', params] as const,
  token: (address: string) => ['token', address] as const,
  swaps: (address: string) => ['swaps', address] as const,
  holders: (address: string) => ['holders', address] as const,
  candles: (address: string) => ['candles', address] as const,
  burns: (address: string) => ['burns', address] as const,
  quote: (address: string, side: string, amountIn: string) => ['quote', address, side, amountIn] as const,
  stats: ['stats'] as const,
  activity: (params: Record<string, string>) => ['activity', params] as const,
};

type Opts<T> = Omit<UseQueryOptions<T, Error>, 'queryKey' | 'queryFn'>;

export function useStocks(initialData?: StocksResponse, opts: Opts<StocksResponse> = {}) {
  return useQuery<StocksResponse, Error>({
    queryKey: qk.stocks,
    queryFn: () => apiGet<StocksResponse>('/api/stocks'),
    initialData,
    refetchInterval: 60_000,
    ...opts,
  });
}

export function useMarkets(params: { stock?: string; q?: string; creator?: string; limit?: number; orderBy?: 'newest' | 'volume24h' } = {}, initialData?: MarketsResponse, opts: Opts<MarketsResponse> = {}) {
  const search = new URLSearchParams();
  if (params.stock) search.set('stock', params.stock);
  if (params.q?.trim()) search.set('q', params.q.trim());
  if (params.creator) search.set('creator', params.creator);
  search.set('limit', String(params.limit ?? 100));
  if (params.orderBy) search.set('orderBy', params.orderBy);
  const key = Object.fromEntries(search);
  return useQuery<MarketsResponse, Error>({
    queryKey: qk.markets(key),
    queryFn: () => apiGet<MarketsResponse>(`/api/markets?${search}`),
    initialData,
    refetchInterval: 15_000,
    placeholderData: (previous) => previous,
    ...opts,
  });
}

export function useToken(address: string, initialData?: TokenResponse) {
  return useQuery<TokenResponse, Error>({
    queryKey: qk.token(address),
    queryFn: async () => {
      try {
        return await apiGet<TokenResponse>(`/api/tokens/${address}`);
      } catch (err) {
        // A launch that is still in the mempool is not an error: keep the page waiting.
        if (err instanceof ApiError && err.status === 404 && initialData?.status === 'pending') return initialData;
        throw err;
      }
    },
    initialData,
    refetchInterval: (query) => (query.state.data?.status === 'indexing' || query.state.data?.status === 'pending' ? 3_000 : 15_000),
  });
}

export function useStats(initialData?: StatsResponse) {
  return useQuery<StatsResponse, Error>({ queryKey: qk.stats, queryFn: () => apiGet<StatsResponse>('/api/stats'), initialData, refetchInterval: 30_000 });
}

export function useActivity(params: { limit?: number; token?: string; actor?: string } = {}, initialData?: ActivityResponse, opts: Opts<ActivityResponse> = {}) {
  const search = new URLSearchParams();
  search.set('limit', String(params.limit ?? 50));
  if (params.token) search.set('token', params.token);
  if (params.actor) search.set('actor', params.actor);
  return useQuery<ActivityResponse, Error>({
    queryKey: qk.activity(Object.fromEntries(search)),
    queryFn: () => apiGet<ActivityResponse>(`/api/activity?${search}`),
    initialData,
    refetchInterval: 5_000,
    ...opts,
  });
}

/**
 * The newest trades. Polled often because this is the cheapest read that says the indexer stored
 * something new; the heavier reads wait for it to say so (see useLiveTrades).
 */
export function useSwaps(address: string, enabled = true) {
  return useQuery<SwapsResponse, Error>({
    queryKey: qk.swaps(address),
    queryFn: () => apiGet<SwapsResponse>(`/api/tokens/${address}/swaps?limit=100`),
    refetchInterval: 3_000,
    enabled,
  });
}

/**
 * The trades list, plus what has to follow it. When the newest indexed trade changes, the chart,
 * the token's figures and its holders are refetched at once rather than on their own clocks (20 s
 * for candles), which left a trade on the list long before it reached the chart. Pending trades
 * from this browser's receipts are marked indexed as the list takes them in. Call it once per page.
 */
export function useLiveTrades(address: string, enabled = true) {
  const swaps = useSwaps(address, enabled);
  const queryClient = useQueryClient();
  const newest = swaps.data?.swaps[0];
  const newestKey = newest ? `${newest.txHash}:${newest.logIndex}` : null;
  const seen = useRef<string | null | undefined>(undefined);
  const { data, dataUpdatedAt } = swaps;
  useEffect(() => {
    if (!data) return;
    markIndexed(address, data.swaps);
    if (seen.current !== undefined && seen.current !== newestKey) {
      void queryClient.invalidateQueries({ queryKey: qk.candles(address) });
      void queryClient.invalidateQueries({ queryKey: qk.token(address) });
      void queryClient.invalidateQueries({ queryKey: qk.holders(address) });
    }
    seen.current = newestKey;
    // dataUpdatedAt: every fetch, not only the ones that changed the data, so pruning keeps time.
  }, [data, dataUpdatedAt, newestKey, address, queryClient]);
  return swaps;
}

/**
 * A token's burns, newest page with the totals. When a new burn shows up the token is refetched so
 * the burned figures on the page follow, and this browser's pending burns are marked indexed.
 */
export function useBurns(address: string, enabled = true) {
  const burns = useQuery<BurnsResponse, Error>({
    queryKey: qk.burns(address),
    queryFn: () => apiGet<BurnsResponse>(`/api/tokens/${address}/burns?limit=100`),
    refetchInterval: 10_000,
    enabled,
  });
  const queryClient = useQueryClient();
  const newest = burns.data?.burns[0];
  const newestKey = newest ? `${newest.txHash}:${newest.logIndex}` : null;
  const seen = useRef<string | null | undefined>(undefined);
  const { data, dataUpdatedAt } = burns;
  useEffect(() => {
    if (!data) return;
    markBurnsIndexed(address, data.burns);
    if (seen.current !== undefined && seen.current !== newestKey) void queryClient.invalidateQueries({ queryKey: qk.token(address) });
    seen.current = newestKey;
  }, [data, dataUpdatedAt, newestKey, address, queryClient]);
  return burns;
}

export function useHolders(address: string, enabled = true, limit = 100) {
  return useQuery<HoldersResponse, Error>({
    queryKey: [...qk.holders(address), limit],
    queryFn: () => apiGet<HoldersResponse>(`/api/tokens/${address}/holders?limit=${limit}`),
    refetchInterval: 30_000,
    enabled,
    placeholderData: (prev) => prev,
  });
}

/**
 * Candles at the width the chart is showing.
 *
 * The bucket is part of the request rather than something the browser does afterwards: the read is
 * capped at 2000 rows, and spending that cap on minutes only to add them together left the
 * four-hour view with eight candles and made a daily view pointless. Asked for daily, 2000 rows
 * reach back further than the launchpad has existed.
 */
export function useCandles(address: string, bucketMinutes = 1) {
  return useQuery<CandlesResponse, Error>({
    queryKey: [...qk.candles(address), bucketMinutes],
    queryFn: () => apiGet<CandlesResponse>(`/api/tokens/${address}/candles?limit=2000&bucket=${bucketMinutes}`),
    refetchInterval: 20_000,
  });
}

export function useQuote(address: string, side: 'buy' | 'sell', amountIn: bigint | null) {
  const amount = amountIn !== null && amountIn > 0n ? amountIn.toString() : '0';
  return useQuery<QuoteView, ApiError>({
    queryKey: qk.quote(address, side, amount),
    queryFn: () => apiPost<QuoteView>('/api/quote', { token: address, side, amountIn: amount }),
    enabled: amount !== '0',
    refetchInterval: 10_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
}
