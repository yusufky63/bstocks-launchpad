import 'server-only';

/**
 * A small fixed-window counter, kept in the instance's own memory.
 *
 * This is not airtight on a serverless platform: every instance counts separately, so the real
 * ceiling is the limit multiplied by however many instances are warm. It is still worth having,
 * because the thing it protects is a single shared Pinata account that serves every token's logo,
 * and the realistic failure is one client in a loop rather than a distributed attack. Bounding that
 * to a few requests a minute per address turns "burned the quota in a minute" into "gets bored".
 */
type Window = { count: number; resetAt: number };

const store = (globalThis as typeof globalThis & { __rateLimit?: Map<string, Window> }).__rateLimit ?? new Map<string, Window>();
(globalThis as typeof globalThis & { __rateLimit?: Map<string, Window> }).__rateLimit = store;

export type RateLimitResult = { ok: boolean; remaining: number; retryAfterSeconds: number };

export function rateLimit(key: string, limit: number, windowMs: number, now = Date.now()): RateLimitResult {
  const existing = store.get(key);
  if (!existing || existing.resetAt <= now) {
    store.set(key, { count: 1, resetAt: now + windowMs });
    if (store.size > 10_000) sweep(now);
    return { ok: true, remaining: limit - 1, retryAfterSeconds: 0 };
  }
  existing.count += 1;
  const retryAfterSeconds = Math.max(1, Math.ceil((existing.resetAt - now) / 1000));
  if (existing.count > limit) return { ok: false, remaining: 0, retryAfterSeconds };
  return { ok: true, remaining: limit - existing.count, retryAfterSeconds };
}

/**
 * Best-effort caller identity. Vercel puts the real client first in `x-forwarded-for`; everything
 * after it is a proxy hop the caller can forge, so only the first entry is used. Requests with no
 * usable address share one bucket rather than escaping the limit entirely.
 */
export function callerKey(request: Request, scope: string): string {
  const forwarded = request.headers.get('x-forwarded-for') ?? '';
  const first = forwarded.split(',')[0]?.trim();
  const ip = first && first.length > 0 ? first : (request.headers.get('x-real-ip')?.trim() || 'unknown');
  return `${scope}:${ip}`;
}

function sweep(now: number): void {
  for (const [key, window] of store) if (window.resetAt <= now) store.delete(key);
}

/** Test seam: drops every counter. */
export function resetRateLimits(): void {
  store.clear();
}
