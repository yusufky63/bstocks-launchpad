import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactElement } from 'react';
import { renderToString } from 'react-dom/server';
import { WagmiProvider, createConfig, custom } from 'wagmi';
import { base } from 'wagmi/chains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';
import type { Db } from '@stockpair/core/db';

const mocks = vi.hoisted(() => ({
  readContract: vi.fn(),
  deployment: {
    factory: '0x1111111111111111111111111111111111111111',
    hook: '0x2222222222222222222222222222222222222222',
    router: '0x3333333333333333333333333333333333333333',
    deployBlock: 1n,
  },
}));

vi.mock('@stockpair/core/db', async (importOriginal) => ({ ...(await importOriginal<typeof import('@stockpair/core/db')>()), readMarket: async () => null }));
vi.mock('@/lib/onchain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/onchain.server')>()),
  readLaunchOnchain: async (token: string) => ({ token, stock: BASE_STOCKS[0]!.address, factory: mocks.deployment.factory, hook: mocks.deployment.hook, creator: '0x4444444444444444444444444444444444444444', name: 'X', symbol: 'X', contractURI: '', launchedAt: new Date().toISOString(), openingSqrtPriceX96: (1n << 96n).toString(), stockUsd8: '23000000000' }),
}));
vi.mock('@/lib/chain.server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/chain.server')>()),
  serverDeployments: () => [mocks.deployment],
  serverDeployment: () => mocks.deployment,
  getPublicClient: () => ({
    readContract: mocks.readContract,
    simulateContract: async () => ({ result: [10n ** 21n, 200_000n] }),
    call: async () => ({ data: '0x' }),
    getBlock: async () => ({ timestamp: 1_900_000_000n }),
  }),
}));

import { EndpointCard } from '@/components/api/endpoint-card';
import { ApiGuide } from '@/components/widgets/api-guide';
import { POST as postQuote } from '@/app/api/quote/route';
import { POST as postLaunchTx } from '@/app/api/tx/launch/route';
import { POST as postSwapTx } from '@/app/api/tx/swap/route';
import { GET as getOpenApi } from '@/app/api/openapi.json/route';
import { GET as getLlms } from '@/app/llms.txt/route';
import { GET as getLlmsFull } from '@/app/llms-full.txt/route';
import { apiLaunchExample, apiRules, apiSwapExample } from '@/lib/api-guide';
import { API_ENDPOINTS, API_EXAMPLES, API_GROUPS, buildApiRequest, curlExample, curlOf, exampleValues, routeFileOf, type ApiEndpoint } from '@/lib/api-reference';
import { setDbForTests } from '@/lib/db.server';
import { publicEnv } from '@/lib/env';
import { poolKeyFor } from '@/lib/quote.server';
import { API_LIMITS, resetRateLimits } from '@/lib/rate-limit.server';

const APP = 'https://launchpad.basestocks.finance';
const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8');

/** Every route file under app/api with the HTTP methods it exports: `GET /api/tokens/{address}`. */
function servedRoutes(): string[] {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? walk(join(dir, entry.name)) : entry.name === 'route.ts' ? [join(dir, entry.name)] : []));
  return walk(join(root, 'app/api')).flatMap((file) => {
    const path = `/${relative(join(root, 'app'), file).replaceAll('\\', '/').replace(/\/route\.ts$/u, '').replace(/\[(\w+)\]/gu, '{$1}')}`;
    const source = readFileSync(file, 'utf8');
    return (['GET', 'POST'] as const).filter((m) => new RegExp(`export (?:async )?function ${m}\\b`, 'u').test(source)).map((m) => `${m} ${path}`);
  });
}

const byId = (id: string) => API_ENDPOINTS.find((e) => e.id === id)!;

describe('the API reference matches the routes', () => {
  it('describes every route the app serves, and nothing it does not', () => {
    const served = servedRoutes().sort();
    const described = API_ENDPOINTS.map((e) => `${e.method} ${e.path}`).sort();
    expect(served.length).toBeGreaterThan(20);
    expect(described).toEqual(served);
  });

  it('keeps ids unique and every group used', () => {
    expect(new Set(API_ENDPOINTS.map((e) => e.id)).size).toBe(API_ENDPOINTS.length);
    for (const group of API_GROUPS) expect(API_ENDPOINTS.some((e) => e.group === group.id), group.id).toBe(true);
  });

  it('names only parameters the route reads', () => {
    for (const e of API_ENDPOINTS) {
      const source = read(`app/${routeFileOf(e.path)}`);
      for (const p of e.params) {
        if (p.in === 'path') expect(e.path, `${e.id}.${p.name}`).toContain(`{${p.name}}`);
        else if (p.in === 'form') expect(source, `${e.id}.${p.name}`).toMatch(new RegExp(`get\\('${p.name}'\\)`, 'u'));
        else expect(source, `${e.id}.${p.name}`).toMatch(new RegExp(`\\b${p.name}\\b`, 'u'));
        for (const f of p.fields ?? []) expect(source, `${e.id}.${p.name}.${f.name}`).toMatch(new RegExp(`\\b${f.name}\\b`, 'u'));
      }
    }
  });

  it('tags limits, partner access and the eligibility rule the way the code applies them', () => {
    const proxy = read('proxy.ts');
    for (const e of API_ENDPOINTS) {
      const source = read(`app/${routeFileOf(e.path)}`);
      if (e.limit) expect(source, e.id).toContain(`limitCaller(request, '${e.limit}')`);
      if (e.eligibility) expect(['quote', 'metadata', 'tx-swap', 'tx-launch'], e.id).toContain(e.id);
    }
    expect(proxy).toContain('const RESTRICTED_WRITES = [/^\\/api\\/quote/, /^\\/api\\/metadata/, /^\\/api\\/tx\\//]');
  });
});

