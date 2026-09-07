import { Attribution } from 'ox/erc8021';
import { describe, expect, it } from 'vitest';

import {
  attributionCapabilities,
  builderDataSuffix,
  getBuilderDataSuffix,
  isAttributionEnabled,
  withAttribution,
} from '@/lib/attribution';

/**
 * The suffix has to decode back to the same builder code the trading app registers, or the two
 * apps attribute to different places while looking identical from the outside.
 */
const BUILDER_CODE = 'bc_71vd6x2w';

describe('Builder Code attribution (ERC-8021)', () => {
  it('ships a suffix that decodes back to the registered code', () => {
    const suffix = getBuilderDataSuffix();
    expect(suffix).not.toBeNull();
    expect(isAttributionEnabled()).toBe(true);
    expect(Attribution.fromData(suffix!)?.codes).toEqual([BUILDER_CODE]);
  });

  it('appends the suffix once and never twice', () => {
    const once = withAttribution('0xdeadbeef');
    expect(once.startsWith('0xdeadbeef')).toBe(true);
    expect(once.length).toBeGreaterThan('0xdeadbeef'.length);
    expect(withAttribution(once)).toBe(once);
  });

  it('leaves the original calldata untouched at the front', () => {
    const call = '0x095ea7b30000000000000000000000001111111111111111111111111111111111111111' as const;
    expect(withAttribution(call).startsWith(call)).toBe(true);
  });

  it('exposes the EIP-5792 dataSuffix capability as optional', () => {
    const caps = attributionCapabilities();
    expect('dataSuffix' in caps).toBe(true);
    if ('dataSuffix' in caps) {
      expect(caps.dataSuffix.optional).toBe(true);
      expect(caps.dataSuffix.value).toBe(getBuilderDataSuffix());
    }
  });

  it('hands writeContract the suffix in the shape viem takes', () => {
    expect(builderDataSuffix()).toBe(getBuilderDataSuffix() ?? undefined);
  });
});
