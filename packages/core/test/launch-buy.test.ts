import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { launchRange, quoteLaunchBuy, sqrtPriceAtTick, tokenIsCurrency0 } from '../src/launch-buy';
import { SUPPLY_RAW } from '../src/math';

/**
 * The vectors are written by packages/contracts/test/LaunchBuyVectors.t.sol from real launchAndBuy
 * calls against v4-core, and re-checked by forge on every run. Matching them to the wei is what lets
 * the create form quote a buy with no onchain view.
 */
const VECTORS = new URL('../../contracts/test/vectors/', import.meta.url);

type Row = Record<string, string | number | boolean>;

function rows(file: string): Row[] {
  return readFileSync(new URL(file, VECTORS), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.trim() !== '')
    .map((line) => JSON.parse(line) as Row);
}

const files = readdirSync(VECTORS).filter((f) => f.endsWith('.jsonl')).sort();

describe('the forge vectors', () => {
  it('are all there, so an empty directory cannot pass', () => {
    expect(files).toEqual(expect.arrayContaining(['launch-buy.jsonl', 'sqrt-price.jsonl']));
    expect(rows('launch-buy.jsonl').length).toBeGreaterThanOrEqual(500);
    expect(rows('sqrt-price.jsonl').length).toBeGreaterThan(0);
  });

  // Every file, every row: a quote row checks each field it carries; a tick row checks TickMath.
  for (const file of files) {
    it(`${file}: every row matches exactly`, () => {
      const all = rows(file);
      let checked = 0;
      for (const row of all) {
        if ('sqrtPriceX96' in row) {
          expect(sqrtPriceAtTick(Number(row.tick)).toString(), `tick ${row.tick}`).toBe(String(row.sqrtPriceX96));
          checked += 1;
          continue;
        }
        const quote = quoteLaunchBuy({
          openingTick: Number(row.tick),
          tokenIsCurrency0: row.tokenIsCurrency0 === true,
          stockIn: BigInt(String(row.stockIn)),
        });
        const label = JSON.stringify(row);
        expect(quote.tokensOut.toString(), label).toBe(String(row.tokensOut));
        if ('tickLower' in row) expect(quote.tickLower, label).toBe(Number(row.tickLower));
        if ('tickUpper' in row) expect(quote.tickUpper, label).toBe(Number(row.tickUpper));
        if ('liquidity' in row) expect(quote.liquidity.toString(), label).toBe(String(row.liquidity));
        if ('sqrtPriceAfterX96' in row) expect(quote.sqrtPriceAfterX96.toString(), label).toBe(String(row.sqrtPriceAfterX96));
        checked += 1;
      }
      expect(checked).toBe(all.length);
    });
  }

  it('cover both orderings, both tick signs and buys up to almost all of the supply', () => {
    const buys = rows('launch-buy.jsonl');
    expect(new Set(buys.map((r) => r.tokenIsCurrency0))).toEqual(new Set([true, false]));
    expect(buys.some((r) => Number(r.tick) < 0)).toBe(true);
    expect(buys.some((r) => Number(r.tick) > 0)).toBe(true);
    expect(buys.some((r) => BigInt(String(r.stockIn)) === 1n)).toBe(true);
    expect(buys.some((r) => BigInt(String(r.tokensOut)) * 10_000n >= SUPPLY_RAW * 9_999n)).toBe(true);
  });
});

describe('sqrtPriceAtTick', () => {
  it('matches the TickMath bounds and refuses anything outside them', () => {
    expect(sqrtPriceAtTick(-887_272)).toBe(4_295_128_739n);
    expect(sqrtPriceAtTick(887_272)).toBe(1_461_446_703_485_210_103_287_273_052_203_988_822_378_723_970_342n);
    expect(sqrtPriceAtTick(0)).toBe(1n << 96n);
    expect(() => sqrtPriceAtTick(887_273)).toThrow(RangeError);
    expect(() => sqrtPriceAtTick(-887_273)).toThrow(RangeError);
    expect(() => sqrtPriceAtTick(1.5)).toThrow(RangeError);
  });
});

