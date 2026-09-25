import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../', import.meta.url));
const read = (path: string) => readFileSync(join(root, path), 'utf8').replace(/\s+/gu, ' ');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(full);
    return /\.tsx?$/u.test(entry.name) ? [full] : [];
  });
}

describe('app copy', () => {
  // The docs and how-it-works pages have their own check in docs.test.ts.
  const files = ['app', 'components', 'lib']
    .flatMap((d) => sourceFiles(join(root, d)))
    .map((f) => relative(root, f).replaceAll('\\', '/'))
    .filter((f) => !f.startsWith('app/docs/') && !f.startsWith('app/how-it-works/'));

  it('says nothing about an anti-snipe window, which no hook has', () => {
    expect(files.length).toBeGreaterThan(40);
    for (const file of files) {
      expect(read(file), file).not.toMatch(/anti-?snipe|snip(?:e|er|ers|ing)\b|99 ?%|over 20 s\b/iu);
    }
  });

  it('names no deployment by version', () => {
    // URL path segments such as an RPC's /v2/ are not names.
    for (const file of files) expect(read(file), file).not.toMatch(/(?<![/.])\b[vV][12]\b(?![/.])/u);
  });

  it('keeps Buy at launch and the editable profile off, with the reviewed wording', () => {
    const form = read('components/create/create-form.tsx');
    expect(form).toContain('const [buyOn, setBuyOn] = useState(false);');
    expect(form).toContain('const [editable, setEditable] = useState(false);');
    expect(form).not.toMatch(/localStorage|sessionStorage/u);
    for (const text of [
      'Buy at launch (optional)',
      "Nobody can trade before this buy. If it can&apos;t complete, nothing is launched and you only pay gas.",
      'Nobody can trade before your buy. This tolerance only covers',
      'A price drop gives you fewer tokens, in steps of about 1%.',
      'Buyers will see that the creator bought',
      'and many traders avoid tokens like that.',
      'Buy at launch is limited to under 50% of supply on this site.',
      'Let me update the image, description and links later',
      'Leave this off unless you want the onchain profile itself to change later.',
      'you can still update the image, description and links this site shows by signing a message with this wallet (no gas)',
      'No approval step, unless you buy at launch: then you approve exactly that amount of',
    ]) {
      expect(form, text).toContain(text);
    }
    const sheet = read('components/create/launch-review-sheet.tsx');
    expect(sheet).toContain('One transaction. If any part fails, nothing is launched.');
    expect(sheet).toContain('for the BStocks launch factory. Only a launch you send yourself can use it.');
    // A fixed profile's site presentation can still be changed by signed message, so nothing says "forever".
    for (const [file, text] of [['create-form', form], ['launch-review-sheet', sheet]]) expect(text, file).not.toMatch(/fixed forever/iu);
    // The review pins once and hands every retry the same document.
    expect(sheet).toContain('pinOnce(pin)');
  });

  it('never promises a locked profile cannot change unless everything in it is content-addressed', () => {
    const records = read('components/token/token-records.tsx');
    expect(records).toContain('profile.contentAddressed ? `${on} It can never change again.`');
    const lock = read('components/token/onchain-profile.tsx');
    expect(lock).not.toContain('can ever change the image, description or links again');
    expect(lock).toContain('can ever point it at a different profile again');
  });

  it('labels the token page claimable figure as the one hook it reads', () => {
    const view = read('components/token/token-view.tsx');
    expect(view).toContain('Creator claimable · {market.stock.symbol} on this hook');
    expect(view).not.toContain('Creator claimable · all');
  });

  it('warns about slippage and price impact in the words reviewed', () => {
    const review = read('components/trade/trade-review-sheet.tsx');
    expect(review).toContain('You accept as little as');
    expect(review).toContain('Very high price impact: this trade moves the price by');
    expect(review).toContain('I understand the price impact');
    expect(read('components/trade/trade-panel.tsx')).toContain('Anyone can launch a token here. Check the creator&apos;s holdings, the holders and a live sell quote before you buy.');
  });
});
