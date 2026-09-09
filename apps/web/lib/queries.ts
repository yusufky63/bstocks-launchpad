'use client';

import { useQuery, type UseQueryOptions } from '@tanstack/react-query';

import type { ActivityResponse, ApiErrorBody, CandlesResponse, HoldersResponse, MarketsResponse, QuoteView, StatsResponse, StocksResponse, SwapsResponse, TokenResponse } from './types';

export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const response = await fetch(path, { cache: 'no-store' });
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
    const err = body && typeof body === 'object' && 'error' in body ? body.error : { code: 'HTTP_ERROR', message: `Request failed (${response.status}).` };
    throw new ApiError(err.code, err.message, response.status);
  }
  return body as T;
}

export async function apiPost<T>(path: string, payload: unknown): Promise<T> {
  const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const body = (await response.json().catch(() => null)) as T | ApiErrorBody | null;
  if (!response.ok || (body && typeof body === 'object' && 'error' in body)) {
    const err = body && typeof body === 'object' && 'error' in body ? body.error : { code: 'HTTP_ERROR', message: `Request failed (${response.status}).` };
    throw new ApiError(err.code, err.message, response.status);
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

export function useSwaps(address: string, enabled = true) {
  return useQuery<SwapsResponse, Error>({
    queryKey: qk.swaps(address),
    queryFn: () => apiGet<SwapsResponse>(`/api/tokens/${address}/swaps?limit=100`),
    refetchInterval: 15_000,
    enabled,
  });
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

export function useCandles(address: string) {
  return useQuery<CandlesResponse, Error>({
    queryKey: qk.candles(address),
    queryFn: () => apiGet<CandlesResponse>(`/api/tokens/${address}/candles?limit=2000`),
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
