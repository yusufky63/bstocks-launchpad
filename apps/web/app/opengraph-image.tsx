import { ImageResponse } from 'next/og';

import { OG, OgCard, OgChip, OgCta, ogCoin, ogFonts } from '@/lib/og';

export const alt = 'BStocks Launchpad — Tokens priced in real stocks';
export const size = OG.size;
export const contentType = 'image/png';

/**
 * Site-wide share card in the ecosystem's shared visual language. Static content (no data
 * fetch) so it never fails.
 */
export default function Image() {
  const coins = ['nvda', 'tsla', 'googl'].map((t) => ogCoin(t)).filter((s): s is string => s !== null);
  const coinPos = [
    { left: 4, top: 34 },
    { left: 178, top: 0 },
    { left: 92, top: 176 },
  ];
  const art =
    coins.length > 0 ? (
      <div style={{ display: 'flex', position: 'relative', width: 360, height: 360 }}>
        {coins.map((src, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={src} alt="" width={184} height={184} style={{ position: 'absolute', width: 184, height: 184, left: coinPos[i]!.left, top: coinPos[i]!.top }} />
        ))}
      </div>
    ) : undefined;
  return new ImageResponse(
    (
      <OgCard art={art}>
        <div style={{ display: 'flex', flexDirection: 'column', fontFamily: OG.display, fontSize: 64, fontWeight: 700, letterSpacing: -2.5, lineHeight: 1.0 }}>
          <span>Tokens priced</span>
          <div style={{ display: 'flex', gap: 16 }}>
            <span>in</span>
            <span style={{ color: OG.blue }}>real stocks</span>
          </div>
        </div>
        <div style={{ fontSize: 23, fontWeight: 500, color: OG.secondary, maxWidth: 560, lineHeight: 1.3 }}>
          Launch a token that trades against a Coinbase tokenized stock on Base.
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <OgChip label="Fixed supply" />
          <OgChip label="Locked liquidity" />
          <OgChip label="Fees in the stock" />
        </div>
        <div style={{ display: 'flex', marginTop: 6 }}>
          <OgCta label="launchpad.basestocks.finance" />
        </div>
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}
