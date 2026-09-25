import { updateLaunchMetadata, type Db } from '@stockpair/core/db';

export type TokenMetadata = {
  description: string | null;
  imageUri: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
};

/**
 * Resolves ipfs:// (and bare CID) URIs through the configured gateway.
 *
 * An ipfs:// URI must stay under its own CID once the URL is normalised. The factory holds an
 * editable profile's link to `ipfs://` and a bare CID, but checks a fixed profile's link (every link
 * on the first factory) only as text, so `ipfs://x/../../ipns/<key>` or `ipfs://%2e%2e/ipns/<key>`
 * would otherwise resolve to a mutable IPNS name while reading as content-addressed.
 */
export function gatewayUrl(uri: string, gateway: string): string | null {
  const trimmed = uri.trim();
  if (trimmed.startsWith('ipfs://')) {
    const rest = trimmed.slice('ipfs://'.length);
    const cid = rest.split('/')[0] ?? '';
    if (!/^[A-Za-z0-9]+$/u.test(cid)) return null;
    const url = `${gateway}/ipfs/${rest}`;
    if (!URL.canParse(url)) return null;
    const base = new URL(`${gateway}/ipfs/${cid}`).pathname;
    const path = new URL(url).pathname;
    return path === base || path.startsWith(`${base}/`) ? url : null;
  }
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

/**
 * Accepts @handle, handle, or a t.me / telegram.me link; returns the canonical t.me URL. The same
 * rule the web app applies to a signed profile, so both kinds of profile store the same form.
 */
export function normalizeTelegram(value: string | null): string | null {
  if (!value) return null;
  const url = value.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(\+?[A-Za-z0-9_]{4,64})\/?$/u);
  const handle = url ? url[1] : value.replace(/^@/u, '');
  if (!handle || !/^\+?[A-Za-z0-9_]{4,64}$/u.test(handle)) return null;
  return `https://t.me/${handle}`;
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
    // The key the launch form pins it under.
    telegram: normalizeTelegram(text('telegram')),
  };
}

/** How long one metadata document may take to arrive. */
const FETCH_TIMEOUT_MS = 10_000;

export async function fetchMetadata(
  contractUri: string,
  gateway: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = FETCH_TIMEOUT_MS,
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
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
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

export type BackfillOptions = Readonly<{
  /** Most documents one run reads. */
  limit?: number;
  /** Wall time one run may take. No fetch starts unless its whole timeout still fits. */
  budgetMs?: number;
  /** Milliseconds now; tests pass a clock they control. */
  now?: () => number;
}>;

/**
 * Fills description/image/links for launches that still lack metadata, reading the contract URI
 * now in force: the launch value, or the latest one an editable token's creator set onchain.
 * Returns how many profiles it filled.
 */
export async function backfillMetadata(
  db: Db,
  gateway: string,
  fetchImpl: typeof fetch = fetch,
  options: BackfillOptions = {},
): Promise<number> {
  const now = options.now ?? Date.now;
  const deadline = now() + (options.budgetMs ?? 30_000);
  // Back off between attempts and stop after a few. A contractURI is whatever the launcher passed
  // in; one that resolves to a host that accepts and hangs used to sit at the head of this set
  // forever, paying its timeout on every idle poll and holding up the chain sync behind it. URIs
  // that have never failed go first, so a token whose URI keeps failing cannot starve new launches.
  const rows = await db.query<{ token: string; uri: string; metadata_attempts: number }>(
    `SELECT token, COALESCE(current_contract_uri, contract_uri) AS uri, metadata_attempts FROM launches
     WHERE metadata_fetched_at IS NULL
       AND metadata_attempts < $2
       AND (metadata_last_attempt_at IS NULL
            OR metadata_last_attempt_at < now() - (interval '1 minute' * power(4, metadata_attempts)))
     ORDER BY metadata_attempts ASC, launched_at DESC LIMIT $1`,
    [options.limit ?? 20, MAX_METADATA_ATTEMPTS],
  );
  let filled = 0;
  for (const row of rows) {
    // Stop rather than start a fetch that could run past the budget; the rest wait for the next run.
    if (deadline - now() < FETCH_TIMEOUT_MS) break;
    const metadata = await fetchMetadata(row.uri, gateway, fetchImpl);
    // Both writes are guarded by the URI that was fetched. The creator may have set a new one while
    // this fetch was in flight; a failure of the old one is not the new one's, and the new one's own
    // fetch fills the profile in.
    if (!metadata) {
      await db.query(
        `UPDATE launches SET metadata_attempts = metadata_attempts + 1, metadata_last_attempt_at = now()
         WHERE token = $1 AND COALESCE(current_contract_uri, contract_uri) = $2`,
        [row.token, row.uri],
      );
      continue;
    }
    if (await updateLaunchMetadata(db, row.token, metadata, row.uri)) filled += 1;
  }
  return filled;
}

type Log = (message: string, fields?: Record<string, unknown>) => void;

/**
 * Runs the metadata backfill beside the chain sync rather than inside it, so a slow gateway or a
 * URI that hangs delays profiles, never swaps, alerts or the cursor. One run at a time: asking
 * while one is in flight does nothing, and the next ask after it finishes starts another.
 */
export function metadataWorker(run: (limit: number) => Promise<number>, log: Log) {
  let current: Promise<void> | null = null;
  return {
    /** Starts a run unless one is in flight; returns whether it started one. Never throws. */
    kick(limit: number): boolean {
      if (current) return false;
      current = run(limit)
        .then((filled) => {
          if (filled > 0) log('metadata filled', { filled });
        })
        .catch((error: unknown) => log('metadata backfill failed', { error: error instanceof Error ? error.message : String(error) }))
        .finally(() => {
          current = null;
        });
      return true;
    },
    /** Resolves once the run in flight, if any, has finished. */
    async settled(): Promise<void> {
      await current;
    },
  };
}
