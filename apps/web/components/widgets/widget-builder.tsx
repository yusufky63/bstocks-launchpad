'use client';

import { Check, Copy } from 'lucide-react';
import { useEffect, useState } from 'react';

import { Input, Segmented, Tabs } from '@/components/ui/controls';
import { Chip, KeyValue, Module, ModuleHeader } from '@/components/ui/primitives';
import {
  EMBED_HEIGHT,
  EMBED_SECTION_LABELS,
  EMBED_SECTIONS,
  contrastRatio,
  embedPath,
  embedResizeScript,
  embedSnippet,
  parseEmbedAccent,
  type EmbedEligibility,
  type EmbedOptions,
  type EmbedSection,
  type EmbedTheme,
  type EmbedWidget,
  type TradeSide,
} from '@/lib/embed';
import { publicEnv } from '@/lib/env';
import { useStocks } from '@/lib/queries';
import type { StocksResponse } from '@/lib/types';

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
/** The site's own primary, what the colour picker starts from. */
const SITE_PRIMARY = '#0370fd';

/** The colour as typed, applied to the code and the preview once typing pauses. */
function useSettled<T>(value: T, ms = 300): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return settled;
}

/** Pick a widget and its options, copy the iframe, and see the widget itself beside the code. */
export function WidgetBuilder({ initialToken, initialStocks }: { initialToken?: string; initialStocks?: StocksResponse }) {
  const [widget, setWidget] = useState<EmbedWidget>('trade');
  const [token, setToken] = useState(initialToken ?? publicEnv.featuredToken);
  const [side, setSide] = useState<TradeSide>('buy');
  const [stock, setStock] = useState<string | null>(null);
  const [theme, setTheme] = useState<EmbedTheme>('auto');
  const [eligibility, setEligibility] = useState<EmbedEligibility>('region');
  const [hide, setHide] = useState<EmbedSection[]>([]);
  const [accentText, setAccentText] = useState('');
  const accentDraft = parseEmbedAccent(accentText);
  const accent = useSettled(accentDraft);
  const sections: readonly EmbedSection[] = EMBED_SECTIONS[widget];
  const toggleHide = (section: EmbedSection) => setHide((current) => (current.includes(section) ? current.filter((s) => s !== section) : [...current, section]));
  const { data: stocksData } = useStocks(initialStocks);
  const stocks = (stocksData?.stocks ?? []).filter((s) => s.enabled);

  const tokenValid = ADDRESS.test(token.trim());
  const options: EmbedOptions | null =
    widget === 'trade' ? (tokenValid ? { widget, token: token.trim(), side, theme, eligibility, hide, accent } : null) : { widget, ...(stock ? { stock } : {}), theme, eligibility, hide, accent };

  return (
    <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_480px] gap-5 items-start">
      <div className="flex flex-col gap-5 min-w-0">
        <Module>
          <Tabs<EmbedWidget>
            ariaLabel="Widget"
            value={widget}
            onChange={setWidget}
            tabs={[
              { id: 'trade', label: 'Trade widget' },
              { id: 'create', label: 'Create widget' },
            ]}
          />
          <div className="p-4 flex flex-col gap-4">
            {widget === 'trade' ? (
              <>
                <p className="text-[13px] text-ink-secondary">Buy and sell one token against its stock, with the live pool quote, slippage and the review step the token page has.</p>
                <Input
                  label="Token address"
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                  error={token.trim() && !tokenValid ? 'Paste a token address: 0x and 40 hex characters.' : undefined}
                />
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-ink-secondary">Opens on</span>
                  <Segmented<TradeSide>
                    ariaLabel="Side the widget opens on"
                    size="sm"
                    value={side}
                    onChange={setSide}
                    options={[
                      { value: 'buy', label: 'Buy', tone: 'buy' },
                      { value: 'sell', label: 'Sell', tone: 'sell' },
                    ]}
                  />
                </div>
              </>
            ) : (
              <>
                <p className="text-[13px] text-ink-secondary">The full create form. The launch goes from the visitor&apos;s wallet to the factory, so the visitor is the creator and earns the creator&apos;s share of every fee.</p>
                <div className="flex flex-col gap-1.5">
                  <span className="text-[12px] text-ink-secondary">Stock it opens with</span>
                  <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Stock the widget opens with">
                    <Chip active={stock === null} onClick={() => setStock(null)} role="radio" aria-checked={stock === null}>
                      Visitor picks
                    </Chip>
                    {stocks.map((s) => (
                      <Chip key={s.address} active={stock === s.address} onClick={() => setStock(s.address)} role="radio" aria-checked={stock === s.address}>
                        {s.symbol}
                      </Chip>
                    ))}
                  </div>
                </div>
              </>
            )}
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Theme</span>
              <Segmented<EmbedTheme>
                ariaLabel="Widget theme"
                size="sm"
                value={theme}
                onChange={setTheme}
                options={[
                  { value: 'auto', label: 'Visitor setting' },
                  { value: 'light', label: 'Light' },
                  { value: 'dark', label: 'Dark' },
                ]}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Eligibility check</span>
              <Segmented<EmbedEligibility>
                ariaLabel="Who the widget asks to confirm they are not a US person"
                size="sm"
                value={eligibility}
                onChange={setEligibility}
                options={[
                  { value: 'region', label: 'Restricted regions' },
                  { value: 'always', label: 'Every visitor' },
                ]}
              />
              <p className="text-[12px] text-ink-muted">
                {eligibility === 'always'
                  ? 'Every visitor confirms they are not a US person (they do not live in the United States and are not a US citizen or resident) once, right above the button, before their first trade or launch.'
                  : 'Only visitors whose connection comes from a restricted country (the United States) are asked, right above the button; the launchpad refuses their trades until they confirm.'}
              </p>
            </div>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Style" />
          <div className="p-4 flex flex-col gap-4">
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Primary colour</span>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="color"
                  aria-label="Pick the primary colour"
                  value={accentDraft ?? SITE_PRIMARY}
                  onChange={(e) => setAccentText(e.target.value)}
                  className="h-9 w-12 shrink-0 cursor-pointer rounded-[6px] border border-line bg-canvas p-1"
                />
                <input
                  aria-label="Primary colour as hex"
                  value={accentText}
                  onChange={(e) => setAccentText(e.target.value)}
                  placeholder="Site blue"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9 w-32 rounded-[6px] border border-line bg-canvas px-2.5 font-mono text-[13px] outline-none focus:border-primary"
                />
                {accentText && (
                  <Chip onClick={() => setAccentText('')} aria-label="Back to the site colour">
                    Reset
                  </Chip>
                )}
              </div>
              {accentText && !accentDraft && <p className="text-[12px] text-danger-fg">Use a six-digit hex colour, like #0052ff.</p>}
              {accentDraft && <AccentContrast accent={accentDraft} />}
              <p className="text-[12px] text-ink-muted">Buttons, links, the selected tab and the focus ring take this colour in light and dark; the shades are derived from it.</p>
            </div>
            <div className="flex flex-col gap-1.5">
              <span className="text-[12px] text-ink-secondary">Hide</span>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Sections to hide">
                {sections.map((section) => (
                  <Chip key={section} active={hide.includes(section)} aria-pressed={hide.includes(section)} onClick={() => toggleHide(section)}>
                    {EMBED_SECTION_LABELS[section]}
                  </Chip>
                ))}
              </div>
              <p className="text-[12px] text-ink-muted">
                {widget === 'create'
                  ? 'A hidden option keeps its default: no buy at launch, a profile fixed onchain, no website or socials. The price, the fee, the review step and the eligibility question always stay.'
                  : 'The price, the fee, the minimum received, the review step and the eligibility question always stay.'}
              </p>
            </div>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Code" />
          <div className="p-4 flex flex-col gap-4">
            {options ? <CodeBlock label="Paste into your page" code={embedSnippet(publicEnv.appUrl, options)} /> : <p className="text-[13px] text-ink-muted">Enter a token address to get the code.</p>}
            <CodeBlock label="Optional · fit the frame to the widget" code={embedResizeScript(publicEnv.appUrl)} />
            <p className="text-[12px] text-ink-muted">
              Without the script the frame keeps the height in the code ({EMBED_HEIGHT[widget]}px) and scrolls inside when the widget grows. Leave the iframe unsandboxed: wallets open popups and browser wallets inject into the frame.
            </p>
          </div>
        </Module>

        <Module>
          <ModuleHeader title="Events" />
          <div className="p-4 flex flex-col gap-3">
            <p className="text-[13px] text-ink-secondary">
              The widget posts messages to your page with <code className="font-mono text-[12px]">source: &apos;bstocks-launchpad&apos;</code>. Check <code className="font-mono text-[12px]">event.origin</code> is <code className="font-mono text-[12px]">{new URL(publicEnv.appUrl).origin}</code>.
            </p>
            <div>
              <KeyValue k="ready" v="{ widget }" />
              <KeyValue k="resize" v="{ height }" />
              <KeyValue k="swap" v="{ token, side, txHash }" />
              <KeyValue k="launch" v="{ token, txHash }" />
            </div>
            <p className="text-[12px] text-ink-muted">
              Any page can post a message that looks like these. Treat swap and launch as a hint to refresh your UI; before you reward anyone for one, look the transaction up on Base. No address, balance or signature leaves the widget.
            </p>
          </div>
        </Module>
      </div>

      <Module ticks>
        <ModuleHeader title="Preview" />
        <div className="p-3 bg-surface">
          {options ? (
            <iframe
              key={embedPath(options)}
              src={embedPath(options)}
              title={widget === 'trade' ? 'Trade widget preview' : 'Create widget preview'}
              className="block w-full border-0 rounded-[8px] bg-canvas"
              style={{ height: EMBED_HEIGHT[widget] }}
              allow="clipboard-write"
            />
          ) : (
            <p className="text-[13px] text-ink-muted p-3">The preview appears once the token address is valid.</p>
          )}
        </div>
      </Module>
    </div>
  );
}

