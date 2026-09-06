const usdFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const compactFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

export function formatUsd(value: number | null | undefined, options: { compact?: boolean } = {}): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (options.compact && Math.abs(value) >= 1_000) return `$${compactFmt.format(value)}`;
  const abs = Math.abs(value);
  if (abs >= 1) return usdFmt.format(value);
  const digits = abs >= 0.01 ? 4 : abs >= 0.0001 ? 6 : 8;
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function formatUsdCompact(value: number | null | undefined): string {
  return formatUsd(value, { compact: true });
}

/** Formats a small ratio (stock per token) with enough significant digits to be meaningful. */
export function formatRatio(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (value === 0) return `0${unit ? ` ${unit}` : ''}`;
  const text = value >= 1 ? value.toFixed(4) : value.toPrecision(4);
  const normalized = Number(text) < 1e-6 ? Number(text).toExponential(3) : Number(text).toString();
  return `${normalized}${unit ? ` ${unit}` : ''}`;
}

export function formatNumber(value: number | null | undefined, maxFraction = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: maxFraction }).format(value);
}

export function formatCompact(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  if (Math.abs(value) < 1_000) return formatNumber(value, 0);
  return compactFmt.format(value);
}

export function formatPct(value: number | null | undefined, opts?: { sign?: boolean; digits?: number }): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const digits = opts?.digits ?? 2;
  const sign = opts?.sign === false ? '' : value > 0 ? '+' : '';
  return `${sign}${value.toFixed(digits)}%`;
}

/** Kept for existing callers; identical to formatPct with a sign. */
export function formatPercent(value: number | null | undefined): string {
  return formatPct(value);
}

export function bpsToPct(bps: number): string {
  const pct = bps / 100;
  return `${pct.toFixed(bps % 100 === 0 ? 0 : bps % 10 === 0 ? 1 : 2)}%`;
}

export function shortAddress(address: string, chars = 4): string {
  if (!address) return '';
  return `${address.slice(0, chars + 2)}…${address.slice(-chars)}`;
}

export function timeAgo(value: string | number | Date): string {
  const ms = value instanceof Date ? value.getTime() : typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : new Date(value).getTime();
  const diff = Math.max(0, Date.now() - ms);
  const s = Math.floor(diff / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

export function formatTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(iso));
}

export function formatDateTime(iso: string): string {
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }).format(new Date(iso)) + ' UTC';
}

/** Token amounts from raw units with a sensible number of fraction digits. */
export function formatTokenAmount(raw: bigint | string | null | undefined, decimals: number, maxFraction = 4): string {
  if (raw === null || raw === undefined) return '—';
  const n = Number(typeof raw === 'string' ? BigInt(raw) : raw) / 10 ** decimals;
  if (!Number.isFinite(n)) return '—';
  const digits = n === 0 ? 0 : n < 0.0001 ? 8 : n < 1 ? 6 : maxFraction;
  return n.toLocaleString('en-US', { maximumFractionDigits: digits });
}
