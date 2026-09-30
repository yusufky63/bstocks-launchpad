import { BASE_STOCKS } from '@stockpair/core';

import { publicEnv } from './env';

/**
 * The API reference, as data. The /docs/api page, the OpenAPI spec, llms-full.txt and the "Try it"
 * requests are all built from this list, so none of them can describe a route differently from the
 * others; test/api-reference.test.ts checks it against the route files themselves.
 */

export type ApiGroupId = 'markets' | 'trading' | 'eligibility' | 'service';
export type ApiLimitScope = 'quote' | 'tx' | 'token' | 'wallet';

export type ApiParamType = 'address' | 'uint' | 'integer' | 'string' | 'enum' | 'boolean' | 'bytes32' | 'object' | 'file';

export type ApiParam = Readonly<{
  name: string;
  in: 'path' | 'query' | 'body' | 'form';
  type: ApiParamType;
  required: boolean;
  description: string;
  enum?: readonly string[];
  min?: number;
  max?: number;
  default?: string;
  /** What "Try it" and the curl line start with. */
  example?: string;
  /** Fields of an `object` parameter. */
  fields?: readonly ApiParam[];
}>;

export type ApiEndpoint = Readonly<{
  id: string;
  group: ApiGroupId;
  method: 'GET' | 'POST';
  /** OpenAPI style: `/api/tokens/{address}`. */
  path: string;
  summary: string;
  description: string;
  params: readonly ApiParam[];
  body?: 'json' | 'multipart';
  /** The shape of a 200, in one line. */
  returns: string;
  errors: readonly string[];
  /** Listed partner origins may call it from a browser. */
  partner: boolean;
  limit?: ApiLimitScope;
  /** Answers 451 from a restricted country until the visitor confirms eligibility. */
  eligibility?: boolean;
  /** Safe to run from the reference page: no pin, no cookie, no stored write. */
  tryable: boolean;
}>;

export const API_GROUPS: ReadonlyArray<Readonly<{ id: ApiGroupId; title: string; intro: string }>> = [
  { id: 'markets', title: 'Markets and tokens', intro: 'Read what the indexer recorded: tokens, prices, trades, candles, holders and wallets. Every figure comes from confirmed events or a live pool read.' },
  { id: 'trading', title: 'Trading and launching', intro: 'Quote a trade, pin a profile, and get the exact calls a wallet sends to trade or launch. Nothing here signs or sends a transaction.' },
  { id: 'eligibility', title: 'Eligibility', intro: 'Where the caller connects from, and the "not a US person" answer that quotes, pins and transaction builds wait for in a restricted country.' },
  { id: 'service', title: 'Service', intro: 'Health of the indexer and the database, and this reference in machine-readable form.' },
];

/** Values the reference starts every example with: real tokens, so "Try it" answers with real data. */
export const API_EXAMPLES = {
  token: publicEnv.featuredToken,
  stock: (BASE_STOCKS.find((s) => s.symbol === 'NVDAc') ?? BASE_STOCKS[0]!).address.toLowerCase(),
  account: '0x1111111111111111111111111111111111111111',
  contractURI: 'ipfs://bafkreibm6jg3ux5qumhcn2b3flc3tyu6dmlb4xa7u5bf44yegnrjhc4yeq',
} as const;

const ADDRESS_PATH: ApiParam = { name: 'address', in: 'path', type: 'address', required: true, description: 'The launched token.', example: API_EXAMPLES.token };
const TOKEN_ERRORS = ['400 INVALID_ADDRESS', '400 INVALID_QUERY', '404 TOKEN_NOT_FOUND', '429 RATE_LIMITED'] as const;
const BUILDER_CODE: ApiParam = { name: 'builderCode', in: 'body', type: 'string', required: false, description: 'Your ERC-8021 builder code. It goes on every call beside the launchpad\'s, so the transaction is attributed to both.' };

