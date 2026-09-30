import { publicEnv } from '@/lib/env';
import { buildOpenApi } from '@/lib/openapi';
import { API_LIMITS } from '@/lib/rate-limit.server';

export const dynamic = 'force-static';

/**
 * The API as OpenAPI 3.1. Any origin may fetch it: a spec is only useful if Swagger, Postman or an
 * agent running on another site can load it.
 */
export function GET(): Response {
  return Response.json(buildOpenApi(publicEnv.appUrl, API_LIMITS), {
    headers: { 'Cache-Control': 'public, max-age=300, s-maxage=300', 'Access-Control-Allow-Origin': '*' },
  });
}
