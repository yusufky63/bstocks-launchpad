# BStocks - Launchpad

Stock-paired token launcher on Base. One transaction creates a zero-admin B20 token with a fixed
1,000,000,000 supply and opens a Uniswap v4 pool against a Coinbase tokenized stock (NVDAc, TSLAc,
AAPLc, …). The whole supply is locked as liquidity forever. Every swap pays a 1% fee in the stock:
70% to the token creator, 30% to the platform treasury. There is no login: wallets sign, contracts
decide, the indexer records what Base confirmed.

```
packages/contracts   Solidity (Foundry): StockPairFactory, StockPairHook, StockPairRouter + tests
packages/core        Shared TypeScript: ABIs, stock registry, price math, log decoding, Postgres schema
apps/indexer         Reads Base logs -> Postgres (launches, swaps, candles, holders, fees, stock quotes)
apps/web             Next.js app: markets, token pages, create flow, trade panel, wallet page, JSON API
```

## How a launch works

1. The creator calls one of three factory functions, all with the creation fee (0.0001 ETH) as `msg.value`:
   - `launch(LaunchParams{name, symbol, contractURI, stock, salt})`: fixed profile, no buy, no deadline.
     The same function and selector (`0x28314fb2`) as the first factory.
   - `launchWithOptions(params, LaunchOptions{metadataEditable, openingFdvUsd8, deadline})`: reverts
     after `deadline` or if the owner changed the opening valuation after the creator reviewed it, and
     optionally keeps the profile editable.
   - `launchAndBuy(params, options, CreatorBuy{stockIn, minTokensOut})`: all of that, then a buy for the
     creator in the same transaction.

   The web app sends `launchWithOptions` or `launchAndBuy` to a factory that has them. While the
   newest factory it is configured with has only `launch`, as the first factory does, it sends that,
   with a fixed profile and no buy, and the create form hides both options.
2. The factory calls the Base-native B20 factory precompile: 18 decimals, `initialAdmin = 0`, supply
   cap and a single mint of the full supply to the factory, and the `contractURI` (ERC-7572). For an
   editable profile, one more bootstrap call grants the factory `METADATA_ROLE`.
3. The stock's Chainlink feed sets the opening price so the token opens at a 5,000 USD valuation.
4. The factory initializes the v4 pool `(token, stock, fee 0, tickSpacing 100, StockPairHook)` and
   adds the entire supply as a single-sided position it holds itself. Nothing can withdraw it.
5. It pays the creation fee to the treasury, then registers the pool with the hook and emits
   `Launched`. The order matters: until the pool is registered the hook rejects every swap in it, so
   a treasury contract cannot trade the new pool during that payment, not even ahead of the
   creator's buy.
6. With `launchAndBuy`, the factory swaps exactly `stockIn` of the stock from the creator's wallet
   for the token and sends the tokens to the creator. It pays the normal 1% fee, 70% of which is
   booked back to the creator. If fewer than `minTokensOut` tokens come out, the whole launch reverts.
7. `StockPairHook` charges 1% of the stock side of every swap as ERC-6909 claims and books 70/30 to
   creator/treasury. Anyone claims with `claim(stock)` or `claimMany(stocks)`.
8. `StockPairRouter.swapExactIn` is the minimal exact-input router the app uses; any v4-aware
   router or aggregator can trade the pool too.

No token launched here has an admin: nobody can mint, burn, pause, block transfers or touch the
locked liquidity. If a creator chose an editable profile, the launch factory, a non-upgradeable
contract, holds one metadata-only permission on that token. Its code uses it for exactly one thing:
pointing the token at a new IPFS profile when the original creator asks. The creator can give it up
for good. Name, symbol and supply can never change.

An editable profile can only point the token at a new `ipfs://` document named by a bare CID
(letters and digits, no path), at launch and on every update, through
`updateContractURI(token, uri)` from the original creator's wallet. `lockMetadata(token)` ends that
for good. The full reference, including selectors, events and errors, is on the site's `/docs` page.

Earlier deployments stay live next to the newest one: their tokens keep trading, earning fees and
claiming through their own factory and hook, and the indexer follows every deployment.

## Requirements

- Node 22+, pnpm 9, Foundry (forge/anvil/cast)
- PostgreSQL (Supabase works) for the indexer and the web app
- Base RPC URLs (two independent providers recommended)
- Pinata JWT for metadata pinning

## Setup

```bash
pnpm install
cp .env.example apps/web/.env.local     # fill DATABASE_URL, BASE_RPC_URL*, PINATA_JWT
cp .env.example apps/indexer/.env       # fill DATABASE_URL, BASE_RPC_URL*
pnpm db:migrate                         # creates the schema and seeds the 13 stocks
```

## Tests

```bash
pnpm test:contracts     # Foundry: launches, buy at launch, editable profiles, fees, partial fills, invariants, quote vectors
pnpm test               # core (embedded Postgres), indexer (fake chain), web (API routes)
```

## Deploy the contracts to Base

```bash
cd packages/contracts
export BASE_RPC_URL=...        # https RPC
export DEPLOYER_PRIVATE_KEY=... # funded deployer; also becomes owner/treasury unless OWNER/TREASURY are set
forge script script/Deploy.s.sol:Deploy --rpc-url $BASE_RPC_URL --broadcast --private-key $DEPLOYER_PRIVATE_KEY
```

