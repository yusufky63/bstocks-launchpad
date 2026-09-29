import { createRequire } from 'node:module';

import { describe, expect, it } from 'vitest';

import { THEME_STORAGE_KEY } from '@/components/layout/theme-provider';
import nextConfig from '@/next.config';
import {
  EMBED_HEIGHT,
  EMBED_MESSAGE_SOURCE,
  THEME_SCRIPT,
  embedLinkAction,
  embedMessage,
  embedPath,
  embedResizeScript,
  embedSnippet,
  parseEmbedEligibility,
  parseEmbedSide,
  parseEmbedTheme,
  withEmbedParams,
} from '@/lib/embed';
import { earlyTradeMarket, tradeMarketOf } from '@/lib/trade-market';

const TOKEN = '0xB20000000000000000000023B657130129AD33E5';
const STOCK = '0x1111111111111111111111111111111111111111';
const APP = 'https://launchpad.basestocks.finance';

describe('widget options', () => {
  it('reads theme and side from the query, defaulting anything else', () => {
    expect(parseEmbedTheme('dark')).toBe('dark');
    expect(parseEmbedTheme('light')).toBe('light');
    expect(parseEmbedTheme('DARK')).toBe('auto');
    expect(parseEmbedTheme(null)).toBe('auto');
    expect(parseEmbedSide('sell')).toBe('sell');
    expect(parseEmbedSide('buy')).toBe('buy');
    expect(parseEmbedSide('short')).toBe('buy');
    expect(parseEmbedSide(undefined)).toBe('buy');
    expect(parseEmbedEligibility('always')).toBe('always');
    expect(parseEmbedEligibility('never')).toBe('region');
    expect(parseEmbedEligibility(null)).toBe('region');
  });

  it('builds the widget path with only the parameters that differ from the defaults', () => {
    expect(embedPath({ widget: 'trade', token: TOKEN })).toBe(`/embed/trade/${TOKEN.toLowerCase()}`);
    expect(embedPath({ widget: 'trade', token: TOKEN, side: 'sell', theme: 'dark' })).toBe(`/embed/trade/${TOKEN.toLowerCase()}?side=sell&theme=dark`);
    expect(embedPath({ widget: 'trade', token: TOKEN, side: 'buy', theme: 'auto' })).toBe(`/embed/trade/${TOKEN.toLowerCase()}`);
    expect(embedPath({ widget: 'create' })).toBe('/embed/create');
    expect(embedPath({ widget: 'create', stock: STOCK, theme: 'light' })).toBe(`/embed/create?stock=${STOCK}&theme=light`);
    // A stock that is not an address is dropped rather than passed on to the form.
    expect(embedPath({ widget: 'create', stock: 'NVDA' })).toBe('/embed/create');
    expect(embedPath({ widget: 'trade', token: TOKEN, eligibility: 'always' })).toBe(`/embed/trade/${TOKEN.toLowerCase()}?eligibility=always`);
    expect(embedPath({ widget: 'create', eligibility: 'region' })).toBe('/embed/create');
  });

  it('refuses a trade widget without a token address', () => {
    expect(() => embedPath({ widget: 'trade' })).toThrow();
    expect(() => embedPath({ widget: 'trade', token: '0x1234' })).toThrow();
  });

  it('gives a host an unsandboxed iframe on this site at the widget height', () => {
    const snippet = embedSnippet(`${APP}/`, { widget: 'trade', token: TOKEN, theme: 'dark' });
    expect(snippet).toContain(`src="${APP}/embed/trade/${TOKEN.toLowerCase()}?theme=dark"`);
    expect(snippet).toContain(`height="${EMBED_HEIGHT.trade}"`);
    expect(snippet).toContain('title="Trade on BStocks Launchpad"');
    expect(snippet).not.toContain('sandbox');
    expect(snippet).toMatch(/^<iframe[\s\S]*><\/iframe>$/u);
    // Two query parameters must survive inside an HTML attribute.
    expect(embedSnippet(APP, { widget: 'create', stock: STOCK, theme: 'light' })).toContain(`src="${APP}/embed/create?stock=${STOCK}&amp;theme=light"`);
  });

  it('only lets the resize script trust this site', () => {
    const script = embedResizeScript(`${APP}/`);
    expect(script).toContain(`e.origin !== '${APP}'`);
    expect(script).toContain(`e.data.source !== '${EMBED_MESSAGE_SOURCE}'`);
    expect(script).toContain('f.contentWindow === e.source');
  });

  it('stamps every message with the source a host filters on', () => {
    expect(embedMessage({ type: 'swap', token: TOKEN, side: 'sell', txHash: '0xabc' })).toEqual({ source: 'bstocks-launchpad', type: 'swap', token: TOKEN, side: 'sell', txHash: '0xabc' });
    expect(embedMessage({ type: 'resize', height: 612 })).toEqual({ source: 'bstocks-launchpad', type: 'resize', height: 612 });
  });

  it('keeps the host theme and eligibility check when the widget moves on inside the frame', () => {
    expect(withEmbedParams('/embed/trade/0x1?tx=0x2', '?theme=dark')).toBe('/embed/trade/0x1?tx=0x2&theme=dark');
    expect(withEmbedParams('/embed/trade/0x1', '?stock=0x3&theme=light')).toBe('/embed/trade/0x1?theme=light');
    expect(withEmbedParams('/embed/trade/0x1', '')).toBe('/embed/trade/0x1');
    expect(withEmbedParams('/embed/trade/0x1', '?theme=neon')).toBe('/embed/trade/0x1');
    // A host that asks every visitor must not lose that the moment a launch moves on to trading.
    expect(withEmbedParams('/embed/trade/0x1?tx=0x2', '?eligibility=always&theme=dark')).toBe('/embed/trade/0x1?tx=0x2&theme=dark&eligibility=always');
    expect(withEmbedParams('/embed/trade/0x1', '?eligibility=sometimes')).toBe('/embed/trade/0x1');
  });

});

