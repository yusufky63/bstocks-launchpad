'use client';

import { ArrowUpRight, ImagePlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useMemo, useState, useSyncExternalStore } from 'react';
import { erc20Abi, parseAbi, zeroAddress, type Address } from 'viem';
import { useAccount, useReadContracts } from 'wagmi';
import { base } from 'wagmi/chains';

import { fdvUsd as fdvUsdOf, formatAmount, openingPriceUsd, parseAmount, stockPairFactoryAbi, stockPerTokenE30, tokenIsCurrency0 } from '@stockpair/core';

import { ConnectButton } from '@/components/layout/connect-button';
import { StockCoin } from '@/components/stock/stock-coin';
import { Checkbox, Input, Switch, TextArea } from '@/components/ui/controls';
import { Banner } from '@/components/ui/display';
import { Button, Chip, KeyValue, Module, ModuleHeader, cx } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';
import { bpsToPct, formatDateTime, formatNumber, formatUsd } from '@/lib/format';
import {
  DEV_BUY_BLOCK_BPS,
  DEV_BUY_CONFIRM_BPS,
  DEV_BUY_NOTICE_BPS,
  DEV_TOLERANCE_DEFAULT_BPS,
  DEV_TOLERANCE_PRESETS_BPS,
  devBuyMinOut,
  devBuyTier,
  parseToleranceInput,
  pausedReason,
  quoteDevBuy,
  stockInForShare,
  useLaunchSalt,
} from '@/lib/launch';
import { normalizeTelegram } from '@/lib/profile';
import { useStocks } from '@/lib/queries';
import { normalizeTwitter } from '@/lib/twitter';
import type { StocksResponse } from '@/lib/types';

import { LaunchReviewSheet, type ReviewedLaunch } from './launch-review-sheet';

type Errors = Partial<Record<'name' | 'symbol' | 'description' | 'website' | 'twitter' | 'telegram' | 'image' | 'stock' | 'buy', string>>;

const feedAbi = parseAbi(['function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)']);

/** The feed holds its last price while the stock market is shut; past this age the notice says so. */
const MARKET_CLOSED_AFTER_S = 60 * 60;
const BSTOCKS_URL = 'https://basestocks.finance/stocks';

const subscribeNever = () => () => {};

/**
 * `/create?name=&symbol=&stock=` arrives from outside: the Telegram bot builds it from what
 * somebody typed in a chat, and a link that lands on an empty form makes the bot look broken while
 * the fault is here.
 *
 * The URL is read as an external store rather than through `useSearchParams` so the page stays
 * static and nothing is assigned from an effect: the server snapshot is empty, the client one is
 * real, and `useSyncExternalStore` is what keeps that from being a hydration mismatch. Same shape
 * the sibling app uses for its own handoff.
 *
 * Nothing here is trusted beyond being a starting value. The name and symbol go through the same
 * validation as anything typed by hand, and the stock has to match one the factory actually
 * accepts, so a crafted link can only ever pre-fill a field, never widen what may be launched.
 * Buy at launch and the editable profile are never prefilled or remembered: both start off.
 */
function parsePrefill(search: string): { name?: string; symbol?: string; stock?: string } {
  const params = new URLSearchParams(search);
  const name = params.get('name')?.slice(0, 64) ?? undefined;
  const symbol = params.get('symbol')?.slice(0, 16) ?? undefined;
  const stock = params.get('stock') ?? undefined;
  return {
    name: name || undefined,
    symbol: symbol || undefined,
    stock: stock && /^0x[0-9a-fA-F]{40}$/.test(stock) ? stock.toLowerCase() : undefined,
  };
}

const pct2 = (ppm: bigint) => `${(Number(ppm) / 10_000).toFixed(2)}%`;

