import type { Address } from 'viem';

import type { MarketView } from './market-view';

export type { MarketView };

export type FeedStatus = 'live' | 'paused' | 'unknown';

/** One row of GET /api/stocks. */
export type StockView = {
  address: string;
  symbol: string;
  ticker: string;
  name: string;
  decimals: number;
  feed: string;
  enabled: boolean;
  image: string | null;
  priceUsd: number | null;
  feedUpdatedAt: string | null;
  feedStatus: FeedStatus;
  launches: number;
};

export type MarketsResponse = { markets: MarketView[]; asOf: string };
export type StocksResponse = { stocks: StockView[] };

export type SwapView = {
  txHash: string;
  logIndex: number;
  side: 'buy' | 'sell';
  trader: string | null;
  sender: string | null;
  amountToken: number;
  amountStock: number;
  feeStock: number;
  amountUsd: number | null;
  price: number;
  priceUsd: number | null;
  blockNumber: string;
  blockTime: string;
  isCreator: boolean;
};

export type SwapsResponse = { token: string; stock: { address: string; symbol: string; decimals: number }; stockUsd: number | null; swaps: SwapView[] };

export type HolderView = { rank: number; address: string; label: string | null; balance: number; sharePercent: number };
export type HoldersResponse = { token: string; holderCount: number; holders: HolderView[]; concentration: HolderConcentration };

export type CandleView = { time: number; open: number; high: number; low: number; close: number; volumeStock: number; volumeToken: number; trades: number };
export type CandlesResponse = { token: string; interval: '1m'; quote: { symbol: string; usd: number | null }; candles: CandleView[] };

export type TokenFees = { totalStock: number; creatorStock: number; platformStock: number; totalUsd: number | null; creatorUsd: number | null; platformUsd: number | null; events: number; claimableStock: number | null; claimableUsd: number | null };
export type TokenLifetime = { trades: number; buys: number; sells: number; volumeStock: number; volumeUsd: number | null; uniqueTraders: number; creatorTrades: number; creatorBought: number; creatorSold: number; firstTradeAt: string | null; day: { trades: number; buys: number; sells: number; volumeStock: number; volumeUsd: number | null; traders: number; creatorTrades: number } };
export type HolderConcentration = { holders: number; poolPercent: number; burnedPercent: number; creatorPercent: number; top10Percent: number; top10OfCirculatingPercent: number; circulatingPercent: number };
export type TokenPool = { liquidity: string; tokenReserve: number; stockReserve: number; stockReserveUsd: number | null; tokenShareOfSupply: number; sqrtPriceX96: string; feeBps: number } | null;
export type TokenDetails = { market: MarketView; fees: TokenFees; lifetime: TokenLifetime; pool: TokenPool; links: { basescan: string; dexscreener: string; geckoterminal: string; uniswap: string } };

export type TokenResponse =
  | { status: 'indexed'; market: MarketView; details?: Omit<TokenDetails, 'market'> }
  | { status: 'pending'; token: string; txHash: string | null }
  | {
      status: 'indexing';
      launch: { token: string; stock: string; creator: string; name: string; symbol: string; contractURI: string; launchedAt: string; stockSymbol: string | null; stockTicker: string | null };
    };

export type QuoteView = {
  amountIn: string;
  amountOut: string;
  side: 'buy' | 'sell';
  feeBps: number;
  midPrice: number | null;
  executionPrice: number | null;
  priceImpactPercent: number | null;
  poolKey: { currency0: Address; currency1: Address; fee: number; tickSpacing: number; hooks: Address };
  zeroForOne: boolean;
  gasEstimate: string;
  liquidity: string;
};

export type ApiErrorBody = { error: { code: string; message: string } };

export type ActivityItem = {
  kind: 'launch' | 'swap';
  at: string;
  txHash: string;
  token: string;
  name: string;
  symbol: string;
  imageUrl: string | null;
  stock: { address: string; symbol: string };
  actor: string | null;
  side: 'buy' | 'sell' | null;
  amountToken: number | null;
  amountStock: number | null;
  amountUsd: number | null;
  isCreator: boolean;
};
export type ActivityResponse = { items: ActivityItem[]; asOf: string };

export type StockFigure = { stock: string; symbol: string; ticker: string; amount: number; usd: number | null };

/** A creator ranked by what the swap fees on their tokens have paid them. */
export type TopCreator = { creator: string; tokens: number; earnedUsd: number | null; byStock: StockFigure[] };
export type StatsResponse = {
  launches: number;
  launches24h: number;
  creators: number;
  traders: number;
  swaps: number;
  swaps24h: number;
  holders: number;
  firstLaunchAt: string | null;
  volumeUsd: number | null;
  volume24hUsd: number | null;
  feesUsd: number | null;
  creatorFeesUsd: number | null;
  platformFeesUsd: number | null;
  volumeByStock: (StockFigure & { dayAmount: number; dayUsd: number | null })[];
  feesByStock: (StockFigure & { creatorAmount: number; platformAmount: number })[];
  topCreators: TopCreator[];
  launchesByStock: { stock: string; symbol: string; launches: number }[];
  asOf: string;
};

export type CreatorOverview = {
  tokens: number;
  trades: number;
  uniqueTraders: number;
  holders: number;
  firstLaunchAt: string | null;
  volumeUsd: number | null;
  feesEarnedUsd: number | null;
  volumeByStock: StockFigure[];
  feesByStock: StockFigure[];
};
