import fs from 'node:fs';
import path from 'node:path';

/**
 * Shared pieces for share cards rendered with next/og (Satori), in the same visual language as
 * BaseStocks (the reference app for the whole ecosystem): white canvas, a bordered card with two
 * blue tick brackets, the brand lockup, Space Grotesk headline. Satori rules: every element with
 * more than one child needs display:flex, and a text node must be the only child of its element.
 */

type OgFont = { name: string; data: Buffer; weight: 400 | 500 | 700; style: 'normal' };

let fontCache: OgFont[] | null = null;

/** Space Grotesk for display text, DM Sans for copy, JetBrains Mono for labels: same as the app. */
export function ogFonts(): OgFont[] {
  if (fontCache) return fontCache;
  const load = (file: string, name: string, weight: 400 | 500 | 700): OgFont => ({
    name,
    data: fs.readFileSync(path.join(process.cwd(), 'app/fonts', file)),
    weight,
    style: 'normal',
  });
  fontCache = [
    load('SpaceGrotesk-700.ttf', 'Space Grotesk', 700),
    load('DMSans-400.ttf', 'DM Sans', 400),
    load('DMSans-500.ttf', 'DM Sans', 500),
    load('JetBrainsMono-400.ttf', 'JetBrains Mono', 400),
  ];
  return fontCache;
}

/** Inline a file under the project root as a data URI; a missing file just drops the image. */
export function dataUri(relative: string): string | null {
  try {
    return `data:image/png;base64,${fs.readFileSync(path.join(process.cwd(), relative)).toString('base64')}`;
  } catch {
    return null;
  }
}

export const OG = {
  blue: '#0370fd',
  ink: '#0a0b0d',
  secondary: '#5b616e',
  muted: '#717886',
  positive: '#2f7d00',
  danger: '#c62a0f',
  border: '#dee1e7',
  surface: '#f8f9fb',
  size: { width: 1200, height: 630 },
  display: 'Space Grotesk',
  body: 'DM Sans',
  mono: 'JetBrains Mono',
} as const;

/** The StockPair mark as Satori-safe SVG: two squares on a baseline, joined by a thin bar. */
export function OgMark({ size = 44 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64">
      <rect x="6" y="20" width="22" height="22" rx="4" fill={OG.blue} />
      <rect x="36" y="20" width="22" height="22" rx="4" fill={OG.ink} opacity="0.85" />
      <rect x="24" y="29" width="16" height="4" rx="2" fill={OG.ink} opacity="0.45" />
      <rect x="6" y="50" width="52" height="3" rx="1.5" fill={OG.ink} opacity="0.3" />
    </svg>
  );
}

/**
 * The card every share image is built on — identical frame and lockup to the BaseStocks cards
 * (the shared block-B mark), with a mono LAUNCHPAD eyebrow telling the two apps apart.
 */
export function OgCard({ accent = OG.blue, children, art, footer }: { accent?: string; children: React.ReactNode; art?: React.ReactNode; footer?: string }) {
  const mark = dataUri('public/brand/logo-mark-transparent-256.png');
  return (
    <div style={{ width: '100%', height: '100%', display: 'flex', padding: 22, background: '#ffffff', fontFamily: OG.body, color: OG.ink }}>
      <div style={{ position: 'relative', flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '48px 60px', border: `1px solid ${OG.border}`, borderRadius: 8, background: '#ffffff' }}>
        <div style={{ position: 'absolute', top: -1, left: -1, width: 26, height: 26, borderTop: `2px solid ${accent}`, borderLeft: `2px solid ${accent}`, borderTopLeftRadius: 8 }} />
        <div style={{ position: 'absolute', bottom: -1, right: -1, width: 26, height: 26, borderBottom: `2px solid ${accent}`, borderRight: `2px solid ${accent}`, borderBottomRightRadius: 8 }} />
        <div style={{ display: 'flex', flex: 1, alignItems: 'center', justifyContent: 'space-between', gap: 32 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 20, width: art ? 620 : 1000 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 11 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {mark && <img src={mark} alt="" width={40} height={40} style={{ width: 40, height: 40 }} />}
              <div style={{ display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', fontFamily: OG.display, fontSize: 29, fontWeight: 700, letterSpacing: -0.5 }}>
                  <span style={{ color: OG.blue }}>Base</span>
                  <span>Stocks</span>
                </div>
                <div style={{ display: 'flex', fontFamily: OG.mono, fontSize: 12, letterSpacing: 4, color: OG.blue, marginTop: 2 }}>LAUNCHPAD</div>
              </div>
            </div>
            {children}
          </div>
          {art}
        </div>
        {footer && <div style={{ display: 'flex', fontSize: 18, color: OG.muted, marginTop: 18 }}>{footer}</div>}
      </div>
    </div>
  );
}

/** Pill with a coloured dot, as on the site's chips. `filled` makes it the headline fact. */
export function OgChip({ label, color = OG.blue, filled = false }: { label: string; color?: string; filled?: boolean }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 9, height: 42, padding: '0 18px', borderRadius: 999, background: filled ? color : '#ffffff', border: `1px solid ${filled ? color : OG.border}`, fontSize: 19, fontWeight: 500, color: filled ? '#ffffff' : OG.ink }}>
      <div style={{ display: 'flex', width: 7, height: 7, borderRadius: 999, background: filled ? '#ffffff' : color }} />
      {label}
    </div>
  );
}

/** The call to action, in the accent colour, with the same arrow the site uses for outbound links. */
export function OgCta({ label, color = OG.blue }: { label: string; color?: string }) {
  return (
    <div style={{ display: 'flex', alignSelf: 'flex-start', alignItems: 'center', gap: 12, height: 54, padding: '0 26px', borderRadius: 999, background: color, color: '#ffffff', fontFamily: OG.display, fontSize: 24, fontWeight: 500 }}>
      <span>{label}</span>
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 17 17 7" />
        <path d="M8 7h9v9" />
      </svg>
    </div>
  );
}

/** A 3D coin for the paired stock, when the brand set has one; tickers with no render drop out. */
export function ogCoin(ticker: string | null | undefined): string | null {
  if (!ticker) return null;
  return dataUri(`public/brand/coins/${ticker.toLowerCase()}-200.png`);
}
