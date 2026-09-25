import type { Address } from 'viem';

import { findDeployment, type StockPairDeployment } from '@stockpair/core';

/**
 * The deployment a launch belongs to. Every factory and hook stays live after a newer one ships,
 * so a token's pool key, fee reads, claims and router all come from the pair that launched it.
 *
 * Rows the indexer stored before it recorded `factory` and `hook` all came from the only deployment
 * there was then, the oldest. A hook this build does not know returns null rather than a guess.
 */
export function deploymentOf(
  deployments: readonly StockPairDeployment[],
  launch: { hook?: string | null; factory?: string | null },
): StockPairDeployment | null {
  const key = launch.hook ?? launch.factory;
  if (!key) return deployments[0] ?? null;
  return findDeployment(deployments, key);
}

/** The hook in a launch's pool key: the stored one, else the oldest deployment's (see above). */
export function hookOf(deployments: readonly StockPairDeployment[], launch: { hook?: string | null }): Address | null {
  if (launch.hook) return launch.hook.toLowerCase() as Address;
  return deployments[0]?.hook ?? null;
}

/**
 * Distinct hooks across deployments, in deployment order. A list read from the env never repeats a
 * hook (readDeployments refuses one that does); this still dedupes, so no hook is read twice.
 */
export function distinctHooks(deployments: readonly StockPairDeployment[]): Address[] {
  const seen = new Set<string>();
  const out: Address[] = [];
  for (const d of deployments) {
    const key = d.hook.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d.hook);
  }
  return out;
}

/** One `claimMany` per hook, each with the stocks that hook owes the account. First-seen order. */
export function claimsByHook(balances: readonly { stock: string; hook: string }[]): { hook: Address; stocks: Address[] }[] {
  const byHook = new Map<string, { hook: Address; stocks: Address[] }>();
  for (const b of balances) {
    const key = b.hook.toLowerCase();
    const entry = byHook.get(key) ?? { hook: b.hook as Address, stocks: [] };
    if (!entry.stocks.some((s) => s.toLowerCase() === b.stock.toLowerCase())) entry.stocks.push(b.stock as Address);
    byHook.set(key, entry);
  }
  return [...byHook.values()];
}