describe('Try it and curl', () => {
  it('fills the path, sends only what was typed, and types JSON values the way the route expects', () => {
    const swap = buildApiRequest(byId('tx-swap'), { token: '0xabc', side: 'buy', amountIn: '5', account: '0xdef', slippageBps: '200', recipient: '' }, APP);
    expect(swap).toEqual({ method: 'POST', url: `${APP}/api/tx/swap`, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: '0xabc', side: 'buy', amountIn: '5', account: '0xdef', slippageBps: 200 }) });
    const launch = buildApiRequest(byId('tx-launch'), { account: '0x1', metadataEditable: 'true', 'buy.stockIn': '100', 'buy.acknowledgeShare': 'false' });
    expect(JSON.parse(launch.body!)).toEqual({ account: '0x1', metadataEditable: true, buy: { stockIn: '100', acknowledgeShare: false } });
    const holders = buildApiRequest(byId('holders'), { address: '0xaa', limit: '10' });
    expect(holders).toEqual({ method: 'GET', url: '/api/tokens/0xaa/holders?limit=10', headers: {} });
    expect(buildApiRequest(byId('names'), { a: '0x1,0x2' }).url).toBe('/api/names?a=0x1,0x2');
  });

  it('quotes curl lines safely for a shell', () => {
    expect(curlOf({ method: 'GET', url: `${APP}/api/stocks`, headers: {} })).toBe(`curl '${APP}/api/stocks'`);
    const post = curlOf({ method: 'POST', url: `${APP}/api/quote`, headers: { 'content-type': 'application/json' }, body: `{"name":"it's"}` });
    expect(post).toContain(`-d '{"name":"it'\\''s"}'`);
    expect(curlExample(byId('metadata'), APP)).toContain('-F image=@logo.png');
  });

  it('starts every runnable route with values that fill its required fields', () => {
    for (const e of API_ENDPOINTS.filter((x) => x.tryable)) {
      const values = exampleValues(e);
      for (const p of e.params.filter((x) => x.required && x.type !== 'object')) expect(values[p.name], `${e.id}.${p.name}`).toBeTruthy();
    }
    expect(API_EXAMPLES.token).toBe(publicEnv.featuredToken);
  });
});

describe('the example requests pass the routes they document', () => {
  beforeEach(() => {
    resetRateLimits();
    setDbForTests({} as Db);
    mocks.readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      const key = poolKeyFor(API_EXAMPLES.token, BASE_STOCKS[0]!.address, mocks.deployment.hook as `0x${string}`);
      const values: Record<string, unknown> = {
        poolKeyOf: key,
        getSlot0: [1n << 96n, 0, 0, 0],
        getLiquidity: 1000n,
        currentFeeBps: 100n,
        allowance: 0n,
        creationFee: 10n ** 14n,
        openingFdvUsd8: 500_000_000_000n,
        predictToken: '0x1111111111111111111111111111111111111112',
        stockInfo: { feed: '0x5555555555555555555555555555555555555555', enabled: true, decimals: 8, symbol: 'NVDAc' },
        metadataStatus: 0,
        previewOpening: [0n, -450_355, 23_000_000_000n],
      };
      if (!(functionName in values)) throw new Error(`unexpected read ${functionName}`);
      return values[functionName];
    });
  });

  const run = async (id: string, handler: (req: Request) => Promise<Response>) => {
    const request = buildApiRequest(byId(id), exampleValues(byId(id)), APP);
    return handler(new Request(request.url, { method: request.method, headers: request.headers, body: request.body }));
  };

  it('quote, swap and launch all answer 200 to their own example', async () => {
    for (const [id, handler] of [['quote', postQuote], ['tx-swap', postSwapTx], ['tx-launch', postLaunchTx]] as const) {
      const res = await run(id, handler);
      expect(res.status, `${id}: ${await res.clone().text()}`).toBe(200);
    }
  });

  it('the quick-start bodies use only fields the reference lists', () => {
    const keys = (example: string) =>
      (example.match(/JSON\.stringify\(\{ ([^}]*) \}\)/u)?.[1] ?? '').split(',').map((part) => part.split(':')[0]!.trim()).filter(Boolean);
    const names = (e: ApiEndpoint) => e.params.map((p) => p.name);
    for (const key of keys(apiSwapExample(APP))) expect(names(byId('tx-swap')), key).toContain(key);
    for (const key of keys(apiLaunchExample(APP))) expect(names(byId('tx-launch')), key).toContain(key);
    for (const field of [...apiLaunchExample(APP).matchAll(/form\.set\('(\w+)'/gu)].map((m) => m[1]!)) expect(names(byId('metadata')), field).toContain(field);
  });
});

