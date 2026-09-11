/**
 * The three Bot API calls this service makes, and the one error it has to respect.
 *
 * No framework. grammY and telegraf both want to own the process loop and route incoming updates;
 * nothing talks to this bot, so all of that is weight. What is needed is a typed sendMessage and a
 * 429 that waits the number of seconds it was told to.
 */

export type InlineButton = { text: string; url: string };

export type SendOptions = {
  buttons?: InlineButton[][];
  /** The page whose share card should render under the post, or null for no preview at all. */
  preview?: string | null;
  silent?: boolean;
};

/** Telegram counts this in characters after entity parsing, not bytes. */
export const TEXT_LIMIT = 4_096;

type ApiError = {
  ok: false;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

export type SendResult = { ok: true; messageId: number } | { ok: false; retriable: boolean; reason: string };

/**
 * Telegram documents one message per second into a single chat, twenty per minute into a group,
 * and about thirty per second overall. It does not say which of those a channel is, so this takes
 * the stricter reading and leaves headroom on top.
 *
 * Waiting is cheaper than a 429: the retry costs a round trip, the `retry_after` it comes back
 * with is measured in seconds rather than milliseconds, and a second 429 stalls everything behind
 * it in the queue.
 */
const MIN_GAP_MS = 1_200;

export class Telegram {
  private lastSentAt = new Map<string, number>();
  /**
   * When a flood limit says come back later, this is later.
   *
   * A retry_after over a minute is too long to sit inside one send, so the call returns and the
   * dispatcher retries — five seconds afterwards, into the same flood limit, over and over. This
   * makes the next attempt fail immediately and locally instead of spending a request on it.
   */
  private cooldownUntil = new Map<string, number>();

  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
    private readonly now: () => number = () => Date.now(),
  ) {}

  /** Holds back until this chat's last message is far enough behind. */
  private async pace(chatId: string): Promise<void> {
    const last = this.lastSentAt.get(chatId);
    if (last !== undefined) {
      const wait = MIN_GAP_MS - (this.now() - last);
      if (wait > 0) await this.sleep(wait);
    }
    this.lastSentAt.set(chatId, this.now());
  }

  async sendMessage(chatId: string, text: string, options: SendOptions = {}, attempt = 0): Promise<SendResult> {
    const until = this.cooldownUntil.get(chatId);
    if (until !== undefined && this.now() < until) {
      return { ok: false, retriable: true, reason: `flood limit for another ${Math.ceil((until - this.now()) / 1_000)}s` };
    }
    // Only on the first try. A retry has already waited out the retry_after Telegram asked for.
    if (attempt === 0) await this.pace(chatId);
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text: text.slice(0, TEXT_LIMIT),
      parse_mode: 'HTML',
      link_preview_options: options.preview
        ? { url: options.preview, prefer_large_media: true }
        : { is_disabled: true },
    };
    if (options.buttons?.length) body.reply_markup = { inline_keyboard: options.buttons };
    if (options.silent) body.disable_notification = true;

    let response: Response;
    try {
      response = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      return { ok: false, retriable: true, reason: error instanceof Error ? error.message : 'network' };
    }

    const parsed = (await response.json().catch(() => null)) as { ok?: boolean; result?: { message_id: number } } | ApiError | null;
    if (parsed && 'ok' in parsed && parsed.ok === true && parsed.result) {
      return { ok: true, messageId: parsed.result.message_id };
    }

    const failure = (parsed ?? {}) as ApiError;
    // retry_after is a documented field on the error, and the only number Telegram will tell you
    // about its own limits. Waiting it out once is the whole flood strategy a single-chat sender
    // needs; a second 429 means something is wrong that sleeping will not fix.
    const wait = failure.parameters?.retry_after;
    if (wait !== undefined) {
      if (attempt === 0 && wait <= 60) {
        await this.sleep((wait + 1) * 1_000);
        return this.sendMessage(chatId, text, options, attempt + 1);
      }
      // Too long to hold a request open for, or a second one in a row. Remember it so the next
      // pass does not spend a request discovering the same limit.
      this.cooldownUntil.set(chatId, this.now() + (wait + 1) * 1_000);
    }

    const reason = failure.description ?? `http ${response.status}`;
    // 400 and 403 are about this message or this chat and will fail again identically: a malformed
    // post, or a bot that is not an administrator of the channel any more. Retrying them forever
    // would wedge the queue behind one bad row.
    const retriable = failure.error_code !== 400 && failure.error_code !== 403;
    return { ok: false, retriable, reason };
  }
}
