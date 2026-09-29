import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WagmiProvider, createConfig, custom } from 'wagmi';
import { base } from 'wagmi/chains';
import { describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';

import {
  EMBED_SECTIONS,
  accentStylesheet,
  accentTokens,
  contrastRatio,
  embedPath,
  embedSnippet,
  parseEmbedAccent,
  parseEmbedHide,
  withEmbedParams,
  type EmbedSection,
} from '@/lib/embed';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/embed/create',
}));

const { TradeWidget } = await import('@/components/embed/trade-widget');
const { CreateWidget } = await import('@/components/embed/create-widget');
const { EmbedShell } = await import('@/components/embed/embed-shell');
const { WidgetBuilder } = await import('@/components/widgets/widget-builder');

const TOKEN = '0xB20000000000000000000023B657130129AD33E5';

describe('widget sections a host can hide', () => {
  it('reads only the sections it knows, once each, in a fixed order', () => {
    expect(parseEmbedHide('steps, BUY,profile,steps,nonsense')).toEqual(['buy', 'profile', 'steps']);
    expect(parseEmbedHide('')).toEqual([]);
    expect(parseEmbedHide(null)).toEqual([]);
  });

  it('puts only the widget’s own sections in its path, commas left readable', () => {
    const hide: EmbedSection[] = ['header', 'presets', 'steps', 'buy'];
    expect(embedPath({ widget: 'trade', token: TOKEN, hide })).toBe(`/embed/trade/${TOKEN.toLowerCase()}?hide=header,presets`);
    expect(embedPath({ widget: 'create', hide })).toBe('/embed/create?hide=header,buy,steps');
    expect(embedPath({ widget: 'create', hide: [] })).toBe('/embed/create');
  });

  it('never lets the price, the fee or the eligibility question be hidden', () => {
    const all = [...EMBED_SECTIONS.trade, ...EMBED_SECTIONS.create] as string[];
    for (const kept of ['price', 'fee', 'quote', 'review', 'eligibility', 'powered']) expect(all).not.toContain(kept);
  });
});

describe('widget primary colour', () => {
  it('takes a six-digit hex with or without #, and nothing else', () => {
    expect(parseEmbedAccent('0052FF')).toBe('#0052ff');
    expect(parseEmbedAccent('#0052ff')).toBe('#0052ff');
    for (const bad of ['blue', '#05f', '0052ffaa', 'red;}body{display:none', '', null]) expect(parseEmbedAccent(bad)).toBeNull();
  });

  it('carries the colour in the path and the snippet', () => {
    expect(embedPath({ widget: 'create', accent: '#0052ff', theme: 'dark' })).toBe('/embed/create?theme=dark&accent=0052ff');
    expect(embedSnippet('https://launchpad.basestocks.finance', { widget: 'trade', token: TOKEN, accent: '#12b76a' })).toContain('?accent=12b76a"');
    expect(embedPath({ widget: 'create', accent: 'nope' })).toBe('/embed/create');
  });

  it('derives the four tokens per theme, with readable button text', () => {
    const blue = accentTokens('#0052ff');
    expect(blue.light['--primary']).toBe('#0052ff');
    expect(blue.light['--primary-contrast']).toBe('#ffffff');
    expect(blue.light['--primary-soft']).toBe('rgba(0, 82, 255, 0.08)');
    expect(blue.dark['--primary-soft']).toBe('rgba(0, 82, 255, 0.16)');
    // Pressed shade: darker on light, lighter on dark, as the site's own blue does.
    expect(contrastRatio(blue.light['--primary-strong']!, '#ffffff')).toBeGreaterThan(contrastRatio('#0052ff', '#ffffff'));
    expect(contrastRatio(blue.dark['--primary-strong']!, '#0a0b0d')).toBeGreaterThan(contrastRatio('#0052ff', '#0a0b0d'));
    // A light colour gets dark text on its buttons.
    expect(accentTokens('#ffd60a').light['--primary-contrast']).toBe('#0a0b0d');
  });

  it('writes a stylesheet only from a parsed colour, so a query cannot inject CSS', () => {
    const css = accentStylesheet('#0052ff');
    expect(css).toContain(':root:root{--primary:#0052ff;');
    expect(css).toContain(':root:root[data-theme="dark"]{');
    expect(css).toContain('@media (prefers-color-scheme: dark){:root:root:not([data-theme="light"]){');
    expect(accentStylesheet(null)).toBe('');
    expect(accentStylesheet('#0052ff;}body{display:none')).toBe('');
    expect(accentStylesheet('</style><script>')).toBe('');
  });

  it('keeps the colour and hidden sections when the frame moves from create to trade', () => {
    expect(withEmbedParams('/embed/trade/0x1?tx=0x2', '?accent=0052ff&hide=steps,header&stock=0x3')).toBe('/embed/trade/0x1?tx=0x2&accent=0052ff&hide=header,steps');
    expect(withEmbedParams('/embed/trade/0x1', '?accent=bad&hide=nope')).toBe('/embed/trade/0x1');
  });
});