describe('theme before paint', () => {
  /** Runs the root layout's inline script against a fake page and returns the theme it set. */
  function themeFor(url: string, stored: string | null | 'refused'): string | null {
    let applied: string | null = null;
    const document = { documentElement: { setAttribute: (_name: string, value: string) => { applied = value; } } };
    const localStorage = {
      getItem: () => {
        if (stored === 'refused') throw new Error('storage denied in this frame');
        return stored;
      },
    };
    new Function('location', 'localStorage', 'document', 'URLSearchParams', THEME_SCRIPT)(new URL(url), localStorage, document, URLSearchParams);
    return applied;
  }

  it("lets a host's theme win inside a widget", () => {
    expect(themeFor(`${APP}/embed/trade/0x1?theme=dark`, 'light')).toBe('dark');
    expect(themeFor(`${APP}/embed/create?stock=0x2&theme=light`, 'dark')).toBe('light');
    // A frame refused storage still gets the host's theme.
    expect(themeFor(`${APP}/embed/create?theme=dark`, 'refused')).toBe('dark');
  });

  it("keeps the visitor's own choice everywhere else", () => {
    expect(themeFor(`${APP}/embed/create`, 'light')).toBe('light');
    expect(themeFor(`${APP}/embed/create?theme=neon`, 'dark')).toBe('dark');
    expect(themeFor(`${APP}/token/0x1?theme=dark`, null)).toBeNull();
    expect(themeFor(`${APP}/embedded?theme=dark`, null)).toBeNull();
    expect(themeFor(`${APP}/`, 'dark')).toBe('dark');
    expect(themeFor(`${APP}/`, 'refused')).toBeNull();
  });

  it('reads the key the theme toggle writes', () => {
    expect(THEME_SCRIPT).toContain(`localStorage.getItem('${THEME_STORAGE_KEY}')`);
  });
});

