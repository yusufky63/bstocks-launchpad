import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { BASE_CONTRACTS, BASE_STOCKS } from '@stockpair/core';

import { AddressLabel } from '@/components/ui/display';
import { Badge, KeyValue, LinkButton, Module, ModuleHeader, PageTitle } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';

import { deploymentLabel, ERRORS, EVENTS, FUNCTIONS, THRESHOLDS, ZERO_ADMIN, type RefItem } from './reference';

export const metadata: Metadata = { title: 'Docs' };

const TOC = [
  ['architecture', 'Architecture'],
  ['contracts', 'Contracts'],
  ['deployments', 'Deployments'],
  ['launch', 'Launch mechanics'],
  ['buy', 'Buy at launch'],
  ['editable', 'Editable profile'],
  ['fees', 'Fees'],
  ['pricing', 'Pricing math'],
  ['indexer', 'Indexer'],
  ['profiles', 'Token profiles'],
  ['api', 'API'],
  ['alerts', 'Alerts'],
  ['stocks', 'Quote stocks'],
  ['thresholds', 'Thresholds'],
  ['reference', 'Contract reference'],
  ['security', 'Security model'],
] as const;

type SectionId = (typeof TOC)[number][0];

/** Number and title come from the TOC, so the rail and the sections cannot disagree. */
function Section({ id, children }: { id: SectionId; children: ReactNode }) {
  const index = TOC.findIndex(([key]) => key === id);
  return (
    <Module id={id} className="scroll-mt-24">
      <ModuleHeader index={String(index + 1).padStart(2, '0')} title={TOC[index]?.[1] ?? id} />
      <div className="p-4 md:p-5 flex flex-col gap-3 text-[14px] text-ink-secondary leading-relaxed [&_strong]:text-ink [&_code]:font-mono [&_code]:text-[12px] [&_code]:bg-surface-muted [&_code]:px-1 [&_code]:rounded-[4px] [&_code]:text-ink">{children}</div>
    </Module>
  );
}

function RefList({ title, items }: { title: string; items: readonly RefItem[] }) {
  return (
    <div className="flex flex-col">
      <h3 className="eyebrow pt-2 pb-1">{title}</h3>
      {items.map((item) => (
        <div key={`${item.contract}:${item.display}`} className="grid grid-cols-1 md:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] gap-x-4 gap-y-1 py-2 border-b border-dashed border-line last:border-b-0">
          <div className="min-w-0 flex flex-col gap-1">
            <code className="w-fit max-w-full break-words">{item.display}</code>
            <span className="font-mono text-[11px] text-ink-muted break-all">{item.id}</span>
          </div>
          <div className="text-[13px]">
            <span className="text-ink">{item.contract}</span> · {item.note}
          </div>
        </div>
      ))}
    </div>
  );
}

const SIGNATURES = `struct LaunchParams  { string name; string symbol; string contractURI; address stock; bytes32 salt; }
struct LaunchOptions { bool metadataEditable; uint256 openingFdvUsd8; uint256 deadline; }
struct CreatorBuy    { uint128 stockIn; uint128 minTokensOut; }

launch(LaunchParams)                                  -> (address token, PoolId poolId)
launchWithOptions(LaunchParams, LaunchOptions)        -> (address token, PoolId poolId)
launchAndBuy(LaunchParams, LaunchOptions, CreatorBuy) -> (address token, PoolId poolId, uint256 tokensOut)`;

