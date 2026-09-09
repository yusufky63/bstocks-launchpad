import { beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedDb, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import {
  insertLaunch,
  readTokenProfile,
  restoreArchivedProfiles,
  rollbackFrom,
  upsertBlock,
  upsertTokenProfile,
} from '../src/db/queries';
import { BASE_STOCKS } from '../src/stocks';

const NVDAc = BASE_STOCKS[0]!.address.toLowerCase();
const TOKEN = '0xb2000000000000000000000000000000000000aa';
const CREATOR = '0x1111111111111111111111111111111111111111';

let db: Db;

async function launchAt(block: bigint) {
  await upsertBlock(db, { number: block, hash: `0xb${block}`, parentHash: '0xb0', timestamp: new Date('2026-09-05T12:00:00Z') });
  await insertLaunch(db, {
    token: TOKEN, stock: NVDAc, creator: CREATOR, poolId: `0x${'ab'.repeat(32)}`,
    tokenIsCurrency0: false, name: 'Test', symbol: 'TEST', contractUri: 'ipfs://x',
    openingSqrtPriceX96: 1n, tickLower: -887_200, tickUpper: 100, liquidity: 10n ** 20n,
    stockUsd8: 22_995_730_000n, blockNumber: block, blockHash: `0xb${block}`, txHash: '0xt1',
    logIndex: 0, launchedAt: new Date('2026-09-05T12:00:00Z'),
  });
}

const PROFILE = {
  token: TOKEN, description: 'signed by the creator', imageUri: 'ipfs://img',
  website: 'https://example.test', twitter: 'https://x.com/creator', telegram: null,
  signer: CREATOR, signature: '0xdeadbeef', issuedAt: new Date('2026-09-05T13:00:00Z'),
};

describe('a reorg over a launch that has a creator-signed profile', () => {
  beforeEach(async () => {
    db = await createEmbeddedDb();
    await migrate(db);
    await launchAt(50_900_010n);
    await upsertTokenProfile(db, PROFILE);
  });

  // The profile is the only thing in the database that no re-index can reproduce: it was signed by
  // the creator and the signature cannot be replayed past its max age.
  it('keeps the profile instead of destroying it, and gives it back when the launch re-indexes', async () => {
    expect(await readTokenProfile(db, TOKEN)).not.toBeNull();

    await rollbackFrom(db, 50_900_010n);
    expect(await readTokenProfile(db, TOKEN)).toBeNull();

    // Same creator and salt produce the same token address, so the replayed launch is the same one.
    await launchAt(50_900_010n);
    const restored = await restoreArchivedProfiles(db, [TOKEN]);
    expect(restored).toBe(1);

    const profile = await readTokenProfile(db, TOKEN);
    expect(profile?.description).toBe('signed by the creator');
    expect(profile?.signature).toBe('0xdeadbeef');
    expect(profile?.signer).toBe(CREATOR);
  });

  it('restores nothing for a token whose launch did not come back', async () => {
    await rollbackFrom(db, 50_900_010n);
    expect(await restoreArchivedProfiles(db, [TOKEN])).toBe(0);
    expect(await readTokenProfile(db, TOKEN)).toBeNull();
  });

  it('leaves a profile alone when the rollback is above its launch', async () => {
    await rollbackFrom(db, 50_900_011n);
    expect(await readTokenProfile(db, TOKEN)).not.toBeNull();
  });

  it('does not restore a profile twice', async () => {
    await rollbackFrom(db, 50_900_010n);
    await launchAt(50_900_010n);
    expect(await restoreArchivedProfiles(db, [TOKEN])).toBe(1);
    expect(await restoreArchivedProfiles(db, [TOKEN])).toBe(0);
  });
});