/** A colour a visitor cannot read is worse than the site's blue: say so while the host picks it. */
function AccentContrast({ accent }: { accent: string }) {
  const onLight = contrastRatio(accent, '#ffffff');
  const onDark = contrastRatio(accent, '#0a0b0d');
  const weak = [onLight < 3 && 'light', onDark < 3 && 'dark'].filter(Boolean);
  if (weak.length === 0) return null;
  return <p className="text-[12px] text-warning-fg">Hard to read as text on {weak.join(' and ')} backgrounds (contrast {Math.min(onLight, onDark).toFixed(1)}:1, 3:1 or more reads well).</p>;
}

function CodeBlock({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="border border-line rounded-[6px] overflow-hidden">
      <div className="flex items-center justify-between gap-2 h-9 px-3 border-b border-line bg-surface">
        <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">{label}</span>
        <button type="button" onClick={copy} className="inline-flex items-center gap-1.5 h-7 px-2 rounded-[6px] text-[12px] text-ink-secondary hover:text-ink transition-fast">
          {copied ? <Check size={13} strokeWidth={1.75} /> : <Copy size={13} strokeWidth={1.75} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="p-3 overflow-x-auto text-[12px] leading-relaxed font-mono text-ink">
        <code>{code}</code>
      </pre>
    </div>
  );
}
