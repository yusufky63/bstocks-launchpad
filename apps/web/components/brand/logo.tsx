import { cx } from '@/components/ui/primitives';

/**
 * The pair mark: two squares on a baseline joined by a thin bar — a token and a stock, paired.
 * Since the brand unification this is a product glyph (kept for in-app illustration), not the
 * lockup: the header and footer carry the shared BaseStocks block-B with a LAUNCHPAD eyebrow.
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

/**
 * Header lockup: the shared BaseStocks block-B mark, the BaseStocks wordmark, and the one thing
 * that tells this app apart — a mono LAUNCHPAD eyebrow under the name.
 */
export function Wordmark({ className, size = 22 }: { className?: string; size?: number }) {
  return (
    <span className={cx('inline-flex items-center gap-2 select-none', className)}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src="/brand/logo-mark-transparent-128.png" alt="" width={size + 8} height={size + 8} className="shrink-0" style={{ width: size + 8, height: size + 8 }} />
      <span className="flex flex-col leading-none">
        <span className="display tracking-[-0.045em]" style={{ fontSize: size * 0.82 }}>
          <span className="text-primary">Base</span>Stocks
        </span>
        <span className="font-mono uppercase text-primary" style={{ fontSize: Math.max(7, size * 0.36), letterSpacing: '0.28em', marginTop: 2 }}>
          Launchpad
        </span>
      </span>
    </span>
  );
}

/** The X wordmark, as a glyph. Used wherever we link to an X profile. */
export function XMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** Telegram's paper plane, for the alerts channel. */
export function TelegramMark({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M21.94 4.3a1.2 1.2 0 0 0-1.63-1.19L2.6 10.02c-1.07.42-1.05 1.95.03 2.34l4.3 1.55 1.66 5.2c.2.63 1 .82 1.46.35l2.43-2.5 4.4 3.23c.6.44 1.46.12 1.62-.6L21.94 4.3ZM8.9 13.43l8.3-5.1-6.6 6.05a1.2 1.2 0 0 0-.37.76l-.22 2-1.11-3.71Z" />
    </svg>
  );
}
