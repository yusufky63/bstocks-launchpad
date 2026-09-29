'use client';

import { useEffect, useRef, type ReactNode } from 'react';

import { Wordmark } from '@/components/brand/logo';
import { EligibilityPolicyProvider } from '@/components/common/eligibility';
import { accentStylesheet, embedLinkAction, embedMessage, type EmbedEligibility, type EmbedMessage, type EmbedSection, type EmbedWidget } from '@/lib/embed';
import { publicEnv } from '@/lib/env';

import { EmbedSectionsProvider } from './embed-sections';

/** Tells the page that framed this widget. Nothing is sent when the widget is open on its own. */
export function postToHost(message: EmbedMessage): void {
  if (typeof window === 'undefined' || window.parent === window) return;
  window.parent.postMessage(embedMessage(message), '*');
}

/**
 * Frame for a widget: no header, ticker or nav, and a "powered by" line. Reports its height to the
 * host so the host can size the iframe to fit.
 *
 * The eligibility question is asked at the trade or launch button, not in a dialog on arrival as
 * the site does: a dialog is centred in the frame, and a frame grown to the create form's height
 * would put it out of the host page's view. `eligibility` is the host's choice of who is asked.
 *
 * `hide` and `accent` are the host's styling: sections left out, and a primary colour that replaces
 * the site's blue in every theme. The "powered by" line stays either way.
 */
export function EmbedShell({
  widget,
  eligibility = 'region',
  hide = [],
  accent = null,
  children,
}: {
  widget: EmbedWidget;
  eligibility?: EmbedEligibility;
  hide?: readonly EmbedSection[];
  accent?: string | null;
  children: ReactNode;
}) {
  const accentCss = accentStylesheet(accent);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    postToHost({ type: 'ready', widget });
    const el = ref.current;
    if (!el) return;
    // The content's own height, not the viewport's: a frame sized to the viewport would never shrink.
    let last = 0;
    const report = () => {
      const height = Math.ceil(el.getBoundingClientRect().height);
      if (height === 0 || height === last) return;
      last = height;
      postToHost({ type: 'resize', height });
    };
    // Once now, so the host can size the frame even before the observer's first delivery (which a
    // hidden tab postpones), then on every change.
    report();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [widget]);

  useEffect(() => {
    // A capture listener on window runs before React's listeners on the document, so a site link
    // (a Next <Link> included) opens a new tab instead of loading the full site inside the frame.
    const onClick = (event: MouseEvent) => {
      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest('a') : null;
      if (!anchor) return;
      if (embedLinkAction(anchor.getAttribute('href'), window.location.href, anchor.getAttribute('target')) !== 'new-tab') return;
      event.preventDefault();
      event.stopPropagation();
      window.open(anchor.href, '_blank', 'noopener,noreferrer');
    };
    window.addEventListener('click', onClick, true);
    return () => window.removeEventListener('click', onClick, true);
  }, []);

  return (
    <div ref={ref} className="mx-auto flex w-full max-w-[560px] flex-col p-2">
      {accentCss && <style dangerouslySetInnerHTML={{ __html: accentCss }} />}
      <EligibilityPolicyProvider policy={eligibility}>
        <EmbedSectionsProvider hide={hide}>{children}</EmbedSectionsProvider>
      </EligibilityPolicyProvider>
      <footer className="flex items-center justify-between gap-3 px-1 pt-2.5 text-[11px] text-ink-muted">
        <a href={publicEnv.appUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1.5 hover:text-ink transition-fast">
          Powered by <Wordmark size={11} />
        </a>
        <span className="font-mono uppercase tracking-[0.08em]">On Base</span>
      </footer>
    </div>
  );
}
