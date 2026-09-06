import 'server-only';

import { verifyTypedData, type Address, type Hex } from 'viem';

import { readMarket, readTokenProfile, upsertTokenProfile, type Db } from '@stockpair/core/db';

import { invalidate } from './cache.server';
import { getPublicClient } from './chain.server';
import { pinImage } from './pinata.server';
import { EMPTY_IMAGE_HASH, PROFILE_DOMAIN, PROFILE_MAX_AGE_SECONDS, PROFILE_TYPES, imageHashOf, type ProfileMessage } from './profile';

export class ProfileError extends Error {
  constructor(
    readonly code: 'TOKEN_NOT_FOUND' | 'NOT_CREATOR' | 'BAD_SIGNATURE' | 'EXPIRED' | 'STALE' | 'IMAGE_MISMATCH',
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** EOA signatures verify offline; smart wallets (Base Account) fall back to an ERC-1271 / ERC-6492 check on Base. */
async function signatureIsValid(signer: Address, message: ProfileMessage, signature: Hex): Promise<boolean> {
  const params = { address: signer, domain: PROFILE_DOMAIN, types: PROFILE_TYPES, primaryType: 'TokenProfile' as const, message, signature };
  try {
    if (await verifyTypedData(params)) return true;
  } catch {
    /* not an EOA signature; try the chain */
  }
  try {
    return await getPublicClient().verifyTypedData(params);
  } catch {
    return false;
  }
}

/**
 * Applies a creator-signed profile update. Order matters: cheap checks first, the chain only when
 * needed, and the image is pinned only after the signature over its hash has been accepted.
 */
export async function applyProfileUpdate(
  db: Db,
  input: { token: string; signer: Address; signature: Hex; message: ProfileMessage; image: { bytes: ArrayBuffer; type: string; fileName: string } | null },
  now = () => Date.now(),
): Promise<{ updated: boolean }> {
  const market = await readMarket(db, input.token);
  if (!market) throw new ProfileError('TOKEN_NOT_FOUND', 'Unknown token.', 404);
  if (market.creator.toLowerCase() !== input.signer.toLowerCase()) throw new ProfileError('NOT_CREATOR', 'Only the wallet that created this token can edit its profile.', 403);
  if (input.message.token.toLowerCase() !== input.token.toLowerCase()) throw new ProfileError('BAD_SIGNATURE', 'The signed message is for a different token.', 400);

  const issued = Number(input.message.issuedAt) * 1000;
  if (!Number.isFinite(issued) || Math.abs(now() - issued) > PROFILE_MAX_AGE_SECONDS * 1000) throw new ProfileError('EXPIRED', 'The signature is too old. Sign again.', 400);
  const existing = await readTokenProfile(db, input.token);
  if (existing && new Date(existing.issued_at).getTime() >= issued) throw new ProfileError('STALE', 'A newer profile is already stored.', 409);

  if (input.image) {
    if (imageHashOf(input.image.bytes) !== input.message.imageHash) throw new ProfileError('IMAGE_MISMATCH', 'The image does not match the signed hash.', 400);
  } else if (input.message.imageHash !== EMPTY_IMAGE_HASH) {
    throw new ProfileError('IMAGE_MISMATCH', 'The signature covers an image that was not uploaded.', 400);
  }

  if (!(await signatureIsValid(input.signer, input.message, input.signature))) throw new ProfileError('BAD_SIGNATURE', 'The signature does not match the creator wallet.', 401);

  const imageUri = input.image ? await pinImage(input.image) : (existing?.image_uri ?? null);
  const updated = await upsertTokenProfile(db, {
    token: input.token,
    description: input.message.description || null,
    imageUri,
    website: input.message.website || null,
    twitter: input.message.twitter || null,
    telegram: input.message.telegram || null,
    signer: input.signer,
    signature: input.signature,
    issuedAt: new Date(issued),
  });
  invalidate(`market:${input.token.toLowerCase()}`);
  invalidate('markets:');
  invalidate('activity:');
  return { updated };
}
