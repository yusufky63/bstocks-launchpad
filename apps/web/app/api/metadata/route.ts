import { z } from 'zod';

import { error, json } from '@/lib/api.server';
import { callerKey, rateLimit } from '@/lib/rate-limit.server';
import { PinError, pinMetadata } from '@/lib/pinata.server';
import { normalizeTwitter } from '@/lib/twitter';
import { websiteSchema } from '@/lib/profile';

export const dynamic = 'force-dynamic';

const fieldsSchema = z.object({
  name: z.string().trim().min(1).max(64),
  symbol: z.string().trim().regex(/^[A-Z0-9]{1,16}$/u),
  description: z.string().trim().max(1_000).default(''),
  website: websiteSchema,
  twitter: z.string().trim().max(60).optional().or(z.literal('')),
});


/** Pins the token's image and ERC-7572 metadata; returns the contractURI for the launch. */
/** Pins are expensive and this endpoint is unauthenticated, so cap what one caller can spend. */
const PINS_PER_HOUR = 10;

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
  const parsed = fieldsSchema.safeParse({
    name: form.get('name'),
    symbol: form.get('symbol'),
    description: form.get('description') ?? '',
    website: form.get('website') ?? '',
    twitter: form.get('twitter') ?? '',
  });
  if (!parsed.success) return error(400, 'INVALID_FIELDS', 'Check the name, symbol, description and website.');
  const twitter = normalizeTwitter(parsed.data.twitter || undefined);
  if (parsed.data.twitter && !twitter) return error(400, 'INVALID_TWITTER', 'Use an X handle like @name or an x.com profile link.');

  const file = form.get('image');
  let image: { bytes: ArrayBuffer; type: string; fileName: string } | null = null;
  if (file instanceof File && file.size > 0) {
    image = { bytes: await file.arrayBuffer(), type: file.type, fileName: file.name || 'image' };
  }

  try {
    const result = await pinMetadata({
      name: parsed.data.name,
      symbol: parsed.data.symbol,
      description: parsed.data.description,
      website: parsed.data.website ? parsed.data.website : null,
      twitter,
      image,
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
