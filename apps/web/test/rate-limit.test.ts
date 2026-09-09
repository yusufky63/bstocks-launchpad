import { beforeEach, describe, expect, it } from 'vitest';

import { callerKey, rateLimit, resetRateLimits } from '@/lib/rate-limit.server';

const req = (headers: Record<string, string>) => new Request('https://example.test/api/metadata', { headers });

describe('rateLimit', () => {
  beforeEach(() => resetRateLimits());

  it('allows up to the limit and refuses past it', () => {
    for (let i = 0; i < 3; i += 1) expect(rateLimit('k', 3, 60_000, 1_000).ok).toBe(true);
    const refused = rateLimit('k', 3, 60_000, 1_000);
    expect(refused.ok).toBe(false);
    expect(refused.retryAfterSeconds).toBe(60);
  });

  it('starts a fresh window once the old one expires', () => {
    for (let i = 0; i < 3; i += 1) rateLimit('k', 3, 60_000, 1_000);
    expect(rateLimit('k', 3, 60_000, 1_000).ok).toBe(false);
    expect(rateLimit('k', 3, 60_000, 62_000).ok).toBe(true);
  });

  it('counts each caller separately', () => {
    for (let i = 0; i < 3; i += 1) rateLimit('a', 3, 60_000, 1_000);
    expect(rateLimit('a', 3, 60_000, 1_000).ok).toBe(false);
    expect(rateLimit('b', 3, 60_000, 1_000).ok).toBe(true);
  });
});

describe('callerKey', () => {
  beforeEach(() => resetRateLimits());

  // Only the first entry is the real client; the rest are proxy hops a caller can append at will.
  it('takes the first address in x-forwarded-for, not the last', () => {
    expect(callerKey(req({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' }), 'm')).toBe('m:1.2.3.4');
  });

  it('cannot be escaped by appending forged hops', () => {
    const a = callerKey(req({ 'x-forwarded-for': '1.2.3.4' }), 'm');
    const b = callerKey(req({ 'x-forwarded-for': '1.2.3.4, 9.9.9.9' }), 'm');
    expect(a).toBe(b);
  });

  it('falls back to x-real-ip, then to a shared bucket', () => {
    expect(callerKey(req({ 'x-real-ip': '4.4.4.4' }), 'm')).toBe('m:4.4.4.4');
    expect(callerKey(req({}), 'm')).toBe('m:unknown');
  });

  it('keeps scopes apart so one endpoint cannot exhaust another', () => {
    expect(callerKey(req({ 'x-real-ip': '4.4.4.4' }), 'a')).not.toBe(callerKey(req({ 'x-real-ip': '4.4.4.4' }), 'b'));
  });
});
