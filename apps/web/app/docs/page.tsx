import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { BASE_CONTRACTS, BASE_STOCKS } from '@stockpair/core';

import { AddressLabel } from '@/components/ui/display';
import { KeyValue, LinkButton, Module, ModuleHeader, PageTitle } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';

export const metadata: Metadata = { title: 'Docs' };

function Section({ id, index, title, children }: { id: string; index: string; title: string; children: ReactNode }) {
  return (
    <Module id={id} className="scroll-mt-24">
      <ModuleHeader index={index} title={title} />
      <div className="p-4 md:p-5 flex flex-col gap-3 text-[14px] text-ink-secondary leading-relaxed [&_strong]:text-ink [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:rounded-[4px] [&_code]:text-ink">{children}</div>
    </Module>
  );
}

const TOC = [
  ['architecture', 'Architecture'],
  ['contracts', 'Contracts'],
  ['launch', 'Launch mechanics'],
  ['fees', 'Fees and anti-snipe'],
  ['pricing', 'Pricing math'],
  ['indexer', 'Indexer'],
  ['profiles', 'Token profiles'],
  ['api', 'API'],
  ['alerts', 'Alerts'],
  ['stocks', 'Quote stocks'],
  ['security', 'Security model'],
] as const;

export default function DocsPage() {
  const d = publicEnv.deployment;
  return (
    <div className="flex flex-col gap-6">
      <PageTitle index="08 — Docs" title="Technical reference" lead="Contracts, math, indexer, API and the security model of the launchpad. Everything below is enforced by code that is deployed on Base; nothing depends on a server behaving well." action={<LinkButton href="/how-it-works">Plain-words version</LinkButton>} />

      <div className="grid grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)] gap-5 items-start">
        <nav aria-label="Docs sections" className="lg:sticky lg:top-[72px] border border-line rounded-[8px] bg-canvas p-2 flex flex-wrap lg:flex-col gap-0.5">
          {TOC.map(([id, label], i) => (
            <a key={id} href={`#${id}`} className="rail flex items-center gap-2 px-3 py-2 rounded-[6px] text-[13px] text-ink-secondary hover:text-ink hover:bg-surface transition-fast">
              <span className="font-mono text-[10px] text-primary">{String(i + 1).padStart(2, '0')}</span>
              {label}
            </a>
          ))}
        </nav>

        <div className="flex flex-col gap-5 min-w-0">
          <Section id="architecture" index="01" title="Architecture">
            <p>
              The launchpad has four parts. <strong>Contracts</strong> on Base (a factory, a Uniswap v4 hook and a small router) hold every rule that matters: supply, liquidity, fees and who may claim them. An <strong>indexer</strong> follows Base, waits for confirmations and stores confirmed launches, swaps, transfers and fee events. The <strong>web app</strong> renders pages and a public JSON API from those rows and talks to the chain only for quotes and live pool state. A shared <strong>core</strong> library holds the stock registry, the price math and the event decoders used by both.
            </p>
            <p>
              The web app never writes to the database and never trusts client input for anything that is displayed. What you see is either a confirmed event, a number derived from confirmed events, or a live <code>eth_call</code>.
            </p>
          </Section>

          <Section id="contracts" index="02" title="Contracts">
            <KeyValue k="Network" v="Base mainnet · 8453" />
            <KeyValue k="StockPairFactory" v={d ? <AddressLabel address={d.factory} explorer chars={10} /> : 'not configured'} />
            <KeyValue k="StockPairHook" v={d ? <AddressLabel address={d.hook} explorer chars={10} /> : 'not configured'} />
            <KeyValue k="StockPairRouter" v={d ? <AddressLabel address={d.router} explorer chars={10} /> : 'not configured'} />
            <KeyValue k="Deployed at block" v={d ? d.deployBlock.toString() : '—'} />
            <KeyValue k="Uniswap v4 PoolManager" v={<AddressLabel address={BASE_CONTRACTS.poolManager} explorer chars={10} />} />
            <KeyValue k="Uniswap v4 Quoter" v={<AddressLabel address={BASE_CONTRACTS.quoter} explorer chars={10} />} />
            <KeyValue k="Uniswap v4 StateView" v={<AddressLabel address={BASE_CONTRACTS.stateView} explorer chars={10} />} />
            <KeyValue k="B20 factory (precompile)" v={<AddressLabel address="0xB20f000000000000000000000000000000000000" explorer chars={10} />} />
            <p className="pt-2">
              <strong>StockPairFactory</strong> is <code>Ownable2Step</code>. The owner can register stocks (address, Chainlink feed, symbol, decimals), enable or disable a stock for new launches, set the creation fee (capped at 0.01 ETH), set the opening valuation (between $100 and $1,000,000) and change the treasury. The owner cannot touch any launched token or pool, and the hook address can be set exactly once.
            </p>
            <p>
              <strong>StockPairHook</strong> implements <code>beforeInitialize</code> (only the factory may create pools with this hook), <code>beforeSwap</code> and <code>afterSwap</code> with return deltas. It charges the fee on whichever side of the swap is the stock, mints the fee to itself as ERC-6909 claims inside the PoolManager and books 70% to the creator and 30% to the treasury. <code>claim(stock)</code> and <code>claimMany(stocks)</code> burn the claims and transfer real stock tokens to the caller.
            </p>
            <p>
              <strong>StockPairRouter</strong> exposes <code>swapExactIn(poolKey, zeroForOne, amountIn, minAmountOut, recipient, deadline)</code>. It pulls the input token from the caller, runs the swap through the PoolManager and pays the output to the recipient. Any Uniswap v4 router can trade these pools; this one is just the simplest.
            </p>
          </Section>

          <Section id="launch" index="03" title="Launch mechanics">
            <p>
              <code>launch(LaunchParams)</code> takes a name, a symbol, an ERC-7572 <code>contractURI</code>, the stock address and a 32-byte salt, and must be sent with exactly the creation fee. In one transaction the factory:
            </p>
            <ol className="list-decimal pl-5 flex flex-col gap-1">
              <li>Calls the Base-native B20 factory with <code>createB20</code>: version 1, 18 decimals, admin set to the zero address, and three bootstrap calls that cap the supply at 1,000,000,000, mint it to the factory and store the contractURI. The token address is <code>predictToken(creator, salt)</code>, so the UI can open the token page before the block lands.</li>
              <li>Reads the stock&apos;s Chainlink feed (rejecting readings older than 7 days or non-positive) and derives the opening <code>sqrtPriceX96</code> so the full supply is worth the configured valuation in USD.</li>
              <li>Initialises a PoolManager pool with LP fee 0, tick spacing 100 and the StockPairHook, and adds a single-sided position holding the entire supply from the opening tick to the edge of the range on the token side.</li>
              <li>Burns any rounding dust to <code>0xdead</code>, records the launch, registers the pool with the hook (which starts the anti-snipe clock), forwards the creation fee to the treasury and emits <code>Launched</code>.</li>
            </ol>
            <p>The factory keeps the position forever; it has no function that calls <code>modifyLiquidity</code> with a negative delta.</p>
          </Section>

          <Section id="fees" index="04" title="Fees and anti-snipe">
            <KeyValue k="Base fee" v="100 bps · 1% of the stock side of every swap" />
            <KeyValue k="Start fee" v="9,900 bps · 99% in the launch block" />
            <KeyValue k="Decay" v="linear over 20 seconds to 1%" />
            <KeyValue k="Split" v="70% creator · 30% treasury" />
            <KeyValue k="Denomination" v="always the stock (NVDAc, TSLAc, …)" />
            <KeyValue k="Creation fee" v="0.0001 ETH to the treasury" />
            <p className="pt-2">
              On a buy (stock in, token out) the fee is taken from the stock input in <code>beforeSwap</code>. On a sell (token in, stock out) it is taken from the stock output in <code>afterSwap</code>. The current rate is <code>currentFeeBps(poolId)</code>; the quote endpoint reads it so the UI can warn during the anti-snipe window. Fees never sit in a server: they are ERC-6909 claims owned by the hook and booked per account, withdrawn with <code>claim</code>.
            </p>
          </Section>

          <Section id="pricing" index="05" title="Pricing math">
            <p>
              Uniswap prices are <code>currency1 per currency0</code> in raw units; the token has 18 decimals and every stock has 8. With the token as currency0, <code>P = 10^8 · FDV / (stockUsd · 10^27)</code>; as currency1 the fraction inverts. The factory computes <code>sqrtPriceX96 = sqrt(P · 2^128) · 2^32</code> with full-precision integer math and derives the tick.
            </p>
            <p>
              The indexer stores every swap&apos;s post-trade price as whole stock per whole token with 30 decimals; the web app multiplies by the stock&apos;s latest Chainlink USD price to show dollars. FDV is that price times one billion. Pool reserves are computed from the locked position (liquidity, tick range) and the live <code>sqrtPriceX96</code> from StateView.
            </p>
          </Section>

          <Section id="indexer" index="06" title="Indexer">
            <p>
              The indexer polls Base every 2 seconds and processes blocks that are at least 3 confirmations deep (<code>INDEXER_CONFIRMATIONS</code>, its default). It fetches <code>Launched</code>, <code>FeeCharged</code> and <code>FeesClaimed</code> logs from the factory and hook, PoolManager <code>Swap</code> logs filtered by the known pool ids, and ERC-20 <code>Transfer</code> logs of launched tokens, then writes everything in one database transaction: launches, swaps (with side, price and trader), fee events, transfers, balances and rebuilt one-minute candles.
            </p>
            <p>
              Reorgs are detected by comparing the stored hash of the last processed block with the chain; on mismatch the indexer rolls back to the last common ancestor and replays. Every minute it refreshes the 13 Chainlink quotes, and it fills token metadata (description, image, website, X) from IPFS in the background. The web app's <code>/api/health</code> reports how far behind the chain head the indexer is.
            </p>
          </Section>

          <Section id="profiles" index="07" title="Token profiles">
            <p>
              Launch metadata (name, symbol, description, image, website, X) is written once into the token&apos;s ERC-7572 <code>contractURI</code> on IPFS. Because that record is immutable, presentation fields can be updated off-chain by the creator: description, image, website, X and Telegram. Name, symbol and supply never change.
            </p>
            <p>
              An update is an EIP-712 message signed by the creator wallet over the token address, the normalised fields, the keccak256 of the new image (or zero when unchanged) and a timestamp. The server accepts it only when the signer equals the launch creator recorded onchain, the timestamp is within 15 minutes of its clock and newer than the stored profile, the uploaded image matches the signed hash, and the signature verifies (offline for EOAs, via ERC-1271 / ERC-6492 on Base for smart wallets such as Base Account). The stored profile overrides the launch metadata field by field and the token page says when the creator last updated it.
            </p>
            <KeyValue k="Signed type" v="TokenProfile(address token, string description, string website, string twitter, string telegram, bytes32 imageHash, uint256 issuedAt)" mono={false} />
            <KeyValue k="Domain" v="StockPair · version 1 · chainId 8453" mono={false} />
          </Section>

          <Section id="api" index="08" title="API">
            <p>All responses are JSON, computed from the indexer&apos;s tables plus live pool reads. Missing data is <code>null</code>, never a placeholder. Reads are memoised server-side for 3 to 15 seconds.</p>
            <KeyValue k="GET /api/markets" v="?stock=&q=&creator=&limit=&offset= · list of markets" mono={false} />
            <KeyValue k="GET /api/stocks" v="the 13 quote stocks with Chainlink price and feed status" mono={false} />
            <KeyValue k="GET /api/tokens/:address" v="market row, fees, lifetime figures, pool reserves, links" mono={false} />
            <KeyValue k="GET /api/tokens/:address/swaps" v="?limit=&before= · trades with dev flag" mono={false} />
            <KeyValue k="GET /api/tokens/:address/candles" v="one-minute OHLCV in stock units" mono={false} />
            <KeyValue k="GET /api/tokens/:address/holders" v="ranked balances with labels" mono={false} />
            <KeyValue k="GET|POST /api/tokens/:address/profile" v="creator-signed profile: read, or update with payload + image" mono={false} />
            <KeyValue k="GET /api/wallet/:address" v="created, holdings, claimable, earnings, trades" mono={false} />
            <KeyValue k="GET /api/stats" v="platform totals and per-stock fees and volume" mono={false} />
            <KeyValue k="GET /api/activity" v="?limit=&token=&actor= · launches and swaps feed" mono={false} />
            <KeyValue k="POST /api/quote" v="{ token, side, amountIn } · exact-in quote from the v4 Quoter" mono={false} />
            <KeyValue k="POST /api/metadata" v="multipart · pins image and ERC-7572 JSON to IPFS" mono={false} />
            <KeyValue k="GET /api/health" v="database, contracts, indexer lag, chain head" mono={false} />
          </Section>

          <Section id="alerts" index="09" title="Alerts">

            <p>

              A Telegram channel posts every launch, every large trade and every market cap milestone. It is fed by the indexer rather than by polling the API: a row is written into an outbox table inside the same database transaction that commits the swap it describes, so an announcement is exactly as durable as the fact behind it. A reorg deletes the unsent rows for the blocks it rolled back, so the channel cannot announce a trade that did not survive.

            </p>

            <p>

              A trade qualifies by clearing an absolute dollar floor <strong>or</strong> a share of that token&apos;s own 24-hour volume, because one threshold cannot serve a token doing $200 a day and one doing $20,000. Individual buys and sells are deliberately not posted: nobody can filter a shared channel, so one busy token would bury every other. Milestones are recorded only after the post is actually delivered, so a failed send retries rather than silently skipping a level.

            </p>

          </Section>


          <Section id="stocks" index="10" title="Quote stocks">
            <p>Coinbase tokenized stocks on Base, registered in the factory with their Chainlink total-return feeds (8 decimals, 24/5). Icons come from each token&apos;s onchain metadata.</p>
            <div className="overflow-x-auto -mx-4 md:-mx-5">
              <table className="w-full text-[13px] min-w-[640px]">
                <thead>
                  <tr className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                    <th className="text-left px-4 md:px-5 py-2 border-b border-line">Symbol</th>
                    <th className="text-left px-2 py-2 border-b border-line">Company</th>
                    <th className="text-left px-2 py-2 border-b border-line">Token</th>
                    <th className="text-left px-2 py-2 border-b border-line">Feed</th>
                  </tr>
                </thead>
                <tbody>
                  {BASE_STOCKS.map((s) => (
                    <tr key={s.address} className="border-b border-line last:border-b-0">
                      <td className="px-4 md:px-5 py-2 font-medium text-ink">{s.symbol}</td>
                      <td className="px-2 py-2">{s.name}</td>
                      <td className="px-2 py-2">
                        <AddressLabel address={s.address} explorer kind="token" showCopy={false} chars={6} />
                      </td>
                      <td className="px-2 py-2">
                        <AddressLabel address={s.feed} explorer showCopy={false} chars={6} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="security" index="11" title="Security model">
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li><strong>No custody.</strong> The site holds no keys and no funds. Fees live in the PoolManager as claims owned by the hook and booked per account.</li>
              <li><strong>No admin over tokens.</strong> Launched tokens have the zero address as admin; the factory cannot mint, pause or withdraw liquidity.</li>
              <li><strong>Bounded owner powers.</strong> The factory owner can only manage the stock registry and fee parameters within hard caps, and can set the hook once.</li>
              <li><strong>Reentrancy and callbacks.</strong> The factory&apos;s launch path is <code>nonReentrant</code>; unlock callbacks accept calls only from the PoolManager.</li>
              <li><strong>Stale feeds rejected.</strong> A launch reverts when the stock&apos;s Chainlink reading is older than 7 days or not positive.</li>
              <li><strong>Confirmed data only.</strong> The indexer records blocks three confirmations deep and rolls back on reorgs; the web app never writes rows from user input.</li>
              <li><strong>Profiles are signed, not trusted.</strong> Off-chain profile edits require an EIP-712 signature from the launch creator over the exact fields and image hash, with a 15-minute validity window and monotonic timestamps against replay.</li>
              <li><strong>Input validation.</strong> Every API parameter is schema-checked; addresses are checksummed and lower-cased; metadata uploads are limited to 2 MB images of four types and 1,000-character descriptions; X and Telegram links are normalised to <code>https://x.com/handle</code> and <code>https://t.me/handle</code>.</li>
              <li><strong>Trading safety.</strong> Quotes come from the v4 Quoter; swaps carry a minimum output from the user&apos;s slippage setting and a 3-minute deadline; the swap is simulated before the wallet opens.</li>
            </ul>
          </Section>

        </div>
      </div>
    </div>
  );
}
