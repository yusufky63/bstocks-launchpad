import type { Db, Row } from './client';

// ---------------------------------------------------------------------------------------------
// Row types (all bigint/numeric columns are strings; timestamps are Date)
// ---------------------------------------------------------------------------------------------

export type StockRow = {
  address: string;
  symbol: string;
  name: string;
  ticker: string;
  decimals: number;
  feed: string;
  enabled: boolean;
  image_uri: string | null;
};

export type StockQuoteRow = {
  stock: string;
  price_usd8: string;
  feed_updated_at: Date;
  observed_at: Date;
  observed_block: string;
};

export type LaunchRow = {
  token: string;
  stock: string;
  creator: string;
  pool_id: string;
  token_is_currency0: boolean;
  name: string;
  symbol: string;
  contract_uri: string;
  description: string | null;
  image_uri: string | null;
  website: string | null;
  twitter: string | null;
  opening_sqrt_price_x96: string;
  tick_lower: number;
  tick_upper: number;
  liquidity: string;
  stock_usd8_at_launch: string;
  block_number: string;
  block_hash: string;
  tx_hash: string;
  log_index: number;
  launched_at: Date;
  metadata_fetched_at: Date | null;
};

export type SwapRow = {
  tx_hash: string;
  log_index: number;
  token: string;
  pool_id: string;
  side: 'buy' | 'sell';
  sender: string;
  trader: string | null;
  amount_token_raw: string;
  amount_stock_raw: string;
  price_token_in_stock: string;
  sqrt_price_x96: string;
  liquidity: string;
  tick: number;
  fee_stock_raw: string;
  block_number: string;
  block_hash: string;
  block_time: Date;
  /** True when the trader is the token's creator (a "dev" buy or sell). */
  is_creator: boolean;
};

export type CandleRow = {
  token: string;
  bucket: Date;
  open: string;
  high: string;
  low: string;
  close: string;
  volume_stock_raw: string;
  volume_token_raw: string;
  trade_count: number;
};

export type BalanceRow = {
  token: string;
  holder: string;
  balance_raw: string;
  updated_block: string;
};

export type MarketRow = LaunchRow & {
  profile_description: string | null;
  profile_image_uri: string | null;
  profile_website: string | null;
  profile_twitter: string | null;
  profile_telegram: string | null;
  profile_updated_at: Date | null;
  stock_symbol: string;
  stock_ticker: string;
  stock_decimals: number;
  stock_usd8: string | null;
  feed_updated_at: Date | null;
  last_price: string | null;
  last_trade_at: Date | null;
  price_24h_ago: string | null;
  volume_24h_stock_raw: string;
  trades_24h: number;
  holder_count: number;
};

export type CursorRow = { next_block: string; last_block_hash: string | null; updated_at: Date };

// ---------------------------------------------------------------------------------------------
// Indexer writes
// ---------------------------------------------------------------------------------------------

export async function readCursor(db: Db): Promise<CursorRow | null> {
  const rows = await db.query<CursorRow>(
    'SELECT next_block, last_block_hash, updated_at FROM indexer_cursor WHERE id = 1',
  );
  return rows[0] ?? null;
}

export async function writeCursor(db: Db, nextBlock: bigint, lastBlockHash: string | null) {
  await db.query(
    `INSERT INTO indexer_cursor (id, next_block, last_block_hash, updated_at)
     VALUES (1, $1, $2, now())
     ON CONFLICT (id) DO UPDATE SET next_block = EXCLUDED.next_block,
       last_block_hash = EXCLUDED.last_block_hash, updated_at = now()`,
    [nextBlock.toString(), lastBlockHash],
  );
}

export async function upsertBlock(
  db: Db,
  block: { number: bigint; hash: string; parentHash: string; timestamp: Date },
) {
  await db.query(
    `INSERT INTO blocks (number, hash, parent_hash, timestamp) VALUES ($1, $2, $3, $4)
     ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash,
       timestamp = EXCLUDED.timestamp`,
    [block.number.toString(), block.hash, block.parentHash, block.timestamp],
  );
}

export async function readBlockHash(db: Db, number: bigint): Promise<string | null> {
  const rows = await db.query<{ hash: string }>('SELECT hash FROM blocks WHERE number = $1', [
    number.toString(),
  ]);
  return rows[0]?.hash ?? null;
}

export type LaunchInsert = {
  token: string;
  stock: string;
  creator: string;
  poolId: string;
  tokenIsCurrency0: boolean;
  name: string;
  symbol: string;
  contractUri: string;
  openingSqrtPriceX96: bigint;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  stockUsd8: bigint;
  blockNumber: bigint;
  blockHash: string;
  txHash: string;
  logIndex: number;
  launchedAt: Date;
};

