'use client';

import { useQuery } from '@tanstack/react-query';

import { Badge } from '@/components/ui/primitives';
import { apiGet } from '@/lib/queries';
import type { DexPaidStatus } from '@/lib/dexscreener';

/** A third-party order status, separate from our token's onchain profile. */
export function DexPaid({ token }: { token: string }) {
  const { data } = useQuery<{ status: DexPaidStatus }>({
    queryKey: ['dex-paid', token.toLowerCase()],
    queryFn: () => apiGet(`/api/tokens/${token}/dex-paid`),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: false,
  });
  if (data?.status === 'approved') {
    return <Badge tone="positive" title="DEX Screener has approved a paid order for this token. This is separate from the onchain profile.">DEX paid</Badge>;
  }
  if (data?.status === 'pending') {
    return <Badge tone="warning" title="A DEX Screener paid order is processing or on hold.">DEX order pending</Badge>;
  }
  return null;
}