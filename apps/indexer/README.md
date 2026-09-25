# StockPair indexer in production

The indexer is a single long-running process, not a serverless function: it polls Base every few
seconds, keeps a cursor in Postgres and must never run twice against the same database (two
copies would race on the cursor). Run **exactly one instance**, restart it on crash, and point it
at the same `DATABASE_URL` the web app reads.

## Where to run it

| Option | Fit |
| --- | --- |
| Railway / Render / Fly.io (Docker) | Simplest: build `apps/indexer/Dockerfile`, set the env, one replica, health check on `:8788/health`. |
| A small VPS with systemd or pm2 | Cheapest; `pnpm --filter @stockpair/indexer exec tsx src/main.ts` under a restart policy. |
| Vercel | **Not suitable.** Vercel runs request-scoped functions; there is no place for a loop that must stay alive. Keep the web app on Vercel and the indexer elsewhere. |

## Environment

Copy `apps/indexer/.env` (same keys as the local file):

```
DATABASE_URL=postgres://…          # the Supabase pooler URL the web app uses
BASE_RPC_URL=https://…             # dedicated RPC (Alchemy/QuickNode); public RPCs rate-limit eth_getLogs
BASE_RPC_URL_FALLBACK=https://…
STOCKPAIR_DEPLOYMENTS=[{"factory":"0x…","hook":"0x…","router":"0x…","deployBlock":…}]
INDEXER_CONFIRMATIONS=3
INDEXER_POLL_MS=2000
IPFS_GATEWAY=https://gateway.pinata.cloud
INDEXER_HEALTH_PORT=8788
```

`STOCKPAIR_DEPLOYMENTS` lists every deployment, oldest first, on one line. Without it, the single
`STOCKPAIR_FACTORY`, `STOCKPAIR_HOOK`, `STOCKPAIR_ROUTER` and `STOCKPAIR_DEPLOY_BLOCK` keys describe
one deployment. A list that does not parse, repeats a factory or hook, or goes back in deploy block
stops the indexer at start with the entry at fault, rather than being half-read. Leave the single
keys naming the first deployment even once the list is set: the release that predates the list
reads only those.

## Release order

The web app and the alerts service read the newest schema; the indexer is what migrates it. Ship in
this order (if Railway and Vercel both deploy on push, do step 1 before pushing):

1. **Migrate production.** `pnpm db:migrate` from the repository root (it reads `DATABASE_URL` from
   `apps/indexer/.env`), or deploy the indexer first: it migrates when it starts. Confirm
   `SELECT max(version) FROM schema_version` returns the new version (8 for the multi-deployment
   release) before anything else goes out. The release already running keeps working meanwhile:
   version 8 only adds tables and columns, each new column is nullable or has a default, the old
   code's inserts name their columns, the old reorg rollback takes a launch's `metadata_updates` rows
   with it (`ON DELETE CASCADE`), and the old indexer's own migrate only re-runs its `IF NOT EXISTS`
   statements. `migrate()` leaves a database a newer release has migrated untouched, so rolling code
   back is safe as well.
2. **Deploy the indexer, environment unchanged.** On its first start it checks every factory's hook
   onchain, stamps each existing launch (STOCK included) with the factory its own Launched receipt
   names, and records the deployment the old cursor followed as indexed. If a stored launch was made
   by a factory the list does not name, or a factory is wired to a different hook, it exits with the
   reason instead of indexing: fix the list, never the database.
3. **Deploy the web app and the alerts service.** Not before step 1: on a version 7 database every
   market read fails, STOCK's included.
4. **New contracts, whenever they come.** See below.

## Adding a deployment

Earlier factories and hooks stay live after a new deployment: their tokens, STOCK included, keep
trading, earning fees and claiming. The indexer reads all of them, so a new deployment is added,
never swapped in, and the database is never reset for it.

1. Append the new entry to the end of `STOCKPAIR_DEPLOYMENTS`. `node scripts/apply-deployment.mjs`
   builds the list from every committed record in `packages/contracts/deployments` (`base.json` is
   the first deployment) plus what the local env files hold, checks onchain that a deployment its
   broadcast did not confirm really has code, and prints the list; set the same value on the
   production host. Never remove or reorder an entry: the indexer refuses to start without a
   deployment it has already indexed.
2. Restart the indexer. Before it moves the cursor again it:
   - checks the list against the database and the chain, and stamps any launch stored without its
     deployment with the factory that emitted it (see Release order, step 2);
   - gives every deployment whose indexed range stops short of the cursor a catch-up pass over the
     missing stretch: [deploy block, cursor) for one just added, or the blocks an older release
     covered without it after a rollback. The pass reads only that deployment's factory and hook and
     the pools and tokens they reveal, and queues no Telegram alerts for that history. If the cursor
     moves while it runs (a second writer that should not exist), it reads that stretch too. It is
     recorded in `indexed_deployments` once it has committed; a pass that fails is rerun on the next
     poll, and every write it makes is idempotent;
   - records a deployment whose deploy block is at or above the cursor without a pass, since the
     main loop reaches it anyway.
3. From then on each range reads every factory and hook and moves every deployment's
   `caught_up_through` with the cursor, and each launch row keeps the `factory` and `hook` that made
   it. A deployment whose range no longer reaches the cursor (a second writer moved it) is not
   advanced; the loop runs its catch-up before the next pass instead of waiting for a restart.

Profile documents are fetched beside the chain sync, one run at a time with a 30-second budget, so a
URI that hangs delays profiles but never trades, alerts or the cursor. An onchain profile change
restarts a failing fetch's backoff at most once an hour.

Stocks' `enabled` flags mirror the newest factory, which is what the create form offers. Prices keep
refreshing for every stock that has a launch as well, so disabling a stock on an older factory does
not freeze its tokens' USD values.

Never point a local indexer at the production database: two indexers race on one cursor.

## Docker

```bash
docker build -f apps/indexer/Dockerfile -t stockpair-indexer .
docker run --env-file apps/indexer/.env -p 8788:8788 stockpair-indexer
```

## Checks

- `GET :8788/health` returns `lastSync`, `head`, `nextBlock` and `lagBlocks`; alert when `lagBlocks` grows past a few dozen or `lastError` is set.
- The web app's `GET /api/health` shows the same lag from the database side.
