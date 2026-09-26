import 'server-only';

import type { Address } from 'viem';

import { ipfsToHttp } from './env';
import { isBareIpfsUri } from './market-view';
import { readTokenContractUri } from './onchain.server';

/** An ERC-7572 document is a few hundred bytes; anything far larger is not one. */
const MAX_DOCUMENT_BYTES = 64 * 1024;

type ReadFailure = { ok: false; code: 'IMAGE_REQUIRED'; message: string };
export type CurrentImage = { ok: true; image: string | null } | ReadFailure;
export type CurrentProfileDocument =
  | { ok: true; image: string | null; description: string; website: string; twitter: string; telegram: string }
  | ReadFailure;

const UNREADABLE: ReadFailure = {
  ok: false,
  code: 'IMAGE_REQUIRED',
  message: "The token's current profile and image could not be read just now. Try again in a minute so existing details are preserved.",
};
const NOT_IPFS: ReadFailure = {
  ok: false,
  code: 'IMAGE_REQUIRED',
  message: "The token's current image is not a plain IPFS image, which an editable profile cannot keep. Choose an image to upload.",
};

type Dependencies = { readContractUri?: (token: Address) => Promise<string>; fetchImpl?: typeof fetch; allowInvalidImage?: boolean };

/** Read the document named by the live onchain URI, not a database row that may lag behind it. */
export async function currentProfileDocument(token: Address, deps: Dependencies = {}): Promise<CurrentProfileDocument> {
  const readContractUri = deps.readContractUri ?? readTokenContractUri;
  const fetchImpl = deps.fetchImpl ?? fetch;
  let uri: string;
  try {
    uri = await readContractUri(token);
  } catch {
    return UNREADABLE;
  }
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

  const fields = document as Record<string, unknown>;
  const text = (...keys: string[]) => {
    const value = keys.map((key) => fields[key]).find((candidate) => typeof candidate === 'string' && candidate.trim() !== '');
    return typeof value === 'string' ? value.trim() : '';
  };
  const image = text('image', 'image_url', 'imageUri');
  if (image && !isBareIpfsUri(image) && !deps.allowInvalidImage) return NOT_IPFS;
  return {
    ok: true,
    image: image && isBareIpfsUri(image) ? image : null,
    description: text('description'),
    website: text('external_link', 'external_url', 'website'),
    twitter: text('twitter', 'x', 'twitter_url'),
    telegram: text('telegram'),
  };
}

/** Kept for callers that only need the current onchain image. */
export async function currentProfileImage(token: Address, deps: Dependencies = {}): Promise<CurrentImage> {
  const result = await currentProfileDocument(token, deps);
  return result.ok ? { ok: true, image: result.image } : result;
}
