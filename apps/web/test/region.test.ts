import { NextRequest } from 'next/server';
import { afterEach, describe, expect, it } from 'vitest';

import { GET as getRegion, POST as postRegion } from '@/app/api/region/route';
import { ELIGIBILITY_COOKIE, ELIGIBILITY_HEADER, eligibilityCookie } from '@/lib/region';
import { proxy } from '@/proxy';

const HOST = 'https://launchpad.basestocks.finance';

function request(path: string, init: { method?: string; country?: string; attested?: boolean; origin?: string; body?: unknown } = {}): NextRequest {
  const headers = new Headers();
  if (init.country) headers.set('x-vercel-ip-country', init.country);
  if (init.attested) headers.set('cookie', `theme=dark; ${ELIGIBILITY_COOKIE}=confirmed`);
  if (init.origin) headers.set('origin', init.origin);
  if (init.body !== undefined) headers.set('content-type', 'application/json');
  return new NextRequest(`${HOST}${path}`, { method: init.method ?? 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
}

const refused = (path: string, init: Parameters<typeof request>[1] = {}) => proxy(request(path, { method: 'POST', ...init })).status === 451;

const previousMode = process.env.GEOBLOCK_MODE;
afterEach(() => {
  if (previousMode === undefined) delete process.env.GEOBLOCK_MODE;
  else process.env.GEOBLOCK_MODE = previousMode;
});

/**
 * An IP address is where a connection comes from, not who is behind it. By default a blocked
 * country is asked, and a visitor who confirms they are not a US person builds trades like anyone.
 */
describe('geoblock, attest mode (the default)', () => {
  it('asks a US connection before a quote or a pin, and says it is a question', async () => {
    expect(refused('/api/quote', { country: 'US' })).toBe(true);
    expect(refused('/api/metadata', { country: 'US' })).toBe(true);
    const body = (await proxy(request('/api/quote', { method: 'POST', country: 'US' })).json()) as { error: { code: string; message: string; details: { country: string; mode: string } } };
    expect(body.error.code).toBe('REGION_RESTRICTED');
    expect(body.error.details).toEqual({ country: 'US', mode: 'attest' });
    expect(body.error.message).toMatch(/confirm you are not a US person/i);
  });

  it('opens quotes and pins to a US IP that confirmed it is not a US person', () => {
    expect(refused('/api/quote', { country: 'US', attested: true })).toBe(false);
    expect(refused('/api/metadata', { country: 'US', attested: true })).toBe(false);
  });

  it('does not take a cookie that only looks like the attestation', () => {
    const headers = new Headers({ 'x-vercel-ip-country': 'US', cookie: `x${ELIGIBILITY_COOKIE}=confirmed; ${ELIGIBILITY_COOKIE}=maybe` });
    expect(proxy(new NextRequest(`${HOST}/api/quote`, { method: 'POST', headers })).status).toBe(451);
  });

  it('leaves reading open to everyone', () => {
    for (const path of ['/api/markets', '/api/stocks', '/api/region', '/api/tokens/0x0000000000000000000000000000000000000001']) {
      expect(proxy(request(path, { country: 'US' })).status, path).not.toBe(451);
    }
  });

  it('never asks a country that is not on the list, and never guesses without a header', () => {
    for (const country of ['TR', 'DE', 'GB', 'JP']) expect(refused('/api/quote', { country })).toBe(false);
    expect(refused('/api/quote')).toBe(false);
  });
});

/**
 * The header carries the same statement as the cookie, for a widget whose browser drops third-party
 * cookies and for a partner that asks the question in its own UI.
 */
describe('the answer as a header', () => {
  const withHeader = (path: string, value: string, origin?: string) => {
    const headers = new Headers({ 'x-vercel-ip-country': 'US', [ELIGIBILITY_HEADER]: value });
    if (origin) headers.set('origin', origin);
    return proxy(new NextRequest(`${HOST}${path}`, { method: 'POST', headers }));
  };

  it('opens quotes and pins like the cookie does', () => {
    expect(withHeader('/api/quote', 'confirmed').status).not.toBe(451);
    expect(withHeader('/api/metadata', 'confirmed').status).not.toBe(451);
    expect(withHeader('/api/quote', 'yes').status).toBe(451);
  });

  it('lets a partner that asked the question pass the answer on', () => {
    const ZKCODEX = 'https://zkcodex.com';
    const pin = withHeader('/api/metadata', 'confirmed', ZKCODEX);
    expect(pin.status).not.toBe(451);
    expect(pin.headers.get('access-control-allow-origin')).toBe(ZKCODEX);
    const preflight = proxy(new NextRequest(`${HOST}/api/metadata`, { method: 'OPTIONS', headers: { origin: ZKCODEX } }));
    expect(preflight.headers.get('access-control-allow-headers')).toContain(ELIGIBILITY_HEADER);
  });

  it('is what /api/region reports too', async () => {
    const headers = new Headers({ 'x-vercel-ip-country': 'US', [ELIGIBILITY_HEADER]: 'confirmed' });
    expect(await (await getRegion(new NextRequest(`${HOST}/api/region`, { headers }))).json()).toMatchObject({ attested: true, restricted: false });
  });

  it('does not open block mode either', () => {
    process.env.GEOBLOCK_MODE = 'block';
    expect(withHeader('/api/quote', 'confirmed').status).toBe(451);
  });
});

describe('asking everyone', () => {
  const previousCountries = process.env.GEOBLOCK_COUNTRIES;
  afterEach(() => {
    if (previousCountries === undefined) delete process.env.GEOBLOCK_COUNTRIES;
    else process.env.GEOBLOCK_COUNTRIES = previousCountries;
  });

  it('asks every country with GEOBLOCK_COUNTRIES=*, and still guesses nothing without a header', () => {
    process.env.GEOBLOCK_COUNTRIES = '*';
    for (const country of ['TR', 'DE', 'US']) {
      expect(refused('/api/quote', { country })).toBe(true);
      expect(refused('/api/quote', { country, attested: true })).toBe(false);
    }
    expect(refused('/api/quote')).toBe(false);
  });
});

describe('geoblock, block mode', () => {
  it('refuses a US connection whatever it says', async () => {
    process.env.GEOBLOCK_MODE = 'block';
    expect(refused('/api/quote', { country: 'US', attested: true })).toBe(true);
    expect(refused('/api/metadata', { country: 'US', attested: true })).toBe(true);
    const body = (await proxy(request('/api/quote', { method: 'POST', country: 'US' })).json()) as { error: { message: string; details: { mode: string } } };
    expect(body.error.details.mode).toBe('block');
    expect(body.error.message).toMatch(/not available in your region/i);
  });
});

describe('/api/region', () => {
  it('reports the rule the proxy enforces', async () => {
    expect(await (await getRegion(request('/api/region', { country: 'US' }))).json()).toMatchObject({ country: 'US', mode: 'attest', blockedCountry: true, attested: false, restricted: true });
    expect(await (await getRegion(request('/api/region', { country: 'US', attested: true }))).json()).toMatchObject({ attested: true, restricted: false });
    expect(await (await getRegion(request('/api/region', { country: 'TR' }))).json()).toMatchObject({ country: 'TR', blockedCountry: false, restricted: false });
    expect(await (await getRegion(request('/api/region'))).json()).toMatchObject({ country: null, restricted: false });
  });

  it('stores a confirmation as a cookie for 30 days and answers as unrestricted', async () => {
    const res = await postRegion(request('/api/region', { method: 'POST', country: 'US', origin: HOST, body: { confirm: true } }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ country: 'US', attested: true, restricted: false });
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain(`${ELIGIBILITY_COOKIE}=confirmed`);
    expect(cookie).toContain(`Max-Age=${30 * 24 * 3600}`);
    expect(cookie).toContain('HttpOnly');
    // https: the /embed widgets live in other sites' iframes, where only SameSite=None is sent.
    expect(cookie).toContain('SameSite=None; Secure; Partitioned');
  });

  it('withdraws a confirmation', async () => {
    const res = await postRegion(request('/api/region', { method: 'POST', country: 'US', attested: true, origin: HOST, body: { confirm: false } }));
    expect(await res.json()).toMatchObject({ attested: false, restricted: true });
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('refuses an answer posted from another site', async () => {
    const res = await postRegion(request('/api/region', { method: 'POST', country: 'US', origin: 'https://evil.example', body: { confirm: true } }));
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a body that is not a yes or a no', async () => {
    expect((await postRegion(request('/api/region', { method: 'POST', origin: HOST, body: { confirm: 'yes' } }))).status).toBe(400);
    expect((await postRegion(request('/api/region', { method: 'POST', origin: HOST, body: {} }))).status).toBe(400);
  });

  it('keeps Lax over plain http, where Secure cannot be set', () => {
    expect(eligibilityCookie(true, false)).toContain('SameSite=Lax');
    expect(eligibilityCookie(true, false)).not.toContain('Secure');
  });
});
