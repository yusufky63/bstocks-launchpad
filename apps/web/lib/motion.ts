/** True when animations should run right now (follows the OS "reduce motion" setting). */
export function motionEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  return !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
