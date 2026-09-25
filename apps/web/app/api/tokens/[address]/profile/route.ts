import { isAddress, isHex, type Address, type Hex } from 'viem';
import { z } from 'zod';

import { readMarket, readTokenProfile } from '@stockpair/core/db';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { PinError } from '@/lib/pinata.server';
import { buildProfileMessage } from '@/lib/profile';
import { ProfileError, applyProfileUpdate } from '@/lib/profile.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

const payloadSchema = z.object({
  signer: z.string().refine(isAddress, 'signer must be an address'),
  signature: z.string().refine(isHex, 'signature must be hex'),
  description: z.string().max(1_000).default(''),
  website: z.string().max(200).default(''),
  twitter: z.string().max(60).default(''),
  telegram: z.string().max(60).default(''),
  imageHash: z.string().regex(/^0x[0-9a-f]{64}$/u),
  issuedAt: z.coerce.number().int().positive(),
});

/** The stored creator profile, if any (the token page already merges it into the market view). */
export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const profile = await readTokenProfile(await getDb(), token);
  if (!profile) return json({ profile: null });
  return json({ profile: { description: profile.description, imageUri: profile.image_uri, website: profile.website, twitter: profile.twitter, telegram: profile.telegram, signer: profile.signer, updatedAt: new Date(profile.updated_at).toISOString() } });
}

/**
 * Creator-signed profile update. Multipart: a `payload` JSON field (the signed fields, signer and
 * signature) plus an optional `image` file whose keccak256 must equal the signed imageHash.
 *
 * Tokens launched with an editable profile are refused outright (409): their profile changes
 * onchain only, and one editing path per token keeps what the page shows equal to what the token says.
 */
export async function POST(request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const token = parseAddressParam(address);
  if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
  const launch = await readMarket(await getDb(), token);
  if (launch?.metadata_editable) return error(409, 'ONCHAIN_PROFILE', "This token's profile lives onchain; update it from the token page.");

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error(400, 'INVALID_FORM', 'Send multipart form data.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(String(form.get('payload') ?? ''));
  } catch {
    return error(400, 'INVALID_PAYLOAD', 'payload must be JSON.');
  }
  const parsed = payloadSchema.safeParse(raw);
  if (!parsed.success) return error(400, 'INVALID_PAYLOAD', 'Check the profile fields, signer and signature.');

  const built = buildProfileMessage({
    token: token as Address,
    description: parsed.data.description,
    website: parsed.data.website,
    twitter: parsed.data.twitter,
    telegram: parsed.data.telegram,
    imageHash: parsed.data.imageHash as Hex,
    issuedAt: BigInt(parsed.data.issuedAt),
  });
  if (built.error) return error(400, 'INVALID_FIELDS', built.error);

  const file = form.get('image');
  const image = file instanceof File && file.size > 0 ? { bytes: await file.arrayBuffer(), type: file.type, fileName: file.name || 'image' } : null;

  try {
    const db = await getDb();
    const result = await applyProfileUpdate(db, { token, signer: parsed.data.signer as Address, signature: parsed.data.signature as Hex, message: built.message, image });
    return json({ ok: true, ...result });
  } catch (cause) {
    if (cause instanceof ProfileError) return error(cause.status, cause.code, cause.message);
    if (cause instanceof PinError) return error(cause.code === 'NOT_CONFIGURED' ? 503 : cause.code === 'IMAGE_INVALID' ? 400 : 502, cause.code, cause.message);
    return error(500, 'PROFILE_FAILED', 'The profile could not be saved.');
  }
}
