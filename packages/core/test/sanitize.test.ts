import { beforeAll, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { insertLaunch, listMarkets, readMarket, sanitizeText, updateLaunchMetadata } from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const NUL = String.fromCodePoint(0);
const DEL = String.fromCodePoint(0x7f);

let db: Db;

function launchWith(token: string, name: string, symbol: string, contractUri: string) {
  return insertLaunch(db, {
    token, stock: NVDAc, creator: '0x1111111111111111111111111111111111111111',
    poolId: '0x' + token.slice(-2).repeat(32), tokenIsCurrency0: false,
    name, symbol, contractUri,
    openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
    stockUsd8: 22_995_730_000n, blockNumber: 50_900_001n, blockHash: '0xb1',
    txHash: '0xt' + token.slice(-4), logIndex: 0, launchedAt: new Date('2026-09-05T12:00:00Z'),
  });
}

describe('sanitizeText', () => {
  it('drops the bytes Postgres refuses to store', () => {
    expect(sanitizeText(NUL)).toBe('');
    expect(sanitizeText('ab' + NUL + 'cd')).toBe('abcd');
    expect(sanitizeText('a' + DEL + 'b')).toBe('ab');
  });

  it('leaves ordinary text, punctuation and emoji alone', () => {
    expect(sanitizeText('Doge Coin')).toBe('Doge Coin');
    expect(sanitizeText('ünïcode $TOKEN')).toBe('ünïcode $TOKEN');
    expect(sanitizeText('rocket 🚀')).toBe('rocket 🚀');
  });

  it('trims, so a name made only of control bytes becomes empty rather than whitespace', () => {
    expect(sanitizeText('  spaced  ')).toBe('spaced');
  });
});

describe('a launch carrying control bytes', () => {
  beforeAll(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
  });

  // The factory validates byte length only, so a one-byte NUL name is a legal launch. Postgres
  // rejects it, the batch rolls back, the cursor never advances, and the indexer retries the same
  // range forever. This is the regression test for that: the write must succeed.
  it('is stored instead of failing the batch and stalling the indexer', async () => {
    const token = '0xb2000000000000000000000000000000000000aa';
    await expect(launchWith(token, NUL, 'A' + NUL + 'B', 'ipfs://x' + NUL)).resolves.toBeUndefined();

    const row = await readMarket(db, token);
    expect(row).not.toBeNull();
    expect(row!.name).toBe('');
    expect(row!.symbol).toBe('AB');
    expect(row!.contract_uri).toBe('ipfs://x');
  });

  it('does not stop the launches after it from being indexed', async () => {
    const good = '0xb2000000000000000000000000000000000000bb';
    await launchWith(good, 'Good Token', 'GOOD', 'ipfs://y');
    const rows = await listMarkets(db, {});
    expect(rows.map((r) => r.symbol).sort()).toEqual(['AB', 'GOOD']);
  });

  it('sanitises metadata fetched from the launcher-supplied URI too', async () => {
    const token = '0xb2000000000000000000000000000000000000aa';
    await expect(
      updateLaunchMetadata(db, token, {
        description: 'hello' + NUL,
        imageUri: 'ipfs://img' + NUL,
        website: 'https://a.example' + NUL,
        twitter: 'https://x.com/handle' + NUL,
      }),
    ).resolves.toBeUndefined();
    const row = await readMarket(db, token);
    expect(row!.description).toBe('hello');
    expect(row!.image_uri).toBe('ipfs://img');
    expect(row!.website).toBe('https://a.example');
  });
});
