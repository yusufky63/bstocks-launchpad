import { z } from 'zod';

import { error, json, limitSchema, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { readActivity } from '@/lib/stats.server';

export const dynamic = 'force-dynamic';
// The database is in another region; a cold instance needs room for the handshake and the reads.
export const maxDuration = 15;

const querySchema = z.object({ limit: limitSchema, token: z.string().optional(), actor: z.string().optional() });

/** Launches and swaps as one feed, newest first. */
export async function GET(request: Request): Promise<Response> {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return error(400, 'INVALID_QUERY', 'Unsupported query parameters.');
  const token = parsed.data.token ? parseAddressParam(parsed.data.token) : null;
  if (parsed.data.token && !token) return error(400, 'INVALID_TOKEN', 'token must be an address.');
  const actor = parsed.data.actor ? parseAddressParam(parsed.data.actor) : null;
  if (parsed.data.actor && !actor) return error(400, 'INVALID_ACTOR', 'actor must be an address.');
  const db = await getDb();
  const activity = await readActivity(db, { limit: parsed.data.limit, ...(token ? { token } : {}), ...(actor ? { actor } : {}) });
  // 503 rather than an empty feed: an empty list would read as "nothing has happened".
  if (!activity) return error(503, 'ACTIVITY_UNAVAILABLE', 'Activity could not be read in time.');
  return json(activity);
}
