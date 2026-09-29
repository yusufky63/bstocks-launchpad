import type { TokenResponse, TradeMarket } from './types';

type IndexingLaunch = Extract<TokenResponse, { status: 'indexing' }>['launch'];

/**
 * What the trade panel needs for a token that is live onchain but not stored yet. Quotes come from
 * the live pool, so only the price fields are missing. Null when this site does not know the stock.
 */
export function earlyTradeMarket(l: IndexingLaunch): TradeMarket | null {
  if (l.stockDecimals === null) return null;
  return {
    token: l.token,
    symbol: l.symbol,
    factory: l.factory,
    hook: l.hook,
    stock: { address: l.stock, symbol: l.stockSymbol ?? 'STOCK', ticker: l.stockTicker ?? '', decimals: l.stockDecimals },
    stockUsd: Number(l.stockUsd8) / 1e8,
    priceUsd: null,
    priceInStock: null,
    stockFeedStatus: 'unknown',
  };
}

/** The market a trade panel can use for this response; null while the launch has not landed. */
export function tradeMarketOf(view: TokenResponse): TradeMarket | null {
  if (view.status === 'indexed') return view.market;
  if (view.status === 'indexing') return earlyTradeMarket(view.launch);
  return null;
}
