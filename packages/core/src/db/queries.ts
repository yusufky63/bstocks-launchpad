import { BASE_CONTRACTS } from '../chain';

import type { Db, Row } from './client';

/** The v4 PoolManager custodies every pool's tokens; it is never a holder. */
const POOL_MANAGER = BASE_CONTRACTS.poolManager.toLowerCase();

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
  volume_all_stock_raw: string;
  trades_all: number;
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

// ---------------------------------------------------------------------------------------------
// Batched writes
//
// A sync pass over a busy block range holds thousands of rows, and one round trip per row is the
// whole cost of the pass once the database is a network hop away. Every writer below takes a list
// and sends one statement per chunk; the single-row versions stay as thin wrappers.
// ---------------------------------------------------------------------------------------------

/** Postgres allows 65535 bind parameters per statement; stay well under it. */
const MAX_BIND_PARAMS = 30_000;

function chunked<T>(rows: readonly T[], columns: number): T[][] {
  if (rows.length === 0) return [];
  const size = Math.max(1, Math.floor(MAX_BIND_PARAMS / columns));
  if (rows.length <= size) return [rows as T[]];
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size) as T[]);
  return out;
}

/** `($1,$2),($3,$4)…` for `rowCount` rows of `columns` each. */
function placeholders(rowCount: number, columns: number, casts?: readonly string[]): string {
  const rows: string[] = [];
  let n = 0;
  for (let r = 0; r < rowCount; r += 1) {
    const cells: string[] = [];
    for (let c = 0; c < columns; c += 1) {
      n += 1;
      // A cast on the first row fixes the column type for the whole VALUES list, which a bare
      // VALUES source in UPDATE ... FROM has no other way to learn.
      cells.push(casts && r === 0 ? `$${n}::${casts[c]}` : `$${n}`);
    }
    rows.push(`(${cells.join(',')})`);
  }
  return rows.join(',');
}

export type BlockInsert = { number: bigint; hash: string; parentHash: string; timestamp: Date };

export async function upsertBlocks(db: Db, blocks: readonly BlockInsert[]) {
  // ON CONFLICT DO UPDATE may affect a row only once per statement, so collapse repeats first.
  const unique = new Map<string, BlockInsert>();
  for (const block of blocks) unique.set(block.number.toString(), block);
  for (const chunk of chunked([...unique.values()], 4)) {
    await db.query(
      `INSERT INTO blocks (number, hash, parent_hash, timestamp)
       VALUES ${placeholders(chunk.length, 4)}
       ON CONFLICT (number) DO UPDATE SET hash = EXCLUDED.hash, parent_hash = EXCLUDED.parent_hash,
         timestamp = EXCLUDED.timestamp`,
      chunk.flatMap((b) => [b.number.toString(), b.hash, b.parentHash, b.timestamp]),
    );
  }
}

export async function upsertBlock(db: Db, block: BlockInsert) {
  await upsertBlocks(db, [block]);
}

export async function readBlockHash(db: Db, number: bigint): Promise<string | null> {
  const rows = await db.query<{ hash: string }>('SELECT hash FROM blocks WHERE number = $1', [
    number.toString(),
  ]);
  return rows[0]?.hash ?? null;
}

/**
 * Strips characters Postgres will not store in a `text` column, and the control characters that
 * have no business in a name.
 *
 * Token names, symbols and URIs come from whatever the launcher passed to the factory, which
 * validates byte length and nothing else. A single NUL byte costs 0.0001 ETH to launch with and
 * makes Postgres reject the row: `invalid byte sequence for encoding "UTF8": 0x00`. That failure
 * rolls back the whole batch, the cursor never advances, and the indexer retries the same range
 * every couple of seconds for as long as it runs — the whole site stops updating for the price of
 * one launch. The contract cannot be fixed retroactively, so the indexer has to defend itself.
 */
