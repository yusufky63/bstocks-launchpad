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
STOCKPAIR_FACTORY=0x…
STOCKPAIR_HOOK=0x…
STOCKPAIR_ROUTER=0x…
STOCKPAIR_DEPLOY_BLOCK=…
INDEXER_CONFIRMATIONS=2
INDEXER_POLL_MS=2000
IPFS_GATEWAY=https://gateway.pinata.cloud
INDEXER_HEALTH_PORT=8788
```

## Docker

```bash
docker build -f apps/indexer/Dockerfile -t stockpair-indexer .
docker run --env-file apps/indexer/.env -p 8788:8788 stockpair-indexer
```

## Checks

- `GET :8788/health` returns `lastSync`, `head`, `nextBlock` and `lagBlocks`; alert when `lagBlocks` grows past a few dozen or `lastError` is set.
- The web app's `GET /api/health` shows the same lag from the database side.
- After a redeploy of the contracts: update the four `STOCKPAIR_*` values, reset the database (`CONFIRM_RESET=yes pnpm exec tsx src/db/cli.ts reset` in `packages/core`), then restart the indexer so it starts from the new deploy block.