describe('tokenIsCurrency0 and launchRange', () => {
  it('orders by address value, whatever the case', () => {
    expect(tokenIsCurrency0('0xb2000000000000000000000000000000000000AA', '0xB20000000000000000000078ee7ce2fE4908108C')).toBe(true);
    expect(tokenIsCurrency0('0xc200000000000000000000000000000000000000', '0xB20000000000000000000078ee7ce2fE4908108C')).toBe(false);
  });

  it('floors toward minus infinity and puts the range on the far side of the price', () => {
    expect(launchRange(true, -450_355)).toMatchObject({ tickLower: -450_300, tickUpper: 887_200 });
    expect(launchRange(false, 449_612)).toMatchObject({ tickLower: -887_200, tickUpper: 449_600 });
    expect(launchRange(false, -1)).toMatchObject({ tickUpper: -100 });
    expect(launchRange(true, -1)).toMatchObject({ tickLower: 0 });
  });

  it('throws when no range is left above the price', () => {
    expect(() => launchRange(true, 887_100)).toThrow(RangeError);
    expect(() => launchRange(false, -887_200)).toThrow(RangeError);
  });
});

describe('quoteLaunchBuy', () => {
  const cases = [
    { openingTick: 449_612, tokenIsCurrency0: false },
    { openingTick: -450_355, tokenIsCurrency0: true },
    { openingTick: 433_724, tokenIsCurrency0: false },
    { openingTick: -406_700, tokenIsCurrency0: true },
  ];

  it('never gives fewer tokens for more stock, until the position runs out', () => {
    for (const c of cases) {
      let previous = -1n;
      let stockIn = 1n;
      let quoted = 0;
      for (;;) {
        let out: bigint;
        try {
          out = quoteLaunchBuy({ ...c, stockIn }).tokensOut;
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          break;
        }
        expect(out >= previous, `${JSON.stringify(c)} at ${stockIn}`).toBe(true);
        // One more raw unit never lowers the output either.
        expect(quoteLaunchBuy({ ...c, stockIn: stockIn + 1n }).tokensOut >= out).toBe(true);
        previous = out;
        quoted += 1;
        stockIn = (stockIn * 3n) / 2n + 1n;
      }
      expect(quoted).toBeGreaterThan(20);
      expect(previous).toBeLessThan(SUPPLY_RAW);
    }
  });

  it('charges no fee below 100 raw units, then 1% floored, and books 70% of it back', () => {
    for (const stockIn of [1n, 2n, 50n, 99n]) {
      expect(quoteLaunchBuy({ ...cases[0]!, stockIn }).fee).toBe(0n);
      expect(quoteLaunchBuy({ ...cases[0]!, stockIn }).creatorFeeBack).toBe(0n);
    }
    expect(quoteLaunchBuy({ ...cases[0]!, stockIn: 100n }).fee).toBe(1n);
    expect(quoteLaunchBuy({ ...cases[0]!, stockIn: 199n }).fee).toBe(1n);
    const hundred = quoteLaunchBuy({ ...cases[0]!, stockIn: 100n * 10n ** 8n });
    expect(hundred.fee).toBe(10n ** 8n);
    expect(hundred.creatorFeeBack).toBe(70_000_000n);
  });

  it('reports the share of supply in basis points and parts per million, floored', () => {
    const q = quoteLaunchBuy({ ...cases[0]!, stockIn: 100n * 10n ** 8n });
    expect(q.supplyBps).toBe((q.tokensOut * 10_000n) / SUPPLY_RAW);
    expect(q.supplyPpm).toBe((q.tokensOut * 1_000_000n) / SUPPLY_RAW);
    expect(q.supplyPpm / 100n).toBe(q.supplyBps);
  });

  it('throws for a zero or negative amount and for a buy that would exhaust the position', () => {
    for (const c of cases) {
      expect(() => quoteLaunchBuy({ ...c, stockIn: 0n })).toThrow(RangeError);
      expect(() => quoteLaunchBuy({ ...c, stockIn: -1n })).toThrow(RangeError);
      expect(() => quoteLaunchBuy({ ...c, stockIn: 10n ** 40n })).toThrow(/exhaust/u);
    }
  });
});
