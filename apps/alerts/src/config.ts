import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';

import { z } from 'zod';

export type AlertsConfig = Readonly<{
  databaseUrl: string;
  botToken: string;
  channelId: string;
  appUrl: string;
  pollMs: number;
  /** A trade must clear this in USD before it is worth a post. */
  minTradeUsd: number;
  /** …or this share of the token's own 24h volume, whichever it reaches first. */
  minTradeShare: number;
  /** But never below this, however quiet the token's day was. */
  minTradeFloorUsd: number;
  /** Above this many postable alerts at once, they collapse into one summary. */
  backlogLimit: number;
  healthPort: number;
  dryRun: boolean;
}>;

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  TELEGRAM_ALERTS_TOKEN: z.string().min(20),
  // A channel is addressed by its numeric id, which survives a rename; @name works for a public
  // channel but stops working the moment somebody changes it.
  TELEGRAM_ALERTS_CHANNEL_ID: z.string().min(1),
  NEXT_PUBLIC_APP_URL: z.string().url().default('https://launchpad.basestocks.finance'),
  ALERTS_POLL_MS: z.coerce.number().int().min(1_000).max(60_000).default(5_000),
  ALERTS_MIN_TRADE_USD: z.coerce.number().min(0).default(500),
  ALERTS_MIN_TRADE_SHARE: z.coerce.number().min(0).max(1).default(0.15),
  ALERTS_MIN_TRADE_FLOOR_USD: z.coerce.number().min(0).default(100),
  ALERTS_BACKLOG_LIMIT: z.coerce.number().int().min(1).max(200).default(8),
  ALERTS_HEALTH_PORT: z.coerce.number().int().min(1).max(65_535).default(8789),
  // Renders and logs every post without sending it. The way to watch what the channel would say
  // before pointing it at the channel.
  ALERTS_DRY_RUN: z
    .string()
    .optional()
    .transform((v) => v === 'true' || v === '1'),
});

export function loadEnvFiles(cwd = process.cwd()): void {
  for (const candidate of ['.env', '.env.local']) {
    const path = resolve(cwd, candidate);
    if (existsSync(path)) {
      try {
        process.loadEnvFile(path);
      } catch {
        // ignore parse issues; validation below reports what is missing
      }
    }
  }
}

/**
 * Returns null when the service is not configured, rather than throwing.
 *
 * A missing bot token means the channel is switched off, which is a normal state — during a
 * deploy, or on a machine that only runs the indexer. Throwing would turn "no channel today" into
 * a crash loop.
 */
export function loadConfig(env: Readonly<Record<string, string | undefined>> = process.env): AlertsConfig | null {
  if (!env.TELEGRAM_ALERTS_TOKEN || !env.TELEGRAM_ALERTS_CHANNEL_ID) return null;
  const parsed = schema.parse(env);
  return Object.freeze({
    databaseUrl: parsed.DATABASE_URL,
    botToken: parsed.TELEGRAM_ALERTS_TOKEN,
    channelId: parsed.TELEGRAM_ALERTS_CHANNEL_ID,
    appUrl: parsed.NEXT_PUBLIC_APP_URL.replace(/\/$/u, ''),
    pollMs: parsed.ALERTS_POLL_MS,
    minTradeUsd: parsed.ALERTS_MIN_TRADE_USD,
    minTradeShare: parsed.ALERTS_MIN_TRADE_SHARE,
    minTradeFloorUsd: parsed.ALERTS_MIN_TRADE_FLOOR_USD,
    backlogLimit: parsed.ALERTS_BACKLOG_LIMIT,
    healthPort: parsed.ALERTS_HEALTH_PORT,
    dryRun: parsed.ALERTS_DRY_RUN,
  });
}
