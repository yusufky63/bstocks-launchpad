'use client';

import { BarChart3, TrendingUp } from 'lucide-react';
import { AreaSeries, CandlestickSeries, ColorType, CrosshairMode, createChart, createSeriesMarkers, HistogramSeries, type IChartApi, type ISeriesApi, type ISeriesMarkersPluginApi, type UTCTimestamp } from 'lightweight-charts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useTheme } from '@/components/layout/theme-provider';
import { Chip, Skeleton, cx } from '@/components/ui/primitives';
import { useCandles } from '@/lib/queries';
import type { CandleView, SwapView } from '@/lib/types';

type Timeframe = 1 | 5 | 15 | 60 | 240 | 1440;
type ChartStyle = 'line' | 'candles';
type ChartSource = 'native' | 'dexscreener';
const SOURCES: Array<{ value: ChartSource; label: string }> = [
  { value: 'native', label: 'Launchpad' },
  { value: 'dexscreener', label: 'DexScreener' },
];

/** Embedded DexScreener chart; Uniswap v4 pools are addressed by pool id. */
export function embedUrl(poolId: string, theme: 'light' | 'dark'): string {
  return `https://dexscreener.com/base/${poolId}?embed=1&loadChartSettings=0&trades=0&tabs=0&info=0&chartLeftToolbar=0&chartTheme=${theme}&theme=${theme}&chartStyle=1&chartType=usd&interval=15`;
}
const TIMEFRAMES: Array<{ value: Timeframe; label: string }> = [
  { value: 1, label: '1m' },
  { value: 5, label: '5m' },
  { value: 15, label: '15m' },
  { value: 60, label: '1h' },
  { value: 240, label: '4h' },
  { value: 1440, label: '1d' },
];

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/** Real 1-minute candles from the indexer, aggregated in the browser. No synthetic bars, ever. */
export function ChartModule({ token, poolId, stockSymbol, creatorSwaps = [] }: { token: string; poolId: string; stockSymbol: string; creatorSwaps?: SwapView[] }) {
  const [source, setSource] = useState<ChartSource>('native');
  const { resolved: theme } = useTheme();
  const [tf, setTf] = useState<Timeframe>(5);
  const [unit, setUnit] = useState<'usd' | 'stock'>('usd');
  const [style, setStyle] = useState<ChartStyle>('candles');
  const { data, isLoading, isError } = useCandles(token, tf);
  const stockUsd = data?.quote.usd ?? null;
  const effectiveUnit = unit === 'usd' && stockUsd ? 'usd' : 'stock';

  const series = useMemo(() => {
    const raw = data?.candles ?? [];
    // Price every minute with the quote that was live for it, then aggregate. Converting after
    // aggregation would put one flat multiplier across the whole history, so a move in the stock
    // would silently redraw candles that had already settled; and an hourly bar's high and low have
    // to be the extremes of the dollar prices people actually saw, not of pool prices rescaled later.
    const priced =
      effectiveUnit === 'usd'
        ? raw.map((c) => {
            const at = c.stockUsd ?? stockUsd ?? 1;
            return { ...c, open: c.open * at, high: c.high * at, low: c.low * at, close: c.close * at, volumeStock: c.volumeStock * at };
          })
        : raw;
    return priced.map((c) => ({
      time: c.time,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volumeStock,
    }));
  }, [data, tf, effectiveUnit, stockUsd]);

  return (
    <div className="flex flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 border-b border-line">
        <div className="inline-flex rounded-[6px] border border-line p-0.5" role="tablist" aria-label="Chart source">
          {SOURCES.map((s) => (
            <button key={s.value} type="button" role="tab" aria-selected={source === s.value} onClick={() => setSource(s.value)} className={cx('h-7 px-2 inline-flex items-center justify-center rounded-[4px] font-mono text-[11px] transition-fast', source === s.value ? 'bg-primary text-primary-contrast' : 'text-ink-secondary hover:text-ink')}>
              {s.label}
            </button>
          ))}
        </div>
        {source !== 'native' && <span className="font-mono text-[11px] text-ink-muted">shown once DexScreener has indexed this pool</span>}
        {source === 'native' && (
        <>
        <div className="flex gap-1" role="tablist" aria-label="Timeframe">
          {TIMEFRAMES.map((t) => (
            <Chip key={t.value} active={tf === t.value} onClick={() => setTf(t.value)} className="h-8 min-h-[32px] px-2.5 text-[12px] font-mono">
              {t.label}
            </Chip>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <div className="inline-flex rounded-[6px] border border-line p-0.5" role="group" aria-label="Unit">
            <button type="button" aria-pressed={effectiveUnit === 'usd'} disabled={!stockUsd} onClick={() => setUnit('usd')} className={cx('h-7 px-2 inline-flex items-center justify-center rounded-[4px] font-mono text-[11px] transition-fast disabled:opacity-40', effectiveUnit === 'usd' ? 'bg-primary text-primary-contrast' : 'text-ink-secondary hover:text-ink')}>
              USD
            </button>
            <button type="button" aria-pressed={effectiveUnit === 'stock'} onClick={() => setUnit('stock')} className={cx('h-7 px-2 inline-flex items-center justify-center rounded-[4px] font-mono text-[11px] transition-fast', effectiveUnit === 'stock' ? 'bg-primary text-primary-contrast' : 'text-ink-secondary hover:text-ink')}>
              {stockSymbol}
            </button>
          </div>
          <div className="inline-flex rounded-[6px] border border-line p-0.5" role="group" aria-label="Chart style">
            <button type="button" aria-pressed={style === 'line'} onClick={() => setStyle('line')} title="Line" className={cx('h-7 w-8 inline-flex items-center justify-center rounded-[4px] transition-fast', style === 'line' ? 'bg-primary text-primary-contrast' : 'text-ink-secondary hover:text-ink')}>
              <TrendingUp size={14} strokeWidth={1.75} />
            </button>
            <button type="button" aria-pressed={style === 'candles'} onClick={() => setStyle('candles')} title="Candlesticks" className={cx('h-7 w-8 inline-flex items-center justify-center rounded-[4px] transition-fast', style === 'candles' ? 'bg-primary text-primary-contrast' : 'text-ink-secondary hover:text-ink')}>
              <BarChart3 size={14} strokeWidth={1.75} />
            </button>
          </div>
        </div>
        </>
        )}
      </div>
      {source !== 'native' ? (
        <iframe key={source + theme} title={`${source} chart`} src={embedUrl(poolId, theme)} className="w-full h-[420px] border-0 bg-canvas" loading="lazy" sandbox="allow-scripts allow-same-origin allow-popups" referrerPolicy="no-referrer" />
      ) : (
      <div className="px-2 py-2">
        {isLoading && !data ? (
          <Skeleton className="h-[320px]" />
        ) : isError ? (
          <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">Chart unavailable.</p>
        ) : series.length === 0 ? (
          <p className="h-[320px] flex items-center justify-center text-[13px] text-ink-muted">No trades yet. The chart starts with the first swap.</p>
        ) : (
          <PriceChart series={series} style={style} unit={effectiveUnit} markers={creatorMarkers(creatorSwaps, tf)} />
        )}
      </div>
      )}
    </div>
  );
}

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };
type Marker = { time: number; side: 'buy' | 'sell'; text: string };

/** Creator ("dev") trades, snapped to the candle they fall in, so they can be drawn on the chart. */
function creatorMarkers(swaps: SwapView[], tf: Timeframe): Marker[] {
  const size = tf * 60;
  const byBucket = new Map<string, Marker>();
  for (const s of swaps) {
    const time = Math.floor(new Date(s.blockTime).getTime() / 1000 / size) * size;
    const key = `${time}:${s.side}`;
    const existing = byBucket.get(key);
    if (existing) existing.text = `DEV ${s.side.toUpperCase()} ×`;
    else byBucket.set(key, { time, side: s.side, text: `DEV ${s.side.toUpperCase()}` });
  }
  return [...byBucket.values()].sort((a, b) => a.time - b.time);
}

function PriceChart({ series, style, unit, markers = [], height = 320 }: { series: Bar[]; style: ChartStyle; unit: 'usd' | 'stock'; markers?: Marker[]; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const markersRef = useRef<ISeriesMarkersPluginApi<UTCTimestamp> | null>(null);
  const areaRef = useRef<ISeriesApi<'Area'> | null>(null);
  const candleRef = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const volumeRef = useRef<ISeriesApi<'Histogram'> | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const text = cssVar('--text-muted') || '#717886';
    const line = cssVar('--border') || '#dee1e7';
    const primary = cssVar('--primary') || '#0370fd';
    const up = cssVar('--positive-fg') || '#2f7d00';
    const down = cssVar('--danger-fg') || '#c62a0f';
    const precision = unit === 'usd' ? 8 : 12;
    const chart = createChart(el, {
      height,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: text, fontFamily: 'JetBrains Mono, ui-monospace, monospace', fontSize: 11, attributionLogo: false },
      grid: { vertLines: { visible: false }, horzLines: { color: line } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.08, bottom: 0.22 } },
      timeScale: { borderVisible: false, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { color: text, width: 1, style: 2, labelBackgroundColor: primary }, horzLine: { color: text, width: 1, style: 2, labelBackgroundColor: primary } },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      handleScale: { mouseWheel: true, pinch: true, axisPressedMouseMove: true },
      localization: { priceFormatter: (p: number) => (unit === 'usd' ? `$${p < 0.01 ? p.toFixed(8) : p.toFixed(p < 10 ? 4 : 2)}` : p.toPrecision(4)) },
    });
    const priceFormat = { type: 'price' as const, precision, minMove: 10 ** -precision };
    if (style === 'candles') {
      candleRef.current = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down, priceLineVisible: true, lastValueVisible: true, priceFormat });
    } else {
      areaRef.current = chart.addSeries(AreaSeries, { lineColor: primary, lineWidth: 2, topColor: 'rgba(3,112,253,0.16)', bottomColor: 'rgba(3,112,253,0)', priceLineVisible: true, lastValueVisible: true, crosshairMarkerRadius: 4, priceFormat });
    }
    volumeRef.current = chart.addSeries(HistogramSeries, { priceFormat: { type: 'volume' }, priceScaleId: 'volume', lastValueVisible: false, priceLineVisible: false });
    chart.priceScale('volume').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, borderVisible: false });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({ width: el.clientWidth }));
    ro.observe(el);
    const observer = new MutationObserver(() => {
      chart.applyOptions({ layout: { textColor: cssVar('--text-muted') }, grid: { horzLines: { color: cssVar('--border') } } });
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      ro.disconnect();
      observer.disconnect();
      markersRef.current = null;
      chart.remove();
      chartRef.current = null;
      areaRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
    };
  }, [height, style, unit]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const up = cssVar('--positive-fg') || '#2f7d00';
    const down = cssVar('--danger-fg') || '#c62a0f';
    if (areaRef.current) areaRef.current.setData(series.map((c) => ({ time: c.time as UTCTimestamp, value: c.close })));
    if (candleRef.current) candleRef.current.setData(series.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    if (volumeRef.current) volumeRef.current.setData(series.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? `${up}55` : `${down}55` })));
    const priceSeries = candleRef.current ?? areaRef.current;
    if (priceSeries) {
      const known = new Set(series.map((c) => c.time));
      const shown = markers
        .filter((m) => known.has(m.time))
        .map((m) => ({ time: m.time as UTCTimestamp, position: m.side === 'buy' ? ('belowBar' as const) : ('aboveBar' as const), shape: m.side === 'buy' ? ('arrowUp' as const) : ('arrowDown' as const), color: m.side === 'buy' ? cssVar('--primary') || '#0370fd' : cssVar('--warning-fg') || '#8a5a00', text: m.text }));
      if (!markersRef.current) markersRef.current = createSeriesMarkers(priceSeries as ISeriesApi<'Candlestick' | 'Area', UTCTimestamp>, shown);
      else markersRef.current.setMarkers(shown);
    }
    chart.timeScale().fitContent();
  }, [series, style, markers]);

  const zoom = (factor: number) => {
    const ts = chartRef.current?.timeScale();
    const range = ts?.getVisibleLogicalRange();
    if (!ts || !range) return;
    const span = range.to - range.from;
    const center = (range.from + range.to) / 2;
    const next = Math.max(5, span * factor);
    ts.setVisibleLogicalRange({ from: center - next / 2, to: center + next / 2 });
  };

  return (
    <div className="relative">
      <div ref={ref} className="w-full" style={{ height }} role="img" aria-label={style === 'candles' ? 'Candlestick chart' : 'Price chart'} />
      <div className="absolute left-2 bottom-2 flex items-center gap-1 rounded-[6px] border border-line bg-canvas/90 backdrop-blur-[2px] p-0.5" role="group" aria-label="Chart zoom">
        <button type="button" onClick={() => zoom(0.6)} aria-label="Zoom in" className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface text-[15px] font-medium">+</button>
        <button type="button" onClick={() => zoom(1.6)} aria-label="Zoom out" className="h-7 w-7 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface text-[15px] font-medium">−</button>
        <button type="button" onClick={() => chartRef.current?.timeScale().fitContent()} aria-label="Reset zoom" className="h-7 px-2 inline-flex items-center justify-center rounded-[4px] text-ink-secondary hover:text-ink hover:bg-surface font-mono text-[10px] uppercase tracking-[0.06em]">fit</button>
      </div>
    </div>
  );
}
