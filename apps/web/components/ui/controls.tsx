'use client';

import { ChevronDown } from 'lucide-react';
import { forwardRef, useId, useState, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from 'react';

import { cx } from './primitives';

/* ---------- Segmented control: one track, one sliding thumb ---------- */

export interface SegmentedOption<T extends string | number> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  tone?: 'default' | 'buy' | 'sell';
  title?: string;
}

export function Segmented<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  size = 'md',
  className,
}: {
  options: Array<SegmentedOption<T>>;
  value: T | null;
  onChange: (value: T) => void;
  ariaLabel: string;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const idx = options.findIndex((o) => o.value === value);
  const n = options.length;
  return (
    <div role="tablist" aria-label={ariaLabel} className={cx('relative grid p-1 rounded-[8px] bg-surface-muted', className)} style={{ gridTemplateColumns: `repeat(${n}, minmax(0, 1fr))` }}>
      {idx >= 0 && (
        <span
          aria-hidden
          className="absolute top-1 bottom-1 left-1 rounded-[6px] bg-canvas border border-line shadow-[0_1px_0_rgba(0,0,0,0.04)] transition-transform duration-200 ease-out motion-reduce:transition-none"
          style={{ width: `calc((100% - 0.5rem) / ${n})`, transform: `translateX(${idx * 100}%)` }}
        />
      )}
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={String(o.value)}
            type="button"
            role="tab"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={cx(
              'relative z-10 rounded-[6px] font-medium transition-colors duration-150 disabled:opacity-40 disabled:cursor-not-allowed',
              size === 'md' ? 'h-10 text-[13px] font-mono uppercase tracking-[0.12em]' : 'h-8 text-[12px] num',
              active ? (o.tone === 'sell' ? 'text-danger-fg' : o.tone === 'buy' ? 'text-primary' : 'text-ink') : 'text-ink-secondary hover:text-ink',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------- Text input ---------- */

export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'prefix'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  prefix?: ReactNode;
  suffix?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input({ label, hint, error, prefix, suffix, className, id, ...rest }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="block">
      {label && (
        <label htmlFor={inputId} className="block mb-1.5 text-[12px] font-mono uppercase tracking-[0.08em] text-ink-muted">
          {label}
        </label>
      )}
      <span className={cx('flex items-center h-12 rounded-[6px] border bg-canvas px-3 gap-2 transition-fast focus-within:border-primary', error ? 'border-danger' : 'border-line-strong', className)}>
        {prefix && <span className="text-ink-secondary shrink-0">{prefix}</span>}
        <input ref={ref} id={inputId} className="flex-1 min-w-0 bg-transparent outline-none text-[16px] placeholder:text-ink-muted" {...rest} />
        {suffix && <span className="text-ink-secondary shrink-0 text-[13px] font-mono">{suffix}</span>}
      </span>
      {error ? <span className="block mt-1.5 text-[13px] text-danger-fg">{error}</span> : hint ? <span className="block mt-1.5 text-[13px] text-ink-muted">{hint}</span> : null}
    </div>
  );
});

export interface TextAreaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea({ label, hint, error, className, id, ...rest }, ref) {
  const generated = useId();
  const inputId = id ?? generated;
  return (
    <div className="block">
      {label && (
        <label htmlFor={inputId} className="block mb-1.5 text-[12px] font-mono uppercase tracking-[0.08em] text-ink-muted">
          {label}
        </label>
      )}
      <textarea
        ref={ref}
        id={inputId}
        className={cx('block w-full min-h-[96px] rounded-[6px] border bg-canvas px-3 py-2.5 text-[15px] placeholder:text-ink-muted transition-fast focus:border-primary resize-y', error ? 'border-danger' : 'border-line-strong', className)}
        {...rest}
      />
      {error ? <span className="block mt-1.5 text-[13px] text-danger-fg">{error}</span> : hint ? <span className="block mt-1.5 text-[13px] text-ink-muted">{hint}</span> : null}
    </div>
  );
});

/** Large amount input: amount first, everything else second. */
export function AmountInput({
  value,
  onChange,
  unit,
  ariaLabel,
  autoFocus,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  unit: ReactNode;
  ariaLabel: string;
  autoFocus?: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-baseline gap-2 border-b border-line-strong focus-within:border-primary pb-2 transition-fast">
      <input
        aria-label={ariaLabel}
        inputMode="decimal"
        autoComplete="off"
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder="0"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/[^0-9.]/gu, '');
          if ((v.match(/\./gu) ?? []).length > 1) return;
          onChange(v);
        }}
        className="display num flex-1 min-w-0 bg-transparent outline-none text-[36px] md:text-[44px] leading-none placeholder:text-ink-muted disabled:opacity-50"
      />
      <span className="font-mono text-[14px] text-ink-secondary shrink-0">{unit}</span>
    </div>
  );
}

