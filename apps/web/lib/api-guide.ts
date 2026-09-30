/**
 * What another app needs to know to build on the API, written once and shown on the Widgets page and
 * in the docs: the conventions every route follows, and working examples of a trade and a launch.
 * Pure strings, so the client builder, the server pages and the tests all read the same text.
 */

export type ApiRule = Readonly<{ label: string; text: string }>;

/** The conventions every route follows; the docs and the Widgets page list them word for word. */
export function apiRules(appUrl: string): readonly ApiRule[] {
  return [
    { label: 'Base URL', text: `${appUrl}/api · JSON in and out · Base mainnet (8453) only` },
    { label: 'Keys', text: 'none · no API key and no login · the one cookie is the visitor\'s eligibility answer' },
    { label: 'Amounts', text: 'integer strings in the smallest unit: a stock has 8 decimals (1 NVDAc = 100000000), a launched token 18' },
    { label: 'Addresses', text: 'any case in, lowercase out' },
    { label: 'Errors', text: '{ error: { code, message, details? } } with a 4xx or 5xx status · 429 carries retry-after · 451 means the eligibility answer is missing' },
    { label: 'Signing', text: 'never on the server · /api/tx returns calls for the visitor\'s own wallet, which signs and sends them' },
    { label: 'From a browser', text: 'another site\'s page may call the API only when its origin is on the partner list · a server may call any route, but then the limits and the eligibility rule apply to the server, not to each visitor' },
  ];
}

/** A trade through the API: ask for the calls, then the visitor's wallet sends them in order. */
export function apiSwapExample(appUrl: string): string {
  return [
    '// 1. Ask for the calls. amountIn is in the input\'s smallest unit: the stock for a buy, the token for a sell.',
    `const res = await fetch('${appUrl}/api/tx/swap', {`,
    "  method: 'POST',",
    "  headers: { 'content-type': 'application/json' },",
    "  body: JSON.stringify({ token, side: 'buy', amountIn: '100000000', account, slippageBps: 100, builderCode: 'bc_yourcode' }),",
    '});',
    'const tx = await res.json();',
    'if (tx.error) throw new Error(tx.error.message);',
    '',
    '// 2. The visitor\'s wallet sends them in order: the approval first, when there is one.',
    '//    The deadline is ten minutes; if the approval takes longer, ask again before the swap.',
    'for (const call of tx.calls) {',
    '  const hash = await walletClient.sendTransaction({ account, to: call.to, data: call.data, value: BigInt(call.value) });',
    '  await publicClient.waitForTransactionReceipt({ hash });',
    '}',
  ].join('\n');
}

/** A launch through the API: pin the profile, ask for the calls, send them. The visitor is the creator. */
export function apiLaunchExample(appUrl: string): string {
  return [
    '// 1. Pin the image and profile to IPFS. The answer is the token\'s contractURI.',
    'const form = new FormData();',
    "form.set('name', 'My Token');",
    "form.set('symbol', 'MYT');",
    "form.set('description', 'What it is about');",
    "form.set('image', file);",
    `const { contractURI } = await (await fetch('${appUrl}/api/metadata', { method: 'POST', body: form })).json();`,
    '',
    '// 2. Ask for the launch calls. The account that sends them is the creator and earns 70% of every fee.',
    `const tx = await (await fetch('${appUrl}/api/tx/launch', {`,
    "  method: 'POST',",
    "  headers: { 'content-type': 'application/json' },",
    "  body: JSON.stringify({ account, name: 'My Token', symbol: 'MYT', contractURI, stock, builderCode: 'bc_yourcode' }),",
    '})).json();',
    '',
    '// 3. Send them in order, then open tx.tokenUrl. The token lands at tx.predictedToken.',
    'for (const call of tx.calls) {',
    '  const hash = await walletClient.sendTransaction({ account, to: call.to, data: call.data, value: BigInt(call.value) });',
    '  await publicClient.waitForTransactionReceipt({ hash });',
    '}',
  ].join('\n');
}
