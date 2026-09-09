'use client';

import Link from 'next/link';
import { useEffect } from 'react';

import { Banner } from '@/components/ui/display';
import { Module } from '@/components/ui/primitives';

/**
 * Without a boundary here, one bad row takes a whole route down for everyone with a raw stack
 * trace. A token whose stored metadata cannot be parsed used to do exactly that, and the button
 * that would have fixed it lived on the page that crashed.
 */
export default function Error({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <Module ticks className="p-6 md:p-10 flex flex-col gap-4 items-start">
      <div className="eyebrow">Something broke on this page</div>
      <h1 className="display text-[28px] md:text-[36px] leading-none">This page could not be rendered.</h1>
      <p className="text-ink-secondary max-w-[60ch]">
        Nothing onchain is affected — your tokens, balances and fees are held by the contracts, not by this site. The
        rest of the launchpad is still working.
      </p>
      {error.digest && <Banner tone="neutral">Reference: {error.digest}</Banner>}
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={reset}
          className="inline-flex items-center justify-center h-11 px-4 rounded-[6px] bg-primary text-primary-contrast border border-primary-strong border-b-[3px] border-b-black/30 text-[15px] font-medium hover:brightness-[1.08] transition-fast"
        >
          Try again
        </button>
        <Link
          href="/markets"
          className="inline-flex items-center justify-center h-11 px-4 rounded-[6px] border border-line-strong border-b-[3px] text-[15px] font-medium hover:bg-surface transition-fast"
        >
          Back to markets
        </Link>
      </div>
    </Module>
  );
}
