import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import type { Address } from 'viem';
import { WagmiProvider, createConfig, custom } from 'wagmi';
import { base } from 'wagmi/chains';
import { describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS, quoteLaunchBuy } from '@stockpair/core';

const nav = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined, replace: () => undefined, refresh: () => undefined }), useSearchParams: () => new URLSearchParams(nav.search) }));

const { CreateForm } = await import('@/components/create/create-form');
const { LaunchReviewSheet, expiresText, profileRowText } = await import('@/components/create/launch-review-sheet');
const { TradeReviewSheet } = await import('@/components/trade/trade-review-sheet');
const { TokenRecords, profileText } = await import('@/components/token/token-records');
const { formatDateTime } = await import('@/lib/format');

/** Server-renders under a wagmi config whose transport refuses every request: nothing leaves the process. */
function render(element: ReactElement): string {
  const config = createConfig({
    chains: [base],
    connectors: [],
    transports: { [base.id]: custom({ request: async () => Promise.reject(new Error('no network in tests')) }) },
  });
  const client = new QueryClient();
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client }, element)))
    .replace(/<!-- -->/gu, '')
    .replace(/&#x27;/gu, "'");
}

const NVDA = BASE_STOCKS[0]!;
const stocks = {
  stocks: [{ address: NVDA.address.toLowerCase(), symbol: NVDA.symbol, ticker: NVDA.ticker, name: NVDA.name, decimals: 8, feed: NVDA.feed, enabled: true, image: null, priceUsd: 230, feedUpdatedAt: null, feedStatus: 'unknown' as const, launches: 0 }],
};

describe('create form', () => {
  it('opens with Buy at launch and the editable profile both off', () => {
    const html = render(createElement(CreateForm, { initialStocks: stocks }));
    expect(html).toContain('Buy at launch (optional)');
    expect(html).toContain('Let me update the image, description and links later');
    const switches = [...html.matchAll(/role="switch" aria-checked="(true|false)"/gu)].map((m) => m[1]);
    expect(switches).toEqual(['false', 'false']);
    // Collapsed while off: no amount field and no tolerance control.
    expect(html).not.toContain('Custom tolerance percent');
    expect(html).not.toMatch(/Amount in /u);
    expect(html).toContain('Telegram (optional)');
    expect(html).not.toMatch(/anti-?snipe/iu);
  });
});

