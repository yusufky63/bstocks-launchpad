import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config';

const BASE = {
  DATABASE_URL: 'postgresql://user:do-not-print@db.example:5432/postgres',
  TELEGRAM_ALERTS_TOKEN: 'x'.repeat(40),
  TELEGRAM_ALERTS_CHANNEL_ID: '-1001234567890',
};

describe('the site address the posts link to', () => {
  it('defaults to the public site and drops a trailing slash', () => {
    expect(loadConfig(BASE)?.appUrl).toBe('https://launchpad.basestocks.finance');
    expect(loadConfig({ ...BASE, NEXT_PUBLIC_APP_URL: 'https://launchpad.basestocks.finance/' })?.appUrl).toBe(
      'https://launchpad.basestocks.finance',
    );
  });

  // A local .env copied onto the host once pointed the channel at localhost. Telegram refused the
  // buttons, the dispatcher took the 400 as final, and the backlog was marked dealt with unposted.
  it('refuses anything that is not public https, so a copied local value cannot burn the queue', () => {
    for (const bad of ['http://localhost:3000', 'https://localhost:3000', 'http://launchpad.basestocks.finance', 'https://127.0.0.1', 'not a url']) {
      expect(() => loadConfig({ ...BASE, NEXT_PUBLIC_APP_URL: bad }), bad).toThrow(/NEXT_PUBLIC_APP_URL|url/iu);
    }
  });

  it('is off, not broken, without a token and channel', () => {
    expect(loadConfig({ DATABASE_URL: BASE.DATABASE_URL })).toBeNull();
  });
});
