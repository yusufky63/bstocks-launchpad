'use client';

import { createContext, useCallback, useContext, type ReactNode } from 'react';

import type { EmbedSection } from '@/lib/embed';

const HiddenContext = createContext<readonly EmbedSection[]>([]);

/** The sections a widget's host left out (`?hide=`). Outside a widget nothing is hidden. */
export function EmbedSectionsProvider({ hide, children }: { hide: readonly EmbedSection[]; children: ReactNode }) {
  return <HiddenContext.Provider value={hide}>{children}</HiddenContext.Provider>;
}

export function useEmbedHidden(): (section: EmbedSection) => boolean {
  const hide = useContext(HiddenContext);
  return useCallback((section: EmbedSection) => hide.includes(section), [hide]);
}
