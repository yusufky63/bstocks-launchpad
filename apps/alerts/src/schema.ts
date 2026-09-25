import { readMarket, type Db } from '@stockpair/core/db';

/** No launch has this address, so the probe finds nothing and only has to run. */
const NO_TOKEN = '0x0000000000000000000000000000000000000000';

/**
 * Why the database cannot serve this build's queries yet, or null when it can.
 *
 * Only the indexer migrates, and it deploys separately from this service. Until it has, every
 * card's market read fails, so each pass deferred every row one log line at a time while /health
 * said nothing was wrong. The probe is the read every card starts with rather than the version
 * number: a migration that skipped an index leaves the version behind with every table and column
 * already in place, and waiting on the number would stop the channel for no reason.
 */
export async function schemaProblem(db: Db): Promise<string | null> {
  try {
    await readMarket(db, NO_TOKEN);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