describe('links inside a widget', () => {
  const page = `${APP}/embed/trade/${TOKEN}`;

  it('keeps widget pages in the frame', () => {
    expect(embedLinkAction(`/embed/trade/${TOKEN}?tx=0x1`, page)).toBe('frame');
    expect(embedLinkAction(`${APP}/embed/create`, page)).toBe('frame');
  });

  it('opens the rest of the site and other sites in a new tab', () => {
    expect(embedLinkAction(`/wallet/${STOCK}`, page)).toBe('new-tab');
    expect(embedLinkAction('/', page)).toBe('new-tab');
    expect(embedLinkAction('/embedded', page)).toBe('new-tab');
    expect(embedLinkAction('https://basescan.org/tx/0x1', page)).toBe('new-tab');
  });

  it('leaves alone links that choose their own target or are not web pages', () => {
    expect(embedLinkAction('https://basestocks.finance', page, '_blank')).toBe('default');
    expect(embedLinkAction('/wallet/x', page, '_self')).toBe('new-tab');
    expect(embedLinkAction('#fees', page)).toBe('default');
    expect(embedLinkAction('mailto:hi@example.com', page)).toBe('default');
    expect(embedLinkAction('javascript:void(0)', page)).toBe('default');
    expect(embedLinkAction(null, page)).toBe('default');
  });
});

describe('trade market for a widget', () => {
  const launch = {
    token: TOKEN.toLowerCase(),
    stock: STOCK,
    creator: '0x2222222222222222222222222222222222222222',
    name: 'Test',
    symbol: 'TEST',
    contractURI: 'ipfs://x',
    launchedAt: '2026-09-29T10:00:00.000Z',
    stockSymbol: 'NVDAc',
    stockTicker: 'NVDA',
    stockDecimals: 8,
    stockUsd8: '23000000000',
    factory: '0x3333333333333333333333333333333333333333',
    hook: '0x4444444444444444444444444444444444444444',
  };

  it('trades a launch that is live but not indexed against the live pool', () => {
    expect(earlyTradeMarket(launch)).toEqual({
      token: launch.token,
      symbol: 'TEST',
      factory: launch.factory,
      hook: launch.hook,
      stock: { address: STOCK, symbol: 'NVDAc', ticker: 'NVDA', decimals: 8 },
      stockUsd: 230,
      priceUsd: null,
      priceInStock: null,
      stockFeedStatus: 'unknown',
    });
  });

  it('has nothing to trade for an unknown stock or a launch still in flight', () => {
    expect(earlyTradeMarket({ ...launch, stockDecimals: null })).toBeNull();
    expect(tradeMarketOf({ status: 'pending', token: launch.token, txHash: null })).toBeNull();
    expect(tradeMarketOf({ status: 'indexing', launch })?.token).toBe(launch.token);
  });
});

describe('who may frame the site', () => {
  const { pathToRegexp } = createRequire(import.meta.url)('next/dist/compiled/path-to-regexp') as { pathToRegexp: (path: string) => RegExp };

  async function headersFor(path: string): Promise<Record<string, string>> {
    const rules = (await nextConfig.headers?.()) ?? [];
    const out: Record<string, string> = {};
    for (const rule of rules) {
      if (!pathToRegexp(rule.source).test(path)) continue;
      for (const h of rule.headers) out[h.key] = h.value;
    }
    return out;
  }

  it('refuses every page outside the widgets', async () => {
    for (const path of ['/', '/create', `/token/${TOKEN}`, '/widgets', '/docs', '/embedded', '/api/markets']) {
      const headers = await headersFor(path);
      expect(headers['X-Frame-Options'], path).toBe('DENY');
      expect(headers['Content-Security-Policy'], path).toBeUndefined();
    }
  });

  it('lets any site frame a widget', async () => {
    for (const path of ['/embed/create', `/embed/trade/${TOKEN}`]) {
      const headers = await headersFor(path);
      expect(headers['X-Frame-Options'], path).toBeUndefined();
      expect(headers['Content-Security-Policy'], path).toBe('frame-ancestors *');
      expect(headers['X-Content-Type-Options'], path).toBe('nosniff');
    }
  });
});
