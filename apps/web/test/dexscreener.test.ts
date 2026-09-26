import { afterEach, describe, expect, it, vi } from 'vitest';

import { GET as getDexPaid } from '@/app/api/tokens/[address]/dex-paid/route';
import { invalidate } from '@/lib/cache.server';
import { resetRateLimits } from '@/lib/rate-limit.server';

import { dexPaidStatus, fetchDexPaidStatus } from '@/lib/dexscreener';


afterEach(() => {
  vi.unstubAllGlobals();
  invalidate();
  resetRateLimits();
});
describe('DEX Screener paid orders', () => {
  it('shows paid only for an approved order and keeps processing separate', () => {
    expect(dexPaidStatus([{ type: 'tokenProfile', status: 'approved', paymentTimestamp: 123 }])).toBe('approved');
    expect(dexPaidStatus([{ type: 'tokenAd', status: 'on-hold', paymentTimestamp: 123 }])).toBe('pending');
    expect(dexPaidStatus([{ type: 'tokenProfile', status: 'rejected' }])).toBe('none');
    expect(dexPaidStatus([])).toBe('none');
  });

  it('reads the live orders envelope without counting boosts as paid profiles', () => {
    expect(dexPaidStatus({ orders: [{ type: 'tokenProfile', status: 'approved' }], boosts: [] })).toBe('approved');
    expect(dexPaidStatus({ orders: [{ type: 'tokenAd', status: 'processing' }], boosts: [] })).toBe('pending');
    expect(dexPaidStatus({ orders: [], boosts: [{ amount: 100 }] })).toBe('none');
    expect(dexPaidStatus({ orders: [{ type: 'unknown', status: 'approved' }] })).toBe('none');
  });

  it('serves and caches an approved Base token order', async () => {
    const token = '0x0000000000000000000000000000000000000001';
    const request = new Request(`http://localhost/api/tokens/${token}/dex-paid`);
    const context = { params: Promise.resolve({ address: token }) };
    const upstream = vi.fn(async (_input: RequestInfo | URL) => Response.json({ orders: [{ type: 'tokenProfile', status: 'approved' }], boosts: [] }));
    vi.stubGlobal('fetch', upstream);
    expect(await (await getDexPaid(request, context)).json()).toEqual({ status: 'approved' });
    expect(await (await getDexPaid(request, context)).json()).toEqual({ status: 'approved' });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0]?.[0]).toBe(`https://api.dexscreener.com/orders/v1/base/${token}`);
  });
  it('does not treat a malformed or unavailable response as unpaid', async () => {
    expect(dexPaidStatus({ orders: null })).toBe('unavailable');
    expect(dexPaidStatus({ boosts: [] })).toBe('unavailable');
    const unavailable = (async () => new Response(null, { status: 503 })) as typeof fetch;
    expect(await fetchDexPaidStatus('0x0000000000000000000000000000000000000001', unavailable)).toBe('unavailable');
  });
});