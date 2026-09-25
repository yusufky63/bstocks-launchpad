import { describe, expect, it } from 'vitest';

import { TX_DEADLINE_SECONDS, txDeadline } from '@/lib/deadline';
import { freshDeadline } from '@/lib/trade';

describe('transaction deadlines', () => {
  it('is ten minutes', () => {
    expect(TX_DEADLINE_SECONDS).toBe(600n);
  });

  it('adds 600 s to the chain time when the chain is ahead of this device', () => {
    expect(txDeadline(1_700_000_100n, 1_700_000_000_000)).toBe(1_700_000_700n);
  });

  it('adds 600 s to the local time when this device is ahead, flooring milliseconds', () => {
    expect(txDeadline(1_700_000_000n, 1_700_000_050_999)).toBe(1_700_000_650n);
  });

  it('reads the latest block at the moment it is asked', async () => {
    let reads = 0;
    const client = { getBlock: async () => ({ timestamp: 9_000_000_000n + BigInt(reads++) }) } as never;
    expect(await freshDeadline(client, 0)).toBe(9_000_000_600n);
    expect(await freshDeadline(client, 0)).toBe(9_000_000_601n);
  });
});
