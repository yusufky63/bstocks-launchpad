import { NextResponse, type NextRequest } from 'next/server'

/**
 * Compliance geoblock at the edge.
 *
 * Every pool on this launchpad is quoted in a Coinbase tokenized stock, so trading here means
 * holding one, and the issuer offers them only to eligible persons outside the United States. The
 * routes that exist to build a trade or open a market answer 451 for a blocked country.
 *
 * Reads stay open everywhere: prices, charts, holders and the market list are public information.
 * The swap itself is a call from the user's own wallet and no server can stop it, which is what the
 * notice in the app is for; this closes the surfaces the app does control.
 *
 * The country comes from the hosting provider's header. No header means no guess and nothing is
 * blocked, so local development is unaffected.
 */
const BLOCKED = (process.env.GEOBLOCK_COUNTRIES ?? 'US')
  .split(',')
  .map((c) => c.trim().toUpperCase())
  .filter(Boolean)

/** Quotes build a swap; metadata pinning is the first step of opening a market. */
const RESTRICTED_WRITES = [/^\/api\/quote/, /^\/api\/metadata/]

function requestCountry(req: NextRequest): string {
  return (req.headers.get('x-vercel-ip-country') ?? req.headers.get('cf-ipcountry') ?? req.headers.get('x-country-code') ?? '').toUpperCase()
}

export function middleware(req: NextRequest) {
  const path = req.nextUrl.pathname
  const write = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS'
  if (!write || !RESTRICTED_WRITES.some((r) => r.test(path))) return NextResponse.next()

  const country = requestCountry(req)
  if (!country || !BLOCKED.includes(country)) return NextResponse.next()

  return NextResponse.json(
    {
      error: {
        code: 'REGION_RESTRICTED',
        message:
          'This is not available in your region. Every token here is paired with a Coinbase tokenized stock, and those are offered only to eligible persons outside the United States.',
        details: { country },
      },
    },
    { status: 451, headers: { 'cache-control': 'no-store' } },
  )
}

export const config = {
  matcher: ['/api/:path*'],
}