export const API_ENDPOINTS: readonly ApiEndpoint[] = [
  // Markets and tokens
  {
    id: 'markets',
    group: 'markets',
    method: 'GET',
    path: '/api/markets',
    summary: 'List markets',
    description: 'Every launched token with its price, FDV, 24-hour volume and change, newest first or by volume.',
    params: [
      { name: 'stock', in: 'query', type: 'address', required: false, description: 'Only tokens paired with this stock.' },
      { name: 'creator', in: 'query', type: 'address', required: false, description: 'Only tokens this address launched.' },
      { name: 'q', in: 'query', type: 'string', required: false, description: 'Search name or symbol, up to 64 characters.' },
      { name: 'limit', in: 'query', type: 'integer', required: false, min: 1, max: 200, default: '50', description: 'Rows to return.', example: '5' },
      { name: 'offset', in: 'query', type: 'integer', required: false, min: 0, max: 10_000, default: '0', description: 'Rows to skip.' },
      { name: 'orderBy', in: 'query', type: 'enum', required: false, enum: ['newest', 'volume24h'], default: 'newest', description: 'Sort order.' },
    ],
    returns: '{ markets: Market[], asOf } · asOf is when the indexer last advanced',
    errors: ['400 INVALID_QUERY', '400 INVALID_STOCK', '400 INVALID_CREATOR'],
    partner: true,
    tryable: true,
  },
  {
    id: 'stocks',
    group: 'markets',
    method: 'GET',
    path: '/api/stocks',
    summary: 'List quote stocks',
    description: 'The Coinbase tokenized stocks a token can pair with, with the latest Chainlink price, feed status and number of launches.',
    params: [],
    returns: '{ stocks: Stock[] }',
    errors: ['503 STOCKS_UNAVAILABLE'],
    partner: true,
    tryable: true,
  },
  {
    id: 'token',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}',
    summary: 'Get one token',
    description: 'The market row with fees, lifetime figures, pool reserves and links. A launch that is confirmed but not indexed yet answers status "indexing", read from its factory.',
    params: [ADDRESS_PATH],
    returns: '{ status: "indexed", market, details, launch, profile } | { status: "indexing", launch }',
    errors: [...TOKEN_ERRORS],
    partner: true,
    limit: 'token',
    tryable: true,
  },
  {
    id: 'swaps',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/swaps',
    summary: 'List trades',
    description: 'A token\'s swaps, newest first, with the creator\'s own trades flagged. Page back with the block and log index of the last row.',
    params: [
      ADDRESS_PATH,
      { name: 'limit', in: 'query', type: 'integer', required: false, min: 1, max: 200, default: '50', description: 'Rows to return.', example: '10' },
      { name: 'before', in: 'query', type: 'integer', required: false, description: 'Only swaps before this block.' },
      { name: 'beforeLog', in: 'query', type: 'integer', required: false, min: 0, description: 'With before: the log index within that block.' },
    ],
    returns: '{ token, stock, stockUsd, swaps: Swap[] }',
    errors: [...TOKEN_ERRORS],
    partner: true,
    limit: 'token',
    tryable: true,
  },
  {
    id: 'candles',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/candles',
    summary: 'Get candles',
    description: 'OHLCV in stock units per bucket, each with the stock\'s USD price that was live when it printed.',
    params: [
      ADDRESS_PATH,
      { name: 'bucket', in: 'query', type: 'enum', required: false, enum: ['1', '5', '15', '60', '240', '1440'], default: '1', description: 'Bucket width in minutes.', example: '60' },
      { name: 'from', in: 'query', type: 'string', required: false, description: 'ISO date: first bucket.' },
      { name: 'to', in: 'query', type: 'string', required: false, description: 'ISO date: last bucket.' },
      { name: 'limit', in: 'query', type: 'integer', required: false, min: 1, max: 2_000, default: '500', description: 'Buckets to return.', example: '24' },
    ],
    returns: '{ token, interval, quote: { symbol, usd }, candles: { time, open, high, low, close, volumeStock, volumeToken, trades, stockUsd }[] }',
    errors: [...TOKEN_ERRORS],
    partner: true,
    limit: 'token',
    tryable: true,
  },
  {
    id: 'holders',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/holders',
    summary: 'List holders',
    description: 'Balances ranked, with the pool, the creator and burned dust labelled, and how concentrated the supply is.',
    params: [ADDRESS_PATH, { name: 'limit', in: 'query', type: 'integer', required: false, min: 1, max: 500, default: '100', description: 'Rows to return.', example: '10' }],
    returns: '{ token, holderCount, concentration, holders: { rank, address, label, balance, sharePercent }[] }',
    errors: [...TOKEN_ERRORS],
    partner: true,
    limit: 'token',
    tryable: true,
  },
  {
    id: 'image',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/image',
    summary: 'Get the token image',
    description: 'The image bytes from this site\'s own origin, at most 5 MB. Link it with ?v= as the market row gives it: a matching v on an ipfs:// image is cached for good.',
    params: [ADDRESS_PATH, { name: 'v', in: 'query', type: 'string', required: false, description: 'First 12 hex of the image URI\'s sha256.' }],
    returns: 'image bytes',
    errors: ['400 INVALID_ADDRESS', '404 TOKEN_NOT_FOUND', '404 NO_IMAGE', '413 IMAGE_TOO_LARGE', '415 NOT_AN_IMAGE', '502 IMAGE_UNREACHABLE'],
    partner: false,
    tryable: false,
  },
  {
    id: 'dex-paid',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/dex-paid',
    summary: 'DEX Screener paid status',
    description: 'Whether the token has a paid DEX Screener profile: approved, pending, none or unavailable. Cached for five minutes; 20 calls a minute per caller.',
    params: [ADDRESS_PATH],
    returns: '{ status }',
    errors: ['400 INVALID_ADDRESS', '429 RATE_LIMITED'],
    partner: false,
    tryable: true,
  },
  {
    id: 'profile',
    group: 'markets',
    method: 'GET',
    path: '/api/tokens/{address}/profile',
    summary: 'Get the creator profile',
    description: 'The creator-signed profile of a fixed-profile token: description, image, website, X, Telegram. Null when the creator never signed one.',
    params: [ADDRESS_PATH],
    returns: '{ profile: { description, imageUri, website, twitter, telegram, signer, updatedAt } | null }',
    errors: ['400 INVALID_ADDRESS'],
    partner: false,
    tryable: true,
  },
  {
    id: 'profile-update',
    group: 'markets',
    method: 'POST',
    path: '/api/tokens/{address}/profile',
    summary: 'Update the creator profile',
    description: 'Multipart: a payload field with the EIP-712 TokenProfile the creator signed, and the image whose keccak256 it names. Stored only when the signer is the launch creator. A token with an editable profile changes it onchain instead (409).',
    params: [
      ADDRESS_PATH,
      { name: 'payload', in: 'form', type: 'string', required: true, description: 'JSON: signer, signature, description, website, twitter, telegram, imageHash, issuedAt.' },
      { name: 'image', in: 'form', type: 'file', required: false, description: 'The new image; its keccak256 must equal imageHash.' },
    ],
    body: 'multipart',
    returns: '{ ok: true, ... }',
    errors: ['400 INVALID_FORM', '400 INVALID_PAYLOAD', '400 INVALID_FIELDS', '409 ONCHAIN_PROFILE', '4xx from the signature check'],
    partner: false,
    tryable: false,
  },
  {
    id: 'wallet',
    group: 'markets',
    method: 'GET',
    path: '/api/wallet/{address}',
    summary: 'Get a wallet',
    description: 'What an address launched, holds, earned as a creator and can claim now, with its recent trades.',
    params: [{ name: 'address', in: 'path', type: 'address', required: true, description: 'Any wallet.', example: API_EXAMPLES.account }],
    returns: '{ wallet, created, holdings, holdingsUsd, claimable, claimableUsd, recentSwaps, ... }',
    errors: ['400 INVALID_ADDRESS', '429 RATE_LIMITED', '503 WALLET_UNAVAILABLE'],
    partner: true,
    limit: 'wallet',
    tryable: true,
  },
  {
    id: 'activity',
    group: 'markets',
    method: 'GET',
    path: '/api/activity',
    summary: 'Activity feed',
    description: 'Launches and swaps as one feed, newest first. Poll it to follow the launchpad; there is no webhook.',
    params: [
      { name: 'limit', in: 'query', type: 'integer', required: false, min: 1, max: 200, default: '50', description: 'Rows to return.', example: '10' },
      { name: 'token', in: 'query', type: 'address', required: false, description: 'Only this token.' },
      { name: 'actor', in: 'query', type: 'address', required: false, description: 'Only this trader or creator.' },
    ],
    returns: '{ items: { kind: "launch" | "swap", at, txHash, token, name, symbol, ... }[], asOf }',
    errors: ['400 INVALID_QUERY', '400 INVALID_TOKEN', '400 INVALID_ACTOR', '503 ACTIVITY_UNAVAILABLE'],
    partner: true,
    tryable: true,
  },
  {
    id: 'stats',
    group: 'markets',
    method: 'GET',
    path: '/api/stats',
    summary: 'Platform totals',
    description: 'Launches, traders, swaps, volume and fees, with the fees and volume per stock.',
    params: [],
    returns: '{ launches, creators, traders, swaps, holders, volumeUsd, feesUsd, volumeByStock, feesByStock, topCreators, asOf, ... }',
    errors: ['503 STATS_UNAVAILABLE'],
    partner: false,
    tryable: true,
  },
  {
    id: 'names',
    group: 'markets',
    method: 'GET',
    path: '/api/names',
    summary: 'Resolve Basenames',
    description: 'Base names for up to 100 addresses at once, memoised on the server.',
    params: [{ name: 'a', in: 'query', type: 'string', required: true, description: 'Comma-separated addresses.', example: API_EXAMPLES.account }],
    returns: '{ names: { [address]: name | null } }',
    errors: [],
    partner: false,
    tryable: true,
  },

  // Trading and launching
  {
    id: 'launch-config',
    group: 'trading',
    method: 'GET',
    path: '/api/launch-config',
    summary: 'Launch configuration',
    description: 'The factory, hook and router new launches use, the builder code, the deadline and the form limits. The creation fee and opening valuation are left out on purpose: read them from the factory right before the wallet opens, or let POST /api/tx/launch do it.',
    params: [],
    returns: '{ chainId, factory, hook, router, deployBlock, builderCode, deadlineSeconds, limits, urls }',
    errors: ['503 NOT_CONFIGURED'],
    partner: true,
    tryable: true,
  },
  {
    id: 'quote',
    group: 'trading',
    method: 'POST',
    path: '/api/quote',
    summary: 'Quote a trade',
    description: 'An exact-input quote from the Uniswap v4 Quoter against the token\'s own pool, including a launch that is confirmed but not indexed yet.',
    params: [
      { name: 'token', in: 'body', type: 'address', required: true, description: 'The launched token.', example: API_EXAMPLES.token },
      { name: 'side', in: 'body', type: 'enum', enum: ['buy', 'sell'], required: true, description: 'buy spends the stock, sell spends the token.', example: 'buy' },
      { name: 'amountIn', in: 'body', type: 'uint', required: true, description: 'Input in its smallest unit: 8 decimals for a stock, 18 for a token.', example: '100000000' },
    ],
    body: 'json',
    returns: '{ amountIn, amountOut, feeBps, midPrice, executionPrice, priceImpactPercent, poolKey, zeroForOne, gasEstimate, liquidity }',
    errors: ['400 INVALID_BODY', '404 TOKEN_NOT_FOUND', '409 NO_LIQUIDITY', '429 RATE_LIMITED', '451 REGION_RESTRICTED', '503 NOT_CONFIGURED'],
    partner: true,
    limit: 'quote',
    eligibility: true,
    tryable: true,
  },
  {
    id: 'tx-swap',
    group: 'trading',
    method: 'POST',
    path: '/api/tx/swap',
    summary: 'Build a swap',
    description: 'The calls for one exact-input trade, for the account that will send them: an approval of exactly amountIn to the token\'s router when the allowance is short, then swapExactIn with the minimum output and a ten-minute deadline. The swap is simulated when no approval is needed.',
    params: [
      { name: 'token', in: 'body', type: 'address', required: true, description: 'The launched token.', example: API_EXAMPLES.token },
      { name: 'side', in: 'body', type: 'enum', enum: ['buy', 'sell'], required: true, description: 'buy spends the stock, sell spends the token.', example: 'buy' },
      { name: 'amountIn', in: 'body', type: 'uint', required: true, description: 'Input in its smallest unit.', example: '100000000' },
      { name: 'account', in: 'body', type: 'address', required: true, description: 'The wallet that sends the calls and pays the input.', example: API_EXAMPLES.account },
      { name: 'recipient', in: 'body', type: 'address', required: false, description: 'Who receives the output. Defaults to account.' },
      { name: 'slippageBps', in: 'body', type: 'integer', required: false, min: 10, max: 500, default: '100', description: 'Tolerance below the quote, in basis points.' },
      BUILDER_CODE,
    ],
    body: 'json',
    returns: '{ calls: { to, data, value, description }[], quote, approval, deadline, expiresAt, simulation, router, tokenIn, tokenOut }',
    errors: ['400 INVALID_BODY', '400 INVALID_AMOUNT', '404 TOKEN_NOT_FOUND', '409 NO_LIQUIDITY', '429 RATE_LIMITED', '451 REGION_RESTRICTED', '502 TX_FAILED', '503 NOT_CONFIGURED'],
    partner: true,
    limit: 'tx',
    eligibility: true,
    tryable: true,
  },
  {
    id: 'metadata',
    group: 'trading',
    method: 'POST',
    path: '/api/metadata',
    summary: 'Pin a token profile',
    description: 'Multipart: pins the image and the ERC-7572 document to IPFS and returns the contractURI a launch takes. With token, it pins a new profile for an editable token, keeping its name and symbol. 10 pins an hour per caller.',
    params: [
      { name: 'name', in: 'form', type: 'string', required: true, description: '1 to 64 characters.' },
      { name: 'symbol', in: 'form', type: 'string', required: true, description: 'A to Z and 0 to 9, up to 16.' },
      { name: 'description', in: 'form', type: 'string', required: false, description: 'Up to 1,000 characters.' },
      { name: 'website', in: 'form', type: 'string', required: false, description: 'An https link.' },
      { name: 'twitter', in: 'form', type: 'string', required: false, description: 'An X handle or x.com link.' },
      { name: 'telegram', in: 'form', type: 'string', required: false, description: 'A Telegram handle or t.me link.' },
      { name: 'image', in: 'form', type: 'file', required: false, description: 'PNG, WebP, JPEG or GIF, up to 2 MB.' },
      { name: 'token', in: 'form', type: 'address', required: false, description: 'An editable token to pin a new profile for.' },
    ],
    body: 'multipart',
    returns: '{ contractURI, imageUri, metadata }',
    errors: ['400 INVALID_FIELDS', '400 IMAGE_INVALID', '409 PROFILE_FIXED', '409 PROFILE_LOCKED', '429 RATE_LIMITED', '451 REGION_RESTRICTED', '502 UPLOAD_FAILED'],
    partner: true,
    eligibility: true,
    tryable: false,
  },
  {
    id: 'tx-launch',
    group: 'trading',
    method: 'POST',
    path: '/api/tx/launch',
    summary: 'Build a launch',
    description: 'The calls that launch a token from the account: an approval of exactly stockIn to the factory when a buy at launch needs one, then launchWithOptions or launchAndBuy with the creation fee as value. The account is the creator and earns 70% of every fee. Send the same salt to keep the same token address.',
    params: [
      { name: 'account', in: 'body', type: 'address', required: true, description: 'The creator\'s wallet, which sends the calls.', example: API_EXAMPLES.account },
      { name: 'name', in: 'body', type: 'string', required: true, description: '1 to 64 bytes.', example: 'Example Token' },
      { name: 'symbol', in: 'body', type: 'string', required: true, description: 'A to Z and 0 to 9, up to 16.', example: 'EXMPL' },
      { name: 'contractURI', in: 'body', type: 'string', required: true, description: 'ipfs://, as POST /api/metadata returns it.', example: API_EXAMPLES.contractURI },
      { name: 'stock', in: 'body', type: 'address', required: true, description: 'The stock it trades against.', example: API_EXAMPLES.stock },
      { name: 'metadataEditable', in: 'body', type: 'boolean', required: false, default: 'false', description: 'Let the creator point the token at a new profile later. Needs a bare-CID contractURI.' },
      { name: 'salt', in: 'body', type: 'bytes32', required: false, description: 'Fixes the token address; random when absent.' },
      {
        name: 'buy',
        in: 'body',
        type: 'object',
        required: false,
        description: 'A buy for the creator in the same transaction.',
        fields: [
          { name: 'stockIn', in: 'body', type: 'uint', required: true, description: 'Stock to spend, 8 decimals.' },
          { name: 'toleranceBps', in: 'body', type: 'integer', required: false, min: 50, max: 500, default: '200', description: 'How far the opening price may move before the launch reverts.' },
          { name: 'acknowledgeShare', in: 'body', type: 'boolean', required: false, description: 'Required once the buy is 15% of the supply or more.' },
        ],
      },
      BUILDER_CODE,
    ],
    body: 'json',
    returns: '{ calls, functionName, predictedToken, salt, creationFee, openingFdvUsd8, buy, approval, deadline, expiresAt, simulation, tokenUrl }',
    errors: ['400 INVALID_BODY', '400 UNKNOWN_STOCK', '409 STOCK_NOT_ENABLED', '409 BUY_TOO_LARGE', '409 SHARE_UNCONFIRMED', '409 SHARE_LIMIT', '429 RATE_LIMITED', '451 REGION_RESTRICTED', '502 TX_FAILED', '503 NOT_CONFIGURED'],
    partner: true,
    limit: 'tx',
    eligibility: true,
    tryable: true,
  },

  // Eligibility
  {
    id: 'region',
    group: 'eligibility',
    method: 'GET',
    path: '/api/region',
    summary: 'Where the caller is',
    description: 'The country the host reports, the mode, and whether quotes, pins and transaction builds wait for the eligibility answer.',
    params: [],
    returns: '{ country, blocked, mode, blockedCountry, attested, restricted }',
    errors: [],
    partner: true,
    tryable: true,
  },
  {
    id: 'region-confirm',
    group: 'eligibility',
    method: 'POST',
    path: '/api/region',
    summary: 'Give the eligibility answer',
    description: 'The visitor\'s own statement that they do not live in the United States and are not a US citizen or resident, kept as a cookie for 30 days. Refused from another site\'s page. A site that asks in its own UI sends x-bstocks-eligibility: confirmed on each request instead.',
    params: [{ name: 'confirm', in: 'body', type: 'boolean', required: true, description: 'true to confirm, false to withdraw.' }],
    body: 'json',
    returns: 'the same as GET, and a Set-Cookie',
    errors: ['400 INVALID_BODY', '403 CROSS_SITE'],
    partner: false,
    tryable: false,
  },

  // Service
  {
    id: 'health',
    group: 'service',
    method: 'GET',
    path: '/api/health',
    summary: 'Health',
    description: 'Database, schema version, contracts, indexer lag and chain head. ok is false while the schema is behind or a launch hook is not configured.',
    params: [],
    returns: '{ ok, database, schema, contracts, deployments, indexer, head }',
    errors: [],
    partner: true,
    tryable: true,
  },
  {
    id: 'openapi',
    group: 'service',
    method: 'GET',
    path: '/api/openapi.json',
    summary: 'OpenAPI spec',
    description: 'This reference as OpenAPI 3.1, for Swagger, Postman, code generators and AI agents. Any origin may fetch it.',
    params: [],
    returns: 'OpenAPI 3.1 document',
    errors: [],
    partner: true,
    tryable: false,
  },
];

