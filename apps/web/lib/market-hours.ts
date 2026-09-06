/**
 * US equity regular session (NYSE/Nasdaq): Mon–Fri 09:30–16:00 America/New_York. Holidays are
 * not modelled; on one, "opens in" is early by a day and the feed's own freshness says the rest.
 */
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour12: false, weekday: 'short', hour: '2-digit', minute: '2-digit' });

export function isUsMarketOpen(at: Date = new Date()): boolean {
  const parts = fmt.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const weekday = get('weekday');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));
  const minutes = hour * 60 + minute;
  return minutes >= 9 * 60 + 30 && minutes < 16 * 60;
}

export interface SessionBoundary {
  open: boolean;
  /** When the current state ends: the close if open, the next open if closed. */
  at: Date;
}

/** When the regular session next opens or closes, walked forward in five-minute steps (at most a long weekend). */
export function nextSessionBoundary(at: Date = new Date()): SessionBoundary {
  const open = isUsMarketOpen(at);
  const STEP = 5 * 60_000;
  let t = Math.ceil(at.getTime() / STEP) * STEP;
  for (let i = 0; i < (4 * 24 * 60) / 5; i++) {
    if (isUsMarketOpen(new Date(t)) !== open) return { open, at: new Date(t) };
    t += STEP;
  }
  return { open, at: new Date(t) };
}

/** "2h 10m" / "38h" / "3d 4h": the coarse remaining time a ticker cell has room for. */
export function untilLabel(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