The script mines a hook address with the right permission bits, deploys factory + hook + router,
registers the 13 Coinbase stocks (8 decimals, passed explicitly because the stock tokens are Base
precompiles that forge cannot simulate) with their Chainlink feeds and, on `--broadcast`, writes
`deployments/base-<block>.json`. It never overwrites an existing record.
Dry-run first by omitting `--broadcast` and adding `--sender <deployer address>`; it should end with
`SIMULATION COMPLETE` and an estimate around 0.0001 ETH, and it prints the record instead of writing it.
Then `node scripts/apply-deployment.mjs` appends the new deployment to `STOCKPAIR_DEPLOYMENTS` and
`NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS` in both local env files. The list is append-only, oldest first;
the newest entry takes new launches. It is built from every committed record in
`packages/contracts/deployments` (`base.json` is the first deployment, the one STOCK launched on)
plus what the env files hold, the script refuses to write a list without the first deployment, and
a record its broadcast did not confirm is only added once `eth_getCode` finds its contracts. Set the
same list on the production indexer and web app, and leave the single `*_FACTORY`, `*_HOOK`,
`*_ROUTER` and `*_DEPLOY_BLOCK` keys naming the first deployment: the release that predates the list
reads only those. `node scripts/redeploy.mjs` does the deploy and the append in one command.

After changing a contract, `pnpm abi` rebuilds and regenerates `packages/core/src/abi/stockpair.ts`;
CI fails if that file drifts from the build.

## Release order

The web app and the alerts service read the newest database schema, and only the indexer (or
`pnpm db:migrate`) applies it. Ship in this order; if Railway and Vercel both deploy on push, do
step 1 before pushing.

1. **Migrate production first.** `pnpm db:migrate`, or deploy the indexer first, which migrates when
   it starts. Confirm `SELECT max(version) FROM schema_version` returns the new version (8 for the
   multi-deployment release). The code running today keeps working on it: version 8 only adds
   tables and columns, each new column is nullable or has a default, the old inserts name their
   columns, and the old reorg rollback takes a launch's `metadata_updates` rows with it. Older
   code's `migrate()` sees a version it does not know and re-applies its own schema on every start;
   every statement in it is `IF NOT EXISTS`, so it adds nothing, removes nothing and a rollback is
   safe. From version 8 on, `migrate()` treats a newer applied version as done and runs no DDL.
2. **Deploy the indexer (Railway), environment unchanged.** Its first start stamps every existing
   launch, STOCK included, with the factory its own Launched receipt names, and exits with the reason
   if the deployment list does not account for a launch or names a factory with a different hook.
3. **Deploy the web app (Vercel) and the alerts service.** Never before step 1: on the old schema
   every market read fails, STOCK's included.
4. **New contracts, later:** the section above, then [apps/indexer/README.md](apps/indexer/README.md#adding-a-deployment).

## Design system (apps/web)

The interface follows one design language: Base blue (`#0370fd`) as the only accent, 1px hairlines
and corner ticks instead of shadows, DM Sans for body text, Space Grotesk for display numbers and
headlines, JetBrains Mono for figures and eyebrow labels (`01 — MARKETS`), a blue rail on hovered
rows, a stock-price tape with the NYSE clock above the header, and light/dark themes from the same
tokens. Tailwind 4 reads the tokens from `app/globals.css` (`@theme inline`); the building blocks live in
`components/ui` (Button, Module, Stat strip, Chip, Badge, KeyValue, Segmented, AmountInput, Sheet,
StickyPanel, TxProgress). Trading opens a review sheet and, on wallets that support EIP-5792 atomic
batches (Base Account), sends approve + swap as one confirmation; other wallets approve first, the
swap is simulated, then sent.

## Run

In production the web app can live on Vercel, but the indexer is a long-running process and needs a
host that keeps one instance alive (Railway, Fly, Render, a VPS): see [apps/indexer/README.md](apps/indexer/README.md)
and `apps/indexer/Dockerfile`.


```bash
pnpm dev:indexer        # polls Base every 2 s, health at http://127.0.0.1:8788/health
pnpm dev                # http://localhost:3000
```

## API

All responses are JSON, computed from the indexer's tables plus live pool reads. Missing data is `null`, never a
placeholder. Server reads are memoised for 3–15 s (`apps/web/lib/cache.server.ts`) so a burst of visitors costs one
database round trip per window.

- `GET /api/markets?stock=&q=&creator=&limit=&offset=`
- `GET /api/stocks` (with official icons from each token's onchain metadata)
- `GET /api/stats` (platform totals, fees and volume per stock)
- `GET /api/activity?limit=&token=&actor=` (launches and swaps feed, creator trades flagged)
- `GET /api/tokens/:address` (falls back to a direct factory read while the indexer catches up; includes
  `launch.creatorBuy` and `profile.onchain`)
- `GET /api/tokens/:address/swaps|candles|holders`
- `GET /api/wallet/:address` (created, holdings, earnings, claimable, recent trades)
- `POST /api/quote` `{ token, side: buy|sell, amountIn }` -> Uniswap v4 Quoter result incl. hook fee
- `POST /api/metadata` multipart `{ name, symbol, description, website, twitter, telegram, image }` -> `ipfs://`
  contractURI; with `token`, the name and symbol come from that token's launch record
- `GET /api/health`

## Notes

- Coinbase stock tokens are Base-native precompiles. Local forks (anvil/forge) cannot execute them,
  so the Foundry tests use an EVM mock at the canonical factory address and 8-decimal mock stocks.
  The deploy script mocks the single `decimals()` read during its dry run.
- Chainlink equity feeds publish 24/5 and pause on weekends; the UI marks stock feeds as
  `live`/`paused` from the feed's `updatedAt` and keeps quoting pools in stock units regardless.
