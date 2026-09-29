import { NextRequest } from 'next/server';
import { describe, expect, it } from 'vitest';

import { GET as getLaunchConfig } from '@/app/api/launch-config/route';
import { publicEnv } from '@/lib/env';
import { proxy } from '@/proxy';

const ZKCODEX = 'https://zkcodex.com';
const STAGING = 'https://zk-codex-git-feat-xp-rewards-yusufky63s-projects.vercel.app';

function request(path: string, init: { method?: string; origin?: string; country?: string } = {}): NextRequest {
  const headers = new Headers();
  if (init.origin) headers.set('origin', init.origin);
  if (init.country) headers.set('x-vercel-ip-country', init.country);
  return new NextRequest(`https://launchpad.basestocks.finance${path}`, { method: init.method ?? 'GET', headers });
}

describe('partner CORS', () => {
  it('lets a partner read the routes a launch needs', () => {
    for (const path of ['/api/launch-config', '/api/stocks', '/api/markets', '/api/region', '/api/health']) {
      const res = proxy(request(path, { origin: ZKCODEX }));
      expect(res.headers.get('access-control-allow-origin'), path).toBe(ZKCODEX);
      expect(res.headers.get('vary')).toBe('Origin');
    }
  });

  it('keeps quotes, wallets and token detail closed to partners', () => {
    for (const path of ['/api/wallet/0x0000000000000000000000000000000000000001', '/api/tokens/0x0000000000000000000000000000000000000001', '/api/activity']) {
      expect(proxy(request(path, { origin: ZKCODEX })).headers.get('access-control-allow-origin'), path).toBeNull();
    }
    expect(proxy(request('/api/quote', { method: 'POST', origin: ZKCODEX })).headers.get('access-control-allow-origin')).toBeNull();
    expect(proxy(request('/api/quote', { method: 'OPTIONS', origin: ZKCODEX })).status).not.toBe(204);
  });

  it('allows zkCodex previews by pattern and nobody else', () => {
    expect(proxy(request('/api/stocks', { origin: STAGING })).headers.get('access-control-allow-origin')).toBe(STAGING);
    expect(proxy(request('/api/stocks', { origin: 'https://zk-codex-x-someone-else.vercel.app' })).headers.get('access-control-allow-origin')).toBeNull();
    expect(proxy(request('/api/stocks', { origin: 'https://evil.example' })).headers.get('access-control-allow-origin')).toBeNull();
    expect(proxy(request('/api/stocks')).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('opens only the metadata pin to partner writes', () => {
    expect(proxy(request('/api/metadata', { method: 'POST', origin: ZKCODEX })).headers.get('access-control-allow-origin')).toBe(ZKCODEX);
    expect(proxy(request('/api/tokens/0x0000000000000000000000000000000000000001/profile', { method: 'POST', origin: ZKCODEX })).headers.get('access-control-allow-origin')).toBeNull();
  });

  it('answers a partner preflight itself', () => {
    const res = proxy(request('/api/metadata', { method: 'OPTIONS', origin: ZKCODEX }));
    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    const read = proxy(request('/api/markets', { method: 'OPTIONS', origin: ZKCODEX }));
    expect(read.headers.get('access-control-allow-methods')).not.toContain('POST');
  });

  it('still geoblocks a partner pin, and the partner can read why', async () => {
    const res = proxy(request('/api/metadata', { method: 'POST', origin: ZKCODEX, country: 'US' }));
    expect(res.status).toBe(451);
    expect(res.headers.get('access-control-allow-origin')).toBe(ZKCODEX);
    expect((await res.json()).error.code).toBe('REGION_RESTRICTED');
  });
});

describe('GET /api/launch-config', () => {
  it('names the deployment new launches go to', async () => {
    const res = getLaunchConfig();
    if (!publicEnv.newest) {
      expect(res.status).toBe(503);
      return;
    }
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.chainId).toBe(8453);
    expect(body.factory).toBe(publicEnv.newest.factory);
    expect(body.deployBlock).toBe(publicEnv.newest.deployBlock.toString());
    expect(body.urls.token).toBe(`${publicEnv.appUrl}/token/{address}`);
    expect(res.headers.get('cache-control')).toContain('max-age=300');
  });
});
