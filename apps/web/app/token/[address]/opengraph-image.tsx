import { ImageResponse } from 'next/og';

import { parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { OG, OgCard, OgChip, OgCta, ogCoin, ogFonts } from '@/lib/og';
import { readMarketCached } from '@/lib/token.server';

export const alt = 'A token paired with a real stock on the BStocks Launchpad';
export const size = OG.size;
export const contentType = 'image/png';

const usd = (v: number): string =>
  v >= 1 ? `$${v.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : `$${v.toLocaleString('en-US', { maximumSignificantDigits: 3 })}`;

/**
 * Per-token share card: name, the paired stock, live price and 24h move. Any failure — unknown
 * address, indexer behind, db down — falls back to the generic card rather than a broken image.
 */
export default async function Image({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;
  const token = parseAddressParam(address);
  const market = token
    ? await (async () => {
        try {
          return await readMarketCached(await getDb(), token);
        } catch {
          return null;
        }
      })()
    : null;

  if (!market) {
    return new ImageResponse(
      (
        <OgCard>
          <div style={{ display: 'flex', fontFamily: OG.display, fontSize: 60, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>Tokens priced in real stocks</div>
          <div style={{ display: 'flex', marginTop: 6 }}>
            <OgCta label="launchpad.basestocks.finance" />
          </div>
        </OgCard>
      ),
      { ...size, fonts: ogFonts() },
    );
  }

  const coin = ogCoin(market.stock.ticker);
  const change = market.change24hPercent;
  const art = coin ? (
    <div style={{ display: 'flex', position: 'relative', width: 340, height: 340, alignItems: 'center', justifyContent: 'center' }}>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={coin} alt="" width={300} height={300} style={{ width: 300, height: 300 }} />
    </div>
  ) : undefined;

  return new ImageResponse(
    (
      <OgCard art={art} footer={`Fixed 1B supply · liquidity locked forever · fees paid in ${market.stock.ticker}`}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={{ display: 'flex', fontFamily: OG.display, fontSize: market.name.length > 16 ? 52 : 64, fontWeight: 700, letterSpacing: -2, lineHeight: 1.05 }}>{market.name}</div>
          <div style={{ display: 'flex', fontFamily: OG.mono, fontSize: 24, color: OG.secondary }}>{`${market.symbol} / ${market.stock.symbol}`}</div>
        </div>
        {market.priceUsd !== null && (
          <div style={{ display: 'flex', alignItems: 'baseline', gap: 16 }}>
            <div style={{ display: 'flex', fontFamily: OG.display, fontSize: 54, fontWeight: 700, letterSpacing: -1 }}>{usd(market.priceUsd)}</div>
            {change !== null && (
              <div style={{ display: 'flex', fontFamily: OG.mono, fontSize: 26, color: change >= 0 ? OG.positive : OG.danger }}>
                {`${change >= 0 ? '+' : ''}${change.toFixed(2)}% 24h`}
              </div>
            )}
          </div>
        )}
        <div style={{ display: 'flex', gap: 12 }}>
          <OgChip label={`Paired with ${market.stock.ticker}`} filled />
          <OgChip label={`${market.holders} holders`} />
        </div>
        <div style={{ display: 'flex', marginTop: 6 }}>
          <OgCta label="Trade on the launchpad" />
        </div>
      </OgCard>
    ),
    { ...size, fonts: ogFonts() },
  );
}
