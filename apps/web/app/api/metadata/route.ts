import type { Address } from 'viem';
import { z } from 'zod';

import { readMarket } from '@stockpair/core/db';

import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { callerKey, rateLimit } from '@/lib/rate-limit.server';
import { PinError, pinMetadata } from '@/lib/pinata.server';
import { currentProfileImage } from '@/lib/profile-document.server';
import { normalizeTelegram, websiteSchema } from '@/lib/profile';
import { normalizeTwitter } from '@/lib/twitter';

export const dynamic = 'force-dynamic';

const profileSchema = z.object({
  description: z.string().trim().max(1_000).default(''),
  website: websiteSchema,
  twitter: z.string().trim().max(60).optional().or(z.literal('')),
  telegram: z.string().trim().max(80).optional().or(z.literal('')),
});

const launchSchema = profileSchema.extend({
  name: z.string().trim().min(1).max(64),
  symbol: z.string().trim().regex(/^[A-Z0-9]{1,16}$/u),
});

/** Pins are expensive and this endpoint is unauthenticated, so cap what one caller can spend. */
const PINS_PER_HOUR = 10;

/**
 * Pins the token's image and ERC-7572 metadata; returns the contractURI (ipfs://CID).
 *
 * Two uses. Before a launch, with the name and symbol the creator typed. For an editable token,
 * with `token`: the name and symbol then come from the launch record and anything the caller sends
 * for them is ignored, because the document must never rename a token. Only the creator's own
 * `updateContractURI` transaction can point the token at the result, so pinning needs no signature.
 * Either way the document only ever names an image that is `ipfs://` and a bare CID.
 */
export async function POST(request: Request): Promise<Response> {
  // Nothing here requires a wallet or a signature, and every call writes up to 2 MB to the one
  // Pinata account that serves every token's image. A single loop would burn the quota and take
  // every logo down with it, so the caller is capped before any body is read.
  const limited = rateLimit(callerKey(request, 'metadata'), PINS_PER_HOUR, 60 * 60_000);
  if (!limited.ok) {
    return json(
      { error: { code: 'RATE_LIMITED', message: 'Too many uploads from this address. Try again shortly.' } },
      429,
      { 'retry-after': String(limited.retryAfterSeconds) },
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return error(400, 'INVALID_FORM', 'Send multipart form data.');
  }
  const profileFields = {
    description: form.get('description') ?? '',
    website: form.get('website') ?? '',
    twitter: form.get('twitter') ?? '',
    telegram: form.get('telegram') ?? '',
  };

  let name: string;
  let symbol: string;
  let editableToken: Address | null = null;
  let profile: z.infer<typeof profileSchema>;
  const tokenField = form.get('token');
  if (tokenField !== null) {
    const token = parseAddressParam(String(tokenField));
    if (!token) return error(400, 'INVALID_ADDRESS', 'Token address is malformed.');
    const market = await readMarket(await getDb(), token);
    if (!market) return error(404, 'TOKEN_NOT_FOUND', 'No token was launched at this address.');
    if (!market.metadata_editable) return error(409, 'PROFILE_FIXED', "This token's profile is fixed.");
    if (market.metadata_locked_at) return error(409, 'PROFILE_LOCKED', "This token's profile is locked for good.");
    const parsed = profileSchema.safeParse(profileFields);
    if (!parsed.success) return error(400, 'INVALID_FIELDS', 'Check the description and website.');
    ({ name, symbol } = market);
    editableToken = token as Address;
    profile = parsed.data;
  } else {
    const parsed = launchSchema.safeParse({ ...profileFields, name: form.get('name'), symbol: form.get('symbol') });
    if (!parsed.success) return error(400, 'INVALID_FIELDS', 'Check the name, symbol, description and website.');
    ({ name, symbol } = parsed.data);
    profile = parsed.data;
  }

  const twitter = normalizeTwitter(profile.twitter || undefined);
  if (profile.twitter && !twitter) return error(400, 'INVALID_TWITTER', 'Use an X handle like @name or an x.com profile link.');
  const telegram = normalizeTelegram(profile.telegram || undefined);
  if (profile.telegram && !telegram) return error(400, 'INVALID_TELEGRAM', 'Use a Telegram handle like @name or a t.me link.');

  const file = form.get('image');
  let image: { bytes: ArrayBuffer; type: string; fileName: string } | null = null;
  if (file instanceof File && file.size > 0) {
    image = { bytes: await file.arrayBuffer(), type: file.type, fileName: file.name || 'image' };
  }

  // An update with no new image keeps the one the token names onchain now, never the indexed row's
  // copy, which can trail an update that just landed. If that cannot be read, the caller uploads one.
  let existingImageUri: string | null = null;
  if (editableToken && !image) {
    const current = await currentProfileImage(editableToken);
    if (!current.ok) return error(409, current.code, current.message);
    existingImageUri = current.image;
  }

  try {
    const result = await pinMetadata({
      name,
      symbol,
      description: profile.description,
      website: profile.website ? profile.website : null,
      twitter,
      telegram,
      image,
      existingImageUri,
    });
    return json(result);
  } catch (cause) {
    if (cause instanceof PinError) {
      const status = cause.code === 'NOT_CONFIGURED' ? 503 : cause.code === 'IMAGE_INVALID' ? 400 : 502;
      return error(status, cause.code, cause.message);
    }
    return error(502, 'UPLOAD_FAILED', 'Metadata could not be pinned.');
  }
}
