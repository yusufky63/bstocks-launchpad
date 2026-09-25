import type { Address } from 'viem';
import { describe, expect, it } from 'vitest';

import { ipfsToHttp, publicEnv } from '@/lib/env';
import { currentProfileImage } from '@/lib/profile-document.server';

const TOKEN = '0xb2000000000000000000000000000000000000bb' as Address;
const cid = (tag: string) => `bafy${tag}${'a'.repeat(55 - tag.length)}`;
const DOC = `ipfs://${cid('doc')}`;
const IMAGE = `ipfs://${cid('image')}`;

/** Gateway stand-in: the one document it knows, and a list of what was asked for. */
function gateway(body: string | null, status = 200) {
  const asked: string[] = [];
  const fetchImpl = (async (url: string) => {
    asked.push(url);
    if (body === null) throw new Error('gateway down');
    return new Response(body, { status });
  }) as typeof fetch;
  return { asked, fetchImpl };
}

describe('gateway links', () => {
  it('never lets an ipfs:// path climb out of its CID to a mutable /ipns/ name', () => {
    for (const uri of [`ipfs://${cid('x')}/../../ipns/k51`, 'ipfs://%2e%2e/ipns/example.com', 'ipfs://x/%2E%2E/%2e%2e/ipns/k51', 'ipfs://x/./a', 'ipfs://x\\..\\ipns\\k51', 'ipfs://..']) {
      expect(ipfsToHttp(uri), uri).toBeNull();
    }
    expect(ipfsToHttp(`ipfs://${cid('x')}`)).toBe(`${publicEnv.ipfsGateway}/ipfs/${cid('x')}`);
    expect(ipfsToHttp(`ipfs://${cid('x')}/logo.a..png`)).toBe(`${publicEnv.ipfsGateway}/ipfs/${cid('x')}/logo.a..png`);
    expect(ipfsToHttp('https://example.com/a.png')).toBe('https://example.com/a.png');
    expect(ipfsToHttp('http://example.com/a.png')).toBeNull();
  });
});

describe("an editable token's current image", () => {
  it('is read from the document the token points at onchain', async () => {
    const g = gateway(JSON.stringify({ name: 'X', image: IMAGE }));
    expect(await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: g.fetchImpl })).toEqual({ ok: true, image: IMAGE });
    expect(g.asked).toEqual([`${publicEnv.ipfsGateway}/ipfs/${cid('doc')}`]);
  });

  it('reads the same keys as the indexer, in the same order', async () => {
    const other = `ipfs://${cid('other')}`;
    const read = (doc: object) => currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway(JSON.stringify(doc)).fetchImpl });
    expect(await read({ image_url: IMAGE, imageUri: other })).toEqual({ ok: true, image: IMAGE });
    expect(await read({ imageUri: other })).toEqual({ ok: true, image: other });
    expect(await read({ name: 'no image', image: '  ' })).toEqual({ ok: true, image: null });
  });

  it('asks for an upload whenever the current image cannot be read or kept', async () => {
    const refused = [
      await currentProfileImage(TOKEN, { readContractUri: async () => { throw new Error('rpc down'); }, fetchImpl: gateway('{}').fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => 'https://example.com/meta.json', fetchImpl: gateway('{}').fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => `${DOC}/../../ipns/k51`, fetchImpl: gateway('{}').fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway(null).fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway('{}', 404).fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway('not json').fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway('["a"]').fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway(JSON.stringify({ image: 'https://example.com/logo.png' })).fetchImpl }),
      await currentProfileImage(TOKEN, { readContractUri: async () => DOC, fetchImpl: gateway(JSON.stringify({ image: `ipfs://${cid('dir')}/logo.png` })).fetchImpl }),
    ];
    for (const result of refused) expect(result).toMatchObject({ ok: false, code: 'IMAGE_REQUIRED' });
  });

  it('does not fetch a document that is not a bare CID', async () => {
    const g = gateway('{}');
    await currentProfileImage(TOKEN, { readContractUri: async () => `${DOC}/meta.json`, fetchImpl: g.fetchImpl });
    expect(g.asked).toEqual([]);
  });
});
