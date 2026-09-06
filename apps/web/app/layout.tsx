import type { Metadata, Viewport } from 'next';
import localFont from 'next/font/local';
import { cookies } from 'next/headers';
import type { ReactNode } from 'react';
import { cookieToInitialState } from 'wagmi';

import { AppShell } from '@/components/layout/app-shell';
import { Providers } from '@/components/providers';
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

const APP_URL = (process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000').replace(/\/$/u, '');

export const metadata: Metadata = {
  metadataBase: new URL(APP_URL),
  title: { default: 'StockPair — Tokens priced in real stocks', template: '%s · StockPair' },
  description: 'Launch a token on Base that trades against a Coinbase tokenized stock. Fixed supply, permanent Uniswap v4 liquidity, fees paid in the stock.',
  applicationName: 'StockPair',
};

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
