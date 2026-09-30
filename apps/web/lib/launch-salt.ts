'use client';

import { useCallback, useState } from 'react';
import type { Hex } from 'viem';

import { randomSalt } from './launch';

/**
 * One salt per form session. The predicted address the creator reviews depends on it, so it must
 * not change between renders or after a failed attempt; only a successful launch uses it up.
 */
export function useLaunchSalt(): readonly [Hex, () => void] {
  const [salt, setSalt] = useState(randomSalt);
  const renew = useCallback(() => setSalt(randomSalt()), []);
  return [salt, renew] as const;
}
