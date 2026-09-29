import { type NextRequest } from 'next/server'
import { z } from 'zod'

import { error, json } from '@/lib/api.server'
import { eligibilityCookie, regionState } from '@/lib/region'

/**
 * Where the visitor is, and whether this launchpad may build a trade for them.
 *
 * The edge proxy enforces the rule; this reads the same rule so the page can say so before somebody
 * fills in a form. Never cached: the answer is per request.
 */
export const dynamic = 'force-dynamic'

export function GET(req: NextRequest) {
  return json(regionState(req))
}

const body = z.object({ confirm: z.boolean() })

/**
 * The visitor's own statement that they are not a US person: they do not live in the United States
 * and are not a US citizen or resident. Stored as a cookie on this device for 30 days, and nothing
 * about the person is recorded. `confirm: false` withdraws it.
 *
 * The cookie travels `SameSite=None` so the /embed widgets can use it, which means any site could
 * post here from a visitor's browser. The browser's `Origin` header is the check: an answer given
 * on somebody else's page is not the visitor's answer. A request without one is not a browser.
 */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  if (origin && !sameOrigin(origin, req)) return error(403, 'CROSS_SITE', 'Confirm eligibility on the launchpad itself.')

  const parsed = body.safeParse(await req.json().catch(() => null))
  if (!parsed.success) return error(400, 'INVALID_BODY', 'Send { "confirm": true } or { "confirm": false }.')

  const res = json(regionState(req, parsed.data.confirm))
  res.headers.append('set-cookie', eligibilityCookie(parsed.data.confirm, req.nextUrl.protocol === 'https:'))
  return res
}

function sameOrigin(origin: string, req: NextRequest): boolean {
  let host: string
  try {
    host = new URL(origin).host.toLowerCase()
  } catch {
    return false
  }
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase()
  return host === req.nextUrl.host.toLowerCase() || host === forwarded
}
