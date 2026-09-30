import { publicEnv } from '@/lib/env';
import { llmsTxt } from '@/lib/llms';

export const dynamic = 'force-static';

/** The short index for language models and agents (llmstxt.org). */
export function GET(): Response {
  return new Response(llmsTxt(publicEnv.appUrl), {
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'public, max-age=300, s-maxage=300', 'Access-Control-Allow-Origin': '*' },
  });
}