export default function DocsPage() {
  // Newest first: the one that takes launches, then every earlier one, which all stay live.
  const deployments = [...publicEnv.deployments].reverse();
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
          <Section id="architecture">
            <p>
              The launchpad has four parts. <strong>Contracts</strong> on Base (a factory, a Uniswap v4 hook and a small router) hold every rule that matters: supply, liquidity, fees and who may claim them. An <strong>indexer</strong> follows Base, waits for confirmations and stores confirmed launches, swaps, transfers, profile changes and fee events. The <strong>web app</strong> renders pages and a public JSON API from those rows; for new launches it also reads the factory directly so trading works while indexing catches up. A shared <strong>core</strong> library holds the stock registry, the price math, the launch quote and the event decoders used by all of them.
            </p>
            <p>
              Everything on a page is a confirmed event, a number derived from confirmed events, or a live <code>eth_call</code> — with one exception, and it is signed: the creator of a token with a fixed profile may replace its presentation fields, and the server stores that only after checking the signature against the creator address recorded onchain. Nothing else the web app receives from a client is ever stored.
            </p>
          </Section>

          <Section id="contracts">
            <KeyValue k="Network" v="Base mainnet · 8453" />
            <KeyValue k="Uniswap v4 PoolManager" v={<AddressLabel address={BASE_CONTRACTS.poolManager} explorer chars={10} />} />
            <KeyValue k="Uniswap v4 Quoter" v={<AddressLabel address={BASE_CONTRACTS.quoter} explorer chars={10} />} />
            <KeyValue k="Uniswap v4 StateView" v={<AddressLabel address={BASE_CONTRACTS.stateView} explorer chars={10} />} />
            <KeyValue k="B20 factory (precompile)" v={<AddressLabel address="0xB20f000000000000000000000000000000000000" explorer chars={10} />} />
            <p className="pt-2">
              The launchpad&apos;s own addresses are under <a href="#deployments" className="text-primary">Deployments</a>. Each deployment is one factory, one hook and one router.
            </p>
            <p>
              <strong>StockPairFactory</strong> is <code>Ownable2Step</code>. The owner can register stocks (address, Chainlink feed, symbol, decimals), enable or disable a stock for new launches, set the creation fee (capped at 0.01 ETH), set the opening valuation (between $100 and $1,000,000) and change the treasury. The owner cannot touch any launched token, its pool or its profile, and the hook address can be set exactly once.
            </p>
            <p>
              <strong>StockPairHook</strong> implements <code>beforeInitialize</code> (only the factory may create pools with this hook), <code>beforeSwap</code> and <code>afterSwap</code> with return deltas. It charges the fee on whichever side of the swap is the stock, mints the fee to itself as ERC-6909 claims inside the PoolManager and books 70% to the creator and 30% to the treasury. <code>claim(stock)</code> and <code>claimMany(stocks)</code> burn the claims and transfer real stock tokens to the caller. It rejects swaps in pools the factory has not registered yet.
            </p>
            <p>
              <strong>StockPairRouter</strong> exposes <code>swapExactIn(poolKey, zeroForOne, amountIn, minAmountOut, recipient, deadline)</code>. It pulls the input token from the caller, runs the swap through the PoolManager and pays the output to the recipient. Any Uniswap v4 router can trade these pools; this one is just the simplest.
            </p>
          </Section>

          <Section id="deployments">
            <p>
              A new deployment never replaces an old one. Hooks cannot be swapped on a live pool, so every factory and hook stays live: tokens launched through them keep trading, earning fees and claiming there, and the indexer follows all of them. Only the newest factory takes launches from this site.
            </p>
            {deployments.length === 0 && <p>No deployment is configured for this build.</p>}
            {deployments.map((d, i) => (
              <div key={d.factory} className="border border-line rounded-[6px] px-3">
                <div className="flex flex-wrap items-center justify-between gap-2 py-2 border-b border-dashed border-line">
                  <strong>{deploymentLabel(d)}</strong>
                  <Badge tone={i === 0 ? 'primary' : 'neutral'}>{i === 0 ? 'Live · new launches' : 'Live · its own tokens'}</Badge>
                </div>
                <KeyValue k="StockPairFactory" v={<AddressLabel address={d.factory} explorer chars={10} />} />
                <KeyValue k="StockPairHook" v={<AddressLabel address={d.hook} explorer chars={10} />} />
                <KeyValue k="StockPairRouter" v={<AddressLabel address={d.router} explorer chars={10} />} />
                <KeyValue k="Deploy block" v={d.deployBlock > 0n ? d.deployBlock.toLocaleString('en-US') : '—'} />
              </div>
            ))}
            <p>
              The first deployment, from 2026-09-06, came before buy at launch, editable profiles and the partial-fill check. Its factory has <code>launch</code> only, so every token from it has a fixed profile. Its <code>launch</code> also registers the new pool with the hook before it pays the treasury, and it checks only the length of the name, symbol and contract URI, not for control characters. Its <code>launch</code>, <code>Launched</code>, <code>launchOf</code>, <code>previewOpening</code>, <code>predictToken</code> and <code>stockInfo</code> have the same signatures and selectors as the newer factory&apos;s, so one decoder reads both. Where this page describes the launch flow, buy at launch, editable profiles or partial fills, it describes the newest deployment.
            </p>
          </Section>

          <Section id="launch">
            <p>
              The newest factory has three ways to launch; the first factory has only <code>launch</code>. All three take the same <code>LaunchParams</code>, must be sent with exactly the creation fee, and create the token at <code>predictToken(creator, salt)</code>. This site sends <code>launchWithOptions</code> or <code>launchAndBuy</code> to a factory that has them. While the newest factory it is configured with has only <code>launch</code>, it sends that, with a fixed profile and no buy, and the create form hides both options.
            </p>
            <pre className="font-mono text-[12px] leading-relaxed bg-surface-muted text-ink rounded-[6px] p-3 overflow-x-auto"><code>{SIGNATURES}</code></pre>
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li><code>launch</code>: fixed profile, no buy, no deadline. The same function and selector as the first factory, so existing integrations keep working. The newest factory&apos;s checks are stricter: it also rejects control characters, and it pays the treasury before the pool is registered.</li>
              <li><code>launchWithOptions</code>: adds a deadline (the launch reverts with <code>Expired</code> after it; the deadline itself still passes), a check that <code>openingFdvUsd8</code> equals the valuation the creator reviewed (<code>OpeningFdvChanged</code>), and the choice of an editable profile, which needs an <code>ipfs://</code> contract URI that is a bare CID, with no path.</li>
              <li><code>launchAndBuy</code>: all of that, then a buy for the sender in the same transaction. <code>stockIn</code> and <code>minTokensOut</code> must both be above zero. See <a href="#buy" className="text-primary">Buy at launch</a>.</li>
            </ul>
            <p>In one transaction the newest factory:</p>
            <ol className="list-decimal pl-5 flex flex-col gap-1">
              <li>Checks the call: the hook is set, <code>msg.value</code> equals the creation fee, the stock is enabled, the name is 1 to 64 bytes, the symbol 1 to 16 and the contract URI at most 512, with no control characters.</li>
              <li>Calls the Base-native B20 factory with <code>createB20</code>: version 1, 18 decimals, admin set to the zero address, and three bootstrap calls that cap the supply at 1,000,000,000, mint it to the factory and store the contractURI. For an editable profile a fourth call grants the factory <code>METADATA_ROLE</code>, and the factory checks the token holds exactly the role it asked for. The token address is <code>predictToken(creator, salt)</code>, so the UI can open the token page before the block lands.</li>
              <li>Reads the stock&apos;s Chainlink feed (rejecting readings older than 7 days or non-positive) and derives the opening <code>sqrtPriceX96</code> so the full supply is worth the configured valuation in USD.</li>
              <li>Initialises a PoolManager pool with LP fee 0, tick spacing 100 and the StockPairHook, and adds a single-sided position holding the entire supply from the opening tick to the edge of the range on the token side.</li>
              <li>Burns any rounding dust to <code>0xdead</code>, pays the creation fee to the treasury, records the launch, registers the pool with the hook and emits <code>Launched</code>, followed by <code>MetadataEditable</code> for an editable profile.</li>
              <li>For <code>launchAndBuy</code> only: swaps exactly <code>stockIn</code> of the stock for the token, delivers the tokens to the sender and emits <code>CreatorBought</code>.</li>
            </ol>
            <p>
              The treasury is paid before the pool is registered, on purpose. The treasury is an address the owner sets, and the payment is a call with full gas. Until <code>registerPool</code> runs, the hook rejects every swap in the new pool (<code>UnknownPool</code>), so nothing the treasury does during that call can trade it: not at the opening price, and not ahead of the creator&apos;s buy.
            </p>
            <p>
              Log order: <code>Initialize</code>, <code>ModifyLiquidity</code>, <code>PoolRegistered</code>, <code>Launched</code>, <code>MetadataEditable</code> (editable only), then for a buy <code>FeeCharged</code>, <code>Swap</code> and <code>CreatorBought</code>. So <code>Launched</code> comes before any <code>Swap</code> in its pool.
            </p>
            <p>The factory keeps the position forever; it has no function that calls <code>modifyLiquidity</code> with a negative delta.</p>
          </Section>

          <Section id="buy">
            <p>
              On the newest factory only, <code>launchAndBuy</code> lets the creator buy their own token in the transaction that creates it. The buy runs after the pool is registered and before the transaction ends, so nobody can trade the pool before it.
            </p>
            <KeyValue k="Paid in" v="the paired stock, from the sender straight into the PoolManager" mono={false} />
            <KeyValue k="Approval" v="stockIn of the stock, to the factory · this site approves exactly that" mono={false} />
            <KeyValue k="Fee" v="the normal 1% · 70% of it booked back to the creator" mono={false} />
            <KeyValue k="Tokens go to" v="the sender (a smart wallet receives them itself)" mono={false} />
            <KeyValue k="msg.value" v="the creation fee only" mono={false} />
            <KeyValue k="If it fails" v="nothing is launched · only gas is spent" mono={false} />
            <KeyValue k="Cap" v="none onchain · this site stops at 50% of supply" mono={false} />
            <p className="pt-2">
              The buy is an exact-input swap of <code>stockIn</code>. If it would return fewer than <code>minTokensOut</code> tokens, the factory reverts with <code>TooLittleReceived</code> and the whole launch is undone: no token, no pool, no creation fee. The factory never holds the stock or the tokens, and it only ever pulls stock from the sender of the launch, so a leftover approval cannot be spent by anyone else. The terms are the same as launching and then buying through the router a moment later; the difference is that nobody can get in between. <code>CreatorBought(token, creator, poolId, stockIn, fee, tokensOut)</code> records it, and the token page shows the share as &quot;Dev buy P%&quot;.
            </p>
            <p>
              <strong>Why the tolerance defaults to 2%.</strong> The quote itself is exact: <code>quoteLaunchBuy</code> in the core library replays the pool math and matches the contracts to the wei, checked against vectors the contract tests write. What can move between review and inclusion is the opening price, which the factory reads from the stock&apos;s Chainlink feed when the transaction runs. The opening range starts on a 100-tick boundary, so a feed move changes the output in steps of about 0.995%. A 1% tolerance would revert on ordinary feed moves; 2% covers a move of up to about 1.5%. A bigger move reverts, and costs only gas.
            </p>
          </Section>

          <Section id="editable">
            <p>
              Off by default, and only on the newest factory. A creator who launches with <code>launchWithOptions</code> or <code>launchAndBuy</code> and sets <code>metadataEditable</code> can later point the token at a new profile. A token from <code>launch</code>, and every token from the first factory, is always fixed.
            </p>
            <KeyValue k="Can change" v="the contract URI: the ERC-7572 document with image, description and links" mono={false} />
            <KeyValue k="Never changes" v="name, symbol, supply, pool, fees" mono={false} />
            <KeyValue k="Links" v="ipfs:// and a bare CID only, at launch and on every update · letters and digits after ipfs://, no path · 8 to 512 bytes" mono={false} />
            <KeyValue k="Who" v="the address that launched the token · not transferable · no owner override" mono={false} />
            <KeyValue k="Lock" v="lockMetadata(token) · one way, for good · the link can never change again" mono={false} />
            <KeyValue k="Status" v="metadataStatus(token): Immutable, Editable or Locked" mono={false} />
            <p className="pt-2">
              The bootstrap that creates an editable token has one extra call, which grants the B20 <code>METADATA_ROLE</code> to the factory and to nobody else. <code>updateContractURI(token, uri)</code> checks that the caller is the launch&apos;s creator and that the token is still editable, accepts only <code>ipfs://</code> followed by a bare CID (letters and digits, so no path, dot, slash or percent sign can lead it anywhere else), sets it on the token and emits <code>ContractURIChanged</code>; the token emits <code>ContractURIUpdated()</code>. The launch itself checks an editable profile&apos;s first link the same way. The factory checks the link, not the document behind it. When the image that document names is also <code>ipfs://</code> and a bare CID, every change to what the token shows is an onchain event, and a locked profile&apos;s content is fixed. A document can still name an image at a web address, which can change with no event at all; the token page says so whenever the link or the image is anything but a bare CID, and this site only ever pins bare-CID images.
            </p>
            <p>
              <code>lockMetadata(token)</code> makes the factory renounce the role. The token has no admin, so nothing can ever grant it again. <code>metadataStatus</code> reads the role from the token itself, so it says Locked from that block on.
            </p>
            <p>
              What it cannot do: at the token level the role also covers the name, symbol and extra-metadata setters. Only the factory&apos;s code keeps them out of reach, and that code has no path to them: no rename function, no generic call, no proxy, no upgrade. Tests pin the factory&apos;s complete list of state-changing functions and scan its bytecode for the rename selectors.
            </p>
            <p>
              On this site an editable token is edited onchain only: the signed off-chain editor is closed for it. The token page shows how many times the profile changed and when. Until the profile is locked, whoever holds the creator&apos;s key can change its links.
            </p>
          </Section>

          <Section id="fees">
            <KeyValue k="Swap fee" v="100 bps · 1% of the stock side of a swap · the live rate is currentFeeBps on the token's own hook" />
            <KeyValue k="Split" v="70% creator · 30% treasury" />
            <KeyValue k="Denomination" v="always the stock (NVDAc, TSLAc, …)" />
            <KeyValue k="Creation fee" v="0.0001 ETH to the treasury" />
            <p className="pt-2">
              When the stock is the amount a swap specifies (an exact-input buy, or an exact-output sell) the fee is taken from it in <code>beforeSwap</code>, so <code>FeeCharged</code> comes before the pool&apos;s <code>Swap</code> log. When the stock is the other side (an exact-input sell, which is every sell through this site&apos;s router, or an exact-output buy) it is taken from the stock amount in <code>afterSwap</code>, after <code>Swap</code>. A fee that rounds to zero is not charged and emits nothing. The current rate is <code>currentFeeBps(poolId)</code>, which the quote endpoint reads from the token&apos;s own hook. Fees never sit in a server: they are ERC-6909 claims owned by the hook and booked per account, withdrawn with <code>claim</code>.
            </p>
            <p>
              <strong>Partial fills.</strong> When the stock is the amount a swap specifies (an exact-input buy or an exact-output sell), the hook takes the fee on that whole amount before the swap runs. The newest hook then checks that the pool filled all of it, and otherwise reverts with <code>PartialFill</code>; Uniswap v4 delivers that inside <code>WrappedError</code>. Pools on the first deployment&apos;s hook have no such check: a swap there that stops early at a price limit its caller set still pays the fee on the full amount it asked for. This site&apos;s router sets no price limit of its own, so its swaps are not affected; third-party routers that set one can be overcharged.
            </p>
          </Section>

          <Section id="pricing">
            <p>
              Uniswap prices are <code>currency1 per currency0</code> in raw units; the token has 18 decimals and every stock has 8. With the token as currency0, <code>P = 10^8 · FDV / (stockUsd · 10^27)</code>; as currency1 the fraction inverts. The factory computes <code>sqrtPriceX96 = sqrt(P · 2^128) · 2^32</code> with full-precision integer math and derives the tick.
            </p>
            <p>
              The indexer stores every swap&apos;s post-trade price as whole stock per whole token with 30 decimals; the web app multiplies by the stock&apos;s latest Chainlink USD price to show dollars. FDV is that price times one billion. Pool reserves are computed from the locked position (liquidity, tick range) and the live <code>sqrtPriceX96</code> from StateView.
            </p>
          </Section>

          <Section id="indexer">
            <p>
              The indexer polls Base every 2 seconds and processes blocks that are at least 3 confirmations deep (<code>INDEXER_CONFIRMATIONS</code>, its default). It fetches <code>Launched</code>, <code>CreatorBought</code>, <code>MetadataEditable</code>, <code>ContractURIChanged</code> and <code>MetadataLocked</code> from every factory, <code>FeeCharged</code> and <code>FeesClaimed</code> from every hook, PoolManager <code>Swap</code> logs filtered by the known pool ids, and ERC-20 <code>Transfer</code> logs of launched tokens, then writes everything in one database transaction: launches, swaps (with side, price and trader), fee events, profile changes, transfers, balances and rebuilt one-minute candles.
            </p>
            <p>
              It follows every deployment in <code>STOCKPAIR_DEPLOYMENTS</code>, and a deployment added later gets a catch-up pass from its own deploy block. A creator&apos;s buy at launch is stored as a buy by the creator, taken from <code>CreatorBought</code>, so it is attributed correctly even when a bundler sent the transaction.
            </p>
            <p>
              Reorgs are detected by comparing the stored hash of the last processed block with the chain; on mismatch the indexer rolls back to the last common ancestor and replays, including any profile change in the rolled-back blocks. Every minute it refreshes the 13 Chainlink quotes, and it fills token metadata (description, image, website, X, Telegram) from IPFS in the background, again whenever an editable token points at a new profile. The web app&apos;s <code>/api/health</code> reports how far behind the chain head the indexer is.
            </p>
          </Section>

          <Section id="profiles">
            <p>
              Launch metadata (name, symbol, description, image, website, X, Telegram) is written into the token&apos;s ERC-7572 <code>contractURI</code> on IPFS. For a token with a fixed profile (every launch that did not choose an editable one, and every token from the first factory) that record can never change, so the creator can update presentation fields off-chain instead: description, image, website, X and Telegram. Name, symbol and supply never change. A token with an editable profile is updated onchain (see <a href="#editable" className="text-primary">Editable profile</a>), and this off-chain path is closed for it.
            </p>
            <p>
              An update is an EIP-712 message signed by the creator wallet over the token address, the normalised fields, the keccak256 of the new image (or zero when unchanged) and a timestamp. The server accepts it only when the signer equals the launch creator recorded onchain, the timestamp is within 15 minutes of its clock and newer than the stored profile, the uploaded image matches the signed hash, and the signature verifies (offline for EOAs, via ERC-1271 / ERC-6492 on Base for smart wallets such as Base Account). The stored profile overrides the launch metadata field by field and the token page says when the creator last updated it.
            </p>
            <KeyValue k="Signed type" v="TokenProfile(address token, string description, string website, string twitter, string telegram, bytes32 imageHash, uint256 issuedAt)" mono={false} />
            <KeyValue k="Domain" v="StockPair · version 1 · chainId 8453" mono={false} />
          </Section>

          <Section id="api">
            <p>Most responses use the indexer&apos;s tables plus live pool reads. A confirmed launch can be quoted and traded directly from its factory and pool before indexing. Missing data is <code>null</code>, never a placeholder. Reads are memoised server-side for 3 to 15 seconds.</p>
            <KeyValue k="GET /api/markets" v="?stock=&q=&creator=&limit=&offset= · list of markets" mono={false} />
            <KeyValue k="GET /api/stocks" v="the 13 quote stocks with Chainlink price and feed status" mono={false} />
            <KeyValue k="GET /api/tokens/:address" v="market row, fees, lifetime figures, pool reserves, links, launch.creatorBuy, profile.onchain" mono={false} />
            <KeyValue k="GET /api/tokens/:address/swaps" v="?limit=&before= · trades with dev flag" mono={false} />
            <KeyValue k="GET /api/tokens/:address/candles" v="one-minute OHLCV in stock units" mono={false} />
            <KeyValue k="GET /api/tokens/:address/holders" v="ranked balances with labels" mono={false} />
            <KeyValue k="GET /api/tokens/:address/dex-paid" v="DEX Screener paid-order status · approved, pending, none or unavailable · cached for five minutes" mono={false} />
            <KeyValue k="GET /api/tokens/:address/image" v="the token image from our own origin, capped at 5 MB · linked with ?v= and the first 12 hex of the image URI's sha256, so a new image gets a new URL · API responses give it as an absolute URL · cached for good only when the image is ipfs:// and a bare CID" mono={false} />
            <KeyValue k="GET /api/names" v="?a=0x..,0x.. · Basenames for up to 100 addresses" mono={false} />
            <KeyValue k="GET|POST /api/tokens/:address/profile" v="creator-signed profile of a fixed-profile token: read, or update with payload + image · 409 for an editable token" mono={false} />
            <KeyValue k="GET /api/wallet/:address" v="created, holdings, claimable, earnings, trades" mono={false} />
            <KeyValue k="GET /api/stats" v="platform totals and per-stock fees and volume" mono={false} />
            <KeyValue k="GET /api/activity" v="?limit=&token=&actor= · launches and swaps feed" mono={false} />
            <KeyValue k="POST /api/quote" v="{ token, side, amountIn } · exact-in quote from the v4 Quoter, including confirmed launches awaiting indexing" mono={false} />
            <KeyValue k="POST /api/metadata" v="multipart · pins image and ERC-7572 JSON to IPFS · with token, the name and symbol come from the launch record" mono={false} />
            <KeyValue k="GET /api/health" v="database, schema version, contracts, launch hooks no configured deployment covers, indexer lag, chain head · ok is false while the schema is behind this build or a launch hook is not configured" mono={false} />
            <KeyValue k="GET /api/region" v="whether the caller's country is one this interface refuses" mono={false} />
          </Section>

          <Section id="alerts">
            <p>
              A Telegram channel posts every launch, every large trade, every market cap milestone and every new high a token sets against its stock. It is fed by the indexer rather than by polling the API: a row is written into an outbox table inside the same database transaction that commits the swap it describes, so an announcement is exactly as durable as the fact behind it. A reorg deletes the unsent rows for the blocks it rolled back, so the channel cannot announce a trade that did not survive.
            </p>
            <p>
              A trade qualifies by clearing an absolute dollar floor <strong>or</strong> a share of that token&apos;s own 24-hour volume, because one threshold cannot serve a token doing $200 a day and one doing $20,000. Not every buy and not every sell: nobody can filter a shared channel, so one busy token posting each of its trades would bury every other. Milestones are recorded only after the post is actually delivered, so a failed send retries rather than silently skipping a level.
            </p>
            <p>
              A creator&apos;s buy at launch appears on the launch post rather than as a separate trade. Profile changes are not posted.
            </p>
          </Section>

          <Section id="stocks">
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

          <Section id="thresholds">
            <p>The limits this site applies before a wallet opens. Only the rows marked onchain are enforced by the contracts; anyone calling the contracts directly sets their own.</p>
            <div className="overflow-x-auto -mx-4 md:-mx-5">
              <table className="w-full text-[13px] min-w-[640px]">
                <thead>
                  <tr className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted">
                    <th className="text-left px-4 md:px-5 py-2 border-b border-line">Setting</th>
                    <th className="text-left px-2 py-2 border-b border-line">Range</th>
                    <th className="text-left px-2 pr-4 md:pr-5 py-2 border-b border-line">Behaviour</th>
                  </tr>
                </thead>
                <tbody>
                  {THRESHOLDS.map((t) => (
                    <tr key={t.setting} className="border-b border-line last:border-b-0 align-top">
                      <td className="px-4 md:px-5 py-2 font-medium text-ink">{t.setting}</td>
                      <td className="px-2 py-2 font-mono num text-[12px] text-ink">{t.range}</td>
                      <td className="px-2 pr-4 md:pr-5 py-2">{t.behaviour}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>

          <Section id="reference">
            <p>
              Selectors and topics of the newest factory, hook and router. The first deployment has the subset its factory and hook implement, with the same selectors. <code>PoolId</code> is <code>bytes32</code>; structs are ABI-encoded as tuples. A <code>PartialFill</code> revert reaches callers as the <code>reason</code> inside Uniswap&apos;s <code>WrappedError</code>.
            </p>
            <RefList title="Functions" items={FUNCTIONS} />
            <RefList title="Events" items={EVENTS} />
            <RefList title="Errors" items={ERRORS} />
          </Section>

          <Section id="security">
            <ul className="list-disc pl-5 flex flex-col gap-1">
              <li><strong>No custody.</strong> The site holds no keys and no funds. Fees live in the PoolManager as claims owned by the hook and booked per account.</li>
              <li><strong>No admin over tokens.</strong> Every token is created with the zero address as admin. {ZERO_ADMIN}</li>
              <li><strong>Bounded owner powers.</strong> The factory owner can only manage the stock registry and fee parameters within hard caps, and can set the hook once. The owner has no power over any launched token, its pool or its profile.</li>
              <li><strong>Nobody else trades inside a launch.</strong> On the newest factory the creation fee is paid before the pool is registered with the hook, and the hook rejects swaps in pools it does not know, so even a treasury contract cannot trade the new pool during the launch; the only swap inside a launch is the creator&apos;s own buy in <code>launchAndBuy</code>. The first factory registers the pool before it pays the treasury.</li>
              <li><strong>Launch checks.</strong> On the newest factory, <code>launchWithOptions</code> and <code>launchAndBuy</code> revert after their deadline and when the opening valuation changed after the creator reviewed it; a changed creation fee already fails the exact <code>msg.value</code> check.</li>
              <li><strong>Reentrancy and callbacks.</strong> The factory&apos;s launch and profile functions are <code>nonReentrant</code>; unlock callbacks accept calls only from the PoolManager.</li>
              <li><strong>Stale feeds rejected.</strong> A launch reverts when the stock&apos;s Chainlink reading is older than 7 days or not positive.</li>
              <li><strong>Confirmed data only.</strong> The indexer records blocks three confirmations deep and rolls back on reorgs. The single row the web app writes on a client&apos;s behalf is a creator&apos;s signed profile, and it is written only after the signature verifies against the launch creator.</li>
              <li><strong>Profiles are signed, not trusted.</strong> Off-chain profile edits, for fixed-profile tokens only, require an EIP-712 signature from the launch creator over the exact fields and image hash, with a 15-minute validity window and monotonic timestamps against replay. Onchain edits of an editable profile come only from the creator&apos;s own transaction.</li>
              <li><strong>Input validation.</strong> Every API parameter is schema-checked; addresses are checksummed and lower-cased; metadata uploads are limited to 2 MB images of four types and 1,000-character descriptions; X and Telegram links are normalised to <code>https://x.com/handle</code> and <code>https://t.me/handle</code>.</li>
              <li><strong>Trading safety.</strong> Quotes come from the v4 Quoter; swaps carry a minimum output from the user&apos;s slippage setting and a 10-minute deadline; the swap is simulated before the wallet opens. On the newest hook a swap that does not fill the stock amount it asked for reverts instead of paying a fee on the part that never traded.</li>
            </ul>
          </Section>
        </div>
      </div>
    </div>
  );
}