describe('machine-readable versions', () => {
  it('publishes an OpenAPI 3.1 document with every route, any origin may read', async () => {
    const res = getOpenApi();
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
    const spec = (await res.json()) as { openapi: string; servers: { url: string }[]; paths: Record<string, Record<string, { operationId: string; parameters?: { name: string; in: string }[]; requestBody?: unknown }>> };
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0]!.url).toBe(publicEnv.appUrl);
    const ids = new Set<string>();
    for (const e of API_ENDPOINTS) {
      const op = spec.paths[e.path]?.[e.method.toLowerCase()];
      expect(op, `${e.method} ${e.path}`).toBeDefined();
      ids.add(op!.operationId);
      for (const name of [...e.path.matchAll(/\{(\w+)\}/gu)].map((m) => m[1])) {
        expect(op!.parameters?.some((p) => p.name === name && p.in === 'path'), `${e.id} declares ${name}`).toBe(true);
      }
      expect(Boolean(op!.requestBody), e.id).toBe(e.method === 'POST');
    }
    expect(ids.size).toBe(API_ENDPOINTS.length);
  });

  it('serves llms.txt as an index that points at the reference, the full text and the spec', async () => {
    const res = getLlms();
    expect(res.headers.get('content-type')).toContain('text/plain');
    const text = await res.text();
    expect(text.startsWith('# BStocks Launchpad\n\n> ')).toBe(true);
    for (const path of ['/docs/api', '/llms-full.txt', '/api/openapi.json', '/how-it-works', '/widgets']) expect(text).toContain(`${publicEnv.appUrl}${path}`);
  });

  it('serves the full reference as one text file with every endpoint, the limits and the contracts', async () => {
    const text = await getLlmsFull().text();
    for (const e of API_ENDPOINTS) expect(text, e.id).toContain(`### ${e.method} ${e.path}`);
    expect(text).toContain(`${API_LIMITS.quote} quotes, ${API_LIMITS.tx} transaction builds`);
    expect(text).toContain(`Quote stocks (${BASE_STOCKS.length})`);
    for (const d of publicEnv.deployments) expect(text).toContain(d.factory.toLowerCase());
    for (const rule of apiRules(publicEnv.appUrl)) expect(text).toContain(rule.text);
  });
});

/** Server-renders under a wagmi config whose transport refuses every request. */
function render(element: ReactElement): string {
  const config = createConfig({ chains: [base], connectors: [], transports: { [base.id]: custom({ request: async () => Promise.reject(new Error('no network in tests')) }) } });
  return renderToString(createElement(WagmiProvider, { config }, createElement(QueryClientProvider, { client: new QueryClient() }, element)))
    .replace(/<!-- -->/gu, '')
    .replace(/&#x27;/gu, "'")
    .replace(/&quot;/gu, '"');
}

describe('reference pages', () => {
  it('shows an endpoint with its tags, parameters, curl and a Try it button', () => {
    const html = render(createElement(EndpointCard, { endpoint: byId('tx-swap'), appUrl: APP, limitPerMinute: API_LIMITS.tx }));
    expect(html).toContain('id="tx-swap"');
    expect(html).toContain('>POST</span>');
    expect(html).toContain('/api/tx/swap');
    expect(html).toContain(`${API_LIMITS.tx}/min`);
    expect(html).toContain('eligibility');
    for (const p of byId('tx-swap').params) expect(html).toContain(p.name);
    expect(html).toContain(`curl -X POST '${APP}/api/tx/swap'`);
    expect(html).toContain('Try it');
  });

  it('says why a route cannot be run from the page', () => {
    expect(render(createElement(EndpointCard, { endpoint: byId('metadata'), appUrl: APP }))).toContain('Not runnable from this page');
  });

  it('is linked from the docs, the Widgets page, How it works and the footer', () => {
    const page = read('app/docs/api/page.tsx');
    expect(page).toContain('apiRules(appUrl)');
    expect(page).toContain('apiSwapExample(appUrl)');
    expect(page).toContain('<EndpointCard');
    expect(page).toContain("'/api/openapi.json'");
    const guide = render(createElement(ApiGuide));
    for (const href of ['/docs/api', '/docs/api#quick-start', '/api/openapi.json', '/llms.txt']) expect(guide).toContain(`href="${href}"`);
    expect(read('app/widgets/page.tsx')).toContain('<ApiGuide />');
    const howItWorks = read('app/how-it-works/page.tsx');
    expect(howItWorks).toContain('Is there an API for my own app or bot?');
    expect(howItWorks).toContain('href="/docs/api"');
    expect(read('components/layout/app-shell.tsx')).toContain("['/docs/api', 'API']");
    expect(existsSync(join(root, 'app/docs/api/page.tsx'))).toBe(true);
  });
});
