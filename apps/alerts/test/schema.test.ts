import { beforeEach, describe, expect, it } from 'vitest';

import { createEmbeddedDb, migrate, SCHEMA_VERSION, type Db } from '@stockpair/core/db';

import { schemaProblem } from '../src/schema';

let db: Db;

describe('whether the database can serve this build yet', () => {
  beforeEach(async () => {
    db = await createEmbeddedDb();
  });

  it('is ready once the indexer has migrated it', async () => {
    await migrate(db);
    expect(await schemaProblem(db)).toBeNull();
  });

  // What a database the indexer has not reached looks like to the query every card starts with.
  it('names what is missing while the migration has not run', async () => {
    await migrate(db);
    await db.exec('DROP TABLE metadata_updates CASCADE');
    expect(await schemaProblem(db)).toMatch(/metadata_updates/u);
  });

  it('is not ready on a database with no schema at all', async () => {
    expect(await schemaProblem(db)).not.toBeNull();
  });

  // A skipped index leaves the version unrecorded with every table in place, and the channel
  // should not go quiet over an index.
  it('does not wait on the version number when the tables are all there', async () => {
    await migrate(db);
    await db.query('DELETE FROM schema_version WHERE version = $1', [SCHEMA_VERSION]);
    expect(await schemaProblem(db)).toBeNull();
  });
});
