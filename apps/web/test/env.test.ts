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
it('trims connector identifiers before they reach RPC and WalletConnect requests', async () => {
  vi.stubEnv('NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID', ' example-project\n');
  vi.stubEnv('NEXT_PUBLIC_ALCHEMY_API_KEY', ' example-key\r\n');
  vi.stubEnv('NEXT_PUBLIC_TELEGRAM_CHANNEL', ' https://t.me/example\n');
  vi.resetModules();
  const { publicEnv } = await import('@/lib/env');
  expect(publicEnv.walletConnectId).toBe('example-project');
  expect(publicEnv.alchemyKey).toBe('example-key');
  expect(publicEnv.telegramChannel).toBe('https://t.me/example');
});