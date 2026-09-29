import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/**
 * Widgets live inside other sites; search engines should find the pages they copy, not these.
 * The host's `?theme=` is applied before paint by the root layout's theme script.
 */
export const metadata: Metadata = { robots: { index: false, follow: false } };

export default function EmbedLayout({ children }: { children: ReactNode }) {
  return children;
}
