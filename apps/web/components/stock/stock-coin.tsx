'use client';

import { useRef, useState, type CSSProperties, type PointerEvent } from 'react';

import { findStockBySymbol } from '@stockpair/core';

import { cx } from '@/components/ui/primitives';

/** Pre-rendered 3D coins shipped in public/brand/coins, keyed by underlying ticker. */
const COINS = new Set(['AAPL', 'GOOGL', 'META', 'MSFT', 'NVDA', 'TSLA']);

export function coinSrc(ticker: string | null | undefined): string | null {
  const key = ticker?.toUpperCase();
  return key && COINS.has(key) ? `/brand/coins/${key.toLowerCase()}-200.png` : null;
}

/** Official Coinbase icon for a stock (from the token's onchain metadata), or null. */
export function stockIcon(ticker: string | null | undefined): string | null {
  return ticker ? (findStockBySymbol(ticker)?.image ?? null) : null;
}

/** Stock badge: the official icon when known, otherwise the ticker on a bordered tile. */
export function StockTile({ ticker, size = 36, className, muted }: { ticker: string; size?: number; className?: string; muted?: boolean }) {
  const [failed, setFailed] = useState(false);
  const src = stockIcon(ticker);
  if (src && !failed) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} className={cx('rounded-[6px] border border-line bg-canvas object-cover shrink-0', muted && 'opacity-55 grayscale', className)} style={{ width: size, height: size }} />;
  }
  return (
    <span
      aria-hidden
      className={cx('inline-flex items-center justify-center rounded-[6px] border border-line bg-surface font-mono text-ink-secondary shrink-0', muted && 'opacity-55', className)}
      style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.28)) }}
    >
      {ticker.slice(0, 5)}
    </span>
  );
}

/**
 * A stock as a 3D coin with two cheap effects: an optional idle float and a pointer tilt driven
 * by two CSS variables. Falls back to the official icon when no render exists for the ticker.
 */
export function StockCoin({
  ticker,
  size = 40,
  float = false,
  tilt = true,
  muted = false,
  delay = 0,
  className,
}: {
  ticker: string;
  size?: number;
  float?: boolean;
  tilt?: boolean;
  muted?: boolean;
  delay?: number;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const src = coinSrc(ticker);
  if (!src) return <StockTile ticker={ticker} size={size} className={cx('rounded-full', className)} muted={muted} />;

  const onMove = (e: PointerEvent<HTMLSpanElement>) => {
    const el = ref.current;
    if (!tilt || !el) return;
    const r = el.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width - 0.5;
    const py = (e.clientY - r.top) / r.height - 0.5;
    el.style.setProperty('--tilt-x', `${(-py * 20).toFixed(1)}deg`);
    el.style.setProperty('--tilt-y', `${(px * 20).toFixed(1)}deg`);
  };
  const onLeave = () => {
    ref.current?.style.setProperty('--tilt-x', '0deg');
    ref.current?.style.setProperty('--tilt-y', '0deg');
  };
  const style = { width: size, height: size, animationDelay: `${delay}ms` } as CSSProperties;
  return (
    <span ref={ref} onPointerMove={onMove} onPointerLeave={onLeave} className={cx('coin', float && 'coin-float', muted && 'opacity-55 grayscale', className)} style={style}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={src} alt="" width={size} height={size} draggable={false} className="coin-img" style={{ width: size, height: size }} />
      <span aria-hidden className="coin-shadow" style={{ animationDelay: `${delay}ms` }} />
    </span>
  );
}

/** Token logo with a typographic fallback: the symbol on a bordered tile. */
export function TokenLogo({ src, symbol, size = 36, className }: { src?: string | null; symbol: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span aria-hidden className={cx('inline-flex items-center justify-center rounded-[6px] border border-line bg-surface font-mono text-ink-secondary shrink-0 uppercase', className)} style={{ width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.3)) }}>
        {symbol.slice(0, 3)}
      </span>
    );
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={src} alt="" width={size} height={size} onError={() => setFailed(true)} className={cx('rounded-[6px] border border-line bg-canvas object-cover shrink-0', className)} style={{ width: size, height: size }} />;
}
