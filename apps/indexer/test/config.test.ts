import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

// Placeholders only: loadConfig is handed this object, never the process environment or a file.
const BASE = { DATABASE_URL: 'postgres://indexer@localhost/test', BASE_RPC_URL: 'https://rpc.invalid' };
const OLD = { factory: '0x00000000000000000000000000000000000000f1', hook: '0x00000000000000000000000000000000000000c4', router: '0x00000000000000000000000000000000000000e0', deployBlock: 1_000 };
const NEW = { factory: '0x00000000000000000000000000000000000000f2', hook: '0x00000000000000000000000000000000000000c5', router: '0x00000000000000000000000000000000000000e1', deployBlock: 2_000 };

describe('loadConfig', () => {
  it('indexes every listed deployment and treats the newest as the create target', () => {
    const config = loadConfig({ ...BASE, STOCKPAIR_DEPLOYMENTS: JSON.stringify([OLD, NEW]) });
    expect(config.deployments.map((d) => [d.factory, d.hook, d.deployBlock])).toEqual([
      [OLD.factory, OLD.hook, 1_000n],
      [NEW.factory, NEW.hook, 2_000n],
    ]);
    expect(config.deployment.factory).toBe(NEW.factory);
  });

  it('falls back to the single keys for one deployment', () => {
    const config = loadConfig({
      ...BASE,
      STOCKPAIR_FACTORY: OLD.factory,
      STOCKPAIR_HOOK: OLD.hook,
      STOCKPAIR_ROUTER: OLD.router,
      STOCKPAIR_DEPLOY_BLOCK: '1000',
    });
    expect(config.deployments).toHaveLength(1);
    expect(config.deployment).toMatchObject({ factory: OLD.factory, deployBlock: 1_000n });
  });

  it('refuses to start on a list it cannot trust, rather than index part of it', () => {
    const single = { STOCKPAIR_FACTORY: OLD.factory, STOCKPAIR_HOOK: OLD.hook, STOCKPAIR_ROUTER: OLD.router };
    for (const list of ['not json', JSON.stringify([NEW, OLD]), JSON.stringify([OLD, OLD])]) {
      // The single keys are no fallback for a broken list: that would quietly drop a deployment.
      expect(() => loadConfig({ ...BASE, ...single, STOCKPAIR_DEPLOYMENTS: list })).toThrow(/STOCKPAIR_DEPLOYMENTS/u);
    }
    expect(() => loadConfig(BASE)).toThrow(/STOCKPAIR_DEPLOYMENTS/u);
  });

  it('says which entry of a refused list is wrong', () => {
    expect(() => loadConfig({ ...BASE, STOCKPAIR_DEPLOYMENTS: JSON.stringify([NEW, OLD]) })).toThrow(
      /^Refusing to start: STOCKPAIR_DEPLOYMENTS\[1\] has deployBlock 1000, before the entry above it \(2000\)/u,
    );
    expect(() => loadConfig({ ...BASE, STOCKPAIR_DEPLOYMENTS: JSON.stringify([OLD, { ...NEW, hook: OLD.hook }]) })).toThrow(
      `STOCKPAIR_DEPLOYMENTS[1] repeats ${OLD.hook}`,
    );
  });
});