export function endpointsIn(group: ApiGroupId): readonly ApiEndpoint[] {
  return API_ENDPOINTS.filter((e) => e.group === group);
}

/** The route file a path lives in, relative to app/: `/api/tokens/{address}` → `api/tokens/[address]/route.ts`. */
export function routeFileOf(path: string): string {
  return `${path.slice(1).replace(/\{(\w+)\}/gu, '[$1]')}/route.ts`;
}

export type ApiRequest = Readonly<{ method: 'GET' | 'POST'; url: string; headers: Record<string, string>; body?: string }>;

/** A form value turned into what the route expects in JSON. */
function jsonValue(param: ApiParam, raw: string): unknown {
  if (param.type === 'integer') return Number(raw);
  if (param.type === 'boolean') return raw === 'true';
  return raw;
}

/**
 * The request "Try it" sends and the curl line shows, from the values typed in (keyed by name, and
 * `parent.field` for an object's fields). Empty values are left out; path parameters are filled in.
 */
export function buildApiRequest(endpoint: ApiEndpoint, values: Record<string, string>, base = ''): ApiRequest {
  let path = endpoint.path;
  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  for (const param of endpoint.params) {
    if (param.type === 'object') {
      const nested: Record<string, unknown> = {};
      for (const field of param.fields ?? []) {
        const raw = values[`${param.name}.${field.name}`]?.trim() ?? '';
        if (raw !== '') nested[field.name] = jsonValue(field, raw);
      }
      if (Object.keys(nested).length > 0) body[param.name] = nested;
      continue;
    }
    const raw = values[param.name]?.trim() ?? '';
    if (param.in === 'path') path = path.replace(`{${param.name}}`, encodeURIComponent(raw));
    else if (raw === '') continue;
    else if (param.in === 'query') query.set(param.name, raw);
    else body[param.name] = jsonValue(param, raw);
  }
  const search = query.toString().replaceAll('%2C', ',');
  const url = `${base}${path}${search ? `?${search}` : ''}`;
  if (endpoint.method === 'GET') return { method: 'GET', url, headers: {} };
  return { method: 'POST', url, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

/** One curl line for a request, quoted for a POSIX shell. */
export function curlOf(request: ApiRequest): string {
  const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
  if (request.method === 'GET') return `curl ${quote(request.url)}`;
  const headers = Object.entries(request.headers).map(([k, v]) => ` \\\n  -H ${quote(`${k}: ${v}`)}`).join('');
  return `curl -X POST ${quote(request.url)}${headers}${request.body ? ` \\\n  -d ${quote(request.body)}` : ''}`;
}

/** The example values an endpoint's form starts with. */
export function exampleValues(endpoint: ApiEndpoint): Record<string, string> {
  const values: Record<string, string> = {};
  for (const param of endpoint.params) {
    if (param.example !== undefined) values[param.name] = param.example;
    for (const field of param.fields ?? []) if (field.example !== undefined) values[`${param.name}.${field.name}`] = field.example;
  }
  return values;
}

/** The curl example an endpoint shows: multipart routes get a form upload, the rest their example request. */
export function curlExample(endpoint: ApiEndpoint, appUrl: string): string {
  if (endpoint.body === 'multipart') {
    const url = `${appUrl}${endpoint.path.replace('{address}', API_EXAMPLES.token)}`;
    const fields = endpoint.params
      .filter((p) => p.in === 'form' && (p.required || p.type === 'file'))
      .map((p) => (p.type === 'file' ? ` \\\n  -F ${p.name}=@logo.png` : ` \\\n  -F '${p.name}=${p.name === 'payload' ? '{…signed…}' : p.name === 'symbol' ? 'EXMPL' : 'Example Token'}'`))
      .join('');
    return `curl -X POST '${url}'${fields}`;
  }
  return curlOf(buildApiRequest(endpoint, exampleValues(endpoint), appUrl));
}
