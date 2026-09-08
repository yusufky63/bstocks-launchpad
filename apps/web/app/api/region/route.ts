import { NextResponse, type NextRequest } from 'next/server'

/**
 * Where the visitor is, and whether this launchpad may build a trade for them.
 *
 * The edge middleware already refuses the routes; this exists so the page can say so before
 * somebody fills in a form. Never cached: the answer is per request.
 */
const BLOCKED = (process.env.GEOBLOCK_COUNTRIES ?? 'US')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean)

export const dynamic = 'force-dynamic'

export function GET(req: NextRequest) {
  const country = (req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry') ?? req.headers.get('x-country-code') ?? '').toUpperCase()
  const restricted = !!country && BLOCKED.includes(country)
  return NextResponse.json({ country: country || null, blocked: BLOCKED, restricted }, { headers: { 'cache-control': 'no-store' } })
}
