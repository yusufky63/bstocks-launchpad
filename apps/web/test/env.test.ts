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