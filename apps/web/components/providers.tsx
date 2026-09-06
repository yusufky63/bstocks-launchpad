'use client';

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { type State, WagmiProvider } from 'wagmi';

import { ThemeProvider } from '@/components/layout/theme-provider';
import { BasenamesProvider } from '@/components/providers/basenames';
import { getWagmiConfig } from '@/lib/wagmi';

export function Providers({ children, initialState }: { children: ReactNode; initialState?: State | undefined }) {
  const [config] = useState(getWagmiConfig);
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1, staleTime: 10_000 } },
      }),
  );
  return (
    <WagmiProvider config={config} initialState={initialState} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <ThemeProvider>
          <BasenamesProvider>{children}</BasenamesProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
