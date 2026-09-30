import { publicEnv } from '@/lib/env';
import { llmsFullTxt } from '@/lib/llms';
import { API_LIMITS } from '@/lib/rate-limit.server';

export const dynamic = 'force-static';

/** The whole API reference in one plain-text file, for a model's context or an agent's tools. */
export function GET(): Response {
  return new Response(llmsFullTxt(publicEnv.appUrl, API_LIMITS), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=300', 'Access-Control-Allow-Origin': '*' },
  });
}
