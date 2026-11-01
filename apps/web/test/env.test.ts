import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('keeps copied URL whitespace out of token image and IPFS addresses', async () => {
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ' https://launchpad.basestocks.finance/\n');
  vi.stubEnv('NEXT_PUBLIC_IPFS_GATEWAY', ' https://gateway.pinata.cloud/\r\n');
  vi.resetModules();
  const { publicEnv, ipfsToHttp } = await import('@/lib/env');
  expect(publicEnv.appUrl + '/api/tokens/example/image').toBe('https://launchpad.basestocks.finance/api/tokens/example/image');
  expect(ipfsToHttp('ipfs://example')).toBe('https://gateway.pinata.cloud/ipfs/example');
});

it('uses default URLs when the configuration contains only whitespace', async () => {
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('NEXT_PUBLIC_APP_URL', ' \n');
  vi.stubEnv('NEXT_PUBLIC_IPFS_GATEWAY', ' \n');
  vi.resetModules();
  const { publicEnv } = await import('@/lib/env');
  expect(publicEnv.appUrl).toBe('https://launchpad.basestocks.finance');
  expect(publicEnv.ipfsGateway).toBe('https://gateway.pinata.cloud');
});
it('trims connector identifiers before they reach WalletConnect requests', async () => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', ' example-project\n');
  vi.stubEnv('NEXT_PUBLIC_TELEGRAM_CHANNEL', ' https://t.me/example\n');
  vi.resetModules();
  const { publicEnv } = await import('@/lib/env');
  expect(publicEnv.walletConnectId).toBe('example-project');
  expect(publicEnv.telegramChannel).toBe('https://t.me/example');
});

it('never puts an RPC key in the browser bundle', async () => {
  // A key in a NEXT_PUBLIC_ variable is shipped to every visitor, who can then spend it.
  vi.stubEnv('NEXT_PUBLIC_ALCHEMY_API_KEY', 'example-key');
  vi.resetModules();
  const { publicEnv } = await import('@/lib/env');
  expect(JSON.stringify(publicEnv)).not.toContain('example-key');
  const { readFileSync } = await import('node:fs');
  const wagmi = readFileSync(new URL('../lib/wagmi.ts', import.meta.url), 'utf8');
  expect(wagmi).not.toMatch(/alchemy|infura|quiknode|NEXT_PUBLIC_[A-Z_]*(KEY|RPC)/iu);
});