describe('launch review sheet', () => {
  const quote = quoteLaunchBuy({ openingTick: -450_355, tokenIsCurrency0: true, stockIn: 1_000_000n });
  const reviewed = (buy: boolean, extra: object = {}) => ({
    plan: {
      account: '0xc0ffee0000000000000000000000000000000001' as Address,
      chainId: 8453,
      factory: '0xfac7000000000000000000000000000000000001' as Address,
      stock: NVDA.address,
      name: 'Test',
      symbol: 'TEST',
      salt: `0x${'ab'.repeat(32)}` as const,
      predicted: '0x1111111111111111111111111111111111111111' as Address,
      metadataEditable: buy,
      reviewedFdv: 500_000_000_000n,
      creationFee: 1_000_000_000_000_000n,
      buy: buy ? { stockIn: 1_000_000n, tokensOut: quote.tokensOut, toleranceBps: 200 } : null,
      ...extra,
    },
    stock: { symbol: 'NVDAc', ticker: 'NVDA', name: 'NVIDIA Corporation', decimals: 8 },
    stockUsd8: 23_000_000_000n,
    quote: buy ? quote : null,
  });
  const sheet = (buy: boolean, extra: object = {}) =>
    render(createElement(LaunchReviewSheet, { open: false, onClose: () => undefined, reviewed: reviewed(buy, extra), pin: async () => 'ipfs://x', onLaunched: () => undefined, onReviewAgain: () => undefined }));

  it('shows every reviewed row and the one-transaction promise', () => {
    const html = sheet(false);
    for (const text of ['Paired stock', '1,000,000,000 · all of it locked in the pool forever', '$5,000.00 FDV', '0.001 ETH + gas', profileRowText(false), 'Expires', '10 minutes after you confirm', 'One transaction. If any part fails, nothing is launched.']) {
      expect(html, text).toContain(text);
    }
    expect(html).not.toContain('Approve exactly');
    expect(html).not.toMatch(/fixed forever/iu);
  });

  it('adds the buy block and the exact approval line when buying at launch', () => {
    const html = sheet(true);
    expect(html).toContain('Editable onchain by you until you lock it');
    expect(html).toContain('Buy at launch');
    expect(html).toContain('Approve exactly 0.01 NVDAc for the BStocks launch factory. Only a launch you send yourself can use it.');
    expect(html).toContain('Tolerance');
    // A buy may need the approval first, so the sheet does not promise a single transaction.
    expect(html).not.toContain('One transaction.');
    expect(html).toContain('otherwise two: the approval, then the launch');
  });

  it('shows no expiry for a plain launch, which carries no deadline', () => {
    const html = sheet(false, { legacy: true });
    expect(html).not.toContain('Expires');
    expect(html).not.toContain('10 minutes after you confirm');
  });

  it('shows the signed deadline, not the time the sheet opened', () => {
    expect(expiresText(null)).toBe('10 minutes after you confirm');
    const deadline = BigInt(Date.UTC(2026, 8, 25, 14, 22) / 1000);
    const local = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(Number(deadline) * 1000));
    expect(expiresText(deadline)).toBe(`${local} (10 minutes)`);
  });

  it('says what a fixed profile fixes, and that the site profile can still change', () => {
    expect(profileRowText(false)).toBe('Name, symbol, supply and contract URI fixed onchain · what this site shows can still be updated by your signed message');
    expect(profileRowText(true)).toBe('Editable onchain by you until you lock it');
  });

  it('asks for a fresh review instead of launching when the connected wallet is not the reviewed one', () => {
    // No wallet is connected in these renders, so the reviewed account is not the connected one.
    const html = sheet(true);
    expect(html).toContain('Your wallet or network changed since you reviewed.');
    expect(html).toMatch(/<button[^>]*>Review again<\/button>/u);
    expect(html).not.toContain('Create and buy');
  });
});

describe('trade review sheet', () => {
  const market = {
    token: '0x1111111111111111111111111111111111111111',
    symbol: 'TEST',
    stock: { address: NVDA.address, symbol: 'NVDAc', ticker: 'NVDA', decimals: 8 },
    stockUsd: 230,
    stockFeedStatus: 'live',
  } as never;
  const quote = (impact: number) => ({
    amountIn: '100000000',
    amountOut: '1000000000000000000000',
    side: 'buy' as const,
    feeBps: 100,
    midPrice: 1,
    executionPrice: 1,
    priceImpactPercent: impact,
    poolKey: { currency0: '0x1111111111111111111111111111111111111111' as Address, currency1: NVDA.address, fee: 0, tickSpacing: 100, hooks: '0x2000000000000000000000000000000000000001' as Address },
    zeroForOne: false,
    gasEstimate: '1',
    liquidity: '1',
  });
  const sheet = (impact: number, slippageBps: number) =>
    render(createElement(TradeReviewSheet, { open: false, onClose: () => undefined, market, quote: quote(impact), amountIn: 100_000_000n, slippageBps, router: '0x3000000000000000000000000000000000000001' as Address }));

  it('spells out a slippage of 3% or more', () => {
    expect(sheet(1, 300)).toContain('Slippage is 3%. You accept as little as 970 TEST, 3% below the quote.');
    expect(sheet(1, 299)).not.toContain('You accept as little as');
  });

  it('gates Confirm behind a tick only at 25% price impact or more', () => {
    const severe = sheet(25, 100);
    expect(severe).toContain('Very high price impact: this trade moves the price by 25.00%. You get far fewer tokens per NVDAc than the current price suggests.');
    expect(severe).toContain('I understand the price impact');
    expect(severe).toMatch(/<button[^>]*disabled=""[^>]*>Buy TEST for/u);
    const warn = sheet(24.99, 100);
    expect(warn).toContain('Price impact above 5%');
    expect(warn).not.toContain('I understand the price impact');
    expect(warn).not.toMatch(/<button[^>]*disabled=""[^>]*>Buy TEST for/u);
  });
});

