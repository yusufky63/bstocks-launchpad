import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { cookieToInitialState } from 'wagmi';

import { AppShell } from '@/components/layout/app-shell';
import { Providers } from '@/components/providers';
import { BSTOCKS_X_HANDLE } from '@/lib/twitter';
import { getWagmiConfig } from '@/lib/wagmi';

import './globals.css';

const body = localFont({
  display: 'swap',
  src: [
    { path: './fonts/DMSans-400.ttf', weight: '400' },
    { path: './fonts/DMSans-500.ttf', weight: '500' },
  ],
  variable: '--font-body',
});

const display = localFont({
  display: 'swap',
  src: './fonts/SpaceGrotesk.woff2',
  variable: '--font-display',
  weight: '300 700',
});

const mono = localFont({
  display: 'swap',
  src: './fonts/JetBrainsMono-400.ttf',
  variable: '--font-mono',
  weight: '400',
});

/** Official production origin as the fallback so share links and wallet metadata never point at localhost. */
const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? (process.env.NODE_ENV === 'production' ? 'https://launchpad.basestocks.finance' : 'http://localhost:3000')).replace(/\/$/u, '');

const DESCRIPTION = 'Launch a token on Base that trades against a Coinbase tokenized stock. Fixed supply, permanent Uniswap v4 liquidity, fees paid in the stock.';

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: 'BaseStocks Launchpad — Tokens priced in real stocks', template: '%s · BaseStocks Launchpad' },
  description: DESCRIPTION,
  applicationName: 'BaseStocks Launchpad',
  appleWebApp: { capable: true, title: 'Launchpad', statusBarStyle: 'default' },
  openGraph: {
    type: 'website',
    siteName: 'BaseStocks Launchpad',
    url: '/',
    locale: 'en_US',
    title: 'BaseStocks Launchpad — Tokens priced in real stocks',
    description: DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', creator: `@${BSTOCKS_X_HANDLE}` },
  robots: { index: true, follow: true },
  // Proves this origin to Base's app directory. The tag has to stay for the domain to keep its verification.
  other: { 'base:app_id': '6a98cc686e87922b5d1d4597' },
};

/** Structured data for link previews and search: the site, and BaseStocks as the org behind it. */
const jsonLd = JSON.stringify({
  '@context': 'https://schema.org',
  '@graph': [
    { '@type': 'WebSite', name: 'BaseStocks Launchpad', url: APP_URL, description: DESCRIPTION },
    { '@type': 'Organization', name: 'BaseStocks', url: 'https://basestocks.finance' },
  ],
});

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0a0b0d' },
  ],
};

const themeScript = `(function(){try{var t=localStorage.getItem('stockpair:theme');if(t==='dark'||t==='light'){document.documentElement.setAttribute('data-theme',t);}}catch(e){}})();`;

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cookieHeader = (await cookies()).toString();
  const initialState = cookieToInitialState(getWagmiConfig(), cookieHeader);
  return (
    <html lang="en" suppressHydrationWarning className={`${body.variable} ${display.variable} ${mono.variable} h-full`}>
      <head>
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: jsonLd }} />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="min-h-full flex flex-col bg-canvas text-ink">
        <Providers initialState={initialState}>
          <AppShell>{children}</AppShell>
        </Providers>
      </body>
    </html>
  );
}
