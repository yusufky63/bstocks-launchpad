/** How long a signed launch or swap stays valid: ten minutes, the same budget o1 uses. */
export const TX_DEADLINE_SECONDS = 600n;

/**
 * The deadline to sign into a transaction: ten minutes past the later of the chain's latest block
 * time and this device's clock. A device clock running behind the chain would otherwise hand out a
 * deadline that is already close to expiry, and one running ahead only adds slack.
 *
 * Callers compute it just before the wallet opens, after any approval has confirmed, so waiting
 * on an approval never eats into the budget.
 */
export function txDeadline(latestBlockTs: bigint, nowMs = Date.now()): bigint {
  const local = BigInt(Math.floor(nowMs / 1000));
  return (latestBlockTs > local ? latestBlockTs : local) + TX_DEADLINE_SECONDS;
}
