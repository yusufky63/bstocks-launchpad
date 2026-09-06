import 'server-only';

import { getAddress, namehash, parseAbi, type Address, type Hex } from 'viem';

import { getPublicClient } from './chain.server';

/**
 * Basenames are ENS-style names issued by Coinbase on Base (e.g. "yusuf.base.eth"). Resolution is
 * two steps against the Base L2 resolver: a reverse lookup that maps an address to a name, then a
 * forward lookup that must map that name back to the same address. Only a name that round-trips is
 * trusted — anyone can set a reverse record, so the forward check is what makes it safe to display.
 */
const L2_RESOLVER = '0xC6d566A56A1aFf6508b41f6c90ff131615583BCD' as const satisfies Address;

/** Base mainnet reverse namespace: chain id 8453 encoded as 0x80002105 per ENSIP-11. */
const REVERSE_SUFFIX = '80002105.reverse';

const resolverAbi = parseAbi([
  'function name(bytes32 node) view returns (string)',
  'function addr(bytes32 node) view returns (address)',
]);

type CacheEntry = { name: string | null; expiresAt: number };
const cache = (globalThis as typeof globalThis & { __basenames?: Map<string, CacheEntry> }).__basenames ?? new Map();
(globalThis as typeof globalThis & { __basenames?: Map<string, CacheEntry> }).__basenames = cache;

const HIT_TTL = 60 * 60_000; // a name that resolves is stable for an hour
const MISS_TTL = 10 * 60_000; // recheck the unnamed sooner in case they register

function reverseNode(address: string): Hex {
  return namehash(`${address.toLowerCase().slice(2)}.${REVERSE_SUFFIX}`);
}

/**
 * Resolves Base names for a set of addresses, returning a map keyed by lowercase address. Values are
 * the verified basename or null. Results are cached per address; only cache misses hit the chain, and
 * the reverse and forward passes are each a single multicall. Never throws — on any RPC failure the
 * affected addresses resolve to null so the caller falls back to the short address.
 */
export async function resolveBasenames(input: readonly string[]): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  const now = Date.now();

  const unique = Array.from(new Set(input.map((a) => a.toLowerCase()).filter((a) => /^0x[0-9a-f]{40}$/u.test(a))));
  const misses: string[] = [];
  for (const addr of unique) {
    const hit = cache.get(addr);
    if (hit && hit.expiresAt > now) out[addr] = hit.name;
    else misses.push(addr);
  }
  if (misses.length === 0) return out;

  const client = getPublicClient();

  // Pass 1: reverse lookup name() for every miss.
  let names: (string | null)[];
  try {
    const res = await client.multicall({
      allowFailure: true,
      contracts: misses.map((addr) => ({ address: L2_RESOLVER, abi: resolverAbi, functionName: 'name', args: [reverseNode(addr)] as const })),
    });
    names = res.map((r) => (r.status === 'success' && typeof r.result === 'string' && r.result.length > 0 ? r.result : null));
  } catch {
    names = misses.map(() => null);
  }

  // Pass 2: forward-verify each candidate name resolves back to the same address.
  const candidates = misses.map((addr, i) => ({ addr, name: names[i] })).filter((c): c is { addr: string; name: string } => c.name !== null);
  let verified: (Address | null)[] = [];
  if (candidates.length > 0) {
    try {
      const res = await client.multicall({
        allowFailure: true,
        contracts: candidates.map((c) => ({ address: L2_RESOLVER, abi: resolverAbi, functionName: 'addr', args: [namehash(c.name)] as const })),
      });
      verified = res.map((r) => (r.status === 'success' ? (r.result as Address) : null));
    } catch {
      verified = candidates.map(() => null);
    }
  }

  const forwardOk = new Map<string, boolean>();
  candidates.forEach((c, i) => {
    const resolved = verified[i];
    forwardOk.set(c.addr, resolved != null && getAddress(resolved) === getAddress(c.addr as Address));
  });

  for (let i = 0; i < misses.length; i += 1) {
    const addr = misses[i]!;
    const name = names[i] ?? null;
    const good = name !== null && forwardOk.get(addr) === true;
    const value = good ? name : null;
    out[addr] = value;
    cache.set(addr, { name: value, expiresAt: now + (value ? HIT_TTL : MISS_TTL) });
  }
  if (cache.size > 10_000) for (const [k, v] of cache) if (v.expiresAt <= now) cache.delete(k);

  return out;
}
