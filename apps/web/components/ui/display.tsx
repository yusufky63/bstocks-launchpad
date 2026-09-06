'use client';

import { Check, CircleAlert, CircleCheck, Copy, ExternalLink, Info, TriangleAlert } from 'lucide-react';
import { useEffect, useReducer, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';

import { formatPct, shortAddress, timeAgo } from '@/lib/format';
import { motionEnabled } from '@/lib/motion';

import { cx } from './primitives';

export const BASE_EXPLORER_URL = 'https://basescan.org';

/** Signed percentage with colour AND sign, plus a screen-reader label. */
export function PriceChange({ value, className, digits = 2 }: { value: number | null | undefined; className?: string; digits?: number }) {
  if (value === null || value === undefined || !Number.isFinite(value)) return <span className={cx('text-ink-muted num', className)}>—</span>;
  const tone = value > 0 ? 'text-positive-fg' : value < 0 ? 'text-danger-fg' : 'text-ink-secondary';
  return (
    <span className={cx('num', tone, className)}>
      <span className="sr-only">{value > 0 ? 'up' : value < 0 ? 'down' : 'unchanged'} </span>
      {formatPct(value, { digits })}
    </span>
  );
}

export function AddressLabel({ address, showCopy = true, explorer = false, kind = 'address', className, chars = 6 }: { address: string; showCopy?: boolean; explorer?: boolean; kind?: 'address' | 'token' | 'tx'; className?: string; chars?: number }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <span className={cx('inline-flex items-center gap-1 min-w-0', className)}>
      <span className="font-mono text-[12px] text-ink-secondary truncate">{shortAddress(address, chars)}</span>
      {showCopy && (
        <button type="button" aria-label="Copy" onClick={copy} className="h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
        </button>
      )}
      {explorer && (
        <a href={`${BASE_EXPLORER_URL}/${kind}/${address}`} target="_blank" rel="noreferrer" aria-label="View on Basescan" className="h-7 w-7 inline-flex items-center justify-center rounded-[6px] text-ink-muted hover:text-ink">
          <ExternalLink size={13} strokeWidth={1.75} />
        </a>
      )}
    </span>
  );
}

export function TxLink({ hash, children, className }: { hash: string; children?: ReactNode; className?: string }) {
  return (
    <a href={`${BASE_EXPLORER_URL}/tx/${hash}`} target="_blank" rel="noreferrer" className={cx('inline-flex items-center gap-1 text-primary text-[13px] font-medium', className)}>
      {children ?? 'View on Basescan'} <ExternalLink size={13} strokeWidth={1.75} />
    </a>
  );
}

export type BannerTone = 'neutral' | 'info' | 'warning' | 'positive' | 'danger';

const BANNER: Record<BannerTone, { box: string; icon: typeof Info | null; iconClass: string }> = {
  neutral: { box: 'border-line bg-surface text-ink-secondary', icon: null, iconClass: '' },
  info: { box: 'border-primary/40 bg-primary-soft text-ink', icon: Info, iconClass: 'text-primary' },
  warning: { box: 'border-warning/60 bg-warning-soft text-ink', icon: TriangleAlert, iconClass: 'text-warning-fg' },
  positive: { box: 'border-positive/60 bg-positive-soft text-ink', icon: CircleCheck, iconClass: 'text-positive-fg' },
  danger: { box: 'border-danger/60 bg-danger-soft text-ink', icon: CircleAlert, iconClass: 'text-danger-fg' },
};

