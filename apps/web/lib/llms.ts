import { BASE_STOCKS } from '@stockpair/core';

import { apiLaunchExample, apiRules, apiSwapExample } from './api-guide';
import { API_ENDPOINTS, API_GROUPS, curlExample, endpointsIn, type ApiParam } from './api-reference';
import { EMBED_MODULES, EMBED_SECTIONS } from './embed';
import { publicEnv } from './env';

/**
 * Plain-text descriptions for language models and agents (https://llmstxt.org): /llms.txt is the
 * short index, /llms-full.txt the whole API reference in one file. Both are built from the same
 * lists as the pages, so an assistant reads what a person reads.
 */

const SUMMARY =
  'BStocks Launchpad launches tokens on Base that trade against a Coinbase tokenized stock (NVDAc, TSLAc, AAPLc and the rest) in a permanently locked Uniswap v4 pool. Every token has a fixed supply of 1,000,000,000, opens at the same valuation priced from the stock\'s Chainlink feed, and has no admin. Every swap pays a 1% fee in the stock: 70% to the token\'s creator, 30% to the platform.';

export function llmsTxt(appUrl: string): string {
  return [
    '# BStocks Launchpad',
    '',
    `> ${SUMMARY}`,
    '',
    'Chain: Base mainnet (8453). The API needs no key. It never signs: /api/tx returns calls for the user\'s own wallet.',
    '',
    '## Docs',
    '',
    `- [How it works](${appUrl}/how-it-works): the mechanism in plain words`,
    `- [Technical docs](${appUrl}/docs): contracts, launch mechanics, fees, pricing, indexer, security`,
    `- [API reference](${appUrl}/docs/api): every endpoint with parameters, errors, curl and Try it`,
    `- [Widgets](${appUrl}/widgets): trade and create as iframes for another site`,
    '',
    '## For agents and tools',
    '',
    `- [Full API reference in one file](${appUrl}/llms-full.txt): conventions, endpoints, examples, contracts, widget options`,
    `- [OpenAPI 3.1 spec](${appUrl}/api/openapi.json): for Swagger, Postman, code generators and tool calling`,
    '',
    '## Optional',
    '',
    `- [Health](${appUrl}/api/health): indexer lag and deployed contracts`,
    `- [Markets](${appUrl}/api/markets): the token list as JSON`,
    '',
  ].join('\n');
}

function paramLine(p: ApiParam, indent = ''): string[] {
  const range = p.min !== undefined || p.max !== undefined ? ` ${p.min ?? ''}..${p.max ?? ''}` : '';
  const choices = p.enum ? ` one of ${p.enum.join(' | ')}` : '';
  const fallback = p.default !== undefined ? ` (default ${p.default})` : '';
  const line = `${indent}- \`${p.name}\` (${p.in}, ${p.type}${range}${choices}, ${p.required ? 'required' : 'optional'})${fallback}: ${p.description}`;
  return [line, ...(p.fields ?? []).flatMap((f) => paramLine(f, `${indent}  `))];
}

export function llmsFullTxt(appUrl: string, limits: Readonly<Record<string, number>>): string {
  const deployments = [...publicEnv.deployments].reverse();
  const lines: string[] = [
    '# BStocks Launchpad: full API reference',
    '',
    `> ${SUMMARY}`,
    '',
    '## Conventions',
    '',
    ...apiRules(appUrl).map((r) => `- ${r.label}: ${r.text}`),
    `- Limits per caller, a minute: ${limits.quote} quotes, ${limits.tx} transaction builds, ${limits.token} token reads, ${limits.wallet} wallet reads. Over the limit: 429 with retry-after.`,
    '- Eligibility: from a restricted country (the United States), POST /api/quote, /api/metadata and /api/tx/* answer 451 REGION_RESTRICTED until the visitor confirms they do not live in the United States and are not a US citizen or resident (POST /api/region, or the header `x-bstocks-eligibility: confirmed` sent after your own checkbox). Never send the header without asking.',
    '- Sending: hand every item of `calls` to the user\'s wallet in order (`to`, `data`, `value` as a decimal string of wei). An approval comes first when the allowance is short. The deadline is ten minutes; ask again if the approval took longer.',
    '',
    '## Quick start',
    '',
    '### A trade',
    '',
    '```js',
    apiSwapExample(appUrl),
    '```',
    '',
    '### A launch',
    '',
    '```js',
    apiLaunchExample(appUrl),
    '```',
    '',
  ];
  for (const group of API_GROUPS) {
    lines.push(`## ${group.title}`, '', group.intro, '');
    for (const e of endpointsIn(group.id)) {
      const tags = [e.partner ? 'partner browsers allowed' : 'same-origin in browsers', e.limit ? `${limits[e.limit]}/min per caller` : null, e.eligibility ? 'eligibility rule applies' : null].filter(Boolean).join(' · ');
      lines.push(`### ${e.method} ${e.path}`, '', `${e.summary}. ${e.description}`, '', `(${tags})`, '');
      if (e.params.length > 0) lines.push('Parameters:', '', ...e.params.flatMap((p) => paramLine(p)), '');
      lines.push(`Returns: ${e.returns}`, '');
      if (e.errors.length > 0) lines.push(`Errors: ${e.errors.join(', ')}`, '');
      lines.push('```sh', curlExample(e, appUrl), '```', '');
    }
  }
  lines.push(
    '## Contracts',
    '',
    'Each deployment is a factory, a hook and a router; every one stays live for its own tokens. New launches go to the newest. Trade a token through the router of the deployment that launched it (POST /api/tx/swap picks it).',
    '',
    ...deployments.flatMap((d, i) => [
      `- ${i === 0 ? 'Newest (takes launches)' : 'Earlier (its own tokens)'}: factory ${d.factory.toLowerCase()}, hook ${d.hook.toLowerCase()}, router ${d.router.toLowerCase()}`,
    ]),
    '',
    `Quote stocks (${BASE_STOCKS.length}): ${BASE_STOCKS.map((s) => `${s.symbol} ${s.address.toLowerCase()}`).join(', ')}`,
    '',
    '## Widgets',
    '',
    `- Trade: ${appUrl}/embed/trade/{token} · query: side=sell, show=${EMBED_MODULES.join(',')}, theme=light|dark, eligibility=always, accent=<hex>, hide=${EMBED_SECTIONS.trade.join(',')}`,
    `- Create: ${appUrl}/embed/create · query: stock=<address>, picker=select, theme, eligibility, accent, hide=${EMBED_SECTIONS.create.join(',')} (hide=stocks with stock fixes it)`,
    '- Events posted to the host page: { source: "bstocks-launchpad", type: "ready" | "resize" | "swap" | "launch" }. Verify a swap or launch onchain before rewarding it.',
    '',
    `Endpoints in this file: ${API_ENDPOINTS.length}.`,
    '',
  );
  return lines.join('\n');
}
