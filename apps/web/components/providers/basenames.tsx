'use client';

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';

/**
 * Collects the addresses being rendered anywhere in the tree and resolves their Base names in one
 * batched request, so a table of 50 holders costs a single round trip instead of 50. Names are
 * cached for the session; `useBasename` returns undefined while loading, then the name or null.
 */
type Ctx = { get: (address: string) => string | null | undefined; register: (address: string) => void };
const BasenamesContext = createContext<Ctx | null>(null);

export function BasenamesProvider({ children }: { children: ReactNode }) {
  const [names, setNames] = useState<Record<string, string | null>>({});
  const namesRef = useRef(names);
  namesRef.current = names;
  const pending = useRef<Set<string>>(new Set());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(() => {
    timer.current = null;
    const batch = Array.from(pending.current).filter((a) => namesRef.current[a] === undefined);
    pending.current.clear();
    if (batch.length === 0) return;
    // Mark as in-flight so we do not requeue the same address before the response lands.
    for (let i = 0; i < batch.length; i += 100) {
      const chunk = batch.slice(i, i + 100);
      fetch(`/api/names?a=${chunk.join(',')}`, { cache: 'no-store' })
        .then((r) => (r.ok ? (r.json() as Promise<{ names: Record<string, string | null> }>) : null))
        .then((body) => {
          if (!body) return;
          setNames((prev) => {
            const next = { ...prev };
            for (const addr of chunk) next[addr] = body.names[addr] ?? null;
            return next;
          });
        })
        .catch(() => {
          setNames((prev) => {
            const next = { ...prev };
            for (const addr of chunk) if (next[addr] === undefined) next[addr] = null;
            return next;
          });
        });
    }
  }, []);

  const register = useCallback(
    (address: string) => {
      const key = address.toLowerCase();
      if (!/^0x[0-9a-f]{40}$/u.test(key)) return;
      if (namesRef.current[key] !== undefined || pending.current.has(key)) return;
      pending.current.add(key);
      if (timer.current === null) timer.current = setTimeout(flush, 60);
    },
    [flush],
  );

  const get = useCallback((address: string) => names[address.toLowerCase()], [names]);

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return <BasenamesContext.Provider value={{ get, register }}>{children}</BasenamesContext.Provider>;
}

/** Returns the Base name for an address: undefined while resolving, a name, or null if it has none. */
export function useBasename(address: string | undefined | null): string | null | undefined {
  const ctx = useContext(BasenamesContext);
  const key = address ? address.toLowerCase() : '';
  useEffect(() => {
    if (ctx && key) ctx.register(key);
  }, [ctx, key]);
  if (!ctx || !key) return null;
  return ctx.get(key);
}
