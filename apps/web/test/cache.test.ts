import { describe, expect, it, vi } from 'vitest';

import { cached, invalidate, withTimeout } from '@/lib/cache.server';

describe('cached', () => {
  it('shares one load between concurrent callers', async () => {
    invalidate();
    let runs = 0;
    const load = async () => {
      runs += 1;
      await new Promise((r) => setTimeout(r, 10));
      return runs;
    };
    const [a, b, c] = await Promise.all([cached('k1', 1_000, load), cached('k1', 1_000, load), cached('k1', 1_000, load)]);
    expect(runs).toBe(1);
    expect([a, b, c]).toEqual([1, 1, 1]);
  });

  it('serves the cached value until the ttl expires', async () => {
    invalidate();
    let runs = 0;
    const load = async () => ++runs;
    expect(await cached('k2', 50, load)).toBe(1);
    expect(await cached('k2', 50, load)).toBe(1);
    await new Promise((r) => setTimeout(r, 60));
    expect(await cached('k2', 50, load)).toBe(2);
  });

  it('stops sharing a load that never settles, so one stall cannot poison the key', async () => {
    vi.useFakeTimers();
    try {
      invalidate();
      let started = 0;
      // The first load hangs forever; the second resolves normally.
      const hang = () => {
        started += 1;
        return new Promise<string>(() => {});
      };
      const ok = () => {
        started += 1;
        return Promise.resolve('fresh');
      };

      void cached('k3', 1_000, hang);
      expect(started).toBe(1);

      // While it is still within the deadline, a second caller joins the same stalled load.
      void cached('k3', 1_000, ok);
      expect(started).toBe(1);

      // Past the deadline the stalled load is retracted and the next caller runs its own.
      await vi.advanceTimersByTimeAsync(13_000);
      const value = await cached('k3', 1_000, ok);
      expect(value).toBe('fresh');
      expect(started).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('withTimeout', () => {
  it('falls back when the promise is too slow, and does not throw when it later rejects', async () => {
    const slow = new Promise((_r, reject) => setTimeout(() => reject(new Error('late')), 50));
    await expect(withTimeout(slow, 10, 'fallback')).resolves.toBe('fallback');
    await new Promise((r) => setTimeout(r, 60));
  });

  it('passes the value through when it arrives in time', async () => {
    await expect(withTimeout(Promise.resolve('quick'), 1_000, 'fallback')).resolves.toBe('quick');
  });
});
