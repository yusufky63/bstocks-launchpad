import type { Metadata } from 'next';

import { LinkButton, Module, ModuleHeader, PageTitle } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';

export const metadata: Metadata = {
  title: 'Alerts',
  description: 'A Telegram channel that posts every launch, every large trade and every market cap milestone on the launchpad.',
};

const POSTS = [
  {
    title: 'Every new launch',
    body: 'The moment a token is indexed: its name, the stock it trades against, who created it, and what it opened at. A few a day, not a stream.',
  },
  {
    title: 'Large trades',
    body: 'A trade that clears $500, or takes a meaningful share of that token\'s own day. Both, because one number cannot serve a token doing $200 a day and one doing $20,000 — a trade counts by being large in dollars or large for its token.',
  },
  {
    title: 'Market cap milestones',
    body: '$10K, $25K, $50K, $100K, $250K, $500K, $1M. Each level once, ever. Falling back under one and crossing it again is not news.',
  },
  {
    title: 'New highs',
    body: 'When a token beats its own record by enough to be worth reading about.',
  },
];

export default function AlertsPage() {
  const channel = publicEnv.telegramChannel;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="08 — Alerts"
        title="What happened, while it is still happening"
        lead="A Telegram channel fed straight from the indexer. Every launch, every large trade, every milestone — posted within seconds of the block, with no account and nothing to configure."
        action={channel ? <LinkButton href={channel} variant="primary" external>Join the channel</LinkButton> : undefined}
      />

      <Module ticks>
        <ModuleHeader title="What it posts" />
        <ul className="grid grid-cols-1 md:grid-cols-2">
          {POSTS.map((p) => (
            <li key={p.title} className="rail border-b border-r border-line p-4 last:border-b-0 md:[&:nth-last-child(-n+2)]:border-b-0">
              <h3 className="font-medium text-[15px]">{p.title}</h3>
              <p className="mt-1.5 text-[13px] text-ink-secondary leading-relaxed">{p.body}</p>
            </li>
          ))}
        </ul>
      </Module>

      <Module>
        <ModuleHeader title="What it does not post" />
        <div className="p-4 text-[13px] text-ink-secondary leading-relaxed max-w-[75ch] flex flex-col gap-3">
          <p>
            Not every buy and not every sell. Everyone in the channel gets the same feed and the only control is
            leaving, so volume is the product: one busy token posting every trade would bury every other token in a
            day, and a channel people have muted is harder to fix than one that never started.
          </p>
          <p>
            Nothing is filtered per person and nothing is configurable, which is the trade for having no account, no
            settings and no bot to talk to. If you want every trade on one token, the token&apos;s own page has the
            full list, live.
          </p>
        </div>
      </Module>

      <Module>
        <ModuleHeader title="Where the numbers come from" />
        <div className="p-4 text-[13px] text-ink-secondary leading-relaxed max-w-[75ch] flex flex-col gap-3">
          <p>
            The same place every figure on this site comes from: the indexer, reading Base. A post is written into
            the queue inside the same database transaction that records the swap it describes, so an announcement is
            exactly as durable as the trade behind it — and if the chain reorganises, the announcement is withdrawn
            before it is sent rather than posted about a trade that no longer exists.
          </p>
          <p>
            Prices are in the stock the token trades against, converted with the Chainlink reading that was live when
            the trade happened, not the one live when the message goes out.
          </p>
        </div>
      </Module>

      {channel && (
        <div className="flex flex-wrap gap-3">
          <LinkButton href={channel} variant="primary" external>
            Join the channel
          </LinkButton>
          <LinkButton href="/docs#alerts">How it works</LinkButton>
        </div>
      )}
    </div>
  );
}
