import { describe, expect, it } from 'vitest';

import { featuredFirst, pickFeatured, withoutFeatured } from '@/lib/featured';

const STOCK = '0xb20000000000000000000023b657130129ad33e5';
const row = (token: string) => ({ token });

describe('the featured token', () => {
  const markets = [row('0xaa'), row(STOCK.toUpperCase().replace('0X', '0x')), row('0xbb')];

  it('goes first in the ticker, whatever case the address is in', () => {
    expect(featuredFirst(markets, STOCK).map((m) => m.token.toLowerCase())).toEqual([STOCK, '0xaa', '0xbb']);
  });

  it('is left out of the top list, since it has its own card', () => {
    expect(withoutFeatured(markets, STOCK).map((m) => m.token)).toEqual(['0xaa', '0xbb']);
  });

  it('falls back to the server read once the list no longer holds it', () => {
    expect(pickFeatured(markets, STOCK)?.token.toLowerCase()).toBe(STOCK);
    expect(pickFeatured([row('0xaa')], STOCK, row(STOCK))?.token).toBe(STOCK);
    expect(pickFeatured([row('0xaa')], STOCK)).toBeNull();
  });
});
