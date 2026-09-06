'use client';

import { X } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';

import { cx } from './primitives';

/**
 * Accessible sheet: native <dialog> (focus trap, Esc, backdrop), bottom sheet on mobile,
 * centered dialog on desktop. The only place a depth shadow is allowed.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  locked,
  footer,
  wide,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Prevent closing while a wallet action is in flight. */
  locked?: boolean;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      if (!locked) onClose();
    };
    el.addEventListener('cancel', onCancel);
    return () => el.removeEventListener('cancel', onCancel);
  }, [locked, onClose]);

  return (
    <dialog
      ref={ref}
      aria-labelledby="sheet-title"
      onClick={(e) => {
        if (e.target === ref.current && !locked) onClose();
      }}
      className={cx(
        'm-0 p-0 w-full bg-canvas text-ink border border-line',
        'fixed inset-x-0 bottom-0 top-auto max-h-[92dvh] rounded-t-[12px] max-w-none',
        'md:inset-0 md:m-auto md:rounded-[12px] md:max-h-[90vh] md:shadow-[0_24px_64px_rgba(10,11,13,0.25)]',
        wide ? 'md:max-w-[720px]' : 'md:max-w-[480px]',
        'open:anim-rise',
      )}
    >
      <div className="flex flex-col max-h-[92dvh] md:max-h-[90vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="sheet-title" className="display text-[20px]">
            {title}
          </h2>
          <button type="button" aria-label="Close" disabled={locked} onClick={onClose} className="h-11 w-11 -mr-3 inline-flex items-center justify-center rounded-[6px] text-ink-secondary hover:text-ink disabled:opacity-40">
            <X size={20} strokeWidth={1.75} />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 flex-1">{children}</div>
        {footer && <div className="px-5 py-4 border-t border-line bg-canvas [padding-bottom:max(16px,env(safe-area-inset-bottom))]">{footer}</div>}
      </div>
    </dialog>
  );
}

/**
 * Sticky sidebar without an inner scrollbar: sticks under the header while it fits, and when it
 * is taller than the viewport its top goes negative so the page scrolls it to its bottom edge.
 */
export function StickyPanel({ offset = 72, gap = 16, className, children }: { offset?: number; gap?: number; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let frame = 0;
    const update = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const h = el.offsetHeight;
        const vh = window.innerHeight;
        el.style.top = `${h + offset + gap > vh ? vh - h - gap : offset}px`;
      });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener('resize', update);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
      window.removeEventListener('resize', update);
    };
  }, [offset, gap]);
  return (
    <div ref={ref} className={cx('sticky self-start', className)} style={{ top: offset }}>
      {children}
    </div>
  );
}
