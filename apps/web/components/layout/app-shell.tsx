'use client';

import { BarChart3, Home, LineChart, Moon, Plus, PlusSquare, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { useAccount } from 'wagmi';

import { TelegramMark, Wordmark, XMark } from '@/components/brand/logo';
import { cx } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';
import { BSTOCKS_X_HANDLE, BSTOCKS_X_URL } from '@/lib/twitter';
import type { MarketsResponse } from '@/lib/types';

import { ConnectButton } from './connect-button';
import { useTheme } from './theme-provider';
import { EligibilityGate } from '@/components/common/eligibility-gate';
import { TopTicker } from './top-ticker';

/** Mobile bar. Stocks and Stats live in the footer; Create is the one accent action. */
const NAV = [
  { href: '/', label: 'Home', icon: Home },
  { href: '/markets', label: 'Markets', icon: LineChart },
  { href: '/create', label: 'Create', icon: PlusSquare },
  { href: '/stats', label: 'Stats', icon: BarChart3 },
] as const;

/** Desktop header text links; Create is a button on the right, Profile is appended when connected. */
const DESKTOP_NAV = [
  { href: '/', label: 'Home' },
  { href: '/markets', label: 'Markets' },
  { href: '/stocks', label: 'Stocks' },
] as const;

const FOOTER_LINKS = [
  ['/stats', 'Stats', false],
  ['/alerts', 'Alerts', false],
  ['/how-it-works', 'How it works', false],
  ['/docs', 'Docs', false],
  ['https://basestocks.finance', 'BaseStocks', true],
  ['https://www.base.org/stocks', 'Tokenized stocks on Base', true],
  ['https://basescan.org', 'BaseScan', true],
] as const;

function isActive(path: string, href: string): boolean {
  if (href === '/') return path === '/';
  if (href === '/markets') return path.startsWith('/markets') || path.startsWith('/token');
  if (href === '/stocks') return path.startsWith('/stocks');
  if (href === '/stats') return path.startsWith('/stats');
  if (href.startsWith('/wallet')) return path.startsWith('/wallet');
  return path.startsWith(href);
}

export function AppShell({ children, initialMarkets }: { children: ReactNode; initialMarkets?: MarketsResponse }) {
  const path = usePathname();
  const { address } = useAccount();
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="sticky top-0 z-30 bg-canvas">
        <TopTicker initialMarkets={initialMarkets} />
        <header className="border-b border-line bg-canvas/95 backdrop-blur-[2px]">
          <div className="mx-auto flex h-14 max-w-[1320px] items-center justify-between gap-2 md:gap-3 px-4 md:px-6">
            <Link href="/" aria-label="BaseStocks Launchpad home" className="inline-flex shrink-0">
              <Wordmark />
            </Link>
            <nav aria-label="Primary" className="hidden md:flex items-center gap-0 lg:gap-0.5 min-w-0">
              {[...DESKTOP_NAV, ...(address ? [{ href: `/wallet/${address}`, label: 'Profile' }] : [])].map((n) => {
                const active = isActive(path, n.href);
                return (
                  <Link
                    key={n.href}
                    href={n.href}
                    aria-current={active ? 'page' : undefined}
                    className={cx(
                      'relative h-10 px-2 lg:px-3 inline-flex items-center rounded-[6px] text-[13px] lg:text-[14px] font-medium transition-fast whitespace-nowrap',
                      'after:absolute after:left-2 after:right-2 lg:after:left-3 lg:after:right-3 after:bottom-1 after:h-[2px] after:bg-primary after:origin-left after:transition-transform after:duration-[180ms]',
                      active ? 'text-primary after:scale-x-100' : 'text-ink-secondary hover:text-ink after:scale-x-0 hover:after:scale-x-100',
                    )}
                  >
                    {n.label}
                  </Link>
                );
              })}
            </nav>
            <div className="flex items-center gap-1.5 shrink-0">
              <Link
                href="/create"
                aria-current={path.startsWith('/create') ? 'page' : undefined}
                className={cx(
                  'hidden md:inline-flex items-center gap-1.5 h-9 px-3 rounded-[6px] text-[13px] font-medium border border-b-[3px] transition-fast active:border-b active:translate-y-[2px]',
                  path.startsWith('/create') ? 'bg-primary-soft text-primary border-primary' : 'bg-primary text-primary-contrast border-primary-strong border-b-black/30 hover:brightness-[1.08]',
                )}
              >
                <Plus size={15} strokeWidth={2} /> Create token
              </Link>
              <a
                href={BSTOCKS_X_URL}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`@${BSTOCKS_X_HANDLE} on X`}
                title={`@${BSTOCKS_X_HANDLE} on X`}
                className="h-9 w-9 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink border border-line hover:border-line-strong transition-fast"
              >
                <XMark size={14} />
              </a>
              {publicEnv.telegramChannel && (
                <a
                  href={publicEnv.telegramChannel}
                  target="_blank"
                  rel="noreferrer noopener"
                  aria-label="Alerts on Telegram"
                  title="Launch and trade alerts on Telegram"
                  className="h-9 w-9 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink border border-line hover:border-line-strong transition-fast"
                >
                  <TelegramMark size={15} />
                </a>
              )}
              <ThemeToggle />
              <span aria-hidden className="hidden md:block w-px h-6 bg-line mx-1" />
              <ConnectButton size="sm" compact />
            </div>
          </div>
        </header>
      </div>

      <main className="flex-1 mx-auto w-full max-w-[1320px] px-4 md:px-6 py-5 md:py-8">{children}</main>

      <footer className="border-t border-line bg-canvas pb-16 md:pb-0">
        <div className="mx-auto max-w-[1320px] px-4 md:px-6 py-4 flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2">
            <Wordmark size={18} />
            <span className="eyebrow">Built on Base</span>
            <span className="inline-flex items-center gap-4">
              <a
                href={BSTOCKS_X_URL}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={`@${BSTOCKS_X_HANDLE} on X`}
                className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-primary transition-fast"
              >
                <XMark size={13} />
                <span className="font-mono text-[12px]">@{BSTOCKS_X_HANDLE}</span>
              </a>
              {publicEnv.telegramChannel && (
                <a
                  href={publicEnv.telegramChannel}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex items-center gap-1.5 text-[13px] text-ink-secondary hover:text-primary transition-fast"
                >
                  <TelegramMark size={13} />
                  <span className="text-[13px]">Alerts</span>
                </a>
              )}
            </span>
            <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-4 gap-y-1 md:ml-auto">
              {FOOTER_LINKS.map(([href, label, external]) =>
                external ? (
                  <a key={href} href={href} target="_blank" rel="noreferrer noopener" className="text-[13px] text-ink-secondary hover:text-primary transition-fast">
                    {label}
                  </a>
                ) : (
                  <Link key={href} href={href} className="text-[13px] text-ink-secondary hover:text-primary transition-fast">
                    {label}
                  </Link>
                ),
              )}
            </nav>
          </div>
          <p className="text-[12px] text-ink-muted leading-relaxed max-w-[110ch]">
            Every token launched here has a fixed 1,000,000,000 supply, no admin, and its whole supply placed in a Uniswap v4 position against a Coinbase tokenized stock — a position no function can withdraw. Swap fees are 1%, paid in the stock: 70% to the creator, 30% to the platform. The launchpad is part of{' '}
            <a href="https://basestocks.finance" target="_blank" rel="noreferrer noopener" className="text-ink-secondary hover:text-primary transition-fast underline underline-offset-2">
              BaseStocks
            </a>
            , an independent interface on Base — not a Base or Coinbase product. The contracts it runs on are onchain and ownerless.
          </p>
          <svg viewBox="0 84 1200 138" aria-hidden className="footer-wordmark mt-4 -mb-4 w-full h-auto select-none" role="presentation">
            <text x="0" y="286" textLength="1200" lengthAdjust="spacing" fontFamily="var(--font-display), 'Space Grotesk', system-ui, sans-serif" fontWeight="700" fontSize="288" letterSpacing="-8.6">
              {'BSTOCKS'.split('').map((ch, i) => (
                <tspan key={i}>{ch}</tspan>
              ))}
            </text>
          </svg>
        </div>
      </footer>

      <nav aria-label="Primary mobile" className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-line bg-canvas [padding-bottom:env(safe-area-inset-bottom)]">
        <div className="grid grid-cols-4">
          {NAV.map((n) => {
            const Icon = n.icon;
            const active = isActive(path, n.href);
            return (
              <Link key={n.href} href={n.href} aria-current={active ? 'page' : undefined} className={cx('relative flex flex-col items-center justify-center gap-1 h-14 text-[10px] font-medium', active ? 'text-primary' : 'text-ink-secondary')}>
                {active && <span aria-hidden className="absolute top-0 left-1/2 -translate-x-1/2 w-7 h-[2px] bg-primary" />}
                <Icon size={19} strokeWidth={1.75} />
                {n.label}
              </Link>
            );
          })}
        </div>
      </nav>

      {/* Keyed by path: every page a refused visitor lands on says so again. */}
      <EligibilityGate key={path} />
    </div>
  );
}

/** One click flips between light and dark. */
export function ThemeToggle() {
  const { resolved, setPreference } = useTheme();
  const Icon = resolved === 'dark' ? Sun : Moon;
  return (
    <button
      type="button"
      aria-label={resolved === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'}
      onClick={() => setPreference(resolved === 'dark' ? 'light' : 'dark')}
      className="h-9 w-9 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink border border-line hover:border-line-strong transition-fast"
    >
      <Icon size={16} strokeWidth={1.75} />
    </button>
  );
}
