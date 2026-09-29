import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WagmiProvider, createConfig, custom } from 'wagmi';
import { base } from 'wagmi/chains';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';

import type { RegionState } from '@/lib/region';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => '/embed/trade/0x1',
}));

const { TradeWidget } = await import('@/components/embed/trade-widget');
const { CreateWidget } = await import('@/components/embed/create-widget');
const { EmbedShell } = await import('@/components/embed/embed-shell');
const { WidgetBuilder } = await import('@/components/widgets/widget-builder');
const { ATTESTATION_TEXT } = await import('@/components/common/eligibility');
const { eligibilityHeaders, storeAttestation, storedAttestation } = await import('@/lib/eligibility');

/** Server-renders with the region answer already in the cache, as the page has it after /api/region. */
function render(element: ReactElement, region?: RegionState): string {
  const config = createConfig({
    chains: [base],
    connectors: [],
    transports: { [base.id]: custom({ request: async () => Promise.reject(new Error('no network in tests')) }) },
  });
  const client = new QueryClient();
  if (region) client.setQueryData(['region'], region);
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client }, element)))
    .replace(/<!-- -->/gu, '')
    .replace(/&#x27;/gu, "'")
    .replace(/&#x2019;/gu, '’');
}

const NVDA = BASE_STOCKS[0]!;
const TOKEN = '0x1111111111111111111111111111111111111111';
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
} as never;
const stocks = {
  stocks: [{ address: NVDA.address.toLowerCase(), symbol: NVDA.symbol, ticker: NVDA.ticker, name: NVDA.name, decimals: 8, feed: NVDA.feed, enabled: true, image: null, priceUsd: 230, feedUpdatedAt: null, feedStatus: 'unknown' as const, launches: 0 }],
};
const indexed = { status: 'indexed', market, launch: { factory: null, hook: null, creatorBuy: null }, profile: { onchain: 'immutable', contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null } } as never;

const region = (over: Partial<RegionState>): RegionState => ({ country: 'TR', blocked: ['US'], mode: 'attest', blockedCountry: false, attested: false, restricted: false, ...over });
const US = region({ country: 'US', blockedCountry: true, restricted: true });

const trade = (eligibility: 'region' | 'always', state?: RegionState) =>
  render(createElement(EmbedShell, { widget: 'trade', eligibility, children: createElement(TradeWidget, { address: TOKEN, initialData: indexed }) }), state);

describe('the eligibility check at the trade button', () => {
  it('asks a US connection before a trade, and says where the connection comes from', () => {
    const html = trade('region', US);
    expect(html).toContain('Before you trade · connection from US');
    expect(html).toContain(ATTESTATION_TEXT);
    expect(html).toContain('Confirm and continue');
  });

  it('asks nobody else by default', () => {
    expect(trade('region', region({}))).not.toContain(ATTESTATION_TEXT);
    // Nor before the region is known: a slow /api/region must not put a question in front of everyone.
    expect(trade('region')).not.toContain(ATTESTATION_TEXT);
  });

  it('asks every visitor where the host chose it, and stops once they answered', () => {
    expect(trade('always', region({}))).toContain(ATTESTATION_TEXT);
    expect(trade('always')).toContain(ATTESTATION_TEXT);
    expect(trade('always', region({ attested: true }))).not.toContain(ATTESTATION_TEXT);
  });

  it('refuses without a question where the deployment blocks outright', () => {
    const html = trade('always', region({ country: 'US', mode: 'block', blockedCountry: true, restricted: true }));
    expect(html).toContain('Trading is not available from your region');
    expect(html).not.toContain(ATTESTATION_TEXT);
  });

  it('asks in the frame, never in a dialog the host page may not show', () => {
    // The wallet sheet is a dialog of its own; no dialog may carry the question.
    const html = trade('region', US);
    const dialogs = [...html.matchAll(/<dialog[\s\S]*?<\/dialog>/gu)].map((m) => m[0]);
    expect(dialogs.some((d) => d.includes(ATTESTATION_TEXT) || d.includes('Before you trade'))).toBe(false);
  });
});

describe('the eligibility check at the launch button', () => {
  const create = (eligibility: 'region' | 'always', state?: RegionState) =>
    render(createElement(EmbedShell, { widget: 'create', eligibility, children: createElement(CreateWidget, { initialStocks: stocks }) }), state);

  it('asks before a launch the same way', () => {
    expect(create('region', US)).toContain('Before you launch · connection from US');
    expect(create('always', region({}))).toContain('Before you launch');
    expect(create('region', region({}))).not.toContain(ATTESTATION_TEXT);
    expect(create('region', region({ country: 'US', mode: 'block', blockedCountry: true, restricted: true }))).toContain('Launching is not available from your region');
  });
});

describe('widget builder', () => {
  it('offers the host a choice of who is asked', () => {
    const html = render(createElement(WidgetBuilder, { initialStocks: stocks }));
    expect(html).toContain('Eligibility check');
    expect(html).toContain('Restricted regions');
    expect(html).toContain('Every visitor');
  });
});

describe('the answer as the browser keeps it', () => {
  const store = new Map<string, string>();
  const fakeWindow = {
    localStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    dispatchEvent: () => true,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  };
  afterEach(() => {
    vi.unstubAllGlobals();
    store.clear();
  });

  it('sends the header only after the visitor answered, for 30 days', () => {
    vi.stubGlobal('window', fakeWindow);
    const now = Date.UTC(2026, 8, 30);
    storeAttestation(false, now);
    expect(eligibilityHeaders()).toEqual({});
    storeAttestation(true, now);
    expect(storedAttestation(now)).toBe(true);
    expect(eligibilityHeaders()).toEqual({ 'x-bstocks-eligibility': 'confirmed' });
    expect(storedAttestation(now + 29 * 86_400_000)).toBe(true);
    expect(storedAttestation(now + 31 * 86_400_000)).toBe(false);
    storeAttestation(false, now);
    expect(storedAttestation(now)).toBe(false);
  });

  it('still holds the answer for the page when storage is refused', () => {
    vi.stubGlobal('window', {
      ...fakeWindow,
      localStorage: {
        getItem: () => {
          throw new Error('denied');
        },
        setItem: () => {
          throw new Error('denied');
        },
        removeItem: () => undefined,
      },
    });
    const now = Date.now();
    storeAttestation(true, now);
    expect(storedAttestation(now)).toBe(true);
    storeAttestation(false, now);
    expect(storedAttestation(now)).toBe(false);
  });
});
