import 'server-only';

import { getAddress } from 'viem';
import { z } from 'zod';

const NO_STORE = { 'Cache-Control': 'no-store, max-age=0' } as const;

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers: { ...NO_STORE, ...headers } });
}

export function error(status: number, code: string, message: string): Response {
  return json({ error: { code, message } }, status);
}

export function parseAddressParam(value: string): `0x${string}` | null {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(value)) return null;
  try {
    return getAddress(value).toLowerCase() as `0x${string}`;
  } catch {
    return null;
  }
}

export const limitSchema = z.coerce.number().int().min(1).max(200).default(50);

/** Converts Date and bigint values so a row can be sent as JSON. */
export function serializable<T>(value: T): T {
  return JSON.parse(
    JSON.stringify(value, (_key, v) => {
      if (typeof v === 'bigint') return v.toString();
      return v;
    }),
  ) as T;
}
