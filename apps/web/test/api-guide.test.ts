import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { BASE_STOCKS } from '@stockpair/core';

import { ApiGuide } from '@/components/widgets/api-guide';
import { apiLaunchExample, apiRules, apiSwapExample } from '@/lib/api-guide';
import { API_LIMITS } from '@/lib/rate-limit.server';

const APP = 'https://launchpad.basestocks.finance';
const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const flat = (text: string) => text.replace(/\s+/gu, ' ');

/** The keys of the first JSON.stringify({ … }) body in an example. */
function bodyKeys(example: string): string[] {
  const body = example.match(/JSON\.stringify\(\{ ([^}]*) \}\)/u)?.[1] ?? '';
  return body.split(',').map((part) => part.split(':')[0]!.trim()).filter(Boolean);
}

/** The field names a docs row lists for a route: `{ a, b?, c?: {...} }` → a, b, c. */
function documentedKeys(route: string): string[] {
  const docs = flat(read('../app/docs/page.tsx'));
  const row = docs.slice(docs.indexOf(`k="${route}"`));
  const fields = row.match(/v="\{ ([^·]*) \} ·/u)?.[1] ?? '';
  return [...fields.replace(/\{[^}]*\}/gu, '').matchAll(/(\w+)\??:?/gu)].map((m) => m[1]!);
}

describe('API guide', () => {
  it('states the unit sizes the stocks and launched tokens really have', () => {
    const amounts = apiRules(APP).find((rule) => rule.label === 'Amounts')!.text;
    expect(new Set(BASE_STOCKS.map((s) => s.decimals))).toEqual(new Set([8]));
    expect(amounts).toContain('a stock has 8 decimals (1 NVDAc = 100000000), a launched token 18');
    expect(apiRules(APP)[0]!.text).toContain(`${APP}/api`);
  });

  it('calls routes that exist, with fields the docs say they take', () => {
    for (const route of ['tx/swap', 'tx/launch', 'metadata']) {
      expect(existsSync(fileURLToPath(new URL(`../app/api/${route}/route.ts`, import.meta.url))), route).toBe(true);
    }
    expect(apiSwapExample(APP)).toContain(`'${APP}/api/tx/swap'`);
    expect(apiLaunchExample(APP)).toContain(`'${APP}/api/tx/launch'`);
    const swapKeys = documentedKeys('POST /api/tx/swap');
    expect(swapKeys).toContain('builderCode');
    for (const key of bodyKeys(apiSwapExample(APP))) expect(swapKeys, key).toContain(key);
    const launchKeys = documentedKeys('POST /api/tx/launch');
    for (const key of bodyKeys(apiLaunchExample(APP))) expect(launchKeys, key).toContain(key);
  });

  it('pins with the form fields the metadata route reads, and reads the field it returns', () => {
    const route = read('../app/api/metadata/route.ts');
    for (const field of [...apiLaunchExample(APP).matchAll(/form\.set\('(\w+)'/gu)].map((m) => m[1]!)) {
      expect(route, field).toContain(`form.get('${field}')`);
    }
    expect(read('../lib/pinata.server.ts')).toContain('return { contractURI:');
  });

  it('sends every call the builders return, value included', () => {
    for (const example of [apiSwapExample(APP), apiLaunchExample(APP)]) {
      expect(example).toContain('for (const call of tx.calls)');
      expect(example).toContain('value: BigInt(call.value)');
    }
  });

  it('shows the configuration, the limits and both examples on the Widgets page', () => {
    const html = renderToString(createElement(ApiGuide, { appUrl: APP, limits: API_LIMITS })).replace(/<!-- -->/gu, '').replace(/&#x27;/gu, "'");
    for (const rule of apiRules(APP)) expect(html).toContain(rule.label);
    expect(html).toContain(`${API_LIMITS.quote} quotes, ${API_LIMITS.tx} transaction builds, ${API_LIMITS.token} token reads, ${API_LIMITS.wallet} wallet reads`);
    expect(html).toContain('/api/tx/swap');
    expect(html).toContain('/api/tx/launch');
    expect(html).toContain('href="/docs#api"');
    expect(html).toContain('id="api"');
  });

  it('is written on the Widgets page, in the docs and on How it works', () => {
    expect(read('../app/widgets/page.tsx')).toContain('<ApiGuide appUrl={publicEnv.appUrl} limits={API_LIMITS} />');
    const docs = read('../app/docs/page.tsx');
    expect(docs).toContain('apiRules(publicEnv.appUrl)');
    expect(docs).toContain('apiSwapExample(publicEnv.appUrl)');
    expect(docs).toContain('apiLaunchExample(publicEnv.appUrl)');
    const howItWorks = read('../app/how-it-works/page.tsx');
    expect(howItWorks).toContain('Is there an API for my own app or bot?');
    expect(howItWorks).toContain('href="/widgets#api"');
  });
});
