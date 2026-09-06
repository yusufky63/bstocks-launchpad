import { type Address, type Hex, keccak256 } from 'viem';
import { z } from 'zod';

import { normalizeTwitter } from './twitter';

/**
 * Creator-signed token profile. The creator signs these exact fields (EIP-712); the server checks
 * the signer is the launch creator and stores the fields as an override for what the token page
 * shows. Nothing here touches the chain: name, symbol and supply stay immutable.
 */
export const PROFILE_DOMAIN = { name: 'StockPair', version: '1', chainId: 8453 } as const;

export const PROFILE_TYPES = {
  TokenProfile: [
    { name: 'token', type: 'address' },
    { name: 'description', type: 'string' },
    { name: 'website', type: 'string' },
    { name: 'twitter', type: 'string' },
    { name: 'telegram', type: 'string' },
    { name: 'imageHash', type: 'bytes32' },
    { name: 'issuedAt', type: 'uint256' },
  ],
} as const;

export type ProfileMessage = {
  token: Address;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  /** keccak256 of the new image bytes, or 0x00…00 when the image is unchanged. */
  imageHash: Hex;
  /** Unix seconds; must be within a few minutes of the server clock and newer than the stored profile. */
  issuedAt: bigint;
};

export const EMPTY_IMAGE_HASH = `0x${'0'.repeat(64)}` as Hex;
export const PROFILE_MAX_AGE_SECONDS = 15 * 60;

export const profileFieldsSchema = z.object({
  description: z.string().trim().max(1_000).default(''),
  website: z.string().trim().url().max(200).optional().or(z.literal('')),
  twitter: z.string().trim().max(60).optional().or(z.literal('')),
  telegram: z.string().trim().max(60).optional().or(z.literal('')),
});

/** Accepts @handle, handle, or a t.me / telegram.me link; returns the canonical t.me URL or null. */
export function normalizeTelegram(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  const url = trimmed.match(/^(?:https?:\/\/)?(?:www\.)?(?:t|telegram)\.me\/(\+?[A-Za-z0-9_]{4,64})\/?$/u);
  const handle = url ? url[1] : trimmed.replace(/^@/u, '');
  if (!handle || !/^\+?[A-Za-z0-9_]{4,64}$/u.test(handle)) return null;
  return `https://t.me/${handle}`;
}

export function telegramHandle(url: string): string {
  const tail = url.replace(/^https:\/\/t\.me\//u, '');
  return tail.startsWith('+') ? 'Telegram group' : `@${tail}`;
}

export function imageHashOf(bytes: ArrayBuffer | Uint8Array | null): Hex {
  if (!bytes) return EMPTY_IMAGE_HASH;
  return keccak256(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
}

/** The message the creator signs, with links already normalised so client and server agree byte for byte. */
export function buildProfileMessage(input: { token: Address; description: string; website: string; twitter: string; telegram: string; imageHash: Hex; issuedAt: bigint }): { message: ProfileMessage; error: string | null } {
  const parsed = profileFieldsSchema.safeParse({ description: input.description, website: input.website, twitter: input.twitter, telegram: input.telegram });
  if (!parsed.success) return { message: null as unknown as ProfileMessage, error: 'Check the description, website, X and Telegram fields.' };
  const twitter = parsed.data.twitter ? normalizeTwitter(parsed.data.twitter) : '';
  if (twitter === null) return { message: null as unknown as ProfileMessage, error: 'Use an X handle like @name or an x.com profile link.' };
  const telegram = parsed.data.telegram ? normalizeTelegram(parsed.data.telegram) : '';
  if (telegram === null) return { message: null as unknown as ProfileMessage, error: 'Use a Telegram handle like @name or a t.me link.' };
  return {
    message: {
      token: input.token.toLowerCase() as Address,
      description: parsed.data.description,
      website: parsed.data.website ?? '',
      twitter,
      telegram,
      imageHash: input.imageHash,
      issuedAt: input.issuedAt,
    },
    error: null,
  };
}
