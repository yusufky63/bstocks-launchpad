import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stockPairFactoryAbi, stockPairHookAbi, stockPairRouterAbi } from '@stockpair/core';
import { type Abi, type AbiEvent, type AbiFunction, toEventSelector, toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import { baseBlockDate, deploymentLabel, ERRORS, EVENTS, FUNCTIONS, type RefItem, type RefSource, THRESHOLDS, ZERO_ADMIN } from '@/app/docs/reference';
import { TX_DEADLINE_SECONDS } from '@/lib/deadline';
import {
  DEV_BUY_BLOCK_BPS,
  DEV_BUY_CONFIRM_BPS,
  DEV_BUY_NOTICE_BPS,
  DEV_TOLERANCE_DEFAULT_BPS,
  DEV_TOLERANCE_MAX_BPS,
  DEV_TOLERANCE_MIN_BPS,
  DEV_TOLERANCE_PRESETS_BPS,
} from '@/lib/launch';
import {
  DEFAULT_SLIPPAGE_BPS,
  IMPACT_SEVERE_PCT,
  IMPACT_WARN_PCT,
  SLIPPAGE_HIGH_BPS,
  SLIPPAGE_MAX_BPS,
  SLIPPAGE_MIN_BPS,
} from '@/lib/settings';

const ABIS: Record<Exclude<RefSource, 'external'>, Abi> = {
  factory: stockPairFactoryAbi as Abi,
  hook: stockPairHookAbi as Abi,
  router: stockPairRouterAbi as Abi,
};

const read = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

/** `name(a, b) payable returns (...)` -> name and the declared parameter count. */
function parse(display: string): { name: string; params: number; indexed: number } {
  const open = display.indexOf('(');
  const inner = display.slice(open + 1, display.indexOf(')', open));
  return {
    name: display.slice(0, open),
    params: inner.trim() === '' ? 0 : inner.split(',').length,
    indexed: inner.split(',').filter((p) => /\bindexed\b/u.test(p)).length,
  };
}

function abiItem(item: RefItem, type: 'function' | 'event' | 'error') {
  const { name } = parse(item.display);
  const found = (ABIS[item.source as Exclude<RefSource, 'external'>] ?? []).find((x) => x.type === type && 'name' in x && x.name === name);
  if (!found) throw new Error(`${item.contract} has no ${type} ${name}`);
  return found as AbiFunction | AbiEvent;
}

const errorSelector = (e: AbiFunction | AbiEvent) => toFunctionSelector({ ...e, type: 'function', outputs: [], stateMutability: 'view' } as AbiFunction);

describe('docs contract reference', () => {
  it('lists every function with the selector and arity of the built ABI', () => {
    for (const item of FUNCTIONS) {
      const fn = abiItem(item, 'function') as AbiFunction;
      expect(toFunctionSelector(fn), item.display).toBe(item.id);
      expect(parse(item.display).params, item.display).toBe(fn.inputs.length);
    }
  });

  it('lists every event with its topic, arity and indexed fields', () => {
    for (const item of EVENTS) {
      if (item.source === 'external') {
        expect(toEventSelector(item.signature!), item.display).toBe(item.id);
        continue;
      }
      const ev = abiItem(item, 'event') as AbiEvent;
      expect(toEventSelector(ev), item.display).toBe(item.id);
      expect(parse(item.display).params, item.display).toBe(ev.inputs.length);
      expect(parse(item.display).indexed, item.display).toBe(ev.inputs.filter((i) => i.indexed).length);
    }
  });

  it('lists every error with its selector', () => {
    for (const item of ERRORS) {
      if (item.source === 'external') {
        expect(toFunctionSelector(item.signature!), item.display).toBe(item.id);
        continue;
      }
      expect(errorSelector(abiItem(item, 'error')), item.display).toBe(item.id);
    }
  });

  it('keeps the selectors the spec and older integrations rely on', () => {
    const ids = new Map([...FUNCTIONS, ...EVENTS, ...ERRORS].map((i) => [parse(i.display).name, i.id]));
    expect(ids.get('launch')).toBe('0x28314fb2');
    expect(ids.get('launchWithOptions')).toBe('0x01499600');
    expect(ids.get('launchAndBuy')).toBe('0xd0150e4f');
    expect(ids.get('Launched')).toBe('0x545827070fae462314f8e79f25d99f8e713bf3cecb38728eb4c4804e1e20d0a6');
    expect(ids.get('PartialFill')).toBe('0xd964f528');
    expect(ids.get('WrappedError')).toBe('0x90bfb865');
  });

  it('leaves out no factory function anyone can send, and no event or custom error', () => {
    const documented = (items: readonly RefItem[], source: RefSource) =>
      new Set(items.filter((i) => i.source === source).map((i) => parse(i.display).name));
    // Library plumbing: ownership transfer, reentrancy, SafeERC20 and the hook base class.
    const plumbing = new Set(['unlockCallback', 'transferOwnership', 'acceptOwnership', 'renounceOwnership', 'OwnershipTransferred', 'OwnershipTransferStarted', 'OwnableInvalidOwner', 'OwnableUnauthorizedAccount', 'ReentrancyGuardReentrantCall', 'SafeERC20FailedOperation', 'HookNotImplemented', 'NotPoolManager']);
    const named = (abi: Abi, type: string, keep: (x: never) => boolean = () => true) =>
      abi.filter((x) => x.type === type && keep(x as never)).map((x) => (x as { name: string }).name).filter((n) => !plumbing.has(n));

    const sendable = named(ABIS.factory, 'function', (f: AbiFunction) => f.stateMutability !== 'view' && f.stateMutability !== 'pure');
    expect(sendable.filter((n) => !documented(FUNCTIONS, 'factory').has(n))).toEqual([]);
    for (const [source, abi] of Object.entries(ABIS) as Array<[RefSource, Abi]>) {
      expect(named(abi, 'event').filter((n) => !documented(EVENTS, source).has(n)), source).toEqual([]);
    }
    const errorNames = new Set(ERRORS.map((i) => parse(i.display).name));
    for (const abi of Object.values(ABIS)) expect(named(abi, 'error').filter((n) => !errorNames.has(n))).toEqual([]);
    // The router's errors share the factory's selectors; the page must say they come from both.
    for (const name of named(ABIS.router, 'error')) {
      expect(ERRORS.find((i) => parse(i.display).name === name)?.contract, name).toContain('StockPairRouter');
    }
  });
});

describe('deployment labels', () => {
  it('dates a deployment by the UTC day of its Base block', () => {
    expect(baseBlockDate(0n)).toBe('2023-06-15');
    // The first deployment: its record's block and the block its contracts landed in.
    expect(baseBlockDate(50_932_763n)).toBe('2026-09-06');
    expect(deploymentLabel({ deployBlock: 50_932_769n })).toBe('Deployed 2026-09-06');
  });

  it('claims no date when the deploy block is unknown', () => {
    expect(deploymentLabel({ deployBlock: 0n })).toBe('Deploy block not configured');
  });
});

describe('thresholds table', () => {
  // The table is written out for readers; these are the limits the site actually enforces.
  const pct = (bps: number) => `${bps / 100}%`;
  const row = (setting: string) => {
    const found = THRESHOLDS.find((t) => t.setting === setting);
    if (!found) throw new Error(`no thresholds row "${setting}"`);
    return found;
  };

  it('states the same limits as the constants the site enforces', () => {
    const slippage = row('Trade slippage');
    expect(slippage.range).toContain(`${pct(SLIPPAGE_MIN_BPS)} to ${pct(SLIPPAGE_MAX_BPS)}`);
    expect(slippage.range).toContain(`default ${pct(DEFAULT_SLIPPAGE_BPS)}`);
    expect(slippage.behaviour).toContain(`Amber from ${pct(SLIPPAGE_HIGH_BPS)}`);
    expect(row('Price impact').range).toBe(`amber from ${IMPACT_WARN_PCT}% · red from ${IMPACT_SEVERE_PCT}%`);
    const tolerance = row('Buy-at-launch tolerance').range;
    expect(tolerance).toContain(`${pct(DEV_TOLERANCE_MIN_BPS)} to ${pct(DEV_TOLERANCE_MAX_BPS)}`);
    expect(tolerance).toContain(`default ${pct(DEV_TOLERANCE_DEFAULT_BPS)}`);
    expect(tolerance).toContain(`presets ${DEV_TOLERANCE_PRESETS_BPS.map((b) => b / 100).join(', ')}%`);
    expect(row('Buy-at-launch share').range).toBe(
      `${pct(DEV_BUY_NOTICE_BPS)} amber · ${pct(DEV_BUY_CONFIRM_BPS)} red · ${pct(DEV_BUY_BLOCK_BPS)} blocked`,
    );
    expect(row('Deadline').range).toBe(`${Number(TX_DEADLINE_SECONDS) / 60} minutes`);
  });
});

describe('public copy', () => {
  const pages = {
    docs: read('../app/docs/page.tsx'),
    howItWorks: read('../app/how-it-works/page.tsx'),
    reference: read('../app/docs/reference.ts'),
    readme: read('../../../README.md'),
    staking: read('../../../docs/staking.md'),
  };

  it('says nothing about an anti-snipe window, which no hook has any more', () => {
    for (const [name, text] of Object.entries(pages)) {
      expect(text, name).not.toMatch(/anti-?snipe|snip(?:e|er|ers|ing)\b|99 ?%|\b20 ?(?:s|sec|seconds)\b|twenty seconds|decay/iu);
    }
  });

  it('uses the zero-admin wording wherever it says a token has no admin', () => {
    expect(pages.readme.replace(/\s+/gu, ' ')).toContain(ZERO_ADMIN);
    expect(pages.docs).toContain('{ZERO_ADMIN}');
    expect(pages.howItWorks).toContain('body: ZERO_ADMIN');
  });

  it('describes an editable profile link the way the factory checks it: ipfs:// and a bare CID', () => {
    // The factory refuses every byte after `ipfs://` that is not a letter or a digit.
    const factory = read('../../../packages/contracts/src/StockPairFactory.sol');
    expect(factory).toMatch(/for \(uint256 i = 7; i < length; \+\+i\) \{\s+if \(\(CID_CHARS >> uint8\(raw\[i\]\)\) & 1 == 0\) revert InvalidText\(\);/u);

    const docs = pages.docs.replace(/\s+/gu, ' ');
    expect(docs).toContain('accepts only <code>ipfs://</code> followed by a bare CID');
    expect(docs).toContain('v="ipfs:// and a bare CID only, at launch and on every update');
    expect(docs).not.toMatch(/starts with <code>ipfs:\/\/<\/code>|v="ipfs:\/\/ only/u);
    for (const name of ['updateContractURI', 'InvalidText']) {
      const item = [...FUNCTIONS, ...ERRORS].find((i) => i.source === 'factory' && parse(i.display).name === name);
      expect(item?.note, name).toContain('ipfs:// and a bare CID');
    }
    expect(pages.readme.replace(/\s+/gu, ' ')).toContain('`ipfs://` document named by a bare CID (letters and digits, no path)');
    // What a creator reads when the factory refuses the link.
    expect(read('../lib/launch.ts')).toContain('Editable profiles need an ipfs:// link to a bare CID, with no path.');
    expect(read('../components/token/onchain-profile.tsx')).toContain('it must be ipfs:// and a bare CID, with no path.');
  });

  it('says the README and the docs agree: the options only go to a factory that has them', () => {
    const readme = pages.readme.replace(/\s+/gu, ' ');
    expect(readme).not.toContain('always sends');
    expect(readme).toContain('While the newest factory it is configured with has only `launch`');
    expect(pages.docs.replace(/\s+/gu, ' ')).toContain('While the newest factory it is configured with has only <code>launch</code>');
  });

  it('names no deployment by version', () => {
    for (const [name, text] of Object.entries(pages)) expect(text, name).not.toMatch(/\bv[12]\b|\bV[12]\b/u);
  });
});
