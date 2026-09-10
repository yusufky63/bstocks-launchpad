import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/**
 * Base's own recipe is a `dataSuffix` on the wagmi config, so that no send site can be forgotten.
 * That does not reach a connected wallet in wagmi 3: `getConnectorClient` builds the wallet client
 * from account, chain, name and transport alone, and both `writeContract` and `sendTransaction`
 * forward only the parameters they were called with. A config-level suffix would land on the read
 * client and never on a transaction. So attribution is passed per call, and this guard stands in
 * for the config option: a new send site that forgets it fails here rather than shipping quietly.
 */
const SEND_CALLS = ['writeContractAsync(', 'writeContract(', 'sendTransaction(', 'sendCalls('];

/** The call's own argument text, from the opening bracket to its match. */
function argumentsOf(source: string, openIndex: number): string {
  let depth = 0;
  for (let i = openIndex; i < source.length; i++) {
    if (source[i] === '(') depth++;
    else if (source[i] === ')' && --depth === 0) return source.slice(openIndex, i + 1);
  }
  return source.slice(openIndex);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}

describe('every send site is attributed', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const files = ['app', 'components', 'lib'].flatMap((d) => sourceFiles(join(root, d)));

  it('finds the send sites it is meant to guard', () => {
    expect(files.length).toBeGreaterThan(20);
  });

  it.each(files.map((f) => relative(root, f)))('%s', (relativePath) => {
    const source = readFileSync(join(root, relativePath), 'utf8');
    if (relativePath.endsWith('attribution.ts')) return;
    for (const call of SEND_CALLS) {
      let at = source.indexOf(call);
      while (at !== -1) {
        const args = argumentsOf(source, at + call.length - 1);
        // A bare `writeContract(` also matches `useWriteContract(`; those take no transaction.
        const isHook = source.slice(Math.max(0, at - 3), at).endsWith('use');
        if (!isHook) {
          expect(args, `${relativePath}: ${call} sends without a Builder Code`).toMatch(
            /dataSuffix|withAttribution/u,
          );
        }
        at = source.indexOf(call, at + call.length);
      }
    }
  });
});
