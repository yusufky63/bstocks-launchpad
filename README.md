# StockPair

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

1. `StockPairFactory.launch(name, symbol, contractURI, stock, salt)` with the creation fee (0.0001 ETH).
2. The factory calls the Base-native B20 factory precompile: 18 decimals, `initialAdmin = 0`, supply
   cap and a single mint of the full supply to the factory, immutable `contractURI` (ERC-7572).
3. The stock's Chainlink feed sets the opening price so the token opens at a 5,000 USD valuation.
4. The factory initializes the v4 pool `(token, stock, fee 0, tickSpacing 100, StockPairHook)` and
   adds the entire supply as a single-sided position it holds itself. Nothing can withdraw it.
5. `StockPairHook` charges 1% of the stock side of every swap (99% -> 1% over the first 20 seconds to
   stop sniping) as ERC-6909 claims and books 70/30 to creator/treasury. Anyone claims with
   `claim(stock)` or `claimMany(stocks)`.
6. `StockPairRouter.swapExactIn` is the minimal exact-input router the app uses; any v4-aware
   router or aggregator can trade the pool too.

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
pnpm test:contracts     # Foundry: 23 tests (launch, both currency orders, fees, anti-snipe, claims, quoter parity)
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
precompiles that forge cannot simulate) with their Chainlink feeds and writes `deployments/base.json`.
Dry-run first by omitting `--broadcast` and adding `--sender <deployer address>`; it should end with
`SIMULATION COMPLETE` and an estimate around 0.0001 ETH.
Copy `factory`, `hook`, `router` and `block` into `STOCKPAIR_*` and `NEXT_PUBLIC_STOCKPAIR_*` in both
env files.

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
- `GET /api/tokens/:address` (falls back to a direct factory read while the indexer catches up)
- `GET /api/tokens/:address/swaps|candles|holders`
- `GET /api/wallet/:address` (created, holdings, earnings, claimable, recent trades)
- `POST /api/quote` `{ token, side: buy|sell, amountIn }` -> Uniswap v4 Quoter result incl. hook fee
- `POST /api/metadata` multipart `{ name, symbol, description, website, image }` -> `ipfs://` contractURI
- `GET /api/health`

## Notes

- Coinbase stock tokens are Base-native precompiles. Local forks (anvil/forge) cannot execute them,
  so the Foundry tests use an EVM mock at the canonical factory address and 8-decimal mock stocks.
  The deploy script mocks the single `decimals()` read during its dry run.
- Chainlink equity feeds publish 24/5 and pause on weekends; the UI marks stock feeds as
  `live`/`paused` from the feed's `updatedAt` and keeps quoting pools in stock units regardless.
