import Link from 'next/link';

import { KeyValue, Module, ModuleHeader } from '@/components/ui/primitives';
import { apiLaunchExample, apiRules, apiSwapExample } from '@/lib/api-guide';
import { BSTOCKS_X_URL } from '@/lib/twitter';

import { CodeBlock } from './code-block';

/** The routes an integration starts from; the docs list every route. */
const ENDPOINTS: ReadonlyArray<readonly [string, string]> = [
  ['POST /api/tx/swap', 'the approve and swap calls for one trade, for the account that will send them'],
  ['POST /api/tx/launch', 'the approve and launch calls for a new token, with the address it will land at'],
  ['POST /api/quote', 'an exact-input quote from the live pool'],
  ['POST /api/metadata', 'pins the image and profile to IPFS and returns the contractURI a launch needs'],
  ['GET /api/launch-config', 'the factory, hook and router new launches use, the builder code and the form limits'],
  ['GET /api/markets', 'the token list · GET /api/tokens/:address with /swaps, /candles and /holders for one token'],
  ['GET /api/wallet/:address', 'what a wallet created, holds and can claim'],
];

type Limits = Readonly<{ quote: number; tx: number; token: number; wallet: number }>;

/**
 * The Widgets page's second half: the same trade and launch through the API, for a site that wants
 * its own interface instead of a frame.
 */
export function ApiGuide({ appUrl, limits }: { appUrl: string; limits: Limits }) {
  return (
    <Module ticks id="api" className="scroll-mt-24">
      <ModuleHeader index="API" title="Your own interface instead of a widget" />
      <div className="p-4 md:p-5 flex flex-col gap-5 text-[14px] text-ink-secondary leading-relaxed">
        <p className="max-w-[80ch]">
          Everything a widget does is one API call away. Your page asks for the transactions, the visitor&apos;s own wallet signs and sends them, and they go straight to the launchpad&apos;s contracts. Nothing is held for anyone, and the fees are the same as on this site: 1% of every trade, 70% of it to the token&apos;s creator.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <h3 className="eyebrow pb-1">Configuration</h3>
            {apiRules(appUrl).map((rule) => (
              <KeyValue key={rule.label} k={rule.label} v={rule.text} mono={false} />
            ))}
            <KeyValue k="Limits" v={`per caller, a minute: ${limits.quote} quotes, ${limits.tx} transaction builds, ${limits.token} token reads, ${limits.wallet} wallet reads`} mono={false} />
            <KeyValue k="Attribution" v="send builderCode and your ERC-8021 code goes on every call beside the launchpad's" mono={false} />
          </div>
          <div>
            <h3 className="eyebrow pb-1">Where to start</h3>
            {ENDPOINTS.map(([route, what]) => (
              <KeyValue key={route} k={<code className="font-mono text-[12px] text-ink">{route}</code>} v={what} mono={false} />
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <CodeBlock label="A trade" code={apiSwapExample(appUrl)} />
          <CodeBlock label="A launch" code={apiLaunchExample(appUrl)} />
        </div>

        <p className="text-[13px]">
          Calling from your visitors&apos; browsers keeps the limits and the eligibility question per visitor; that needs your site on the partner list, so{' '}
          <a href={BSTOCKS_X_URL} target="_blank" rel="noreferrer noopener" className="text-primary font-medium">
            ask BStocks on X
          </a>
          . Every field, response and error is in the{' '}
          <Link href="/docs#api" className="text-primary font-medium">
            API reference
          </Link>
          .
        </p>
      </div>
    </Module>
  );
}
