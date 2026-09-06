import { json } from '@/lib/api.server';
import { resolveBasenames } from '@/lib/basenames.server';

export const dynamic = 'force-dynamic';

/**
 * Batched Base-name lookup for a set of addresses. The client collects the addresses it is about to
 * render and asks once; the server memoises each name so repeat visitors do not re-hit the chain.
 * GET /api/names?a=0x..,0x.. → { names: { "0x..": "name.base.eth" | null } }
 */
export async function GET(req: Request): Promise<Response> {
  const raw = new URL(req.url).searchParams.get('a') ?? '';
  const addresses = raw
    .split(',')
    .map((a) => a.trim())
    .filter((a) => /^0x[0-9a-fA-F]{40}$/u.test(a))
    .slice(0, 100);
  if (addresses.length === 0) return json({ names: {} });
  const names = await resolveBasenames(addresses);
  return json({ names });
}
