import type { Metadata } from 'next';
import Link from 'next/link';

import { KeyValue, LinkButton, Module, ModuleHeader, PageTitle } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'How it works' };

const STEPS = [
  {
    title: 'Pick the stock your token trades against',
    body: 'The quote side of every pool is one of the 13 Coinbase tokenized stocks on Base: NVDAc, TSLAc, AAPLc and the rest. They are B20 tokens backed 1:1 by shares, each with a Chainlink price feed. Nothing here trades against ETH or USDC.',
  },
  {
    title: 'Create in one transaction',
    body: 'The factory calls the Base-native B20 factory to mint a token with exactly 1,000,000,000 supply and no admin (no mint, no pause, no upgrade), then opens a Uniswap v4 pool and deposits the whole supply as a single-sided position. You pay 0.0001 ETH plus gas. There is no account and no sign-in.',
  },
  {
    title: 'Every token opens at the same valuation',
    body: 'The opening price is derived onchain from the stock\'s Chainlink feed so that each launch starts at a $5,000 fully diluted valuation. If NVDAc is $230, one NVDAc buys about 46 million tokens at launch. The number is fixed by the contract, not by the creator.',
  },
  {
    title: 'Liquidity can never leave',
    body: 'The position is owned by the factory and the factory has no function that removes it. Buyers push the price up the curve, sellers push it down, and the stock that flows in stays in the pool as the other side of the market.',
  },
  {
    title: 'Snipers pay 99%',
    body: 'For the first 20 seconds after launch the swap fee starts at 99% and falls linearly to 1%. A bot buying in the launch block gives almost all of its stock to the creator and the platform, so there is nothing to snipe.',
  },
  {
    title: 'Fees are paid in the stock',
    body: 'Every buy and sell pays a 1% fee, always denominated in the stock (NVDAc, not the token). The hook books 70% to the creator and 30% to the platform as claims inside the pool manager. Creators withdraw from their wallet page whenever they like; nothing is held by a server.',
  },
  {
    title: 'Everything you see is read from the chain',
    body: 'An indexer waits two block confirmations, then records launches, swaps, transfers and fee events. Prices, candles, holders, volume and earnings are computed from those rows. When a figure cannot be derived it shows as a dash, never as an estimate.',
  },
  {
    title: 'And it tells you without being asked',
    body: 'The same indexer feeds a Telegram channel: every launch, every large trade, every market cap milestone, posted within seconds of the block. The post is written into a queue inside the same database transaction that records the trade, so if the chain reorganises the announcement is withdrawn before it is sent rather than left standing about a trade that no longer exists.',
  },
];

const FAQ = [
  ['Do I need an account?', 'No. Connect a wallet on Base and you can create or trade. The site never asks for a signature to log in.'],
  ['How do I get NVDAc or another stock token?', 'Buy it on BaseStocks (basestocks.finance), the trading app in the same ecosystem, or through Coinbase and any Base DEX; base.org/stocks lists the venues. Coinbase tokenized stocks are available only to eligible persons outside the United States.'],
  ['Why is the USD price marked "last close" on weekends?', 'Chainlink equity feeds update during US extended trading hours and hold the last close in between. Token prices in stock terms keep moving; the USD conversion uses the last feed value.'],
  ['What does the creator get?', '70% of every swap fee, in the stock, claimable at any time from the wallet page. Nothing else: the creator holds no tokens at launch unless they buy them like anyone else.'],
  ['What does the platform get?', '30% of swap fees plus the 0.0001 ETH creation fee.'],
  ['Can the creator pull liquidity or mint more?', 'No. The token has no admin and the factory has no withdraw function. Both are enforced by the contracts, not by policy.'],
  ['Can the creator change the token after launch?', 'Only the profile: description, image, website, X and Telegram. The creator signs the new fields with their wallet (a message, not a transaction) and the page shows them as updated by the creator, with the time. Name, symbol, supply, the pool and the fee split are onchain and cannot change.'],
  ['What is a "dev" trade?', 'A swap made by the wallet that created the token. They are marked on the chart and in the trades list so buyers can see when a creator is buying or selling.'],
  ['Will the Telegram channel post my token?', 'Launches all get posted. After that a trade is announced when it clears $500, or when it is a meaningful share of that token’s own day and still worth a reader’s attention — not every buy and not every sell, because one busy token posting every trade would bury every other one. There is nothing to configure and no account; the channel is the same feed for everybody.'],
];

export default function HowItWorksPage() {
  const d = publicEnv.deployment;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="07 — How it works" title="Tokens priced in real stocks, end to end" lead="A launchpad where every token is paired with a Coinbase tokenized stock on Base. This page explains the mechanism in plain words; the technical reference lives in the docs." action={<LinkButton href="/docs">Technical docs</LinkButton>} />

      <Module ticks>
        <ModuleHeader title="The mechanism" />
        <ol className="grid grid-cols-1 md:grid-cols-2">
          {STEPS.map((s, i) => (
            <li key={s.title} className="p-5 border-b border-line md:[&:nth-child(odd)]:border-r md:[&:nth-last-child(-n+1)]:border-b-0 flex flex-col gap-2">
              <span className="font-mono text-[11px] text-primary">0{i + 1}</span>
              <div className="display-medium text-[18px]">{s.title}</div>
              <p className="text-[14px] text-ink-secondary leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </Module>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start">
        <Module>
          <ModuleHeader title="Questions" />
          <dl className="px-4 py-2">
            {FAQ.map(([q, a]) => (
              <div key={q} className="py-3 border-b border-dashed border-line last:border-b-0">
                <dt className="font-medium text-[15px]">{q}</dt>
                <dd className="mt-1 text-[14px] text-ink-secondary leading-relaxed">{a}</dd>
              </div>
            ))}
          </dl>
        </Module>
        <Module ticks>
          <ModuleHeader title="The deal, in numbers" />
          <div className="px-4 py-2">
            <KeyValue k="Supply" v="1,000,000,000 · fixed" />
            <KeyValue k="Liquidity" v="100% locked, forever" />
            <KeyValue k="Opening valuation" v="$5,000 FDV" />
            <KeyValue k="Swap fee" v="1% · in the stock" />
            <KeyValue k="Creator share" v="70% of every fee" />
            <KeyValue k="Platform share" v="30% of every fee" />
            <KeyValue k="Anti-snipe" v="99% → 1% over 20 s" />
            <KeyValue k="Creation fee" v="0.0001 ETH" />
            <KeyValue k="Network" v="Base · chain 8453" />
            {d && <KeyValue k="Factory" v={<a href={`https://basescan.org/address/${d.factory}`} target="_blank" rel="noreferrer" className="text-primary">{d.factory.slice(0, 10)}…</a>} />}
          </div>
          <div className="p-4 border-t border-line flex flex-col gap-2">
            <LinkButton href="/create" variant="primary" full>
              Create a token
            </LinkButton>
            <LinkButton href="/alerts" full>
              Get alerts on Telegram
            </LinkButton>
            <Link href="/stocks" className="text-[13px] text-primary font-medium text-center">
              See the 13 stocks →
            </Link>
          </div>
        </Module>
      </div>
    </div>
  );
}
