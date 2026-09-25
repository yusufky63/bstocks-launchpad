'use client';

import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { Chip, cx } from '@/components/ui/primitives';
import { bpsToPct } from '@/lib/format';
import { parseSlippageInput, slippageLevel, useSlippage } from '@/lib/settings';

const PRESETS_BPS = [50, 100, 300, 500];

/**
 * Slippage tolerance next to the quote: a compact pill with a popover of presets and a custom field.
 * A custom value outside 0.1–5% is shown as an error and not applied; the pill always shows what is.
 */
export function SlippageControl({ className }: { className?: string }) {
  const { slippageBps, setSlippageBps } = useSlippage();
  const [open, setOpen] = useState(false);
  const [custom, setCustom] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const pct = bpsToPct(slippageBps);
  const high = slippageLevel(slippageBps) === 'high';
  const isPreset = PRESETS_BPS.includes(slippageBps);

  return (
    <div ref={ref} className={cx('relative', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Slippage tolerance"
        className={cx('inline-flex items-center gap-1.5 h-9 px-2.5 rounded-[6px] border text-[12px] font-mono num transition-fast', open ? 'border-primary text-primary' : high ? 'border-warning-fg/60 text-warning-fg' : 'border-line text-ink-secondary hover:border-line-strong hover:text-ink')}
      >
        <SlidersHorizontal size={13} strokeWidth={1.75} /> {pct}
      </button>
      {open && (
        <div role="dialog" aria-label="Slippage tolerance" className="absolute right-0 top-[calc(100%+6px)] z-30 w-[272px] rounded-[8px] border border-line bg-canvas shadow-[0_8px_24px_rgba(0,0,0,0.12)] p-3 flex flex-col gap-2.5">
          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">Slippage tolerance</span>
            <span className={cx('font-mono num text-[12px]', high ? 'text-warning-fg' : 'text-ink')}>{pct}</span>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {PRESETS_BPS.map((b) => (
              <Chip
                key={b}
                active={slippageBps === b}
                onClick={() => {
                  setSlippageBps(b);
                  setCustom('');
                  setCustomError(null);
                }}
                className="h-8 min-h-[32px] px-2.5 text-[12px]"
              >
                {bpsToPct(b)}
              </Chip>
            ))}
            <label className={cx('flex items-center h-8 rounded-[6px] border px-2 gap-1 text-[12px] transition-fast focus-within:border-primary', customError ? 'border-danger' : isPreset ? 'border-line text-ink-secondary' : 'border-primary text-ink')}>
              <input
                inputMode="decimal"
                placeholder="Custom"
                aria-label="Custom slippage percent"
                aria-invalid={customError !== null}
                value={custom !== '' ? custom : isPreset ? '' : (slippageBps / 100).toString()}
                onChange={(e) => {
                  const v = e.target.value.replace(/[^0-9.]/gu, '');
                  setCustom(v);
                  if (v === '') {
                    setCustomError(null);
                    return;
                  }
                  const parsed = parseSlippageInput(v);
                  if ('error' in parsed) {
                    setCustomError(parsed.error);
                    return;
                  }
                  setCustomError(null);
                  setSlippageBps(parsed.bps);
                }}
                className="w-14 bg-transparent outline-none num placeholder:text-ink-muted"
              />
              <span>%</span>
            </label>
          </div>
          {customError && <p className="text-[12px] text-danger-fg">{customError} Still using {pct}.</p>}
          <p className="text-[11px] text-ink-muted leading-snug">The most the price may move against you between the quote and the swap. {high ? 'Three percent or more leaves room for a worse fill.' : 'One percent suits most pools here; fresh launches move fast.'}</p>
        </div>
      )}
    </div>
  );
}