/* ---------- Slider ---------- */

export function Slider({
  value,
  min = 0,
  max = 100,
  step = 1,
  onChange,
  ariaLabel,
  disabled,
  className,
  marks,
  valueLabel,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
  disabled?: boolean;
  className?: string;
  marks?: string[];
  valueLabel?: string;
}) {
  const pct = max === min ? 0 : ((Math.min(max, Math.max(min, value)) - min) / (max - min)) * 100;
  return (
    <div className={cx('flex flex-col gap-1', className)}>
      <div className="flex items-center gap-3">
        <input
          type="range"
          className="slider flex-1"
          style={{ '--fill': `${pct}%` } as React.CSSProperties}
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          aria-label={ariaLabel}
          aria-valuetext={valueLabel}
          onChange={(e) => onChange(Number(e.target.value))}
        />
        {valueLabel !== undefined && <span className="font-mono num text-[12px] text-ink-secondary min-w-[52px] text-right">{valueLabel}</span>}
      </div>
      {marks && (
        <div className="flex justify-between font-mono text-[10px] uppercase tracking-[0.08em] text-ink-muted px-0.5" aria-hidden>
          {marks.map((m) => (
            <span key={m}>{m}</span>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- Collapsible ---------- */

export function Collapsible({ title, children, defaultOpen = false, className }: { title: ReactNode; children: ReactNode; defaultOpen?: boolean; className?: string }) {
  const [open, setOpen] = useState(defaultOpen);
  const id = useId();
  return (
    <div className={cx('border-t border-line', className)}>
      <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)} className="w-full min-h-[44px] flex items-center justify-between py-3 text-[13px] font-medium text-ink-secondary hover:text-ink">
        <span>{title}</span>
        <ChevronDown size={16} strokeWidth={1.75} className={cx('transition-fast transition-transform', open && 'rotate-180')} />
      </button>
      <div id={id} hidden={!open} className="pb-3 anim-fade">
        {children}
      </div>
    </div>
  );
}

/* ---------- Tabs (underline style) ---------- */

export function Tabs<T extends string>({ tabs, value, onChange, ariaLabel }: { tabs: Array<{ id: T; label: ReactNode }>; value: T; onChange: (id: T) => void; ariaLabel: string }) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="grid border-b border-line" style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}>
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          type="button"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'relative h-11 text-[12px] md:text-[13px] font-medium transition-fast',
            value === t.id ? 'text-primary after:absolute after:left-0 after:right-0 after:-bottom-px after:h-[2px] after:bg-primary' : 'text-ink-secondary hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/* ---------- Checkbox: a required acknowledgement ---------- */

export function Checkbox({ checked, onChange, children, className, disabled }: { checked: boolean; onChange: (checked: boolean) => void; children: ReactNode; className?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex items-start gap-2.5 text-[13px] cursor-pointer select-none', disabled && 'opacity-50 cursor-not-allowed', className)}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 shrink-0 accent-primary cursor-pointer disabled:cursor-not-allowed" />
      <span className="min-w-0">{children}</span>
    </label>
  );
}

/* ---------- Switch: an on/off setting that starts off ---------- */

export function Switch({ checked, onChange, label, disabled, id }: { checked: boolean; onChange: (checked: boolean) => void; label: string; disabled?: boolean; id?: string }) {
  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        'relative inline-flex h-6 w-10 shrink-0 items-center rounded-full border transition-fast disabled:opacity-40 disabled:cursor-not-allowed outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
        checked ? 'bg-primary border-primary-strong' : 'bg-surface-muted border-line-strong',
      )}
    >
      <span aria-hidden className={cx('inline-block h-4 w-4 rounded-full bg-canvas border border-line shadow-[0_1px_0_rgba(0,0,0,0.06)] transition-transform duration-150 motion-reduce:transition-none', checked ? 'translate-x-[19px]' : 'translate-x-[3px]')} />
    </button>
  );
}
