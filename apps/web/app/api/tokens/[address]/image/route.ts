import { readMarket } from '@stockpair/core/db';

import { error, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { ipfsToHttp } from '@/lib/env';
import { effectiveImageUri, imageVersion, isBareIpfsUri } from '@/lib/market-view';

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
 *
 * The site links `?v=<first 12 hex of sha256(image URI)>`. An image can change (a signed profile,
 * or an editable token's onchain update), so only a request whose `v` matches the current image is
 * cached for good, and only when that image is a bare ipfs:// CID; anything else gets a short cache.
 */
export async function GET(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');

  const market = await readMarket(await getDb(), token);
  if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');

  // The same image the site shows: the signed profile's for fixed tokens, the onchain one for editable.
  const uri = effectiveImageUri(market);
  const source = ipfsToHttp(uri);
  if (!uri || !source) return error(404, 'NO_IMAGE', 'This token has no image.');
  // `v` hashes the URI, not the bytes: it pins the bytes only when the URI is itself a content hash.
  // An https image can be replaced at the same address, which a year-long immutable cache would hide.
  const current = isBareIpfsUri(uri) && new URL(request.url).searchParams.get('v') === imageVersion(uri);

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
      // A matching `v` on a bare CID names these exact bytes, so it never needs revalidating. Anything
      // else may be a different image tomorrow; a minute is as long as it can be trusted.
      'cache-control': current ? 'public, max-age=31536000, immutable' : 'public, max-age=60, s-maxage=60',
    },
  });
}
