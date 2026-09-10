import { describe, expect, it } from 'vitest';

import { buildProfileMessage, profileFieldsSchema, safeExternalUrl } from '@/lib/profile';

/**
 * Every field on a token profile is chosen by whoever paid the launch fee, and the token page
 * renders three of them as links. Two were already normalised to canonical x.com and t.me URLs. The
 * website was left to `z.url()`, which on zod 4.5.4 accepts `javascript:`, `data:` and `vbscript:`
 * because they are well-formed URLs: well-formed is the wrong test for something that becomes an
 * anchor under this brand's name.
 */
const HOSTILE = [
  'javascript:alert(document.domain)',
  'data:text/html,<script>alert(1)</script>',
  'vbscript:msgbox(1)',
  'file:///etc/passwd',
  'tg://resolve?domain=impostor',
];

describe('website field', () => {
  it.each(HOSTILE)('refuses %s', (value) => {
    expect(profileFieldsSchema.safeParse({ website: value }).success).toBe(false);
  });

  it('accepts an ordinary link, and an empty field', () => {
    for (const value of ['https://example.test/path?a=1', 'http://example.test']) {
      expect(profileFieldsSchema.safeParse({ website: value }).success).toBe(true);
    }
    expect(profileFieldsSchema.safeParse({ website: '' }).success).toBe(true);
  });
});

describe('buildProfileMessage', () => {
  const base = {
    token: `0x${'a'.repeat(40)}` as `0x${string}`,
    description: '',
    website: '',
    twitter: '',
    telegram: '',
    imageHash: `0x${'0'.repeat(64)}` as `0x${string}`,
    issuedAt: 1n,
  };

  it('refuses a hostile website before anything is signed or stored', () => {
    const built = buildProfileMessage({ ...base, website: 'javascript:alert(1)' });
    expect(built.error).not.toBeNull();
    expect(built.message).toBeNull();
  });

  it('still canonicalises the handles beside it', () => {
    const built = buildProfileMessage({ ...base, twitter: '@someone', telegram: 'somegroup' });
    expect(built.error).toBeNull();
    expect(built.message.twitter).toBe('https://x.com/someone');
    expect(built.message.telegram).toBe('https://t.me/somegroup');
  });
});

/**
 * The render-side guard exists because rows written before the rule still hold whatever they hold,
 * and because a future writer that forgets the schema should not be able to put a scheme on a page.
 */
describe('safeExternalUrl', () => {
  it.each(HOSTILE)('returns nothing for %s', (value) => {
    expect(safeExternalUrl(value)).toBeNull();
  });

  it('passes http and https through untouched', () => {
    expect(safeExternalUrl('https://example.test/a')).toBe('https://example.test/a');
    expect(safeExternalUrl('  http://example.test  ')).toBe('http://example.test');
  });

  it('returns nothing for an empty or missing value', () => {
    expect(safeExternalUrl('')).toBeNull();
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl(undefined)).toBeNull();
  });
});
