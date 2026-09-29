import { json, error, serializable } from '@/lib/api.server';
import { TX_DEADLINE_SECONDS } from '@/lib/deadline';
import { publicEnv } from '@/lib/env';

export const dynamic = 'force-static';

/**
 * What a partner site needs to run a launch in its own UI: the deployment new launches go to, the
 * limits this site applies before it pins, and where a launched token lives here.
 *
 * Fee and opening valuation are not in it on purpose. `launchWithOptions` reverts unless both match
 * the chain at inclusion, so a partner reads them from the factory right before the wallet opens,
 * exactly as this site's own create form does.
 */
export function GET(): Response {
  const deployment = publicEnv.newest;
  if (!deployment) return error(503, 'NOT_CONFIGURED', 'Launchpad contracts are not configured.');
  return json(
    serializable({
      chainId: 8453,
      appUrl: publicEnv.appUrl,
      factory: deployment.factory,
      hook: deployment.hook,
      router: deployment.router,
      deployBlock: deployment.deployBlock,
      builderCode: publicEnv.builderCode,
      deadlineSeconds: Number(TX_DEADLINE_SECONDS),
      limits: {
        nameBytes: 64,
        symbolPattern: '^[A-Z0-9]{1,16}$',
        descriptionChars: 1_000,
        imageBytes: 2 * 1024 * 1024,
        imageTypes: ['image/png', 'image/webp', 'image/jpeg', 'image/gif'],
      },
      urls: {
        token: `${publicEnv.appUrl}/token/{address}`,
        create: `${publicEnv.appUrl}/create`,
        metadata: `${publicEnv.appUrl}/api/metadata`,
        stocks: `${publicEnv.appUrl}/api/stocks`,
        markets: `${publicEnv.appUrl}/api/markets`,
        region: `${publicEnv.appUrl}/api/region`,
      },
    }),
    200,
    { 'Cache-Control': 'public, max-age=300, s-maxage=300' },
  );
}