describe('token records', () => {
  const market = {
    token: '0x1111111111111111111111111111111111111111',
    name: 'Test',
    symbol: 'TEST',
    creator: '0x2222222222222222222222222222222222222222',
    stock: { address: NVDA.address, symbol: 'NVDAc', ticker: 'NVDA', decimals: 8 },
    poolId: `0x${'cd'.repeat(32)}`,
    txHash: `0x${'e1'.repeat(32)}`,
    launchedAt: '2026-09-20T10:00:00.000Z',
    holders: 3,
    description: null,
    website: null,
    twitter: null,
    telegram: null,
    profileUpdatedAt: null,
    priceInStock: null,
    priceUsd: null,
  } as never;
  const profile = (onchain: 'immutable' | 'editable' | 'locked', extra: object = {}) => ({ onchain, contractUri: 'ipfs://x', contentAddressed: true, updates: 0, lastUpdatedAt: null, lockedAt: null, ...extra });

  it('describes each profile state in one line', () => {
    expect(profileText({ profileUpdatedAt: null }, profile('immutable'))).toBe('As written in the launch metadata');
    expect(profileText({ profileUpdatedAt: null }, profile('editable'))).toBe('Editable onchain by the creator · not changed yet');
    expect(profileText({ profileUpdatedAt: null }, profile('editable', { updates: 2, lastUpdatedAt: '2026-09-20T10:00:00.000Z' }))).toBe(`Editable onchain by the creator · changed 2 times, last ${formatDateTime('2026-09-20T10:00:00.000Z')}`);
    expect(profileText({ profileUpdatedAt: null }, profile('editable', { updates: 1, lastUpdatedAt: '2026-09-20T10:00:00.000Z' }))).toContain('changed 1 time, last');
    expect(profileText({ profileUpdatedAt: null }, profile('locked', { lockedAt: '2026-09-21T10:00:00.000Z' }))).toMatch(/^Locked by the creator on 21 .+ UTC\. It can never change again\.$/u);
    const warning = ' Part of this profile is served from an address whose content can change without an onchain record.';
    expect(profileText({ profileUpdatedAt: null }, profile('immutable', { contentAddressed: false }))).toBe(`As written in the launch metadata${warning}`);
    // Locked, but an image at a web address can still change: only the link is promised.
    const locked = profileText({ profileUpdatedAt: null }, profile('locked', { lockedAt: '2026-09-21T10:00:00.000Z', contentAddressed: false }));
    expect(locked).toMatch(/^Locked by the creator on 21 .+ UTC\. The token can never point at a different profile again\. Part of this profile/u);
    expect(locked).not.toContain('It can never change again');
  });

  it('shows the creator buy at launch, the profile permission, and no anti-snipe fee', () => {
    nav.search = 'tab=details';
    const launch = { factory: null, hook: null, creatorBuy: { stockInRaw: '100000000', feeRaw: '1000000', tokensOutRaw: (43_500_000n * 10n ** 18n).toString(), supplyBps: 435, txHash: `0x${'e1'.repeat(32)}` } };
    const html = render(createElement(TokenRecords, { market, launch, profile: profile('editable') }));
    expect(html).toContain('Creator buy at launch');
    expect(html).toContain('43,500,000 TEST (4.35%) for 1 NVDAc');
    expect(html).toContain('Profile permission');
    expect(html).toContain('uses it only to replace the contract URI when the original creator asks');
    expect(html).toContain('1% of every swap in NVDAc: 70% to the creator, 30% to the platform.');
    expect(html).not.toMatch(/anti-?snipe|99%/iu);

    const old = render(createElement(TokenRecords, { market, launch: { factory: null, hook: null, creatorBuy: null }, profile: profile('immutable') }));
    expect(old).toMatch(/Creator buy at launch<\/span><span[^>]*>None</u);
    expect(old).not.toContain('Profile permission');
    nav.search = '';
  });
});
