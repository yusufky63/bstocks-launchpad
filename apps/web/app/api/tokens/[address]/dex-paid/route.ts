import { error, json, parseAddressParam } from '@/lib/api.server';
import { cached } from '@/lib/cache.server';
import { fetchDexPaidStatus } from '@/lib/dexscreener';
import { callerKey, rateLimit } from '@/lib/rate-limit.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

/** DEX Screener permits 60 order lookups a minute. Cache per token and limit callers. */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const limited = rateLimit(callerKey(request, 'dex-paid'), 20, 60_000);
  if (!limited.ok) return error(429, 'RATE_LIMITED', 'Try again in a moment.');
  const status = await cached(`dex-paid:${token}`, 5 * 60_000, () => fetchDexPaidStatus(token));
  return json({ status });
}