/** Server-renders as the widget page does, with no network. */
function render(element: ReactElement): string {
  const config = createConfig({ chains: [base], connectors: [], transports: { [base.id]: custom({ request: async () => Promise.reject(new Error('no network in tests')) }) } });
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client: new QueryClient() }, element)))
    .replace(/<!-- -->/gu, '')
    .replace(/&#x27;/gu, "'");
}

const NVDA = BASE_STOCKS[0]!;
const stocks = {
  stocks: [{ address: NVDA.address.toLowerCase(), symbol: NVDA.symbol, ticker: NVDA.ticker, name: NVDA.name, decimals: 8, feed: NVDA.feed, enabled: true, image: null, priceUsd: 230, feedUpdatedAt: null, feedStatus: 'unknown' as const, launches: 0 }],
};
const market = {
  token: TOKEN.toLowerCase(),
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
} as never;
const indexed = { status: 'indexed', market, launch: { factory: null, hook: null, creatorBuy: null }, profile: { onchain: 'immutable', contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null } } as never;

const create = (hide: EmbedSection[], accent: string | null = null) => render(createElement(EmbedShell, { widget: 'create', hide, accent, children: createElement(CreateWidget, { initialStocks: stocks }) }));
const trade = (hide: EmbedSection[]) => render(createElement(EmbedShell, { widget: 'trade', hide, children: createElement(TradeWidget, { address: TOKEN.toLowerCase(), initialData: indexed }) }));

describe('a create widget with parts hidden', () => {
  it('shows everything by default', () => {
    const html = create([]);
    for (const text of ['Launch a stock-paired token', 'Website (optional)', 'Buy at launch (optional)', 'Let me update the image, description and links later', 'What happens', 'A zero-admin B20 token']) expect(html).toContain(text);
  });

  it('leaves out exactly what the host hid, and keeps what matters', () => {
    const html = create(['header', 'links', 'buy', 'profile', 'steps']);
    for (const text of ['Launch a stock-paired token', 'Website (optional)', 'X (optional)', 'Buy at launch (optional)', 'Let me update the image, description and links later', 'What happens', 'A zero-admin B20 token']) expect(html).not.toContain(text);
    for (const text of ['Name', 'Symbol', 'Description', 'Paired stock', 'Creation fee', 'Creator share']) expect(html).toContain(text);
    expect(html).toContain('>Launch<');
  });

  it('carries the host colour into the page', () => {
    expect(create([], '#12b76a')).toContain('<style>:root:root{--primary:#12b76a;');
    expect(create([])).not.toContain(':root:root');
  });
});

describe('a trade widget with parts hidden', () => {
  it('leaves out the title, presets and notes, and keeps the trade', () => {
    const full = trade([]);
    expect(full).toContain('aria-label="Open the full token page"');
    expect(full).toContain('aria-label="Share of stock balance to spend"');
    expect(full).toContain('liquidity locked forever');
    const bare = trade(['header', 'presets', 'notes']);
    expect(bare).not.toContain('aria-label="Open the full token page"');
    expect(bare).not.toContain('aria-label="Share of stock balance to spend"');
    expect(bare).not.toContain('liquidity locked forever');
    expect(bare).toContain('aria-label="Trade side"');
    expect(bare).toContain('Live quote');
    expect(bare).toContain('Powered by');
  });
});

describe('widget builder style controls', () => {
  it('offers a colour and the sections of the chosen widget', () => {
    const html = render(createElement(WidgetBuilder, { initialStocks: stocks }));
    expect(html).toContain('Primary colour');
    expect(html).toContain('aria-label="Sections to hide"');
    for (const label of ['Title', 'Balance presets', 'Pool notes']) expect(html).toContain(label);
  });
});