export async function insertLaunch(db: Db, l: LaunchInsert) {
  await db.query(
    `INSERT INTO launches (token, stock, creator, pool_id, token_is_currency0, name, symbol,
       contract_uri, opening_sqrt_price_x96, tick_lower, tick_upper, liquidity,
       stock_usd8_at_launch, block_number, block_hash, tx_hash, log_index, launched_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
     ON CONFLICT (token) DO NOTHING`,
    [
      l.token.toLowerCase(),
      l.stock.toLowerCase(),
      l.creator.toLowerCase(),
      l.poolId.toLowerCase(),
      l.tokenIsCurrency0,
      l.name,
      l.symbol,
      l.contractUri,
      l.openingSqrtPriceX96.toString(),
      l.tickLower,
      l.tickUpper,
      l.liquidity.toString(),
      l.stockUsd8.toString(),
      l.blockNumber.toString(),
      l.blockHash,
      l.txHash,
      l.logIndex,
      l.launchedAt,
    ],
  );
}

export async function updateLaunchMetadata(
  db: Db,
  token: string,
  metadata: { description: string | null; imageUri: string | null; website: string | null; twitter?: string | null },
) {
  await db.query(
    `UPDATE launches SET description = $2, image_uri = $3, website = $4, twitter = $5, metadata_fetched_at = now()
     WHERE token = $1`,
    [token.toLowerCase(), metadata.description, metadata.imageUri, metadata.website, metadata.twitter ?? null],
  );
}

export type SwapInsert = {
  txHash: string;
  logIndex: number;
  token: string;
  poolId: string;
  side: 'buy' | 'sell';
  sender: string;
  trader: string | null;
  amountTokenRaw: bigint;
  amountStockRaw: bigint;
  priceTokenInStock: string; // decimal string
  sqrtPriceX96: bigint;
  liquidity: bigint;
  tick: number;
  feeStockRaw: bigint;
  blockNumber: bigint;
  blockHash: string;
  blockTime: Date;
};

