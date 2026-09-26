/** DEX Screener's per-token paid-order statuses. */
export type DexPaidStatus = 'approved' | 'pending' | 'none' | 'unavailable';

const ORDER_TYPES = new Set(['tokenProfile', 'communityTakeover', 'tokenAd', 'trendingBarAd']);

/** Only a validated response may say there are no orders. */
export function dexPaidStatus(value: unknown): DexPaidStatus {
  // The current API wraps orders alongside boosts; retain support for its legacy array.
  const items = Array.isArray(value)
    ? value
    : value !== null && typeof value === 'object' && 'orders' in value
      ? value.orders
      : null;
  if (!Array.isArray(items)) return 'unavailable';
  const orders = items.filter((item): item is Record<string, unknown> =>
    item !== null && typeof item === 'object' && !Array.isArray(item) && ORDER_TYPES.has((item as { type?: string }).type ?? ''),
  );
  if (orders.some((order) => order.status === 'approved')) return 'approved';
  if (orders.some((order) => order.status === 'processing' || order.status === 'on-hold')) return 'pending';
  return 'none';
}

export async function fetchDexPaidStatus(token: string, fetchImpl: typeof fetch = fetch): Promise<DexPaidStatus> {
  try {
    const response = await fetchImpl(`https://api.dexscreener.com/orders/v1/base/${token}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return 'unavailable';
    return dexPaidStatus(await response.json());
  } catch {
    return 'unavailable';
  }
}