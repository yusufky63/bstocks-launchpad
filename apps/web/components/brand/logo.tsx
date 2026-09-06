import { cx } from '@/components/ui/primitives';

/**
 * StockPair mark: two squares on a baseline, one brand blue, one ink, joined by a thin bar —
 * a token and a stock, paired. Follows the theme via currentColor.
 */
export function LogoMark({ size = 24, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={cx('shrink-0', className)} aria-hidden>
      <rect x="6" y="20" width="22" height="22" rx="4" fill="var(--primary)" />
      <rect x="36" y="20" width="22" height="22" rx="4" fill="currentColor" opacity="0.85" />
      <rect x="24" y="29" width="16" height="4" rx="2" fill="currentColor" opacity="0.45" />
      <rect x="6" y="50" width="52" height="3" rx="1.5" fill="currentColor" opacity="0.3" />
    </svg>
  );
}

/** Header lockup: the mark next to the wordmark text. */
export function Wordmark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cx('inline-flex items-center gap-2 select-none', className)}>
      <LogoMark size={size + 4} />
      <span className="display tracking-[-0.045em] leading-none" style={{ fontSize: size * 0.95 }}>
        Stock<span className="text-primary">Pair</span>
      </span>
    </span>
  );
}