export async function insertSwap(db: Db, s: SwapInsert) {
  await db.query(
    `INSERT INTO swaps (tx_hash, log_index, token, pool_id, side, sender, trader,
       amount_token_raw, amount_stock_raw, price_token_in_stock, sqrt_price_x96, liquidity, tick,
       fee_stock_raw, block_number, block_hash, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      s.txHash,
      s.logIndex,
      s.token.toLowerCase(),
      s.poolId.toLowerCase(),
      s.side,
      s.sender.toLowerCase(),
      s.trader?.toLowerCase() ?? null,
      s.amountTokenRaw.toString(),
      s.amountStockRaw.toString(),
      s.priceTokenInStock,
      s.sqrtPriceX96.toString(),
      s.liquidity.toString(),
      s.tick,
      s.feeStockRaw.toString(),
      s.blockNumber.toString(),
      s.blockHash,
      s.blockTime,
    ],
  );
}

export async function setSwapFee(db: Db, txHash: string, poolId: string, feeStockRaw: bigint) {
  await db.query(
    `UPDATE swaps SET fee_stock_raw = fee_stock_raw + $3 WHERE tx_hash = $1 AND pool_id = $2`,
    [txHash, poolId.toLowerCase(), feeStockRaw.toString()],
  );
}

export type TransferInsert = {
  txHash: string;
  logIndex: number;
  token: string;
  from: string;
  to: string;
  amountRaw: bigint;
  blockNumber: bigint;
  blockTime: Date;
};

export async function insertTransfer(db: Db, t: TransferInsert): Promise<boolean> {
  const rows = await db.query(
    `INSERT INTO transfers (tx_hash, log_index, token, from_address, to_address, amount_raw,
       block_number, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING tx_hash`,
    [
      t.txHash,
      t.logIndex,
      t.token.toLowerCase(),
      t.from.toLowerCase(),
      t.to.toLowerCase(),
      t.amountRaw.toString(),
      t.blockNumber.toString(),
      t.blockTime,
    ],
  );
  return rows.length > 0;
}

export async function applyBalanceDelta(
  db: Db,
  token: string,
  holder: string,
  delta: bigint,
  blockNumber: bigint,
) {
  await db.query(
    `INSERT INTO balances (token, holder, balance_raw, updated_block) VALUES ($1, $2, $3, $4)
     ON CONFLICT (token, holder) DO UPDATE SET
       balance_raw = balances.balance_raw + EXCLUDED.balance_raw,
       updated_block = EXCLUDED.updated_block`,
    [token.toLowerCase(), holder.toLowerCase(), delta.toString(), blockNumber.toString()],
  );
}

export type FeeEventInsert = {
  txHash: string;
  logIndex: number;
  poolId: string;
  token: string;
  stock: string;
  amountRaw: bigint;
  creatorRaw: bigint;
  platformRaw: bigint;
  feeBps: number;
  blockNumber: bigint;
  blockTime: Date;
};

export async function insertFeeEvent(db: Db, f: FeeEventInsert) {
  await db.query(
    `INSERT INTO fee_events (tx_hash, log_index, pool_id, token, stock, amount_raw, creator_raw,
       platform_raw, fee_bps, block_number, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      f.txHash,
      f.logIndex,
      f.poolId.toLowerCase(),
      f.token.toLowerCase(),
      f.stock.toLowerCase(),
      f.amountRaw.toString(),
      f.creatorRaw.toString(),
      f.platformRaw.toString(),
      f.feeBps,
      f.blockNumber.toString(),
      f.blockTime,
    ],
  );
}

export async function insertFeeClaim(
  db: Db,
  c: {
    txHash: string;
    logIndex: number;
    stock: string;
    account: string;
    amountRaw: bigint;
    blockNumber: bigint;
    blockTime: Date;
  },
) {
  await db.query(
    `INSERT INTO fee_claims (tx_hash, log_index, stock, account, amount_raw, block_number, block_time)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (tx_hash, log_index) DO NOTHING`,
    [
      c.txHash,
      c.logIndex,
      c.stock.toLowerCase(),
      c.account.toLowerCase(),
      c.amountRaw.toString(),
      c.blockNumber.toString(),
      c.blockTime,
    ],
  );
}

/** Rebuilds the one-minute candle for a token/bucket from the swaps table. */
export async function rebuildCandle(db: Db, token: string, bucket: Date) {
  await db.query(
    `INSERT INTO candles (token, bucket, open, high, low, close, volume_stock_raw, volume_token_raw, trade_count)
     SELECT $1, $2,
       (array_agg(price_token_in_stock ORDER BY block_number, log_index))[1],
       max(price_token_in_stock), min(price_token_in_stock),
       (array_agg(price_token_in_stock ORDER BY block_number DESC, log_index DESC))[1],
       sum(amount_stock_raw), sum(amount_token_raw), count(*)::int
     FROM swaps
     WHERE token = $1 AND block_time >= $2 AND block_time < $2::timestamptz + interval '1 minute'
     HAVING count(*) > 0
     ON CONFLICT (token, bucket) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
       low = EXCLUDED.low, close = EXCLUDED.close, volume_stock_raw = EXCLUDED.volume_stock_raw,
       volume_token_raw = EXCLUDED.volume_token_raw, trade_count = EXCLUDED.trade_count`,
    [token.toLowerCase(), bucket],
  );
}

export async function upsertStockQuote(
  db: Db,
  q: { stock: string; priceUsd8: bigint; feedUpdatedAt: Date; observedAt: Date; observedBlock: bigint },
) {
  await db.query(
    `INSERT INTO stock_quotes (stock, price_usd8, feed_updated_at, observed_at, observed_block)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (stock) DO UPDATE SET price_usd8 = EXCLUDED.price_usd8,
       feed_updated_at = EXCLUDED.feed_updated_at, observed_at = EXCLUDED.observed_at,
       observed_block = EXCLUDED.observed_block`,
    [q.stock.toLowerCase(), q.priceUsd8.toString(), q.feedUpdatedAt, q.observedAt, q.observedBlock.toString()],
  );
  await db.query(
    `INSERT INTO stock_quote_history (stock, feed_updated_at, price_usd8) VALUES ($1, $2, $3)
     ON CONFLICT (stock, feed_updated_at) DO NOTHING`,
    [q.stock.toLowerCase(), q.feedUpdatedAt, q.priceUsd8.toString()],
  );
}

/** Removes everything at or after `fromBlock` (reorg recovery) and rebuilds derived tables. */
export async function rollbackFrom(db: Db, fromBlock: bigint) {
  const from = fromBlock.toString();
  await db.transaction(async (tx) => {
    const affected = await tx.query<{ token: string; bucket: Date }>(
      `SELECT DISTINCT token, date_trunc('minute', block_time) AS bucket FROM swaps WHERE block_number >= $1`,
      [from],
    );
    const undone = await tx.query<{ token: string; from_address: string; to_address: string; amount_raw: string }>(
      `DELETE FROM transfers WHERE block_number >= $1 RETURNING token, from_address, to_address, amount_raw`,
      [from],
    );
    for (const t of undone) {
      await applyBalanceDelta(tx, t.token, t.from_address, BigInt(t.amount_raw), fromBlock);
      await applyBalanceDelta(tx, t.token, t.to_address, -BigInt(t.amount_raw), fromBlock);
    }
    await tx.query('DELETE FROM swaps WHERE block_number >= $1', [from]);
    await tx.query('DELETE FROM fee_events WHERE block_number >= $1', [from]);
    await tx.query('DELETE FROM fee_claims WHERE block_number >= $1', [from]);
    // Launches in the reorged range take their derived rows with them.
    await tx.query('DELETE FROM token_profiles WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
    await tx.query('DELETE FROM balances WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
    await tx.query('DELETE FROM candles WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
    await tx.query('DELETE FROM launches WHERE block_number >= $1', [from]);
    await tx.query('DELETE FROM blocks WHERE number >= $1', [from]);
    for (const c of affected) {
      await tx.query('DELETE FROM candles WHERE token = $1 AND bucket = $2', [c.token, c.bucket]);
      await rebuildCandle(tx, c.token, c.bucket);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Reads for the API
// ---------------------------------------------------------------------------------------------

export async function listStocks(db: Db): Promise<(StockRow & Partial<StockQuoteRow>)[]> {
  return db.query(
    `SELECT s.*, q.price_usd8, q.feed_updated_at, q.observed_at, q.observed_block
     FROM stocks s LEFT JOIN stock_quotes q ON q.stock = s.address
     ORDER BY s.symbol`,
  );
}

/** Mirrors the factory's per-stock enabled flag (the owner disables stocks Coinbase has not issued). */
export async function setStockEnabled(db: Db, stock: string, enabled: boolean): Promise<void> {
  await db.query('UPDATE stocks SET enabled = $2 WHERE address = $1', [stock.toLowerCase(), enabled]);
}

export async function readStockQuote(db: Db, stock: string): Promise<StockQuoteRow | null> {
  const rows = await db.query<StockQuoteRow>('SELECT * FROM stock_quotes WHERE stock = $1', [
    stock.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

const MARKET_SELECT = `
  SELECT l.*, s.symbol AS stock_symbol, s.ticker AS stock_ticker, s.decimals AS stock_decimals,
    q.price_usd8 AS stock_usd8, q.feed_updated_at,
    p.description AS profile_description, p.image_uri AS profile_image_uri, p.website AS profile_website,
    p.twitter AS profile_twitter, p.telegram AS profile_telegram, p.updated_at AS profile_updated_at,
    last.price_token_in_stock AS last_price, last.block_time AS last_trade_at,
    ago.price_token_in_stock AS price_24h_ago,
    coalesce(vol.volume_stock_raw, 0)::numeric(40,0) AS volume_24h_stock_raw,
    coalesce(vol.trades, 0)::int AS trades_24h,
    coalesce(h.holder_count, 0)::int AS holder_count
  FROM launches l
  JOIN stocks s ON s.address = l.stock
  LEFT JOIN stock_quotes q ON q.stock = l.stock
  LEFT JOIN token_profiles p ON p.token = l.token
  LEFT JOIN LATERAL (
    SELECT price_token_in_stock, block_time FROM swaps
    WHERE swaps.token = l.token ORDER BY block_number DESC, log_index DESC LIMIT 1
  ) last ON true
  LEFT JOIN LATERAL (
    -- Ordered by block_time so the (token, block_time DESC) index serves this without a sort;
    -- block_time and block_number are monotonic together, so the row picked is the same.
    SELECT price_token_in_stock FROM swaps
    WHERE swaps.token = l.token AND block_time <= now() - interval '24 hours'
    ORDER BY block_time DESC, log_index DESC LIMIT 1
  ) ago ON true
  LEFT JOIN LATERAL (
    SELECT sum(amount_stock_raw) AS volume_stock_raw, count(*) AS trades FROM swaps
    WHERE swaps.token = l.token AND block_time > now() - interval '24 hours'
  ) vol ON true
  LEFT JOIN LATERAL (
    SELECT count(*) AS holder_count FROM balances
    WHERE balances.token = l.token AND balance_raw > 0
      AND holder <> '0x000000000000000000000000000000000000dead'
  ) h ON true`;

export async function listMarkets(
  db: Db,
  options: { stock?: string; creator?: string; tokens?: readonly string[]; search?: string; limit?: number; offset?: number } = {},
): Promise<MarketRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.tokens) {
    if (options.tokens.length === 0) return [];
    params.push(options.tokens.map((t) => t.toLowerCase()));
    clauses.push(`l.token = ANY($${params.length}::text[])`);
  }
  if (options.stock) {
    params.push(options.stock.toLowerCase());
    clauses.push(`l.stock = $${params.length}`);
  }
  if (options.creator) {
    params.push(options.creator.toLowerCase());
    clauses.push(`l.creator = $${params.length}`);
  }
  if (options.search) {
    params.push(`%${options.search.toLowerCase()}%`);
    clauses.push(
      `(lower(l.name) LIKE $${params.length} OR lower(l.symbol) LIKE $${params.length} OR l.token LIKE $${params.length})`,
    );
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const limitIndex = params.length;
  params.push(Math.max(options.offset ?? 0, 0));
  const offsetIndex = params.length;
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.query<MarketRow>(
    `${MARKET_SELECT} ${where} ORDER BY l.launched_at DESC LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
    params,
  );
}

export async function readMarket(db: Db, token: string): Promise<MarketRow | null> {
  const rows = await db.query<MarketRow>(`${MARKET_SELECT} WHERE l.token = $1`, [
    token.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

export async function listSwaps(
  db: Db,
  options: { token?: string; trader?: string; limit?: number; beforeBlock?: bigint; beforeLogIndex?: number } = {},
): Promise<SwapRow[]> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.token) {
    params.push(options.token.toLowerCase());
    clauses.push(`s.token = $${params.length}`);
  }
  if (options.trader) {
    params.push(options.trader.toLowerCase());
    clauses.push(`s.trader = $${params.length}`);
  }
  if (options.beforeBlock !== undefined) {
    if (options.beforeLogIndex !== undefined) {
      // Keyset cursor: strictly older than the (block, log) pair, so same-block swaps are not skipped.
      params.push(options.beforeBlock.toString(), options.beforeLogIndex);
      clauses.push(`(s.block_number, s.log_index) < ($${params.length - 1}, $${params.length})`);
    } else {
      params.push(options.beforeBlock.toString());
      clauses.push(`s.block_number < $${params.length}`);
    }
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return db.query<SwapRow>(
    `SELECT s.*, (s.trader IS NOT NULL AND s.trader = l.creator) AS is_creator
     FROM swaps s JOIN launches l ON l.token = s.token
     ${where} ORDER BY s.block_number DESC, s.log_index DESC LIMIT $${params.length}`,
    params,
  );
}

export async function listCandles(
  db: Db,
  token: string,
  options: { from?: Date; to?: Date; limit?: number } = {},
): Promise<CandleRow[]> {
  const params: unknown[] = [token.toLowerCase()];
  const clauses = ['token = $1'];
  if (options.from) {
    params.push(options.from);
    clauses.push(`bucket >= $${params.length}`);
  }
  if (options.to) {
    params.push(options.to);
    clauses.push(`bucket <= $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 500, 1), 2000));
  const rows = await db.query<CandleRow>(
    `SELECT * FROM (SELECT * FROM candles WHERE ${clauses.join(' AND ')} ORDER BY bucket DESC LIMIT $${params.length}) c ORDER BY bucket ASC`,
    params,
  );
  return rows;
}

export async function listHolders(db: Db, token: string, limit = 50): Promise<BalanceRow[]> {
  return db.query<BalanceRow>(
    `SELECT * FROM balances WHERE token = $1 AND balance_raw > 0
     ORDER BY balance_raw DESC LIMIT $2`,
    [token.toLowerCase(), Math.min(Math.max(limit, 1), 500)],
  );
}

export type HolderConcentrationRow = {
  holders: number;
  pool_raw: string;
  burned_raw: string;
  top10_raw: string;
  creator_raw: string;
};

/**
 * Who holds the supply: the pool, burned dust, the creator and the ten largest wallets outside the
 * pool. Shares are computed by the caller against the fixed supply and the circulating part.
 */
export async function holderConcentration(db: Db, token: string, poolManager: string): Promise<HolderConcentrationRow> {
  const t = token.toLowerCase();
  const pool = poolManager.toLowerCase();
  const dead = '0x000000000000000000000000000000000000dead';
  const [row] = await db.query<HolderConcentrationRow>(
    `SELECT
       (SELECT count(*) FROM balances WHERE token = $1 AND balance_raw > 0 AND holder NOT IN ($2, $3))::int AS holders,
       coalesce((SELECT balance_raw FROM balances WHERE token = $1 AND holder = $2), 0)::numeric(40,0)::text AS pool_raw,
       coalesce((SELECT balance_raw FROM balances WHERE token = $1 AND holder = $3), 0)::numeric(40,0)::text AS burned_raw,
       coalesce((SELECT sum(balance_raw) FROM (
          SELECT balance_raw FROM balances WHERE token = $1 AND balance_raw > 0 AND holder NOT IN ($2, $3)
          ORDER BY balance_raw DESC LIMIT 10) top), 0)::numeric(40,0)::text AS top10_raw,
       coalesce((SELECT b.balance_raw FROM balances b JOIN launches l ON l.token = b.token
          WHERE b.token = $1 AND b.holder = l.creator), 0)::numeric(40,0)::text AS creator_raw`,
    [t, pool, dead],
  );
  return row!;
}

export type TokenProfileRow = {
  token: string;
  description: string | null;
  image_uri: string | null;
  website: string | null;
  twitter: string | null;
  telegram: string | null;
  signer: string;
  signature: string;
  issued_at: Date;
  updated_at: Date;
};

export async function readTokenProfile(db: Db, token: string): Promise<TokenProfileRow | null> {
  const rows = await db.query<TokenProfileRow>('SELECT * FROM token_profiles WHERE token = $1', [token.toLowerCase()]);
  return rows[0] ?? null;
}

/**
 * Stores a creator-signed profile. The caller has already verified the signature and that the
 * signer is the launch creator; a message older than the stored one is rejected here so a
 * replayed old signature can never roll a profile back.
 */
export async function upsertTokenProfile(
  db: Db,
  p: { token: string; description: string | null; imageUri: string | null; website: string | null; twitter: string | null; telegram: string | null; signer: string; signature: string; issuedAt: Date },
): Promise<boolean> {
  const rows = await db.query<{ token: string }>(
    `INSERT INTO token_profiles (token, description, image_uri, website, twitter, telegram, signer, signature, issued_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (token) DO UPDATE SET description = EXCLUDED.description, image_uri = EXCLUDED.image_uri,
       website = EXCLUDED.website, twitter = EXCLUDED.twitter, telegram = EXCLUDED.telegram,
       signer = EXCLUDED.signer, signature = EXCLUDED.signature, issued_at = EXCLUDED.issued_at, updated_at = now()
     WHERE token_profiles.issued_at < EXCLUDED.issued_at
     RETURNING token`,
    [p.token.toLowerCase(), p.description, p.imageUri, p.website, p.twitter, p.telegram, p.signer.toLowerCase(), p.signature, p.issuedAt],
  );
  return rows.length > 0;
}

export async function listHoldings(db: Db, holder: string): Promise<(BalanceRow & { name: string; symbol: string; stock: string })[]> {
  return db.query(
    `SELECT b.*, l.name, l.symbol, l.stock FROM balances b JOIN launches l ON l.token = b.token
     WHERE b.holder = $1 AND b.balance_raw > 0 ORDER BY b.balance_raw DESC`,
    [holder.toLowerCase()],
  );
}

export async function creatorEarnings(
  db: Db,
  creator: string,
): Promise<{ token: string; stock: string; earned_raw: string }[]> {
  return db.query(
    `SELECT f.token, f.stock, sum(f.creator_raw)::numeric(40,0)::text AS earned_raw
     FROM fee_events f JOIN launches l ON l.token = f.token
     WHERE l.creator = $1 GROUP BY f.token, f.stock ORDER BY earned_raw DESC`,
    [creator.toLowerCase()],
  );
}

// ---------------------------------------------------------------------------------------------
// Analytics reads (fees, lifetime figures, creator profile, activity feed, platform stats)
// ---------------------------------------------------------------------------------------------

export type FeeSummaryRow = {
  total_raw: string;
  creator_raw: string;
  platform_raw: string;
  events: number;
  first_at: Date | null;
  last_at: Date | null;
};

/** Every hook fee charged on a token's pool, split the way the hook books it. */
export async function tokenFeeSummary(db: Db, token: string): Promise<FeeSummaryRow> {
  const [row] = await db.query<FeeSummaryRow>(
    `SELECT coalesce(sum(amount_raw), 0)::numeric(40,0)::text AS total_raw,
            coalesce(sum(creator_raw), 0)::numeric(40,0)::text AS creator_raw,
            coalesce(sum(platform_raw), 0)::numeric(40,0)::text AS platform_raw,
            count(*)::int AS events, min(block_time) AS first_at, max(block_time) AS last_at
     FROM fee_events WHERE token = $1`,
    [token.toLowerCase()],
  );
  return row!;
}

export type TokenLifetimeRow = {
  trades: number;
  buys: number;
  sells: number;
  volume_stock_raw: string;
  unique_traders: number;
  creator_trades: number;
  creator_bought_raw: string;
  creator_sold_raw: string;
  first_trade_at: Date | null;
  last_trade_at: Date | null;
  trades_24h: number;
  buys_24h: number;
  sells_24h: number;
  volume_24h_stock_raw: string;
  traders_24h: number;
  creator_trades_24h: number;
};

/** All-time trading figures for one token, including what its creator bought and sold. */
export async function tokenLifetime(db: Db, token: string): Promise<TokenLifetimeRow> {
  const [row] = await db.query<TokenLifetimeRow>(
    `SELECT count(*)::int AS trades,
            count(*) FILTER (WHERE s.side = 'buy')::int AS buys,
            count(*) FILTER (WHERE s.side = 'sell')::int AS sells,
            coalesce(sum(s.amount_stock_raw), 0)::numeric(40,0)::text AS volume_stock_raw,
            count(DISTINCT s.trader)::int AS unique_traders,
            count(*) FILTER (WHERE s.trader = l.creator)::int AS creator_trades,
            coalesce(sum(s.amount_token_raw) FILTER (WHERE s.trader = l.creator AND s.side = 'buy'), 0)::numeric(40,0)::text AS creator_bought_raw,
            coalesce(sum(s.amount_token_raw) FILTER (WHERE s.trader = l.creator AND s.side = 'sell'), 0)::numeric(40,0)::text AS creator_sold_raw,
            min(s.block_time) AS first_trade_at, max(s.block_time) AS last_trade_at,
            count(*) FILTER (WHERE s.block_time > now() - interval '24 hours')::int AS trades_24h,
            count(*) FILTER (WHERE s.side = 'buy' AND s.block_time > now() - interval '24 hours')::int AS buys_24h,
            count(*) FILTER (WHERE s.side = 'sell' AND s.block_time > now() - interval '24 hours')::int AS sells_24h,
            coalesce(sum(s.amount_stock_raw) FILTER (WHERE s.block_time > now() - interval '24 hours'), 0)::numeric(40,0)::text AS volume_24h_stock_raw,
            count(DISTINCT s.trader) FILTER (WHERE s.block_time > now() - interval '24 hours')::int AS traders_24h,
            count(*) FILTER (WHERE s.trader = l.creator AND s.block_time > now() - interval '24 hours')::int AS creator_trades_24h
     FROM swaps s JOIN launches l ON l.token = s.token WHERE s.token = $1`,
    [token.toLowerCase()],
  );
  return row!;
}

export type StockAmountRow = { stock: string; symbol: string; decimals: number; amount_raw: string };

export type CreatorOverviewRow = {
  tokens: number;
  trades: number;
  unique_traders: number;
  holders: number;
  first_launch_at: Date | null;
  volume_by_stock: StockAmountRow[];
  fees_by_stock: StockAmountRow[];
};

/** The creator profile in numbers: their tokens, the trading they attracted, the fees they earned. */
export async function creatorOverview(db: Db, creator: string): Promise<CreatorOverviewRow> {
  const c = creator.toLowerCase();
  const [head] = await db.query<{ tokens: number; first_launch_at: Date | null }>(
    `SELECT count(*)::int AS tokens, min(launched_at) AS first_launch_at FROM launches WHERE creator = $1`,
    [c],
  );
  const [trading] = await db.query<{ trades: number; unique_traders: number }>(
    `SELECT count(*)::int AS trades, count(DISTINCT s.trader)::int AS unique_traders
     FROM swaps s JOIN launches l ON l.token = s.token WHERE l.creator = $1`,
    [c],
  );
  const [holders] = await db.query<{ holders: number }>(
    `SELECT count(*)::int AS holders FROM balances b JOIN launches l ON l.token = b.token
     WHERE l.creator = $1 AND b.balance_raw > 0 AND b.holder <> '0x000000000000000000000000000000000000dead'`,
    [c],
  );
  const volume = await db.query<StockAmountRow>(
    `SELECT l.stock, st.symbol, st.decimals, coalesce(sum(s.amount_stock_raw), 0)::numeric(40,0)::text AS amount_raw
     FROM launches l JOIN stocks st ON st.address = l.stock LEFT JOIN swaps s ON s.token = l.token
     WHERE l.creator = $1 GROUP BY l.stock, st.symbol, st.decimals`,
    [c],
  );
  const fees = await db.query<StockAmountRow>(
    `SELECT f.stock, st.symbol, st.decimals, sum(f.creator_raw)::numeric(40,0)::text AS amount_raw
     FROM fee_events f JOIN launches l ON l.token = f.token JOIN stocks st ON st.address = f.stock
     WHERE l.creator = $1 GROUP BY f.stock, st.symbol, st.decimals`,
    [c],
  );
  return {
    tokens: head?.tokens ?? 0,
    first_launch_at: head?.first_launch_at ?? null,
    trades: trading?.trades ?? 0,
    unique_traders: trading?.unique_traders ?? 0,
    holders: holders?.holders ?? 0,
    volume_by_stock: volume,
    fees_by_stock: fees,
  };
}

export type ActivityRow = {
  kind: 'launch' | 'swap';
  at: Date;
  block_number: string;
  tx_hash: string;
  log_index: number;
  token: string;
  name: string;
  symbol: string;
  image_uri: string | null;
  stock: string;
  stock_symbol: string;
  stock_decimals: number;
  actor: string | null;
  side: 'buy' | 'sell' | null;
  amount_token_raw: string | null;
  amount_stock_raw: string | null;
  is_creator: boolean;
};

/** Launches and swaps in one time-ordered feed, optionally for a single token or trader. */
export async function listActivity(
  db: Db,
  options: { limit?: number; token?: string; actor?: string } = {},
): Promise<ActivityRow[]> {
  const params: unknown[] = [];
  const filters: string[] = [];
  if (options.token) {
    params.push(options.token.toLowerCase());
    filters.push(`token = $${params.length}`);
  }
  if (options.actor) {
    params.push(options.actor.toLowerCase());
    filters.push(`actor = $${params.length}`);
  }
  params.push(Math.min(Math.max(options.limit ?? 50, 1), 200));
  const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  return db.query<ActivityRow>(
    `SELECT * FROM (
       SELECT 'launch' AS kind, l.launched_at AS at, l.block_number, l.tx_hash, l.log_index, l.token, l.name, l.symbol,
              l.image_uri, l.stock, st.symbol AS stock_symbol, st.decimals AS stock_decimals,
              l.creator AS actor, NULL::text AS side, NULL::numeric AS amount_token_raw, NULL::numeric AS amount_stock_raw,
              true AS is_creator
       FROM launches l JOIN stocks st ON st.address = l.stock
       UNION ALL
       SELECT 'swap', s.block_time, s.block_number, s.tx_hash, s.log_index, s.token, l.name, l.symbol,
              l.image_uri, l.stock, st.symbol, st.decimals,
              s.trader, s.side, s.amount_token_raw, s.amount_stock_raw,
              (s.trader IS NOT NULL AND s.trader = l.creator)
       FROM swaps s JOIN launches l ON l.token = s.token JOIN stocks st ON st.address = l.stock
     ) feed ${where}
     ORDER BY at DESC, block_number DESC, log_index DESC LIMIT $${params.length}`,
    params,
  );
}

export type PlatformStatsRow = {
  launches: number;
  launches_24h: number;
  creators: number;
  traders: number;
  swaps: number;
  swaps_24h: number;
  holders: number;
  first_launch_at: Date | null;
  volume_by_stock: (StockAmountRow & { day_raw: string })[];
  fees_by_stock: (StockAmountRow & { creator_raw: string; platform_raw: string })[];
  launches_by_stock: { stock: string; symbol: string; launches: number }[];
};

/** What the platform has done so far, every figure counted from confirmed events. */
export type TopCreatorRow = {
  creator: string;
  tokens: number;
  stock: string;
  symbol: string;
  decimals: number;
  creator_raw: string;
};

/**
 * Creators ranked by the fees their tokens have earned them, broken down per stock because fees are
 * paid in the stock and a creator can have tokens against several. The caller converts to USD and
 * sums; the row count is capped at a few per creator, so `limit` is a creator limit, not a row limit.
 */
export async function topCreatorsByFees(db: Db, limit = 10): Promise<TopCreatorRow[]> {
  return db.query<TopCreatorRow>(
    `WITH earned AS (
       SELECT l.creator, f.stock, sum(f.creator_raw) AS creator_raw
       FROM fee_events f JOIN launches l ON l.token = f.token
       GROUP BY l.creator, f.stock
     ),
     ranked AS (
       SELECT creator, sum(creator_raw) AS total_raw FROM earned GROUP BY creator
       ORDER BY total_raw DESC LIMIT $1
     )
     SELECT e.creator, e.stock, s.symbol, s.decimals,
            e.creator_raw::text AS creator_raw,
            (SELECT count(*)::int FROM launches WHERE creator = e.creator) AS tokens
     FROM earned e
     JOIN ranked r ON r.creator = e.creator
     JOIN stocks s ON s.address = e.stock
     ORDER BY r.total_raw DESC, e.creator_raw DESC`,
    [Math.min(Math.max(limit, 1), 50)],
  );
}

export async function platformStats(db: Db): Promise<PlatformStatsRow> {
  // The database is remote, so what costs time here is round trips, not the aggregates themselves.
  // The scalar rollups share one query and the groupings are issued together, turning six
  // sequential trips into two.
  const headRow = db.query<{ launches: number; launches_24h: number; creators: number; first_launch_at: Date | null; swaps: number; swaps_24h: number; traders: number; holders: number }>(
    `SELECT (SELECT count(*) FROM launches)::int AS launches,
            (SELECT count(*) FROM launches WHERE launched_at > now() - interval '24 hours')::int AS launches_24h,
            (SELECT count(DISTINCT creator) FROM launches)::int AS creators,
            (SELECT min(launched_at) FROM launches) AS first_launch_at,
            (SELECT count(*) FROM swaps)::int AS swaps,
            (SELECT count(*) FROM swaps WHERE block_time > now() - interval '24 hours')::int AS swaps_24h,
            (SELECT count(DISTINCT trader) FROM swaps)::int AS traders,
            (SELECT count(*) FROM balances
              WHERE balance_raw > 0 AND holder <> '0x000000000000000000000000000000000000dead')::int AS holders`,
  );
  const volumeRows = db.query<StockAmountRow & { day_raw: string }>(
    `SELECT l.stock, st.symbol, st.decimals,
            coalesce(sum(s.amount_stock_raw), 0)::numeric(40,0)::text AS amount_raw,
            coalesce(sum(s.amount_stock_raw) FILTER (WHERE s.block_time > now() - interval '24 hours'), 0)::numeric(40,0)::text AS day_raw
     FROM launches l JOIN stocks st ON st.address = l.stock LEFT JOIN swaps s ON s.token = l.token
     GROUP BY l.stock, st.symbol, st.decimals`,
  );
  const feeRows = db.query<StockAmountRow & { creator_raw: string; platform_raw: string }>(
    `SELECT f.stock, st.symbol, st.decimals,
            sum(f.amount_raw)::numeric(40,0)::text AS amount_raw,
            sum(f.creator_raw)::numeric(40,0)::text AS creator_raw,
            sum(f.platform_raw)::numeric(40,0)::text AS platform_raw
     FROM fee_events f JOIN stocks st ON st.address = f.stock GROUP BY f.stock, st.symbol, st.decimals`,
  );
  const launchRows = db.query<{ stock: string; symbol: string; launches: number }>(
    `SELECT l.stock, st.symbol, count(*)::int AS launches FROM launches l JOIN stocks st ON st.address = l.stock
     GROUP BY l.stock, st.symbol ORDER BY launches DESC`,
  );
  const [scalars, volume, fees, launches] = await Promise.all([headRow, volumeRows, feeRows, launchRows]);
  const head = scalars[0];
  const trading = head;
  const holders = head;
  return {
    launches: head?.launches ?? 0,
    launches_24h: head?.launches_24h ?? 0,
    creators: head?.creators ?? 0,
    traders: trading?.traders ?? 0,
    swaps: trading?.swaps ?? 0,
    swaps_24h: trading?.swaps_24h ?? 0,
    holders: holders?.holders ?? 0,
    first_launch_at: head?.first_launch_at ?? null,
    volume_by_stock: volume,
    fees_by_stock: fees,
    launches_by_stock: launches,
  };
}

export type { Row };