export function sanitizeText(value: string): string {
  let out = '';
  for (const ch of value) {
    const code = ch.codePointAt(0) ?? 0;
    // Everything below U+0020 plus DEL. Written as a code-point test rather than a character
    // class so this source file does not itself contain the bytes it exists to remove.
    if (code >= 0x20 && code !== 0x7f) out += ch;
  }
  return out.trim();
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

export async function insertLaunches(db: Db, launches: readonly LaunchInsert[]) {
  for (const chunk of chunked(launches, 18)) {
    await db.query(
      `INSERT INTO launches (token, stock, creator, pool_id, token_is_currency0, name, symbol,
         contract_uri, opening_sqrt_price_x96, tick_lower, tick_upper, liquidity,
         stock_usd8_at_launch, block_number, block_hash, tx_hash, log_index, launched_at)
       VALUES ${placeholders(chunk.length, 18)}
       ON CONFLICT (token) DO NOTHING`,
      chunk.flatMap((l) => [
        l.token.toLowerCase(),
        l.stock.toLowerCase(),
        l.creator.toLowerCase(),
        l.poolId.toLowerCase(),
        l.tokenIsCurrency0,
        sanitizeText(l.name),
        sanitizeText(l.symbol),
        sanitizeText(l.contractUri),
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
      ]),
    );
  }
}

export async function insertLaunch(db: Db, l: LaunchInsert) {
  await insertLaunches(db, [l]);
}

export async function updateLaunchMetadata(
  db: Db,
  token: string,
  metadata: { description: string | null; imageUri: string | null; website: string | null; twitter?: string | null },
) {
  await db.query(
    `UPDATE launches SET description = $2, image_uri = $3, website = $4, twitter = $5, metadata_fetched_at = now()
     WHERE token = $1`,
    // Metadata comes from a URI the launcher chose, so it is no more trusted than the launch text.
    [
      token.toLowerCase(),
      metadata.description === null ? null : sanitizeText(metadata.description),
      metadata.imageUri === null ? null : sanitizeText(metadata.imageUri),
      metadata.website === null ? null : sanitizeText(metadata.website),
      metadata.twitter == null ? null : sanitizeText(metadata.twitter),
    ],
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

export async function insertSwaps(db: Db, swaps: readonly SwapInsert[]) {
  for (const chunk of chunked(swaps, 17)) {
    await db.query(
      `INSERT INTO swaps (tx_hash, log_index, token, pool_id, side, sender, trader,
         amount_token_raw, amount_stock_raw, price_token_in_stock, sqrt_price_x96, liquidity, tick,
         fee_stock_raw, block_number, block_hash, block_time)
       VALUES ${placeholders(chunk.length, 17)}
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      chunk.flatMap((s) => [
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
      ]),
    );
  }
}

export async function insertSwap(db: Db, s: SwapInsert) {
  await insertSwaps(db, [s]);
}

/**
 * Adds hook fees onto the swaps they belong to. A transaction can carry several FeeCharged logs
 * for one pool, so the amounts are summed before the join — matching what repeated single-row
 * updates produced, in one statement.
 */
export async function addSwapFees(
  db: Db,
  fees: readonly { txHash: string; logIndex: number; poolId: string; feeStockRaw: bigint }[],
) {
  // Attribute each fee to the swap that produced it. Keying on (tx, pool) alone matched every swap
  // in a transaction that touched the same pool twice -- an arb route -- and gave each of them the
  // combined total. Setting rather than adding also keeps a re-run from stacking.
  const totals = new Map<string, { txHash: string; logIndex: number; amount: bigint }>();
  for (const fee of fees) {
    const key = `${fee.txHash}|${fee.logIndex}`;
    const current = totals.get(key);
    if (current) current.amount += fee.feeStockRaw;
    else totals.set(key, { txHash: fee.txHash, logIndex: fee.logIndex, amount: fee.feeStockRaw });
  }
  for (const chunk of chunked([...totals.values()], 3)) {
    await db.query(
      `UPDATE swaps s SET fee_stock_raw = v.fee
       FROM (VALUES ${placeholders(chunk.length, 3, ['text', 'int', 'numeric'])})
         AS v(tx_hash, log_index, fee)
       WHERE s.tx_hash = v.tx_hash AND s.log_index = v.log_index`,
      chunk.flatMap((f) => [f.txHash, f.logIndex, f.amount.toString()]),
    );
  }
}

export async function setSwapFee(db: Db, txHash: string, logIndex: number, poolId: string, feeStockRaw: bigint) {
  await addSwapFees(db, [{ txHash, logIndex, poolId, feeStockRaw }]);
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

/** Returns the transfers that were new, so balances are only moved once per log. */
export async function insertTransfers(
  db: Db,
  transfers: readonly TransferInsert[],
): Promise<TransferInsert[]> {
  const inserted: TransferInsert[] = [];
  for (const chunk of chunked(transfers, 8)) {
    const returned = await db.query<{ tx_hash: string; log_index: number | string }>(
      `INSERT INTO transfers (tx_hash, log_index, token, from_address, to_address, amount_raw,
         block_number, block_time)
       VALUES ${placeholders(chunk.length, 8)}
       ON CONFLICT (tx_hash, log_index) DO NOTHING RETURNING tx_hash, log_index`,
      chunk.flatMap((t) => [
        t.txHash,
        t.logIndex,
        t.token.toLowerCase(),
        t.from.toLowerCase(),
        t.to.toLowerCase(),
        t.amountRaw.toString(),
        t.blockNumber.toString(),
        t.blockTime,
      ]),
    );
    const fresh = new Set(returned.map((row) => `${row.tx_hash}|${Number(row.log_index)}`));
    for (const t of chunk) if (fresh.has(`${t.txHash}|${t.logIndex}`)) inserted.push(t);
  }
  return inserted;
}

export async function insertTransfer(db: Db, t: TransferInsert): Promise<boolean> {
  return (await insertTransfers(db, [t])).length > 0;
}

export type BalanceDelta = { token: string; holder: string; delta: bigint; blockNumber: bigint };

export async function applyBalanceDeltas(db: Db, deltas: readonly BalanceDelta[]) {
  // ON CONFLICT DO UPDATE may affect a row only once per statement, so fold a holder's moves
  // within this pass into a single delta and keep the highest block it was seen at.
  const totals = new Map<string, BalanceDelta>();
  for (const d of deltas) {
    const token = d.token.toLowerCase();
    const holder = d.holder.toLowerCase();
    const key = `${token}|${holder}`;
    const current = totals.get(key);
    if (current) {
      current.delta += d.delta;
      if (d.blockNumber > current.blockNumber) current.blockNumber = d.blockNumber;
    } else {
      totals.set(key, { token, holder, delta: d.delta, blockNumber: d.blockNumber });
    }
  }
  for (const chunk of chunked([...totals.values()], 4)) {
    await db.query(
      `INSERT INTO balances (token, holder, balance_raw, updated_block)
       VALUES ${placeholders(chunk.length, 4)}
       ON CONFLICT (token, holder) DO UPDATE SET
         balance_raw = balances.balance_raw + EXCLUDED.balance_raw,
         updated_block = EXCLUDED.updated_block`,
      chunk.flatMap((d) => [d.token, d.holder, d.delta.toString(), d.blockNumber.toString()]),
    );
  }
}

export async function applyBalanceDelta(
  db: Db,
  token: string,
  holder: string,
  delta: bigint,
  blockNumber: bigint,
) {
  await applyBalanceDeltas(db, [{ token, holder, delta, blockNumber }]);
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

export async function insertFeeEvents(db: Db, fees: readonly FeeEventInsert[]) {
  for (const chunk of chunked(fees, 11)) {
    await db.query(
      `INSERT INTO fee_events (tx_hash, log_index, pool_id, token, stock, amount_raw, creator_raw,
         platform_raw, fee_bps, block_number, block_time)
       VALUES ${placeholders(chunk.length, 11)}
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      chunk.flatMap((f) => [
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
      ]),
    );
  }
}

export async function insertFeeEvent(db: Db, f: FeeEventInsert) {
  await insertFeeEvents(db, [f]);
}

export type FeeClaimInsert = {
  txHash: string;
  logIndex: number;
  stock: string;
  account: string;
  amountRaw: bigint;
  blockNumber: bigint;
  blockTime: Date;
};

export async function insertFeeClaims(db: Db, claims: readonly FeeClaimInsert[]) {
  for (const chunk of chunked(claims, 7)) {
    await db.query(
      `INSERT INTO fee_claims (tx_hash, log_index, stock, account, amount_raw, block_number, block_time)
       VALUES ${placeholders(chunk.length, 7)}
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      chunk.flatMap((c) => [
        c.txHash,
        c.logIndex,
        c.stock.toLowerCase(),
        c.account.toLowerCase(),
        c.amountRaw.toString(),
        c.blockNumber.toString(),
        c.blockTime,
      ]),
    );
  }
}

export async function insertFeeClaim(db: Db, c: FeeClaimInsert) {
  await insertFeeClaims(db, [c]);
}

/**
 * Rebuilds one-minute candles from the swaps table. The join drops buckets that hold no swaps,
 * so a bucket that ends up empty is left alone rather than written as a zero row.
 */
export async function rebuildCandles(
  db: Db,
  buckets: readonly { token: string; bucket: Date }[],
) {
  const unique = new Map<string, { token: string; bucket: Date }>();
  for (const entry of buckets) {
    const token = entry.token.toLowerCase();
    unique.set(`${token}|${entry.bucket.toISOString()}`, { token, bucket: entry.bucket });
  }
  for (const chunk of chunked([...unique.values()], 2)) {
    await db.query(
      `INSERT INTO candles (token, bucket, open, high, low, close, volume_stock_raw,
         volume_token_raw, trade_count)
       SELECT b.token, b.bucket,
         (array_agg(s.price_token_in_stock ORDER BY s.block_number, s.log_index))[1],
         max(s.price_token_in_stock), min(s.price_token_in_stock),
         (array_agg(s.price_token_in_stock ORDER BY s.block_number DESC, s.log_index DESC))[1],
         sum(s.amount_stock_raw), sum(s.amount_token_raw), count(*)::int
       FROM (VALUES ${placeholders(chunk.length, 2, ['text', 'timestamptz'])})
         AS b(token, bucket)
       JOIN swaps s ON s.token = b.token
         AND s.block_time >= b.bucket AND s.block_time < b.bucket + interval '1 minute'
       GROUP BY b.token, b.bucket
       ON CONFLICT (token, bucket) DO UPDATE SET open = EXCLUDED.open, high = EXCLUDED.high,
         low = EXCLUDED.low, close = EXCLUDED.close, volume_stock_raw = EXCLUDED.volume_stock_raw,
         volume_token_raw = EXCLUDED.volume_token_raw, trade_count = EXCLUDED.trade_count`,
      chunk.flatMap((entry) => [entry.token, entry.bucket]),
    );
  }
}

export async function rebuildCandle(db: Db, token: string, bucket: Date) {
  await rebuildCandles(db, [{ token, bucket }]);
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
/**
 * Puts back any profile that a rollback parked, for launches that have just been re-indexed. The
 * token address is deterministic for a given creator and salt, so a re-org that replays the same
 * launch produces the same token and the creator's signed profile becomes valid again.
 */
export async function restoreArchivedProfiles(db: Db, tokens: readonly string[]): Promise<number> {
  if (tokens.length === 0) return 0;
  const lower = tokens.map((t) => t.toLowerCase());
  const restored = await db.query<{ token: string }>(
    `INSERT INTO token_profiles
       (token, description, image_uri, website, twitter, telegram, signer, signature, issued_at, updated_at)
     SELECT a.token, a.description, a.image_uri, a.website, a.twitter, a.telegram,
            a.signer, a.signature, a.issued_at, a.updated_at
     FROM token_profiles_archive a
     WHERE a.token = ANY($1::text[])
       AND EXISTS (SELECT 1 FROM launches l WHERE l.token = a.token)
     ON CONFLICT (token) DO NOTHING
     RETURNING token`,
    [lower],
  );
  if (restored.length > 0) {
    await db.query('DELETE FROM token_profiles_archive WHERE token = ANY($1::text[])', [restored.map((r) => r.token)]);
  }
  return restored.length;
}

/**
 * Undoes everything at or above `fromBlock`.
 *
 * Runs directly on the handle it is given and opens no transaction of its own, because the caller
 * needs the undo and its own cursor write to land together -- a cursor left pointing past rows that
 * no longer exist leaves a hole nothing re-reads. Pass a transaction.
 */
export async function rollbackFrom(db: Db, fromBlock: bigint) {
  const from = fromBlock.toString();

  const affected = await db.query<{ token: string; bucket: Date }>(
    `SELECT DISTINCT token, date_trunc('minute', block_time) AS bucket FROM swaps WHERE block_number >= $1`,
    [from],
  );
  const undone = await db.query<{ token: string; from_address: string; to_address: string; amount_raw: string }>(
    `DELETE FROM transfers WHERE block_number >= $1 RETURNING token, from_address, to_address, amount_raw`,
    [from],
  );
  for (const t of undone) {
    await applyBalanceDelta(db, t.token, t.from_address, BigInt(t.amount_raw), fromBlock);
    await applyBalanceDelta(db, t.token, t.to_address, -BigInt(t.amount_raw), fromBlock);
  }
  await db.query('DELETE FROM swaps WHERE block_number >= $1', [from]);
  await db.query('DELETE FROM fee_events WHERE block_number >= $1', [from]);
  await db.query('DELETE FROM fee_claims WHERE block_number >= $1', [from]);
  // Launches in the reorged range take their derived rows with them -- except the creator's signed
  // profile, which is not derived from anything and cannot be signed again. Park it first.
  await db.query(
    `INSERT INTO token_profiles_archive
       (token, description, image_uri, website, twitter, telegram, signer, signature, issued_at, updated_at)
     SELECT p.token, p.description, p.image_uri, p.website, p.twitter, p.telegram,
            p.signer, p.signature, p.issued_at, p.updated_at
     FROM token_profiles p
     WHERE p.token IN (SELECT token FROM launches WHERE block_number >= $1)
     ON CONFLICT (token) DO UPDATE SET
       description = EXCLUDED.description, image_uri = EXCLUDED.image_uri, website = EXCLUDED.website,
       twitter = EXCLUDED.twitter, telegram = EXCLUDED.telegram, signer = EXCLUDED.signer,
       signature = EXCLUDED.signature, issued_at = EXCLUDED.issued_at, updated_at = EXCLUDED.updated_at`,
    [from],
  );
  await db.query('DELETE FROM token_profiles WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
  await db.query('DELETE FROM balances WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
  await db.query('DELETE FROM candles WHERE token IN (SELECT token FROM launches WHERE block_number >= $1)', [from]);
  await db.query('DELETE FROM launches WHERE block_number >= $1', [from]);
  await db.query('DELETE FROM blocks WHERE number >= $1', [from]);
  // Announcements for blocks that no longer exist. Only the unsent ones: a row already posted is
  // the record of what the channel actually said, and deleting it would not unsay it.
  await db.query('DELETE FROM alert_outbox WHERE block_number >= $1 AND sent_at IS NULL', [from]);
  for (const c of affected) {
    await db.query('DELETE FROM candles WHERE token = $1 AND bucket = $2', [c.token, c.bucket]);
    await rebuildCandle(db, c.token, c.bucket);
  }
}

/**
 * The highest the token has ever traded, in stock terms.
 *
 * Candles already hold a per-minute high, so this is one aggregate rather than a scan of every
 * swap. It is deliberately in stock terms and not USD: the pair is the token against the stock, so
 * a peak measured this way is the token's own, unmoved by what NVDA did that week.
 */
export async function tokenPeakInStock(db: Db, token: string): Promise<number | null> {
  const [row] = await db.query<{ high: string | null }>(
    'SELECT max(high)::text AS high FROM candles WHERE token = $1',
    [token.toLowerCase()],
  );
  const high = row?.high === null || row?.high === undefined ? null : Number(row.high);
  return high !== null && Number.isFinite(high) && high > 0 ? high : null;
}

// ---------------------------------------------------------------------------------------------
// Alert outbox
//
// The indexer enqueues here inside the same transaction that commits the swap or launch being
// announced, so an alert is exactly as durable as the fact behind it: a rollback leaves none, a
// commit cannot lose one. The dispatcher is a separate process and may be seconds or minutes
// behind; that is why the payload is snapshotted at enqueue time rather than re-read at send time.
// ---------------------------------------------------------------------------------------------

export type AlertKind = 'launch' | 'trade' | 'milestone' | 'ath';

export type AlertInsert = {
  kind: AlertKind;
  token: string;
  payload: unknown;
  blockNumber: bigint;
  /** Identifies the event, so a reorg that replays it cannot announce it twice. */
  dedupeKey?: string | null;
};

export type AlertRow = {
  id: string;
  kind: AlertKind;
  token: string;
  payload: unknown;
  block_number: string;
  created_at: Date;
  sent_at: Date | null;
};

/** jsonb comes back parsed from postgres.js and PGlite alike, but a driver that hands back the
 *  raw text should not become a crash in the dispatcher. */
function parsePayload(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export async function enqueueAlerts(db: Db, alerts: readonly AlertInsert[]) {
  // ON CONFLICT over the dedupe key, so re-indexing a range after a reorg replays the rows without
  // replaying the announcements. A null key never conflicts, which the partial index allows.
  for (const chunk of chunked(alerts, 5)) {
    await db.query(
      `INSERT INTO alert_outbox (kind, token, payload, block_number, dedupe_key)
       VALUES ${placeholders(chunk.length, 5, ['text', 'text', 'jsonb', 'bigint', 'text'])}
       ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
      chunk.flatMap((a) => [
        a.kind,
        a.token.toLowerCase(),
        JSON.stringify(a.payload ?? null),
        a.blockNumber.toString(),
        a.dedupeKey ?? null,
      ]),
    );
  }
}

/** The oldest unsent alerts, in the order they happened. */
export async function listPendingAlerts(db: Db, limit = 20): Promise<AlertRow[]> {
  const capped = Math.min(Math.max(limit, 1), 500);
  const rows = await db.query<AlertRow>(
    `SELECT id, kind, token, payload, block_number, created_at, sent_at
     FROM alert_outbox WHERE sent_at IS NULL ORDER BY id LIMIT ${capped}`,
  );
  return rows.map((row) => ({ ...row, payload: parsePayload(row.payload) }));
}

export async function countPendingAlerts(db: Db): Promise<number> {
  const rows = await db.query<{ count: string }>('SELECT count(*)::text AS count FROM alert_outbox WHERE sent_at IS NULL');
  return Number(rows[0]?.count ?? 0);
}

/** Marks rows sent. Called only after Telegram acknowledges, so a crash mid-send redelivers
 *  rather than dropping. */
export async function markAlertsSent(db: Db, ids: readonly string[]) {
  if (ids.length === 0) return;
  await db.query('UPDATE alert_outbox SET sent_at = now() WHERE id = ANY($1::bigint[])', [ids]);
}

/**
 * Drops rows that are no longer news.
 *
 * Sent rows are history. Unsent ones matter more: if the service is off for a month the indexer
 * keeps queueing, and nobody wants a Tuesday trade announced in March — the backlog would collapse
 * into one summary anyway, so the rows past the window are only weight.
 */
export async function pruneAlerts(db: Db, sentAfterDays = 30, unsentAfterDays = 3): Promise<number> {
  // count(*) rather than RETURNING id: the caller only logs how many went, and shipping every
  // deleted id back over the wire to length-check it is the whole cost of a large sweep.
  const [row] = await db.query<{ removed: string }>(
    `WITH gone AS (
       DELETE FROM alert_outbox
       WHERE (sent_at IS NOT NULL AND sent_at < now() - ($1 || ' days')::interval)
          OR (sent_at IS NULL AND created_at < now() - ($2 || ' days')::interval)
       RETURNING 1
     )
     SELECT count(*)::text AS removed FROM gone`,
    [String(Math.max(1, Math.floor(sentAfterDays))), String(Math.max(1, Math.floor(unsentAfterDays)))],
  );
  return Number(row?.removed ?? 0);
}

// ---------------------------------------------------------------------------------------------
// Alert marks
//
// A milestone is crossed once. Without a record of what has been announced, a restart would
// re-announce every level every token has ever passed.
// ---------------------------------------------------------------------------------------------

export type AlertMarkRow = { token: string; kind: string; value: string; marked_at: Date };

export async function readAlertMark(db: Db, token: string, kind: string): Promise<AlertMarkRow | null> {
  const rows = await db.query<AlertMarkRow>(
    'SELECT token, kind, value, marked_at FROM alert_marks WHERE token = $1 AND kind = $2',
    [token.toLowerCase(), kind],
  );
  return rows[0] ?? null;
}

export async function readAlertMarks(db: Db, kind: string): Promise<AlertMarkRow[]> {
  return db.query<AlertMarkRow>('SELECT token, kind, value, marked_at FROM alert_marks WHERE kind = $1', [kind]);
}

export async function setAlertMark(db: Db, token: string, kind: string, value: string) {
  await db.query(
    `INSERT INTO alert_marks (token, kind, value, marked_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (token, kind) DO UPDATE SET value = EXCLUDED.value, marked_at = now()`,
    [token.toLowerCase(), kind, value],
  );
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
    coalesce(vol.volume_all_stock_raw, 0)::numeric(40,0) AS volume_all_stock_raw,
    coalesce(vol.trades_all, 0)::int AS trades_all,
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
    -- Lifetime and 24h come from one pass over the token's swaps rather than two laterals.
    SELECT sum(amount_stock_raw) FILTER (WHERE block_time > now() - interval '24 hours') AS volume_stock_raw,
           count(*) FILTER (WHERE block_time > now() - interval '24 hours') AS trades,
           sum(amount_stock_raw) AS volume_all_stock_raw,
           count(*) AS trades_all
    FROM swaps WHERE swaps.token = l.token
  ) vol ON true
  LEFT JOIN LATERAL (
    -- The Uniswap PoolManager holds the locked supply; it is liquidity, not a holder. Counting it
    -- here while holderConcentration excludes it put "Holders 2" and "1 wallets" on one screen.
    SELECT count(*) AS holder_count FROM balances
    WHERE balances.token = l.token AND balance_raw > 0
      AND holder <> '0x000000000000000000000000000000000000dead'
      AND holder <> lower('${POOL_MANAGER}')
  ) h ON true`;

export async function listMarkets(
  db: Db,
  options: {
    stock?: string;
    creator?: string;
    tokens?: readonly string[];
    search?: string;
    limit?: number;
    offset?: number;
    /** Default 'newest'. 'volume24h' ranks by traded value so a mover outside the newest page can surface. */
    orderBy?: 'newest' | 'volume24h';
  } = {},
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
  // Ranking by traded value has to happen here, not in the caller: a caller can only sort the page
  // it was given, so a token doing real volume outside the newest N could never surface at all.
  // Volume is summed in stock units, so it is multiplied by the stock's quote to compare across
  // pairs -- NVDAc and SNDKc differ by an order of magnitude in price.
  const order =
    options.orderBy === 'volume24h'
      ? `coalesce(vol.volume_stock_raw, 0) * coalesce(q.price_usd8, 0) DESC, l.launched_at DESC`
      : `l.launched_at DESC`;
  return db.query<MarketRow>(
    `${MARKET_SELECT} ${where} ORDER BY ${order} LIMIT $${limitIndex} OFFSET $${offsetIndex}`,
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

/**
 * Candles, optionally grouped into wider buckets before they leave the database.
 *
 * The table stores one row per minute and the read is capped at 2000 rows, which is a little over
 * thirty-three hours. Grouping those in the browser is why the four-hour view only ever had eight
 * candles on it and why a daily view was not worth offering: the cap was being spent on minutes
 * that were about to be added together anyway. Grouping here spends it on the bucket the caller
 * actually asked for, so 2000 daily candles reach back further than the launchpad has existed.
 *
 * `bucketMinutes` is a whitelist rather than a number from the caller: it goes into the SQL as a
 * width, and the set is the same one the chart offers.
 */
const CANDLE_BUCKETS = [1, 5, 15, 60, 240, 1_440] as const;
export type CandleBucketMinutes = (typeof CANDLE_BUCKETS)[number];

export function isCandleBucket(value: number): value is CandleBucketMinutes {
  return (CANDLE_BUCKETS as readonly number[]).includes(value);
}

export async function listCandles(
  db: Db,
  token: string,
  options: { from?: Date; to?: Date; limit?: number; bucketMinutes?: CandleBucketMinutes } = {},
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

  const width = options.bucketMinutes && isCandleBucket(options.bucketMinutes) ? options.bucketMinutes : 1;
  if (width > 1) {
    params.push(Math.min(Math.max(options.limit ?? 500, 1), 2000));
    const seconds = width * 60;
    // open is the first close-ordered row of the bucket and close the last, which is what makes
    // this a candle rather than a summary. `DISTINCT ON` would need the same ordering twice.
    const rows = await db.query<CandleRow>(
      `SELECT * FROM (
         SELECT token,
                to_timestamp(floor(extract(epoch FROM bucket) / ${seconds}) * ${seconds}) AS bucket,
                (array_agg(open ORDER BY bucket ASC))[1]  AS open,
                max(high)                                  AS high,
                min(low)                                   AS low,
                (array_agg(close ORDER BY bucket DESC))[1] AS close,
                sum(volume_stock_raw)                      AS volume_stock_raw,
                sum(volume_token_raw)                      AS volume_token_raw,
                sum(trade_count)::int                      AS trade_count
           FROM candles
          WHERE ${clauses.join(' AND ')}
          GROUP BY token, 2
          ORDER BY 2 DESC
          LIMIT $${params.length}
       ) c ORDER BY bucket ASC`,
      params,
    );
    return rows;
  }

  params.push(Math.min(Math.max(options.limit ?? 500, 1), 2000));
  const rows = await db.query<CandleRow>(
    `SELECT * FROM (SELECT * FROM candles WHERE ${clauses.join(' AND ')} ORDER BY bucket DESC LIMIT $${params.length}) c ORDER BY bucket ASC`,
    params,
  );
  return rows;
}

export type StockQuotePoint = { feed_updated_at: Date; price_usd8: string };

/**
 * The stock's quotes covering a window, plus the one still in effect when the window opens, so a
 * caller can price each moment in the window with the quote that was live at the time rather than
 * with whatever the price happens to be now.
 */
export async function listStockQuoteHistory(
  db: Db,
  stock: string,
  from: Date,
  to: Date,
): Promise<StockQuotePoint[]> {
  return db.query<StockQuotePoint>(
    `SELECT feed_updated_at, price_usd8::text AS price_usd8
     FROM stock_quote_history
     WHERE stock = $1 AND feed_updated_at <= $3
       AND feed_updated_at >= coalesce(
         (SELECT max(feed_updated_at) FROM stock_quote_history
           WHERE stock = $1 AND feed_updated_at <= $2),
         $2)
     ORDER BY feed_updated_at ASC`,
    [stock.toLowerCase(), from, to],
  );
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
  // Round trips to a remote database dominate here, so the scalars share one query and the two
  // groupings are issued alongside it: five sequential trips become one wave.
  const scalarRow = db.query<{ tokens: number; first_launch_at: Date | null; trades: number; unique_traders: number; holders: number }>(
    `SELECT (SELECT count(*) FROM launches WHERE creator = $1)::int AS tokens,
            (SELECT min(launched_at) FROM launches WHERE creator = $1) AS first_launch_at,
            (SELECT count(*) FROM swaps s JOIN launches l ON l.token = s.token WHERE l.creator = $1)::int AS trades,
            (SELECT count(DISTINCT s.trader) FROM swaps s JOIN launches l ON l.token = s.token WHERE l.creator = $1)::int AS unique_traders,
            (SELECT count(*) FROM balances b JOIN launches l ON l.token = b.token
              WHERE l.creator = $1 AND b.balance_raw > 0
                AND b.holder <> '0x000000000000000000000000000000000000dead'
                AND b.holder <> lower('${POOL_MANAGER}'))::int AS holders`,
    [c],
  );
  const volumeRows = db.query<StockAmountRow>(
    `SELECT l.stock, st.symbol, st.decimals, coalesce(sum(s.amount_stock_raw), 0)::numeric(40,0)::text AS amount_raw
     FROM launches l JOIN stocks st ON st.address = l.stock LEFT JOIN swaps s ON s.token = l.token
     WHERE l.creator = $1 GROUP BY l.stock, st.symbol, st.decimals`,
    [c],
  );
  const feeRows = db.query<StockAmountRow>(
    `SELECT f.stock, st.symbol, st.decimals, sum(f.creator_raw)::numeric(40,0)::text AS amount_raw
     FROM fee_events f JOIN launches l ON l.token = f.token JOIN stocks st ON st.address = f.stock
     WHERE l.creator = $1 GROUP BY f.stock, st.symbol, st.decimals`,
    [c],
  );
  const [scalars, volume, fees] = await Promise.all([scalarRow, volumeRows, feeRows]);
  const head = scalars[0];
  return {
    tokens: head?.tokens ?? 0,
    first_launch_at: head?.first_launch_at ?? null,
    trades: head?.trades ?? 0,
    unique_traders: head?.unique_traders ?? 0,
    holders: head?.holders ?? 0,
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
              WHERE balance_raw > 0 AND holder <> '0x000000000000000000000000000000000000dead'
                AND holder <> lower('${POOL_MANAGER}'))::int AS holders`,
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
