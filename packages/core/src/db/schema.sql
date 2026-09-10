-- StockPair schema. One file, applied by packages/core/src/db/migrate.ts.
-- Every row here comes from a confirmed Base block; nothing is written from user input.

CREATE TABLE IF NOT EXISTS schema_version (
  version    integer PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

-- Tokenized stocks the factory accepts as the quote side of a pool.
CREATE TABLE IF NOT EXISTS stocks (
  address     text PRIMARY KEY,               -- lowercase 0x address of the B20 stock token
  symbol      text NOT NULL,                  -- NVDAc
  name        text NOT NULL,                  -- NVIDIA Corporation
  ticker      text NOT NULL,                  -- NVDA (underlying)
  decimals    integer NOT NULL,
  feed        text NOT NULL,                  -- Chainlink aggregator address
  enabled     boolean NOT NULL DEFAULT true,
  added_block bigint NOT NULL DEFAULT 0
);

-- Latest known USD price per stock from Chainlink (total-return, 8 decimals).
CREATE TABLE IF NOT EXISTS stock_quotes (
  stock       text PRIMARY KEY REFERENCES stocks(address),
  price_usd8  numeric(38, 0) NOT NULL,
  feed_updated_at timestamptz NOT NULL,       -- Chainlink updatedAt; stops advancing off-hours
  observed_at timestamptz NOT NULL,
  observed_block bigint NOT NULL
);

-- Historical stock price observations (one row per feed round we saw).
CREATE TABLE IF NOT EXISTS stock_quote_history (
  stock       text NOT NULL REFERENCES stocks(address),
  feed_updated_at timestamptz NOT NULL,
  price_usd8  numeric(38, 0) NOT NULL,
  PRIMARY KEY (stock, feed_updated_at)
);

-- Confirmed blocks the indexer processed (for reorg detection and as-of timestamps).
CREATE TABLE IF NOT EXISTS blocks (
  number      bigint PRIMARY KEY,
  hash        text NOT NULL,
  parent_hash text NOT NULL,
  timestamp   timestamptz NOT NULL
);

-- One row per StockPairFactory.Launched event.
CREATE TABLE IF NOT EXISTS launches (
  token            text PRIMARY KEY,          -- lowercase B20 token address
  stock            text NOT NULL REFERENCES stocks(address),
  creator          text NOT NULL,
  pool_id          text NOT NULL UNIQUE,      -- 0x + 64 hex
  token_is_currency0 boolean NOT NULL,
  name             text NOT NULL,
  symbol           text NOT NULL,
  contract_uri     text NOT NULL,
  description      text,
  image_uri        text,
  website          text,
  opening_sqrt_price_x96 numeric(60, 0) NOT NULL,
  tick_lower       integer NOT NULL,
  tick_upper       integer NOT NULL,
  liquidity        numeric(40, 0) NOT NULL,
  stock_usd8_at_launch numeric(38, 0) NOT NULL,
  block_number     bigint NOT NULL,
  block_hash       text NOT NULL,
  tx_hash          text NOT NULL,
  log_index        integer NOT NULL,
  launched_at      timestamptz NOT NULL,
  metadata_fetched_at timestamptz
);
CREATE INDEX IF NOT EXISTS launches_stock_idx ON launches (stock, launched_at DESC);
CREATE INDEX IF NOT EXISTS launches_creator_idx ON launches (creator, launched_at DESC);
CREATE INDEX IF NOT EXISTS launches_time_idx ON launches (launched_at DESC);

-- One row per PoolManager.Swap on a launch pool.
CREATE TABLE IF NOT EXISTS swaps (
  tx_hash          text NOT NULL,
  log_index        integer NOT NULL,
  token            text NOT NULL REFERENCES launches(token),
  pool_id          text NOT NULL,
  side             text NOT NULL CHECK (side IN ('buy', 'sell')),  -- buy = trader receives token
  sender           text NOT NULL,             -- PoolManager unlock caller (router)
  trader           text,                      -- tx.from when known
  amount_token_raw numeric(40, 0) NOT NULL,   -- absolute token amount moved
  amount_stock_raw numeric(40, 0) NOT NULL,   -- absolute stock amount moved (pool side, before hook fee)
  price_token_in_stock numeric(60, 30) NOT NULL, -- whole stock per whole token after the swap
  sqrt_price_x96   numeric(60, 0) NOT NULL,
  liquidity        numeric(40, 0) NOT NULL,
  tick             integer NOT NULL,
  fee_stock_raw    numeric(40, 0) NOT NULL DEFAULT 0,  -- hook fee charged in stock
  block_number     bigint NOT NULL,
  block_hash       text NOT NULL,
  block_time       timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS swaps_token_time_idx ON swaps (token, block_time DESC);
-- Serves the trades list and its keyset pagination: token filter, newest first, stable tiebreak.
CREATE INDEX IF NOT EXISTS swaps_token_block_idx ON swaps (token, block_number DESC, log_index DESC);
CREATE INDEX IF NOT EXISTS swaps_trader_idx ON swaps (trader, block_time DESC);
CREATE INDEX IF NOT EXISTS swaps_block_idx ON swaps (block_number);

-- One-minute candles in stock units, rebuilt from swaps.
CREATE TABLE IF NOT EXISTS candles (
  token        text NOT NULL REFERENCES launches(token),
  bucket       timestamptz NOT NULL,          -- minute start
  open         numeric(60, 30) NOT NULL,
  high         numeric(60, 30) NOT NULL,
  low          numeric(60, 30) NOT NULL,
  close        numeric(60, 30) NOT NULL,
  volume_stock_raw numeric(40, 0) NOT NULL,
  volume_token_raw numeric(40, 0) NOT NULL,
  trade_count  integer NOT NULL,
  PRIMARY KEY (token, bucket)
);

-- Token transfers of launched tokens (source for balances).
CREATE TABLE IF NOT EXISTS transfers (
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  token        text NOT NULL REFERENCES launches(token),
  from_address text NOT NULL,
  to_address   text NOT NULL,
  amount_raw   numeric(40, 0) NOT NULL,
  block_number bigint NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS transfers_token_idx ON transfers (token, block_number);
CREATE INDEX IF NOT EXISTS transfers_block_idx ON transfers (block_number);

-- Current balances per holder, derived from transfers.
CREATE TABLE IF NOT EXISTS balances (
  token        text NOT NULL REFERENCES launches(token),
  holder       text NOT NULL,
  balance_raw  numeric(40, 0) NOT NULL,
  updated_block bigint NOT NULL,
  PRIMARY KEY (token, holder)
);
CREATE INDEX IF NOT EXISTS balances_rank_idx ON balances (token, balance_raw DESC);
CREATE INDEX IF NOT EXISTS balances_holder_idx ON balances (holder);

-- Hook fee events, for creator earnings.
CREATE TABLE IF NOT EXISTS fee_events (
  tx_hash        text NOT NULL,
  log_index      integer NOT NULL,
  pool_id        text NOT NULL,
  token          text NOT NULL REFERENCES launches(token),
  stock          text NOT NULL,
  amount_raw     numeric(40, 0) NOT NULL,
  creator_raw    numeric(40, 0) NOT NULL,
  platform_raw   numeric(40, 0) NOT NULL,
  fee_bps        integer NOT NULL,
  block_number   bigint NOT NULL,
  block_time     timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fee_events_token_idx ON fee_events (token, block_number);

CREATE TABLE IF NOT EXISTS fee_claims (
  tx_hash      text NOT NULL,
  log_index    integer NOT NULL,
  stock        text NOT NULL,
  account      text NOT NULL,
  amount_raw   numeric(40, 0) NOT NULL,
  block_number bigint NOT NULL,
  block_time   timestamptz NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
CREATE INDEX IF NOT EXISTS fee_claims_account_idx ON fee_claims (account, block_number);

-- Indexer progress. One row.
CREATE TABLE IF NOT EXISTS indexer_cursor (
  id           integer PRIMARY KEY CHECK (id = 1),
  next_block   bigint NOT NULL,
  last_block_hash text,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Additive changes (idempotent). Version 2: X profile in metadata, stock icons.
ALTER TABLE launches ADD COLUMN IF NOT EXISTS twitter text;

-- Version 5: metadata backfill needs to give up. Without an attempt count a URI that never resolves
-- stays at the head of the pending set forever, and each pass pays its timeout again.
ALTER TABLE launches ADD COLUMN IF NOT EXISTS metadata_attempts integer NOT NULL DEFAULT 0;
ALTER TABLE launches ADD COLUMN IF NOT EXISTS metadata_last_attempt_at timestamptz;
ALTER TABLE stocks ADD COLUMN IF NOT EXISTS image_uri text;

-- Version 3: creator-signed profile overrides. Name and symbol stay onchain and immutable; these
-- fields are presentation only and always shown as "updated by the creator".
-- A reorg deletes the launch a profile hangs off, and the FK below would block that. These rows are
-- the only thing in the database that is not derivable from the chain: the creator signed them, the
-- signature cannot be replayed past its max age, and no re-index brings them back. So a rollback
-- parks them here instead of destroying them, and re-indexing the same launch restores them.
CREATE TABLE IF NOT EXISTS token_profiles_archive (
  token        text PRIMARY KEY,
  description  text,
  image_uri    text,
  website      text,
  twitter      text,
  telegram     text,
  signer       text NOT NULL,
  signature    text NOT NULL,
  issued_at    timestamptz NOT NULL,
  updated_at   timestamptz NOT NULL,
  archived_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS token_profiles (
  token        text PRIMARY KEY REFERENCES launches(token),
  description  text,
  image_uri    text,
  website      text,
  twitter      text,
  telegram     text,
  signer       text NOT NULL,                 -- creator address that signed the update
  signature    text NOT NULL,                 -- EIP-712 signature over the fields
  issued_at    timestamptz NOT NULL,          -- timestamp inside the signed message (replay guard)
  updated_at   timestamptz NOT NULL DEFAULT now()
);

-- Version 6: the alert channel. The indexer writes a row here inside the same transaction that
-- commits the swap or launch it describes, so an announcement is exactly as durable as the fact it
-- announces: a rollback leaves none, a commit cannot lose one.
--
-- No FK to launches(token). A reorg deletes launches wholesale, and these rows are cleaned up
-- explicitly by rollbackFrom rather than cascaded, so that a row already sent stays as a record of
-- what the channel actually said.
CREATE TABLE IF NOT EXISTS alert_outbox (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,                 -- launch | trade | milestone | ath
  token        text NOT NULL,
  -- Everything needed to render, snapshotted at commit. The dispatcher never re-reads: a post has
  -- to say what was true when it happened, not what is true when it is finally sent.
  payload      jsonb NOT NULL,
  block_number bigint NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  sent_at      timestamptz
);

-- What has already been announced. Milestones are crossed once and a restart must not repeat them.
CREATE TABLE IF NOT EXISTS alert_marks (
  token     text NOT NULL,
  kind      text NOT NULL,                    -- mcap | ath | digest
  value     numeric(60,30) NOT NULL,          -- the level reached, so a later crossing can compare
  marked_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (token, kind)
);

CREATE INDEX IF NOT EXISTS alert_outbox_pending_idx ON alert_outbox (id) WHERE sent_at IS NULL;
CREATE INDEX IF NOT EXISTS alert_outbox_block_idx ON alert_outbox (block_number);