export function CreateForm({ initialStocks }: { initialStocks?: StocksResponse }) {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  // New launches go to the newest deployment only; older factories keep their tokens, not new ones.
  const deployment = publicEnv.newest;

  const search = useSyncExternalStore(subscribeNever, () => window.location.search, () => '');
  const prefill = useMemo(() => parsePrefill(search), [search]);

  // Held as null until the person types, so a prefilled value can appear after hydration without an
  // effect writing it in, and clearing a field still clears it.
  const [nameState, setName] = useState<string | null>(null);
  const [symbolState, setSymbol] = useState<string | null>(null);
  const name = nameState ?? prefill.name ?? '';
  const symbol = symbolState ?? prefill.symbol ?? '';
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [telegram, setTelegram] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stockState, setStock] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  // Component state only: every visit starts with no buy, the default tolerance and a fixed profile.
  const [buyOn, setBuyOn] = useState(false);
  const [buyText, setBuyText] = useState('');
  const [toleranceBps, setToleranceBps] = useState<number>(DEV_TOLERANCE_DEFAULT_BPS);
  const [toleranceText, setToleranceText] = useState('');
  const [toleranceError, setToleranceError] = useState<string | null>(null);
  const [shareAck, setShareAck] = useState(false);
  const [editable, setEditable] = useState(false);
  const [salt, renewSalt] = useLaunchSalt();
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [reviewed, setReviewed] = useState<(ReviewedLaunch & { id: number }) | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);

  const { data: stocksData } = useStocks(initialStocks);
  const stocks = (stocksData?.stocks ?? []).filter((s) => s.enabled);

  // Resolved against the list rather than taken from the URL, so the value is always exactly one
  // the factory accepts and the match cannot turn on whether two sides happen to agree about case.
  const prefillStock = useMemo(
    () => (prefill.stock ? (stocks.find((s) => s.address.toLowerCase() === prefill.stock)?.address ?? null) : null),
    [stocks, prefill.stock],
  );
  const stock = stockState ?? prefillStock;
  const selected = stocks.find((s) => s.address === stock) ?? null;
  const onBase = isConnected && !!address && chainId === base.id;

  const liveQuery = { refetchInterval: 15_000, refetchOnWindowFocus: true } as const;
  const factoryReads = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'creationFee' },
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'openingFdvUsd8' },
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'predictToken', args: address ? [address, salt] : undefined },
      // Capability read: only a factory with the launch options answers this.
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'metadataStatus', args: [zeroAddress] },
    ],
    query: { enabled: Boolean(deployment), ...liveQuery },
  });
  const creationFee = factoryReads.data?.[0]?.result as bigint | undefined;
  const openingFdv = factoryReads.data?.[1]?.result as bigint | undefined;
  const predicted = factoryReads.data?.[2]?.result as Address | undefined;
  const legacy = factoryReads.data?.[3]?.status === 'failure';
  const feeEth = creationFee === undefined ? null : Number(creationFee) / 1e18;
  const fdvUsd = openingFdv === undefined ? 5_000 : Number(openingFdv) / 1e8;

  const stockReads = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'previewOpening', args: stock && predicted ? [stock as Address, predicted] : undefined },
      { address: stock as Address | undefined, abi: erc20Abi, functionName: 'balanceOf', args: address ? [address] : undefined },
      { address: selected?.feed as Address | undefined, abi: feedAbi, functionName: 'latestRoundData' },
    ],
    query: { enabled: Boolean(deployment && stock && predicted), ...liveQuery },
  });
  const opening = stockReads.data?.[0]?.result as readonly [bigint, number, bigint] | undefined;
  const balance = stockReads.data?.[1]?.result as bigint | undefined;
  const round = stockReads.data?.[2]?.result as readonly [bigint, bigint, bigint, bigint, bigint] | undefined;

  const decimals = selected?.decimals ?? 8;
  const stockSymbol = selected?.symbol ?? 'the stock';
  const ticker = selected?.ticker ?? 'The stock';
  // previewOpening reverts when the factory will not launch against this stock right now (disabled,
  // or a feed too old or broken); say so, rather than leaving the quote lines empty for no reason.
  const pausedNow = stockReads.data?.[0]?.status === 'failure' ? pausedReason(stockReads.data[0].error, { stock: stockSymbol, ticker }) : null;
  const stockUsd8 = opening?.[2];
  const stockUsd = stockUsd8 === undefined ? null : Number(stockUsd8) / 1e8;
  const usdOf = (raw: bigint) => (stockUsd === null ? null : (Number(raw) / 10 ** decimals) * stockUsd);
  const feedUpdatedAt = round ? Number(round[3]) : null;
  const marketClosed = feedUpdatedAt !== null && Date.now() / 1000 - feedUpdatedAt > MARKET_CLOSED_AFTER_S;

  const buyActive = buyOn && !legacy;
  const stockIn = buyActive ? parseAmount(buyText, decimals) : null;
  const openingTick = opening ? Number(opening[1]) : null;
  const quote = useMemo(() => {
    if (!predicted || !stock || openingTick === null || stockIn === null || stockIn <= 0n) return null;
    try {
      return quoteDevBuy({ predicted, stock: stock as Address, openingTick, stockIn });
    } catch {
      return null;
    }
  }, [predicted, stock, openingTick, stockIn]);
  // What 5%, 15% and the 50% limit cost at this opening, so the tiers read in money as well.
  const scale = useMemo(() => {
    if (!predicted || !stock || openingTick === null || !buyActive) return null;
    const at = { predicted, stock: stock as Address, openingTick };
    return {
      notice: stockInForShare(DEV_BUY_NOTICE_BPS, at),
      confirm: stockInForShare(DEV_BUY_CONFIRM_BPS, at),
      block: stockInForShare(DEV_BUY_BLOCK_BPS, at),
    };
  }, [predicted, stock, openingTick, buyActive]);
  const tier = quote ? devBuyTier(quote.supplyBps) : 'none';
  const insufficient = buyActive && stockIn !== null && balance !== undefined && stockIn > balance;
  const tokenFirst = predicted && stock ? tokenIsCurrency0(predicted, stock as Address) : null;
  const openingUsd = opening && stockUsd8 !== undefined && tokenFirst !== null ? openingPriceUsd(opening[0], tokenFirst, decimals, stockUsd8) : null;
  const afterFdv = quote && stockUsd8 !== undefined && tokenFirst !== null ? fdvUsdOf(stockPerTokenE30(quote.sqrtPriceAfterX96, tokenFirst, decimals), stockUsd8) : null;
  const spentUsd = stockIn === null ? null : usdOf(stockIn);
  // What each token cost including the 1% fee, next to where the pool opened.
  const averageUsd = quote && spentUsd !== null && quote.tokensOut > 0n ? spentUsd / (Number(quote.tokensOut) / 1e18) : null;

  function validate(): Errors {
    const next: Errors = {};
    // The contract measures bytes, not characters. A 61-character Turkish name is 75 bytes, so a
    // name that passes a character count here can be pinned to IPFS and then never launch.
    const nameBytes = new TextEncoder().encode(name.trim()).length;
    if (nameBytes < 1 || nameBytes > 64) {
      next.name = nameBytes > 64 && name.trim().length <= 64 ? 'Too long for the contract: accented characters take more than one byte each. Shorten it a little.' : 'Use 1 to 64 characters.';
    }
    if (!/^[A-Z0-9]{1,16}$/u.test(symbol)) next.symbol = 'Use 1 to 16 uppercase letters or digits.';
    if (description.length > 1_000) next.description = 'Keep the description under 1,000 characters.';
    if (website && !/^https:\/\/[^\s]+$/u.test(website)) next.website = 'Use a full https:// link.';
    if (twitter && !normalizeTwitter(twitter)) next.twitter = 'Use an X handle like @name or an x.com profile link.';
    if (telegram && !normalizeTelegram(telegram)) next.telegram = 'Use a Telegram handle like @name or a t.me link.';
    if (image && image.size > 2 * 1024 * 1024) next.image = 'Keep the image at or below 2 MB.';
    if (image && !['image/png', 'image/webp', 'image/jpeg', 'image/gif'].includes(image.type)) next.image = 'Use PNG, WebP, JPEG or GIF.';
    if (!stock) next.stock = 'Pick the stock your token trades against.';
    if (buyActive && (stockIn === null || stockIn <= 0n)) next.buy = 'Enter an amount, or turn off Buy at launch.';
    return next;
  }

  /** The profile is pinned only once the creator confirms, so a review that goes nowhere pins nothing. */
  const pin = async (): Promise<string> => {
    const form = new FormData();
    form.set('name', name.trim());
    form.set('symbol', symbol);
    form.set('description', description.trim());
    form.set('website', website.trim());
    form.set('twitter', twitter.trim());
    form.set('telegram', telegram.trim());
    if (image) form.set('image', image);
    const response = await fetch('/api/metadata', { method: 'POST', body: form });
    const pinned = (await response.json()) as { contractURI: string } | { error: { message: string } };
    if (!response.ok || 'error' in pinned) throw new Error('error' in pinned ? pinned.error.message : 'Metadata could not be pinned.');
    return pinned.contractURI;
  };

  /** Reads everything the price depends on again, then freezes it into what the sheet shows and sends. */
  async function openReview() {
    if (!deployment || !address || !selected) return;
    setReviewError(null);
    setReviewing(true);
    try {
      if (chainId !== base.id) throw new Error('Switch your wallet to Base first.');
      const fresh = await factoryReads.refetch();
      const fee = fresh.data?.[0]?.result as bigint | undefined;
      const fdv = fresh.data?.[1]?.result as bigint | undefined;
      const token = fresh.data?.[2]?.result as Address | undefined;
      const isLegacy = fresh.data?.[3]?.status === 'failure';
      const freshStock = await stockReads.refetch();
      const openRead = freshStock.data?.[0];
      const paused = openRead?.status === 'failure' ? pausedReason(openRead.error, { stock: selected.symbol, ticker: selected.ticker }) : null;
      if (paused) throw new Error(paused);
      const open = openRead?.result as readonly [bigint, number, bigint] | undefined;
      if (fee === undefined || fdv === undefined || !token || !open) throw new Error('The launch terms could not be read from Base. Try again in a moment.');
      const wantsBuy = buyOn && !isLegacy && stockIn !== null && stockIn > 0n;
      const freshBalance = freshStock.data?.[1]?.result as bigint | undefined;
      if (wantsBuy && freshBalance !== undefined && freshBalance < stockIn!) throw new Error(`Not enough ${selected.symbol} for this buy.`);
      const freshQuote = wantsBuy ? quoteDevBuy({ predicted: token, stock: selected.address as Address, openingTick: Number(open[1]), stockIn: stockIn! }) : null;
      if (freshQuote && devBuyTier(freshQuote.supplyBps) === 'blocked') throw new Error('Buy at launch is limited to under 50% of supply on this site.');
      if (freshQuote && devBuyTier(freshQuote.supplyBps) === 'confirm' && !shareAck) throw new Error('Tick the box under your buy to confirm the share you will hold.');
      setReviewed({
        id: Date.now(),
        plan: {
          // predictToken above was read for this wallet; the sheet and executeLaunch refuse any other.
          account: address,
          chainId: base.id,
          factory: deployment.factory,
          stock: selected.address as Address,
          name: name.trim(),
          symbol,
          salt,
          predicted: token,
          metadataEditable: editable && !isLegacy,
          reviewedFdv: fdv,
          creationFee: fee,
          buy: freshQuote && stockIn ? { stockIn, tokensOut: freshQuote.tokensOut, toleranceBps, shareAck } : null,
          legacy: isLegacy,
        },
        stock: { symbol: selected.symbol, ticker: selected.ticker, name: selected.name, decimals: selected.decimals },
        stockUsd8: open[2],
        quote: freshQuote,
      });
      setSheetOpen(true);
    } catch (err) {
      setReviewError(err instanceof Error ? err.message : 'The launch terms could not be read from Base.');
    } finally {
      setReviewing(false);
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    void openReview();
  }

  const openingTokensPerStock = selected && selected.priceUsd !== null ? (selected.priceUsd * 1e9) / fdvUsd : null;
  const blocked = buyActive && tier === 'blocked';
  const needsAck = buyActive && tier === 'confirm' && !shareAck;
  const ctaDisabled = !deployment || insufficient || blocked || needsAck || pausedNow !== null;
  const ctaLabel = insufficient ? `Not enough ${stockSymbol}` : buyActive ? 'Review launch and buy' : 'Review launch';

  return (
    <form className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start" onSubmit={submit}>
      <div className="flex flex-col gap-5 min-w-0">
        <Module ticks>
          <ModuleHeader index="01" title="Token" />
          <div className="p-4 md:p-5 flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_200px] gap-4">
              <Input label="Name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nvidia Dog" error={errors.name} autoComplete="off" />
              <Input label="Symbol" maxLength={16} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, ''))} placeholder="NDOG" error={errors.symbol} autoComplete="off" autoCapitalize="characters" />
            </div>
            <TextArea label="Description" maxLength={1_000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this token about?" hint={`${description.length}/1000 · stored in the token's ERC-7572 metadata`} error={errors.description} />
            <Input label="Website (optional)" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" error={errors.website} autoComplete="off" />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="X (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or x.com/handle" error={errors.twitter} autoComplete="off" autoCapitalize="none" spellCheck={false} />
              <Input label="Telegram (optional)" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@group or t.me/group" error={errors.telegram} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </div>
            <div>
              <span className="block mb-1.5 text-[12px] font-mono uppercase tracking-[0.08em] text-ink-muted">Image (optional)</span>
              <label className={cx('flex items-center gap-4 rounded-[6px] border border-dashed px-4 py-3 cursor-pointer transition-fast hover:border-line-strong', errors.image ? 'border-danger' : 'border-line-strong')}>
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="" className="h-14 w-14 rounded-[6px] border border-line object-cover" />
                ) : (
                  <span className="h-14 w-14 rounded-[6px] border border-line bg-surface inline-flex items-center justify-center text-ink-muted">
                    <ImagePlus size={20} strokeWidth={1.75} />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">{image ? image.name : 'Choose an image'}</span>
                  <span className="block text-[12px] text-ink-muted">PNG, WebP, JPEG or GIF up to 2 MB. Pinned to IPFS.</span>
                </span>
                <input
                  type="file"
                  accept="image/png,image/webp,image/jpeg,image/gif"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setImage(file);
                    if (preview) URL.revokeObjectURL(preview);
                    setPreview(file ? URL.createObjectURL(file) : null);
                  }}
                />
              </label>
              {errors.image && <span className="block mt-1.5 text-[13px] text-danger-fg">{errors.image}</span>}
            </div>
          </div>
        </Module>

        <Module ticks>
          <ModuleHeader index="02" title="Paired stock" action={<span className="font-mono text-[11px] text-ink-muted">{stocks.length} available</span>} />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-line" role="radiogroup" aria-label="Paired stock">
            {stocks.map((s) => {
              const active = stock === s.address;
              return (
                <button
                  key={s.address}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => {
                    setStock(s.address);
                    setShareAck(false);
                  }}
                  className={cx('rail flex items-center gap-3 px-4 py-3 text-left transition-fast bg-canvas hover:bg-surface min-h-[72px]', active && 'bg-primary-soft hover:bg-primary-soft')}
                >
                  <StockCoin ticker={s.ticker} size={36} tilt={false} />
                  <span className="min-w-0">
                    <span className={cx('block font-medium text-[15px] leading-tight', active && 'text-primary')}>{s.symbol}</span>
                    <span className="block text-[12px] text-ink-secondary truncate">{s.name}</span>
                    <span className="block font-mono num text-[11px] text-ink-muted">
                      {formatUsd(s.priceUsd)}
                      {s.feedStatus === 'holding' ? ' · last close' : ''} · {s.launches} paired
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {errors.stock && <p className="px-4 py-2 text-[13px] text-danger-fg border-t border-line">{errors.stock}</p>}
        </Module>

        {!legacy && (
          <Module>
            <ModuleHeader
              index="04"
              title="Buy at launch (optional)"
              action={<Switch checked={buyOn} onChange={(on) => { setBuyOn(on); setShareAck(false); }} label="Buy at launch" />}
            />
            <div className="p-4 md:p-5 flex flex-col gap-4">
              <p className="text-[13px] text-ink-secondary max-w-[70ch]">
                Spend {stockSymbol} to buy your token in the same transaction that creates it. Nobody can trade before this buy. If it can&apos;t complete, nothing is launched and you only pay gas.
              </p>
              {buyOn && (
                <>
                  <div className="flex flex-col gap-1">
                    <Input
                      label={`Amount in ${stockSymbol}`}
                      inputMode="decimal"
                      value={buyText}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/gu, '');
                        if ((v.match(/\./gu) ?? []).length > 1) return;
                        setBuyText(v);
                        setShareAck(false);
                      }}
                      placeholder="0"
                      suffix={stockSymbol}
                      error={errors.buy}
                      autoComplete="off"
                    />
                    <div className="flex items-center justify-between gap-3 font-mono num text-[12px] text-ink-muted">
                      <span>
                        Balance: {balance === undefined ? '—' : `${formatAmount(balance, decimals, 6)} ${stockSymbol}`}
                        {balance !== undefined && balance > 0n && (
                          <>
                            {' · '}
                            <button type="button" className="text-primary font-medium" onClick={() => setBuyText(formatAmount(balance, decimals, decimals).replaceAll(',', ''))}>
                              Max
                            </button>
                          </>
                        )}
                      </span>
                      <span>{stockIn !== null && stockIn > 0n ? `≈ ${formatUsd(usdOf(stockIn))} at the Chainlink price` : ''}</span>
                    </div>
                  </div>
                  {insufficient && (
                    <p className="text-[12px] text-danger-fg">
                      Not enough {stockSymbol}.{' '}
                      <a href={`${BSTOCKS_URL}/${stock}`} target="_blank" rel="noreferrer noopener" className="text-primary font-medium">
                        Get {stockSymbol} on BStocks →
                      </a>
                    </p>
                  )}
                  {!onBase && <p className="text-[12px] text-ink-muted">Connect a wallet on Base to see the exact quote.</p>}
                  {marketClosed && feedUpdatedAt !== null && (
                    <Banner tone="info">
                      {ticker}&apos;s market is closed. The opening price uses the last Chainlink price ({formatDateTime(new Date(feedUpdatedAt * 1000).toISOString())}).
                    </Banner>
                  )}

                  {quote && stockIn !== null && (
                    <div>
                      <KeyValue k="You receive" v={`≈ ${formatAmount(quote.tokensOut, 18, 2)} ${symbol || 'tokens'} (${pct2(quote.supplyPpm)} of supply)`} />
                      <KeyValue k="Minimum received" v={`${formatAmount(devBuyMinOut(quote.tokensOut, toleranceBps), 18, 2)} ${symbol || 'tokens'} · tolerance ${bpsToPct(toleranceBps)}`} />
                      <KeyValue k="Fee 1%" v={`${formatAmount(quote.fee, decimals, 6)} ${stockSymbol} · 70% (${formatAmount(quote.creatorFeeBack, decimals, 6)}) comes back to you as claimable creator fees`} />
                      <KeyValue k="Average price" v={`${formatUsd(averageUsd)} per token · opening price ${formatUsd(openingUsd)}`} />
                      <KeyValue k="Market cap after your buy" v={`≈ ${formatUsd(afterFdv, { compact: true })}`} />
                    </div>
                  )}

                  {quote && tier === 'none' && <p className="text-[13px] text-ink-secondary">You will hold {pct2(quote.supplyPpm)} of supply.</p>}
                  {quote && tier === 'notice' && <Banner tone="warning">Buyers will see that the creator bought {pct2(quote.supplyPpm)} of supply at launch.</Banner>}
                  {quote && tier === 'confirm' && (
                    <Banner tone="danger">
                      <Checkbox checked={shareAck} onChange={setShareAck}>
                        I understand buyers will see that I hold {pct2(quote.supplyPpm)} of the supply, and many traders avoid tokens like that.
                      </Checkbox>
                    </Banner>
                  )}
                  {quote && tier === 'blocked' && <Banner tone="danger">Buy at launch is limited to under 50% of supply on this site.</Banner>}
                  {scale && (
                    <p className="text-[12px] text-ink-muted">
                      For scale: 5% of supply costs about {formatUsd(usdOf(scale.notice), { compact: true })}, 15% about {formatUsd(usdOf(scale.confirm), { compact: true })}, and this site stops below 50% (about {formatUsd(usdOf(scale.block), { compact: true })}).
                    </p>
                  )}

                  <div className="border-t border-line pt-3 flex flex-col gap-2">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Tolerance</span>
                      <span className="font-mono num text-[12px] text-ink">{bpsToPct(toleranceBps)}</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {DEV_TOLERANCE_PRESETS_BPS.map((b) => (
                        <Chip
                          key={b}
                          active={toleranceBps === b && toleranceText === ''}
                          onClick={() => {
                            setToleranceBps(b);
                            setToleranceText('');
                            setToleranceError(null);
                          }}
                          className="h-8 min-h-[32px] px-2.5 text-[12px]"
                        >
                          {bpsToPct(b)}
                        </Chip>
                      ))}
                      <label className={cx('flex items-center h-8 rounded-[6px] border px-2 gap-1 text-[12px] transition-fast focus-within:border-primary', toleranceError ? 'border-danger' : toleranceText ? 'border-primary text-ink' : 'border-line text-ink-secondary')}>
                        <input
                          inputMode="decimal"
                          placeholder="Custom"
                          aria-label="Custom tolerance percent"
                          aria-invalid={toleranceError !== null}
                          value={toleranceText}
                          onChange={(e) => {
                            const v = e.target.value.replace(/[^0-9.]/gu, '');
                            setToleranceText(v);
                            if (v === '') {
                              setToleranceError(null);
                              setToleranceBps(DEV_TOLERANCE_DEFAULT_BPS);
                              return;
                            }
                            const parsed = parseToleranceInput(v);
                            if ('error' in parsed) {
                              setToleranceError(parsed.error);
                              return;
                            }
                            setToleranceError(null);
                            setToleranceBps(parsed.bps);
                          }}
                          className="w-14 bg-transparent outline-none num placeholder:text-ink-muted"
                        />
                        <span>%</span>
                      </label>
                    </div>
                    {toleranceError && <p className="text-[12px] text-danger-fg">{toleranceError} Still using {bpsToPct(toleranceBps)}.</p>}
                    <p className="text-[12px] text-ink-muted">
                      Nobody can trade before your buy. This tolerance only covers {ticker}&apos;s Chainlink price moving before your transaction lands. A price drop gives you fewer tokens, in steps of about 1%.
                    </p>
                  </div>
                </>
              )}
            </div>
          </Module>
        )}

        {!legacy && (
          <Module>
            <ModuleHeader index="05" title="Profile" />
            <div className="p-4 md:p-5 flex items-start justify-between gap-4">
              <label htmlFor="editable-profile" className="min-w-0 cursor-pointer">
                <span className="block text-[14px] font-medium">Let me update the image, description and links later</span>
                <span className="block mt-1 text-[13px] text-ink-secondary max-w-[70ch]">
                  Off: the token&apos;s onchain contract URI never changes, and you can still update the image, description and links this site shows by signing a message with this wallet (no gas). On: only this wallet can later point the token at a new profile onchain, through the BStocks launch factory, one transaction per change. The name, symbol and supply never change either way. Buyers see an Editable profile badge until you lock it, and you can lock it for good at any time. Leave this off unless you want the onchain profile itself to change later.
                </span>
              </label>
              <Switch id="editable-profile" checked={editable} onChange={setEditable} label="Let me update the image, description and links later" />
            </div>
          </Module>
        )}
      </div>

      <div className="flex flex-col gap-5 lg:sticky lg:top-[72px]">
        <Module ticks>
          <ModuleHeader index="03" title="What happens" />
          <ol className="px-4 pt-3 flex flex-col gap-2 text-[13px] text-ink-secondary">
            {[
              'A zero-admin B20 token with exactly 1,000,000,000 supply is created.',
              `A Uniswap v4 pool opens against ${selected ? selected.symbol : 'the stock you pick'} at a ${formatUsd(fdvUsd, { compact: true })} valuation, priced from the live Chainlink feed.`,
              'The whole supply is locked as liquidity forever; nobody can withdraw it. You hold none unless you buy at launch.',
              `Every swap pays 1% in ${selected ? selected.symbol : 'the stock'}; you claim 70% of it any time from your wallet page.`,
            ].map((text, i) => (
              <li key={text} className="flex gap-3">
                <span className="font-mono text-[11px] text-primary shrink-0 w-5">0{i + 1}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <div className="px-4 pt-3 pb-2">
            <KeyValue k="Creation fee" v={feeEth === null ? '…' : `${feeEth} ETH + gas`} />
            <KeyValue k="Opening valuation" v={formatUsd(fdvUsd, { compact: true })} />
            <KeyValue k="Opening price" v={openingTokensPerStock === null ? '—' : `1 ${selected!.symbol} ≈ ${formatNumber(openingTokensPerStock, 0)} ${symbol || 'tokens'}`} />
            <KeyValue k="Creator share" v="70% of every fee" />
            {buyActive && quote && <KeyValue k="Buy at launch" v={`${formatAmount(stockIn ?? 0n, decimals, 6)} ${stockSymbol} · ${pct2(quote.supplyPpm)}`} />}
            {!legacy && <KeyValue k="Profile" v={editable ? 'Editable onchain until you lock it' : 'Contract URI fixed onchain · site profile editable by signed message'} mono={false} />}
          </div>
          <div className="p-4 border-t border-line flex flex-col gap-3">
            {!deployment && <Banner tone="danger">Contracts are not configured on this server.</Banner>}
            {pausedNow && <Banner tone="warning">{pausedNow}</Banner>}
            {reviewError && <Banner tone="danger">{reviewError}</Banner>}
            {!onBase ? (
              <ConnectButton full size="lg" />
            ) : (
              <Button type="submit" full size="lg" loading={reviewing} disabled={ctaDisabled}>
                {ctaLabel} <ArrowUpRight size={16} strokeWidth={1.75} />
              </Button>
            )}
            {insufficient && (
              <a href={`${BSTOCKS_URL}/${stock}`} target="_blank" rel="noreferrer noopener" className="text-[13px] text-primary font-medium">
                Get {stockSymbol} on BStocks →
              </a>
            )}
            <p className="text-[12px] text-ink-muted">No approval step, unless you buy at launch: then you approve exactly that amount of {stockSymbol} for the launch factory.</p>
          </div>
        </Module>
      </div>

      {reviewed && (
        <LaunchReviewSheet
          key={reviewed.id}
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          reviewed={reviewed}
          pin={pin}
          onReviewAgain={() => {
            setSheetOpen(false);
            void openReview();
          }}
          onLaunched={({ token, txHash }) => {
            // The salt is spent only by a launch that landed; a revert keeps it, and the address.
            renewSalt();
            router.push(`/token/${token.toLowerCase()}?tx=${txHash}`);
          }}
        />
      )}
    </form>
  );
}
