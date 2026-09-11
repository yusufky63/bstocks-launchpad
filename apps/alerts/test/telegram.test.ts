import { describe, expect, it } from 'vitest';

import { Telegram } from '../src/telegram';

/** A clock and a sleep that cost nothing, so the pacing can be measured rather than waited out. */
function harness(responses: unknown[]) {
  let clock = 1_000_000;
  const slept: number[] = [];
  const bodies: Record<string, unknown>[] = [];
  const queue = [...responses];

  const fetchImpl = (async (_url: string, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    const next = queue.shift() ?? { ok: true, result: { message_id: bodies.length } };
    return { ok: true, status: 200, json: async () => next } as unknown as Response;
  }) as unknown as typeof fetch;

  const telegram = new Telegram(
    'x'.repeat(20),
    fetchImpl,
    async (ms: number) => {
      slept.push(ms);
      clock += ms;
    },
    () => clock,
  );
  return { telegram, slept, bodies, tick: (ms: number) => (clock += ms) };
}

describe('pacing', () => {
  // Telegram documents one message per second into a single chat. Eight queued posts fired
  // back to back is eight seconds of flood limit, and the 429 that ends it stalls everything
  // behind it.
  it('holds a gap between messages to the same chat', async () => {
    const { telegram, slept } = harness([]);
    await telegram.sendMessage('-100', 'first');
    await telegram.sendMessage('-100', 'second');
    await telegram.sendMessage('-100', 'third');

    expect(slept).toEqual([1_200, 1_200]);
  });

  it('does not wait when the last message is already old enough', async () => {
    const { telegram, slept, tick } = harness([]);
    await telegram.sendMessage('-100', 'first');
    tick(5_000);
    await telegram.sendMessage('-100', 'second');

    expect(slept).toEqual([]);
  });

  it('paces each chat on its own clock', async () => {
    const { telegram, slept } = harness([]);
    await telegram.sendMessage('-100', 'to the channel');
    await telegram.sendMessage('-200', 'to somewhere else');

    expect(slept).toEqual([]);
  });
});

describe('when Telegram pushes back', () => {
  // retry_after is the only number Telegram will tell you about its own limits.
  it('waits exactly as long as it was told, then tries once more', async () => {
    const { telegram, slept } = harness([
      { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 3 } },
      { ok: true, result: { message_id: 7 } },
    ]);

    const result = await telegram.sendMessage('-100', 'hello');
    expect(result).toEqual({ ok: true, messageId: 7 });
    expect(slept).toContain(4_000); // retry_after + 1
  });

  it('gives up rather than looping on a second 429', async () => {
    const { telegram } = harness([
      { ok: false, error_code: 429, parameters: { retry_after: 2 } },
      { ok: false, error_code: 429, description: 'still limited', parameters: { retry_after: 2 } },
    ]);

    const result = await telegram.sendMessage('-100', 'hello');
    expect(result).toMatchObject({ ok: false, retriable: true });
  });

  // A malformed post or a bot that is no longer an administrator fails identically every time;
  // retrying it forever would wedge the queue behind one row.
  it('marks a 400 and a 403 as not worth retrying', async () => {
    for (const code of [400, 403]) {
      const { telegram } = harness([{ ok: false, error_code: code, description: 'nope' }]);
      expect(await telegram.sendMessage('-100', 'hello')).toMatchObject({ ok: false, retriable: false });
    }
  });

  it('treats a network failure as worth another go', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const telegram = new Telegram('x'.repeat(20), fetchImpl, async () => undefined, () => 0);
    expect(await telegram.sendMessage('-100', 'hello')).toMatchObject({ ok: false, retriable: true });
  });
});

describe('the request it builds', () => {
  it('asks for HTML, keeps the buttons, and silences the preview by default', async () => {
    const { telegram, bodies } = harness([]);
    await telegram.sendMessage('-100', '<b>hi</b>', { buttons: [[{ text: 'Trade', url: 'https://x.test' }]] });

    expect(bodies[0]).toMatchObject({
      chat_id: '-100',
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: [[{ text: 'Trade', url: 'https://x.test' }]] },
    });
  });

  it('lets a page render its own card when one is named', async () => {
    const { telegram, bodies } = harness([]);
    await telegram.sendMessage('-100', 'hi', { preview: 'https://launchpad.basestocks.finance/token/0xb2' });

    expect(bodies[0]?.link_preview_options).toMatchObject({ url: 'https://launchpad.basestocks.finance/token/0xb2' });
  });

  it('never sends more than Telegram will accept', async () => {
    const { telegram, bodies } = harness([]);
    await telegram.sendMessage('-100', 'x'.repeat(5_000));

    expect(String(bodies[0]?.text)).toHaveLength(4_096);
  });
});
