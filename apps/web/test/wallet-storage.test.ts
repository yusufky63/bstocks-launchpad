import { describe, expect, it } from 'vitest';

import { walletStorage } from '@/lib/wagmi';

/** A key-value store that keeps what it is given, or refuses everything like a blocked frame. */
function store(refuse = false) {
  const map = new Map<string, string>();
  const guard = () => {
    if (refuse) throw new Error('SecurityError: storage is refused in this frame');
  };
  return {
    map,
    getItem: (key: string) => (guard(), map.get(key) ?? null),
    setItem: (key: string, value: string) => (guard(), void map.set(key, value)),
    removeItem: (key: string) => (guard(), void map.delete(key)),
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    key: () => null,
  };
}

describe('wallet storage', () => {
  it('keeps the connected wallet in both the cookie and the browser', () => {
    const cookies = store();
    const local = store();
    const storage = walletStorage(cookies, () => local as unknown as Storage);
    storage.setItem('wagmi.store', 'connected');
    expect(cookies.map.get('wagmi.store')).toBe('connected');
    expect(local.map.get('wagmi.store')).toBe('connected');
    storage.removeItem('wagmi.store');
    expect(cookies.map.size + local.map.size).toBe(0);
  });

  it('reads the cookie first, which the server renders from', () => {
    const cookies = store();
    const local = store();
    cookies.map.set('k', 'from-cookie');
    local.map.set('k', 'from-local');
    expect(walletStorage(cookies, () => local as unknown as Storage).getItem('k')).toBe('from-cookie');
  });

  it("remembers the wallet in a widget whose frame is refused the cookie", () => {
    // In a cross-site iframe a Lax cookie is never set: writes vanish and reads come back empty.
    const cookies = { getItem: () => null, setItem: () => undefined, removeItem: () => undefined };
    const local = store();
    const storage = walletStorage(cookies, () => local as unknown as Storage);
    storage.setItem('wagmi.recentConnectorId', 'injected');
    expect(storage.getItem('wagmi.recentConnectorId')).toBe('injected');
  });

  it('never throws when every store is refused, and just forgets', () => {
    const storage = walletStorage(store(true), () => store(true) as unknown as Storage);
    expect(() => storage.setItem('k', 'v')).not.toThrow();
    expect(storage.getItem('k')).toBeNull();
    expect(() => storage.removeItem('k')).not.toThrow();
    // No window at all, as on the server.
    expect(walletStorage(store(), () => null).getItem('missing')).toBeNull();
  });
});
