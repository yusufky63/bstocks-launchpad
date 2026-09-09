import { updateLaunchMetadata, type Db } from '@stockpair/core/db';

export type TokenMetadata = {
  description: string | null;
  imageUri: string | null;
  website: string | null;
  twitter: string | null;
};

/** Resolves ipfs:// (and bare CID) URIs through the configured gateway. */
export function gatewayUrl(uri: string, gateway: string): string | null {
  const trimmed = uri.trim();
  if (trimmed.startsWith('ipfs://')) return `${gateway}/ipfs/${trimmed.slice('ipfs://'.length)}`;
  if (/^https:\/\//u.test(trimmed)) return trimmed;
  if (/^ba[a-z2-7]{20,}$/u.test(trimmed) || /^Qm[1-9A-HJ-NP-Za-km-z]{44}$/u.test(trimmed)) {
    return `${gateway}/ipfs/${trimmed}`;
  }
  return null;
}

/** Accepts @handle, handle, or a full x.com / twitter.com URL; returns the canonical profile URL. */
export function normalizeTwitter(value: string | null): string | null {
  if (!value) return null;
  const url = value.match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/u);
  const handle = url ? url[1] : value.replace(/^@/u, '');
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/u.test(handle)) return null;
  return `https://x.com/${handle}`;
}

export function parseMetadata(value: unknown): TokenMetadata {
  const record = typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const text = (key: string) => {
    const v = record[key];
    return typeof v === 'string' && v.trim().length > 0 ? v.trim().slice(0, 2_000) : null;
  };
  // The website is rendered as a link and its hostname is read, so anything that is not an http(s)
  // URL is dropped here rather than stored. A launcher writing "nvidia.com" -- a typo, not an
  // attack -- would otherwise be enough to throw while rendering that token's page.
  const httpUrl = (value: string | null): string | null => {
    if (value === null) return null;
    if (!URL.canParse(value)) return null;
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:' ? value : null;
  };
  return {
    description: text('description'),
    imageUri: text('image') ?? text('image_url') ?? text('imageUri'),
    website: httpUrl(text('external_link') ?? text('external_url') ?? text('website')),
    twitter: normalizeTwitter(text('twitter') ?? text('x') ?? text('twitter_url')),
  };
}

export async function fetchMetadata(
  contractUri: string,
  gateway: string,
  fetchImpl: typeof fetch = fetch,
): Promise<TokenMetadata | null> {
  if (contractUri.startsWith('data:application/json;base64,')) {
    try {
      const json = Buffer.from(contractUri.slice('data:application/json;base64,'.length), 'base64').toString('utf8');
      return parseMetadata(JSON.parse(json));
    } catch {
      return null;
    }
  }
  const url = gatewayUrl(contractUri, gateway);
  if (!url) return null;
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return null;
    const contentLength = Number(response.headers.get('content-length') ?? '0');
    if (contentLength > 200_000) return null;
    return parseMetadata(await response.json());
  } catch {
    return null;
  }
}

/** How many times a URI is retried before it is left alone. */
const MAX_METADATA_ATTEMPTS = 6;

/** Fills description/image/website for launches that still lack metadata. */
export async function backfillMetadata(
  db: Db,
  gateway: string,
  fetchImpl: typeof fetch = fetch,
  limit = 20,
): Promise<number> {
  // Back off between attempts and stop after a few. A contractURI is whatever the launcher passed
  // in; one that resolves to a host that accepts and hangs used to sit at the head of this set
  // forever, paying its timeout on every idle poll and holding up the chain sync behind it.
  const rows = await db.query<{ token: string; contract_uri: string; metadata_attempts: number }>(
    `SELECT token, contract_uri, metadata_attempts FROM launches
     WHERE metadata_fetched_at IS NULL
       AND metadata_attempts < $2
       AND (metadata_last_attempt_at IS NULL
            OR metadata_last_attempt_at < now() - (interval '1 minute' * power(4, metadata_attempts)))
     ORDER BY launched_at DESC LIMIT $1`,
    [limit, MAX_METADATA_ATTEMPTS],
  );
  let filled = 0;
  for (const row of rows) {
    const metadata = await fetchMetadata(row.contract_uri, gateway, fetchImpl);
    if (!metadata) {
      await db.query(
        `UPDATE launches SET metadata_attempts = metadata_attempts + 1, metadata_last_attempt_at = now()
         WHERE token = $1`,
        [row.token],
      );
      continue;
    }
    await updateLaunchMetadata(db, row.token, metadata);
    filled += 1;
  }
  return filled;
}
