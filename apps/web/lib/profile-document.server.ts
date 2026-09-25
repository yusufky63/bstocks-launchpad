import 'server-only';

import type { Address } from 'viem';

import { ipfsToHttp } from './env';
import { isBareIpfsUri } from './market-view';
import { readTokenContractUri } from './onchain.server';

/** An ERC-7572 document is a few hundred bytes; anything far larger is not one. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

export type CurrentImage = { ok: true; image: string | null } | { ok: false; code: 'IMAGE_REQUIRED'; message: string };

const UNREADABLE: CurrentImage = {
  ok: false,
  code: 'IMAGE_REQUIRED',
  message: "The token's current image could not be read just now. Choose the image again to keep it, or try again in a minute.",
};
const NOT_IPFS: CurrentImage = {
  ok: false,
  code: 'IMAGE_REQUIRED',
  message: "The token's current image is not a plain IPFS image, which an editable profile cannot keep. Choose an image to upload.",
};

/**
 * The image an editable token's profile names right now, read from the token itself: its onchain
 * contract URI, then the IPFS document behind it. The indexed row can trail an update that has just
 * landed, and pinning its older image into the next document would quietly undo that update. When
 * the current image cannot be read, or is not a bare ipfs:// CID, the caller must upload one.
 */
export async function currentProfileImage(
  token: Address,
  deps: { readContractUri?: (token: Address) => Promise<string>; fetchImpl?: typeof fetch } = {},
): Promise<CurrentImage> {
  const readContractUri = deps.readContractUri ?? readTokenContractUri;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let uri: string;
  try {
    uri = await readContractUri(token);
  } catch {
    return UNREADABLE;
  }
  // Editable tokens only ever point at ipfs:// links; a path could leave the CID, so only a bare one is read.
  const source = isBareIpfsUri(uri) ? ipfsToHttp(uri) : null;
  if (!source) return UNREADABLE;

  let document: unknown;
  try {
    const response = await fetchImpl(source, { signal: AbortSignal.timeout(8_000) });
    if (!response.ok) return UNREADABLE;
    const text = await response.text();
    if (text.length > MAX_DOCUMENT_BYTES) return UNREADABLE;
    document = JSON.parse(text);
  } catch {
    return UNREADABLE;
  }
  if (!document || typeof document !== 'object' || Array.isArray(document)) return UNREADABLE;

  // The same keys, in the same order, as the indexer reads.
  const fields = document as Record<string, unknown>;
  const raw = [fields.image, fields.image_url, fields.imageUri].find((v): v is string => typeof v === 'string' && v.trim() !== '');
  if (raw === undefined) return { ok: true, image: null };
  const image = raw.trim();
  return isBareIpfsUri(image) ? { ok: true, image } : NOT_IPFS;
}
