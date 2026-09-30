import { NextResponse, type NextRequest } from 'next/server'

import { ELIGIBILITY_HEADER, regionState } from '@/lib/region'

/**
 * Compliance geoblock at the edge.
 *
 * Named `proxy`, not `middleware`: Next.js 16 renamed the convention, and a file called
 * middleware.ts is simply never loaded.
 *
 * Every pool on this launchpad is quoted in a Coinbase tokenized stock, so trading here means
 * holding one, and the issuer offers them only to eligible persons outside the United States. The
 * routes that exist to build a trade or open a market answer 451 for a blocked country until the
 * visitor confirms they are not a US person (lib/region.ts has the rule and the modes).
 *
 * Reads stay open everywhere: prices, charts, holders and the market list are public information.
 * The swap itself is a call from the user's own wallet and no server can stop it, which is what the
 * notice in the app is for; this closes the surfaces the app does control.
 *
 * The country comes from the hosting provider's header. No header means no guess and nothing is
 * blocked, so local development is unaffected.
 */

/** Quotes and the transaction builders build a swap or a launch; metadata pinning is the first step of opening a market. */
const RESTRICTED_WRITES = [/^\/api\/quote/, /^\/api\/metadata/, /^\/api\/tx\//]

/**
 * Partner sites that run the launch flow in their own UI (zkCodex) call this API from the
 * visitor's browser. It has to be the browser, not a partner server: the geoblock above and the
 * pin rate limit both key on the visitor's own connection, and a server in a blocked country would
 * be refused for everyone. Every route here is public and cookie-less, so the list only states who
 * the API is meant for. Partners read what a launch and a trade need (the launch config, stocks,
 * markets, activity, one token with its trades, candles and holders, a wallet, the region) and
 * post the metadata pin, quotes and the transaction builders. Each of the routes that used to stay
 * closed to them (quotes, wallets, token detail) now has a per-caller limit of its own
 * (lib/rate-limit.server.ts), on top of the memoised reads behind it.
 *
 * `PARTNER_ORIGINS` replaces the default list. beta.zkcodex.com is zkCodex's staging site; its Vercel
 * previews are allowed by pattern: only that team can create hosts under the suffix.
 */
const PARTNER_ORIGINS = (process.env.PARTNER_ORIGINS ?? 'https://zkcodex.com,https://www.zkcodex.com,https://beta.zkcodex.com,http://localhost:3001')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/u, ''))
  .filter(Boolean)
const PARTNER_PREVIEW = /^https:\/\/zk-codex-[a-z0-9-]+-yusufky63s-projects\.vercel\.app$/u
const PARTNER_READS = [
  /^\/api\/(?:launch-config|stocks|markets|region|health|activity)\/?$/,
  /^\/api\/tokens\/0x[0-9a-fA-F]{40}(?:\/(?:swaps|candles|holders))?\/?$/,
  /^\/api\/wallet\/0x[0-9a-fA-F]{40}\/?$/,
]
const PARTNER_WRITES = [/^\/api\/(?:metadata|quote|tx\/swap|tx\/launch)\/?$/]

function partnerOrigin(req: NextRequest): string | null {
  const origin = req.headers.get('origin')
  if (!origin) return null
  return PARTNER_ORIGINS.includes(origin) || PARTNER_PREVIEW.test(origin) ? origin : null
}

function corsHeaders(origin: string, path: string): Record<string, string> {
  const writable = PARTNER_WRITES.some((r) => r.test(path))
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': writable ? 'GET, HEAD, POST, OPTIONS' : 'GET, HEAD, OPTIONS',
    // The eligibility header lets a partner that asks the question in its own UI pass the answer on.
    'access-control-allow-headers': `content-type, ${ELIGIBILITY_HEADER}`,
    'access-control-max-age': '600',
    vary: 'Origin',
  }
}

function partnerRoute(path: string): boolean {
  return PARTNER_READS.some((r) => r.test(path)) || PARTNER_WRITES.some((r) => r.test(path))
}

function withCors(res: NextResponse, req: NextRequest, path: string): NextResponse {
  const origin = partnerOrigin(req)
  const read = req.method === 'GET' || req.method === 'HEAD'
  const allowed = read ? partnerRoute(path) : PARTNER_WRITES.some((r) => r.test(path))
  if (!origin || !allowed) return res
  for (const [key, value] of Object.entries(corsHeaders(origin, path))) res.headers.set(key, value)
  return res
}

export function proxy(req: NextRequest) {
  const path = req.nextUrl.pathname
  if (req.method === 'OPTIONS') {
    const origin = partnerOrigin(req)
    if (origin && partnerRoute(path)) return new NextResponse(null, { status: 204, headers: corsHeaders(origin, path) })
    return NextResponse.next()
  }
  return withCors(geoblock(req, path), req, path)
}

function geoblock(req: NextRequest, path: string): NextResponse {
  const write = req.method !== 'GET' && req.method !== 'HEAD'
  if (!write || !RESTRICTED_WRITES.some((r) => r.test(path))) return NextResponse.next()

  const region = regionState(req)
  if (!region.restricted) return NextResponse.next()

  // In `attest` the visitor is asked, not banned, and the message has to say so: a 451 that a
  // checkbox clears must not read like a wall. In `block` there is genuinely nothing to do.
  const reason = 'Every token here is paired with a Coinbase tokenized stock, and those are offered only to eligible persons outside the United States.'
  return NextResponse.json(
    {
      error: {
        code: 'REGION_RESTRICTED',
        message: region.mode === 'attest' ? `Confirm you are not a US person to continue. ${reason}` : `This is not available in your region. ${reason}`,
        details: { country: region.country, mode: region.mode },
      },
    },
    { status: 451, headers: { 'cache-control': 'no-store' } },
  )
}

export const config = {
  matcher: ['/api/:path*'],
}
