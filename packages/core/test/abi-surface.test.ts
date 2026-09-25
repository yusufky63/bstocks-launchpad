import { toFunctionSelector, type AbiFunction, type AbiParameter } from 'viem';
import { describe, expect, it } from 'vitest';

import { stockPairFactoryAbi, stockPairHookAbi } from '../src/abi/stockpair';

/**
 * The factory holds METADATA_ROLE on every editable token, and the precompile would let that role
 * rename the token. Only the factory's own code stops it, so its write surface is pinned here: any
 * new state-changing function, and above all a generic call executor, must fail this test first.
 */

const functions = stockPairFactoryAbi.filter((item) => item.type === 'function') as unknown as readonly AbiFunction[];
const writes = functions.filter((f) => f.stateMutability !== 'view' && f.stateMutability !== 'pure');

/** Every parameter type, including the members of struct parameters. */
function types(params: readonly AbiParameter[]): string[] {
  return params.flatMap((p) => ('components' in p && p.components ? [p.type, ...types(p.components)] : [p.type]));
}

/** The canonical type of a parameter, with structs spelled out as tuples, as selectors hash it. */
function canonical(p: AbiParameter): string {
  if (!p.type.startsWith('tuple') || !('components' in p) || !p.components) return p.type;
  return `(${p.components.map(canonical).join(',')})${p.type.slice('tuple'.length)}`;
}

/** The 4-byte selector of a function or custom error, from the generated ABI. */
const selector = (name: string, abi: readonly unknown[] = stockPairFactoryAbi) => {
  const item = (abi as readonly (AbiFunction | { type: 'error'; name: string; inputs: readonly AbiParameter[] })[]).find(
    (i) => i.name === name && (i.type === 'function' || i.type === 'error'),
  );
  if (!item) throw new Error(`${name} is not in the ABI`);
  return toFunctionSelector(`${item.name}(${item.inputs.map(canonical).join(',')})`);
};

describe('the factory ABI surface', () => {
  it('has exactly the allowed state-changing functions', () => {
    expect(writes.map((f) => f.name).sort()).toEqual(
      [
        'launch',
        'launchWithOptions',
        'launchAndBuy',
        'updateContractURI',
        'lockMetadata',
        'unlockCallback',
        'setHook',
        'setTreasury',
        'setCreationFee',
        'setOpeningFdv',
        'addStock',
        'setStockEnabled',
        'transferOwnership',
        'acceptOwnership',
        'renounceOwnership',
      ].sort(),
    );
  });

  it('has no generic call path: no (address, bytes), no raw bytes outside the PoolManager callback', () => {
    for (const f of functions) {
      const inputs = types(f.inputs);
      expect(inputs, f.name).not.toEqual(['address', 'bytes']);
      if (f.name !== 'unlockCallback') {
        expect(inputs.filter((t) => t === 'bytes' || t === 'bytes[]'), f.name).toEqual([]);
      }
    }
    expect(types(functions.find((f) => f.name === 'unlockCallback')!.inputs)).toEqual(['bytes']);
  });

  it('has no execute, multicall or delegate of any kind', () => {
    for (const f of functions) expect(f.name, f.name).not.toMatch(/execute|multicall|delegate/iu);
  });

  it('keeps the selectors integrations and the web rely on', () => {
    expect(selector('launch')).toBe('0x28314fb2');
    expect(selector('launchWithOptions')).toBe('0x01499600');
    expect(selector('launchAndBuy')).toBe('0xd0150e4f');
    expect(selector('metadataStatus')).toBe('0x9ce0634d');
    expect(selector('updateContractURI')).toBe('0x6697392e');
    expect(selector('lockMetadata')).toBe('0x37d1df5f');
    expect(selector('Expired')).toBe('0x203d82d8');
    expect(selector('OpeningFdvChanged')).toBe('0x7156ad5e');
    expect(selector('ZeroAmount')).toBe('0x1f2a2005');
    expect(selector('TooLittleReceived')).toBe('0xc9f52c71');
    expect(selector('UnexpectedRoles')).toBe('0xa507f32b');
    expect(selector('MetadataNotEditable')).toBe('0x4a38a31a');
    expect(selector('NotCreator')).toBe('0x93687c0b');
    expect(selector('PartialFill', stockPairHookAbi)).toBe('0xd964f528');
  });

  it('no longer describes the removed anti-snipe window', () => {
    const names = stockPairHookAbi.map((item) => ('name' in item ? item.name : ''));
    expect(names).not.toContain('ANTI_SNIPE_SECONDS');
    expect(names).not.toContain('START_FEE_BPS');
    // The old hook answers the same selector, so fee reads work on both.
    expect(selector('currentFeeBps', stockPairHookAbi)).toBe(toFunctionSelector('currentFeeBps(bytes32)'));
  });
});
