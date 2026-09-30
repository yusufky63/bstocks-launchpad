import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WagmiProvider, createConfig, custom } from 'wagmi';
import { base } from 'wagmi/chains';
import { describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';

const nav = vi.hoisted(() => ({ path: '/' }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => nav.path,
}));

const { TradeWidget } = await import('@/components/embed/trade-widget');
const { CreateWidget } = await import('@/components/embed/create-widget');
const { EmbedShell } = await import('@/components/embed/embed-shell');
const { WidgetBuilder } = await import('@/components/widgets/widget-builder');
const { AppShell } = await import('@/components/layout/app-shell');
const { ThemeProvider } = await import('@/components/layout/theme-provider');
const { publicEnv } = await import('@/lib/env');

/** Server-renders under a wagmi config whose transport refuses every request: nothing leaves the process. */
function render(element: ReactElement): string {
  const config = createConfig({
    chains: [base],
    connectors: [],
    transports: { [base.id]: custom({ request: async () => Promise.reject(new Error('no network in tests')) }) },
  });
  const client = new QueryClient();
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client }, createElement(ThemeProvider, null, element))))
    .replace(/<!-- -->/gu, '')
    .replace(/&#x27;/gu, "'");
}

const NVDA = BASE_STOCKS[0]!;
const TOKEN = '0x1111111111111111111111111111111111111111';
const stocks = {
  stocks: [{ address: NVDA.address.toLowerCase(), symbol: NVDA.symbol, ticker: NVDA.ticker, name: NVDA.name, decimals: 8, feed: NVDA.feed, enabled: true, image: null, priceUsd: 230, feedUpdatedAt: null, feedStatus: 'unknown' as const, launches: 0 }],
};

const market = {
  token: TOKEN,
  name: 'Test Token',
  symbol: 'TEST',
  imageUrl: null,
  creator: '0x2222222222222222222222222222222222222222',
  factory: null,
  hook: null,
  stock: { address: NVDA.address.toLowerCase(), symbol: NVDA.symbol, ticker: NVDA.ticker, decimals: 8 },
  poolId: `0x${'cd'.repeat(32)}`,
  priceInStock: 0.0001,
  priceUsd: 0.023,
  change24hPercent: 4.2,
  stockUsd: 230,
  stockFeedStatus: 'live',
  holders: 3,
} as never;

describe('trade widget', () => {
  it('shows the token, its pair and the trade panel, with a way out to the full page', () => {
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: { status: 'indexed', market, launch: { factory: null, hook: null, creatorBuy: null }, profile: { onchain: 'immutable', contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null } } }));
    expect(html).toContain('Test Token');
    expect(html).toContain(NVDA.symbol);
    expect(html).toContain('aria-label="Trade side"');
    expect(html).toMatch(new RegExp(`<a href="${publicEnv.appUrl}/token/${TOKEN}" target="_blank"[^>]*aria-label="Open the full token page"`, 'u'));
  });

  it('opens on the side the host asked for', () => {
    const html = render(createElement(TradeWidget, { address: TOKEN, initialSide: 'sell', initialData: { status: 'indexed', market, launch: { factory: null, hook: null, creatorBuy: null }, profile: { onchain: 'immutable', contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null } } }));
    expect(html).toContain('Share of position to sell');
  });

  it('trades a launch the indexer has not stored yet', () => {
    const launch = { token: TOKEN, stock: NVDA.address.toLowerCase(), creator: '0x2222222222222222222222222222222222222222', name: 'Fresh', symbol: 'FRSH', contractURI: 'ipfs://x', launchedAt: '2026-09-29T10:00:00.000Z', stockSymbol: NVDA.symbol, stockTicker: NVDA.ticker, stockDecimals: 8, stockUsd8: '23000000000', factory: '0x3333333333333333333333333333333333333333', hook: '0x4444444444444444444444444444444444444444' };
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: { status: 'indexing', launch } }));
    expect(html).toContain('Fresh');
    expect(html).toContain('Live · history loading');
    expect(html).toContain('aria-label="Trade side"');
  });

  it('waits for a launch still in flight without offering a trade', () => {
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: { status: 'pending', token: TOKEN, txHash: `0x${'ab'.repeat(32)}` } }));
    expect(html).toContain('Launch submitted · waiting for Base');
    expect(html).toContain('Launch transaction');
    expect(html).not.toContain('aria-label="Trade side"');
  });
});