/** Tone is colour and an icon: amber for "look before you sign", green for "it landed", red for "it did not". */
export function Banner({ children, tone = 'neutral', className }: { children: ReactNode; tone?: BannerTone; className?: string }) {
  const t = BANNER[tone];
  const Icon = t.icon;
  return (
    <div role={tone === 'danger' ? 'alert' : 'status'} className={cx('flex items-start gap-2.5 border rounded-[8px] px-4 py-3 text-[13px]', t.box, className)}>
      {Icon && <Icon size={15} strokeWidth={1.75} className={cx('shrink-0 mt-0.5', t.iconClass)} aria-hidden />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

const noop = () => () => {};

/** Relative time that only renders on the client, so "57s ago" vs "1m ago" can never mismatch hydration. */
export function TimeAgo({ value, placeholder = '', className }: { value: string | number | null | undefined; placeholder?: string; className?: string }) {
  const isClient = useSyncExternalStore(
    noop,
    () => true,
    () => false,
  );
  const [, tick] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    const t = setInterval(tick, 30_000);
    return () => clearInterval(t);
  }, []);
  if (!isClient || !value) return <span className={className}>{placeholder}</span>;
  return <span className={className}>{timeAgo(value)}</span>;
}

/** Subtle numeric tween: 240 ms, one easing family, honours reduced motion. */
export function AnimatedNumber({ value, format, className, durationMs = 240 }: { value: number | null | undefined; format: (v: number) => string; className?: string; durationMs?: number }) {
  const [shown, setShown] = useState<number | null>(value ?? null);
  const prev = useRef<number | null>(value ?? null);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (value === null || value === undefined) {
      setShown(null);
      prev.current = null;
      return;
    }
    const from = prev.current;
    prev.current = value;
    if (from === null || !motionEnabled() || from === value) {
      setShown(value);
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / durationMs);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(from + (value - from) * eased);
      if (t < 1) raf.current = requestAnimationFrame(tick);
    };
    raf.current = requestAnimationFrame(tick);
    return () => {
      if (raf.current) cancelAnimationFrame(raf.current);
    };
  }, [value, durationMs]);

  return <span className={className}>{shown === null ? '—' : format(shown)}</span>;
}

/** Tiny inline trend line. Colour is never the only signal: pair it with a signed % nearby. */
export function Sparkline({ points, width = 84, height = 28, className }: { points: number[]; width?: number; height?: number; className?: string }) {
  if (points.length < 2) return <span className={cx('inline-block', className)} style={{ width, height }} aria-hidden />;
  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min || 1;
  const step = width / (points.length - 1);
  const y = (p: number) => (height - 2 - ((p - min) / span) * (height - 4)).toFixed(1);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y(p)}`).join(' ');
  const last = points[points.length - 1]!;
  const first = points[0]!;
  const color = last > first ? 'var(--positive-fg)' : last < first ? 'var(--danger-fg)' : 'var(--text-muted)';
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className={cx('shrink-0', className)} aria-hidden>
      <path d={d} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={((points.length - 1) * step).toFixed(1)} cy={y(last)} r="2" fill={color} />
    </svg>
  );
}

const STEPS: Array<{ id: 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED'; label: string }> = [
  { id: 'SUBMITTED', label: 'Submitted' },
  { id: 'CONFIRMING', label: 'In a block' },
  { id: 'CONFIRMED', label: 'Confirmed' },
];
const ORDER: Record<string, number> = { SUBMITTED: 0, CONFIRMING: 1, CONFIRMED: 2 };

/** Submitted → In a block → Confirmed. Never shows "confirmed" before the receipt says so. */
export function TxProgress({ state, txHash }: { state: 'SUBMITTED' | 'CONFIRMING' | 'CONFIRMED'; txHash?: string }) {
  const idx = ORDER[state] ?? -1;
  return (
    <div className="flex flex-col gap-3" aria-live="polite">
      <ol className="grid grid-cols-3 gap-1">
        {STEPS.map((s, i) => {
          const done = idx >= i;
          const active = idx === i && state !== 'CONFIRMED';
          return (
            <li key={s.id} className="flex flex-col gap-2">
              <div className={cx('h-1 rounded-full transition-base', done ? 'bg-primary' : 'bg-surface-muted')} />
              <div className={cx('flex items-center gap-1 text-[12px] font-mono uppercase tracking-[0.06em]', done ? 'text-ink' : 'text-ink-muted')}>
                {done && !active ? <Check size={12} strokeWidth={2} /> : active ? <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-primary border-t-transparent animate-spin" /> : null}
                {s.label}
              </div>
            </li>
          );
        })}
      </ol>
      {txHash && <TxLink hash={txHash} />}
    </div>
  );
}
