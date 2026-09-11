# Alerts

Posts what happens on the launchpad to one Telegram channel.

The indexer already sees every launch and every swap within seconds of the block. This service is
the outbound half: it reads what the indexer queued, decides what is worth saying, and says it.

## What it posts

| | |
| --- | --- |
| **New launch** | every one |
| **Large trade** | a trade that clears `ALERTS_MIN_TRADE_USD`, *or* is `ALERTS_MIN_TRADE_SHARE` of that token's own 24h volume while still clearing `ALERTS_MIN_TRADE_FLOOR_USD` |
| **Market cap milestone** | $10K, $25K, $50K, $100K, $250K, $500K, $1M — each once, ever |
| **New high** | when it beats the last one by at least 5% |

Not every buy and not every sell. Nobody can filter this channel: everyone gets the same feed and
the only control is leaving. $STOCK alone did 2,323 trades in its first five days, and posting them
would make the channel unreadable in a day — which is harder to undo than never having started.
Per-token trade alerts belong in a bot people subscribe to, not in a shared channel.

The thresholds exist because one number cannot serve both ends of the range. An absolute floor
alone means a token doing $200 a day is never heard from; a share of daily volume alone means the
first trade after a quiet night is always "significant". A trade qualifies by being large in
dollars **or** large relative to the day that token is having.

The share rule carries a floor of its own, because "20% of the day" on a token doing $5 a day is a
$1 trade. Large has to mean something to a reader, not only to the arithmetic.

## How it gets its work

The indexer writes an `alert_outbox` row inside the same transaction that commits the swap or
launch it describes (`apps/indexer/src/sync.ts`, just before the cursor write). So an announcement
is exactly as durable as the fact behind it: a rollback leaves none, a commit cannot lose one, and
there is no "since when" bookkeeping to get wrong. A reorg deletes the unsent ones, so the channel
never announces a trade that did not survive.

The indexer takes no view on what is worth posting. Deciding lives here, in the service that can be
redeployed without touching the chain sync, because thresholds are the setting most likely to be
wrong on the first try.

## Running it

```
pnpm --filter @stockpair/alerts dev
```

Set `ALERTS_DRY_RUN=true` to render and log every post without sending one. That is the way to
watch what the channel would say before pointing it at the channel.

| Variable | |
| --- | --- |
| `DATABASE_URL` | the same database the indexer writes |
| `TELEGRAM_ALERTS_TOKEN` | from BotFather |
| `TELEGRAM_ALERTS_CHANNEL_ID` | numeric, `-100…` for a channel |
| `NEXT_PUBLIC_APP_URL` | where the buttons point (default `https://launchpad.basestocks.finance`) |
| `ALERTS_MIN_TRADE_USD` | default `500` |
| `ALERTS_MIN_TRADE_SHARE` | default `0.15` |
| `ALERTS_MIN_TRADE_FLOOR_USD` | default `100`; the share rule never fires below this |
| `ALERTS_BACKLOG_LIMIT` | default `8`; above this a pass collapses into one summary |
| `ALERTS_POLL_MS` | default `5000` |
| `ALERTS_DRY_RUN` | `true` to send nothing |

With no `TELEGRAM_ALERTS_TOKEN` the service logs that it is disabled and exits. A machine that only
runs the indexer, or a deploy before the channel exists, is a normal state; throwing would turn
"no channel yet" into a restart loop.

The bot must be an **administrator** of the channel. Use the numeric id rather than `@name`: the
numeric id survives a rename.

## Deploying

A container, the same way the indexer runs. `docker build -f apps/alerts/Dockerfile .` from the
repository root. Unlike the indexer there is no single-instance requirement in principle — but two
copies would both drain the same outbox and double-post, so run one.

It is deliberately not on Vercel. A cron's best case is one run a minute, which is a long time for
a trade alert, and a serverless function cannot hold a queue across invocations: a `retry_after` of
30 seconds means paying for 30 seconds of wall time or dropping the message.

## Notes on Telegram

**HTML, not MarkdownV2.** MarkdownV2 asks for eighteen characters to be escaped under rules that
change with context, and one miss rejects the whole message with a 400 rather than mangling a word.
Token names come from whatever a creator typed and routinely carry `_`, `.` and `$`.

**Every button is a URL.** In a channel, a `callback_data` button that edits its message edits it
for every reader — one person tapping "Holders" would rewrite the post for everybody.

**The emoji bar is capped at 48.** The one open-source buy bot with real code uses one emoji per $10
with no ceiling, which draws a thousand of them for a $10,000 buy against a 4,096 character limit.
