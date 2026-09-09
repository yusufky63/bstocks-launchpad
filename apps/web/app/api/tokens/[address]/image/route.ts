import { readMarket, readTokenProfile } from '@stockpair/core/db';

import { error, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { ipfsToHttp } from '@/lib/env';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

/** Cap what we will proxy, so a launcher cannot point this at something enormous. */
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Serves a token's image from our own origin.
 *
 * Two reasons this exists rather than linking the gateway directly. Every visitor was pulling the
 * full-size original straight from a public IPFS gateway on every page, and those gateways are not
 * dependable — ipfs.io answers 429 and cloudflare-ipfs fails outright, so only the pinning
 * service's own gateway currently works. And when someone asks for a URL to our token's image — an
 * aggregator, a wallet, a listing form — an ipfs:// URI or a gateway link that half the internet
 * refuses is a poor thing to hand over. This is a stable https URL we control.
 *
 * The bytes still live on IPFS; this only fetches and caches them.
 */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');

  const db = await getDb();
  const [market, profile] = await Promise.all([readMarket(db, token), readTokenProfile(db, token)]);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');

  // The creator's signed profile image wins over the one fixed at launch, matching the site.
  const source = ipfsToHttp(profile?.image_uri ?? market.image_uri);
  if (!source) return error(404, 'NO_IMAGE', 'This token has no image.');

  let upstream: Response;
  try {
    upstream = await fetch(source, { signal: AbortSignal.timeout(10_000) });
  } catch {
    return error(502, 'IMAGE_UNREACHABLE', 'The image could not be fetched right now.');
  }
  if (!upstream.ok || !upstream.body) return error(502, 'IMAGE_UNREACHABLE', 'The image could not be fetched right now.');

  const type = upstream.headers.get('content-type') ?? '';
  if (!type.startsWith('image/')) return error(415, 'NOT_AN_IMAGE', 'That URI does not point at an image.');
  const length = Number(upstream.headers.get('content-length') ?? '0');
  if (length > MAX_BYTES) return error(413, 'IMAGE_TOO_LARGE', 'That image is too large to serve.');

  return new Response(upstream.body, {
    headers: {
      'content-type': type,
      // Content at a CID never changes, and a signed profile change moves the CID, so this is safe
      // to cache hard. The URL stays the same; what it points at is versioned by the CID behind it.
      'cache-control': 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800',
    },
  });
}
