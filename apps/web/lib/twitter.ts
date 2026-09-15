/**
 * The X account this site points people at: the brand account, re-created after the earlier ones
 * were suspended. One constant so the header, the footer and the metadata agree.
 */
export const BSTOCKS_X_HANDLE = 'BStocksOnBase';
export const BSTOCKS_X_URL = `https://x.com/${BSTOCKS_X_HANDLE}`;

/** Accepts @handle, handle, or an x.com / twitter.com URL; returns the canonical profile URL or null. */
export function normalizeTwitter(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?(?:x|twitter)\.com\/([A-Za-z0-9_]{1,15})\/?$/u);
  const handle = url ? url[1] : trimmed.replace(/^@/u, '');
  if (!handle || !/^[A-Za-z0-9_]{1,15}$/u.test(handle)) return null;
  return `https://x.com/${handle}`;
}

/** The @handle shown next to an X link. */
export function twitterHandle(url: string): string {
  return `@${url.replace(/^https:\/\/x\.com\//u, '')}`;
}
