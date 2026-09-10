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

export class Telegram {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  async sendMessage(chatId: string, text: string, options: SendOptions = {}, attempt = 0): Promise<SendResult> {
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
    if (wait !== undefined && attempt === 0 && wait <= 60) {
      await this.sleep((wait + 1) * 1_000);
      return this.sendMessage(chatId, text, options, attempt + 1);
    }

    const reason = failure.description ?? `http ${response.status}`;
    // 400 and 403 are about this message or this chat and will fail again identically: a malformed
    // post, or a bot that is not an administrator of the channel any more. Retrying them forever
    // would wedge the queue behind one bad row.
    const retriable = failure.error_code !== 400 && failure.error_code !== 403;
    return { ok: false, retriable, reason };
  }
}