describe('trade widget with a chart and lists', () => {
  const indexed = { status: 'indexed' as const, market, launch: { factory: null, hook: null, creatorBuy: null }, profile: { onchain: 'immutable' as const, contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null } };

  it('adds the chart above the panel and only the lists the host asked for below it', () => {
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: indexed, show: ['chart', 'holders'] }));
    expect(html).toContain('aria-label="Chart source"');
    expect(html.indexOf('aria-label="Chart source"')).toBeLessThan(html.indexOf('aria-label="Trade side"'));
    expect(html).toContain('aria-label="Token records"');
    expect(html).toContain('Holders · 3');
    expect(html).not.toMatch(/>Trades(?: ·[^<]*)?</u);
    expect(html).not.toContain('Fees &amp; pool');
  });

  it('shows neither without show', () => {
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: indexed }));
    expect(html).not.toContain('aria-label="Chart source"');
    expect(html).not.toContain('aria-label="Token records"');
  });

  it('says when a launch still being indexed will get them', () => {
    const launch = { token: TOKEN, stock: NVDA.address.toLowerCase(), creator: '0x2222222222222222222222222222222222222222', name: 'Fresh', symbol: 'FRSH', contractURI: 'ipfs://x', launchedAt: '2026-09-29T10:00:00.000Z', stockSymbol: NVDA.symbol, stockTicker: NVDA.ticker, stockDecimals: 8, stockUsd8: '23000000000', factory: '0x3333333333333333333333333333333333333333', hook: '0x4444444444444444444444444444444444444444' };
    const html = render(createElement(TradeWidget, { address: TOKEN, initialData: { status: 'indexing', launch }, show: ['chart', 'trades'] }));
    expect(html).toContain('The chart and the lists appear once the launch is indexed');
    expect(html).toContain('aria-label="Trade side"');
  });
});

describe('create widget stock picker', () => {
  it('offers the stocks in one dropdown when the host asks', () => {
    const html = render(createElement(CreateWidget, { initialStocks: stocks, stockPicker: 'select' }));
    expect(html).toMatch(/<select aria-label="Paired stock"/u);
    expect(html).toContain(`>${NVDA.symbol} · ${NVDA.name}`);
    expect(html).not.toContain('role="radiogroup" aria-label="Paired stock"');
  });

  it('shows a fixed stock as one row, with nothing to pick', () => {
    const html = render(createElement(CreateWidget, { initialStocks: stocks, lockedStock: NVDA.address }));
    expect(html).toContain('your token trades against it');
    expect(html).not.toMatch(/<select aria-label="Paired stock"/u);
    expect(html).not.toContain('role="radiogroup" aria-label="Paired stock"');
  });

  it('brings the picker back when the fixed stock is not one it can launch against', () => {
    const html = render(createElement(CreateWidget, { initialStocks: stocks, lockedStock: '0x9999999999999999999999999999999999999999' }));
    expect(html).toContain('role="radiogroup" aria-label="Paired stock"');
  });
});

describe('create widget', () => {
  it('is the site create form, with its reviewed defaults', () => {
    const html = render(createElement(CreateWidget, { initialStocks: stocks }));
    expect(html).toContain('Launch a stock-paired token');
    expect(html).toContain('Buy at launch (optional)');
    const switches = [...html.matchAll(/role="switch" aria-checked="(true|false)"/gu)].map((m) => m[1]);
    expect(switches).toEqual(['false', 'false']);
  });
});

describe('widget frame', () => {
  it('carries a powered-by link that leaves the frame', () => {
    const html = render(createElement(EmbedShell, { widget: 'trade', children: createElement('p', null, 'inside') }));
    expect(html).toContain('inside');
    expect(html).toMatch(new RegExp(`<a href="${publicEnv.appUrl}" target="_blank"[^>]*>Powered by`, 'u'));
  });

  it('drops the site header, ticker and footer on widget pages only', () => {
    nav.path = '/embed/trade/0x1';
    const bare = render(createElement(AppShell, { children: createElement('p', null, 'widget body') }));
    expect(bare).toBe('<p>widget body</p>');
    nav.path = '/create';
    const site = render(createElement(AppShell, { children: createElement('p', null, 'page body') }));
    expect(site).toContain('aria-label="Primary"');
    expect(site).toContain('href="/widgets"');
    nav.path = '/';
  });
});

describe('widget builder', () => {
  it('starts on the featured token with a copyable iframe and a live preview', () => {
    const html = render(createElement(WidgetBuilder, { initialStocks: stocks }));
    const src = `${publicEnv.appUrl}/embed/trade/${publicEnv.featuredToken}`;
    expect(html).toContain(`src=&quot;${src}&quot;`);
    expect(html).toContain(`<iframe src="/embed/trade/${publicEnv.featuredToken}"`);
    expect(html).toContain('Optional · fit the frame to the widget');
    expect(html).toContain('before you reward anyone for one, look the transaction up on Base');
    expect(html).toContain('aria-label="Parts to add under the trade panel"');
    for (const label of ['Price chart', 'Trades', 'Holders']) expect(html).toContain(`>${label}</button>`);
  });

  it('opens on a token passed in', () => {
    const html = render(createElement(WidgetBuilder, { initialToken: TOKEN, initialStocks: stocks }));
    expect(html).toContain(`<iframe src="/embed/trade/${TOKEN}"`);
  });
});
