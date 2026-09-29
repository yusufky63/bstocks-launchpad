/**
 * Who may build a trade here: the country the hosting provider reports, and the visitor's own word.
 *
 * Every pool on this launchpad is quoted in a Coinbase tokenized stock, and the issuer offers those
 * only to eligible persons outside the United States. An IP address says where a connection comes
 * from, not who is behind it: a non-US person travelling or on a US-hosted VPN looks the same as a
 * US resident. So the default mode, `attest`, asks a blocked country rather than refusing it. A
 * visitor who confirms they do not live in the United States and are not a US citizen or resident
 * gets a cookie, and the routes that build a trade answer them. `GEOBLOCK_MODE=block` refuses
 * whatever the visitor says, for a deployment that must.
 *
 * `GEOBLOCK_COUNTRIES=*` asks every visitor the host reports a country for, for an operator who
 * wants the statement from everyone before a trade.
 *
 * The answer travels two ways, and either is enough. The cookie is what the site itself sets. The
 * `x-bstocks-eligibility: confirmed` header is what the page sends alongside it, because a widget in
 * another site's iframe may not be allowed to keep a cookie at all (Safari), and it is how a partner
 * that asks the question in its own UI passes the visitor's answer on. Both are the visitor's own
 * statement; neither is more verifiable than the other.
 *
 * One definition, shared by the edge proxy that enforces it and /api/region that reports it, so the
 * page never tells a visitor something the routes disagree with. No `server-only` here: the proxy
 * imports it, and the client imports the names and types.
 */
export const ELIGIBILITY_COOKIE = 'bstocks_eligibility';
export const ELIGIBILITY_HEADER = 'x-bstocks-eligibility';
const THIRTY_DAYS = 30 * 24 * 3600;

export type GeoMode = 'attest' | 'block';

export type RegionState = {
  /** ISO code from the host's geo header, or null when none was sent (local development). */
  country: string | null;
  blocked: string[];
  mode: GeoMode;
  /** The connection comes from a country on the list. */
  blockedCountry: boolean;
  /** The visitor has confirmed they are not a US person on this device. */
  attested: boolean;
  /** The routes that build a trade refuse this visitor. */
  restricted: boolean;
};

export function geoPolicy(): { blocked: string[]; mode: GeoMode } {
  const blocked = (process.env.GEOBLOCK_COUNTRIES ?? 'US')
    .split(',')
    .map((c) => c.trim().toUpperCase())
    .filter(Boolean);
  return { blocked, mode: process.env.GEOBLOCK_MODE === 'block' ? 'block' : 'attest' };
}

export function requestCountry(headers: Headers): string | null {
  const country = (headers.get('x-vercel-ip-country') ?? headers.get('cf-ipcountry') ?? headers.get('x-country-code') ?? '').trim().toUpperCase();
  return country || null;
}

const ATTESTED = new RegExp(`(?:^|;\\s*)${ELIGIBILITY_COOKIE}=confirmed(?:;|$)`, 'u');

export function attestedIn(headers: Headers): boolean {
  return headers.get(ELIGIBILITY_HEADER)?.trim() === 'confirmed' || ATTESTED.test(headers.get('cookie') ?? '');
}

/** Whether a request may build a trade. No country header means no guess and nothing is refused. */
export function regionState(req: Request, attested = attestedIn(req.headers)): RegionState {
  const country = requestCountry(req.headers);
  const { blocked, mode } = geoPolicy();
  const blockedCountry = !!country && (blocked.includes('*') || blocked.includes(country));
  return { country, blocked, mode, blockedCountry, attested, restricted: blockedCountry && !(mode === 'attest' && attested) };
}

/**
 * The attestation as a Set-Cookie value, 30 days, or its removal. HttpOnly: nothing in the page
 * needs to read it, /api/region says what it means.
 *
 * Over https it travels `SameSite=None; Secure; Partitioned`, because the widgets under /embed run
 * inside other sites' iframes, where a Lax cookie is never sent and the answer would not stick.
 * Partitioned keeps the embedded copy apart from the top-level one. The route that sets it checks
 * `Origin` itself, which is the cross-site protection Lax would otherwise have given. Plain http
 * (local development) cannot carry Secure and keeps Lax.
 */
export function eligibilityCookie(confirm: boolean, secure: boolean): string {
  const attributes = secure ? '; HttpOnly; SameSite=None; Secure; Partitioned' : '; HttpOnly; SameSite=Lax';
  return confirm ? `${ELIGIBILITY_COOKIE}=confirmed; Path=/; Max-Age=${THIRTY_DAYS}${attributes}` : `${ELIGIBILITY_COOKIE}=; Path=/; Max-Age=0${attributes}`;
}
