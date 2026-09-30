/**
 * Widgets: the trade panel and the create form as pages another site can put in an iframe.
 *
 * Everything under /embed may be framed by any origin (next.config.ts); every other page still
 * refuses. The widget talks to its host only through postMessage, and only to say things the host
 * could read from the chain anyway: its height, that it is ready, and the hash of a swap or launch
 * the visitor just made. No address, balance or signature ever leaves the frame.
 */

export type EmbedWidget = 'trade' | 'create';
export type EmbedTheme = 'auto' | 'light' | 'dark';
export type TradeSide = 'buy' | 'sell';
/**
 * When the widget asks the "not a US person" question: `region` only where the server requires it
 * (a blocked country), `always` of every visitor before their first trade or launch. A host picks
 * `always` when it wants the statement from everyone on its own site.
 */
export type EmbedEligibility = 'region' | 'always';
/** How the create widget offers the stocks: the site's grid of tiles, or one compact dropdown. */
export type EmbedPicker = 'grid' | 'select';

/**
 * Default frame heights. The trade widget fits whole at a 420px width, a live quote included. The
 * create form is about 2,500px tall at that width, so by default it scrolls inside its frame; the
 * optional resize script grows the frame to the full form instead.
 */
export const EMBED_HEIGHT: Record<EmbedWidget, number> = { trade: 820, create: 900 };

/**
 * Optional parts of the trade widget a host adds with `?show=`: the price chart and the token's
 * trades and holders lists. Off by default: the plain widget is a trade panel and nothing else.
 */
export const EMBED_MODULES = ['chart', 'trades', 'holders'] as const;
export type EmbedModule = (typeof EMBED_MODULES)[number];
export const EMBED_MODULE_LABELS: Record<EmbedModule, string> = { chart: 'Price chart', trades: 'Trades', holders: 'Holders' };
/** What each added module takes at a 420px width. */
const MODULE_HEIGHT = { chart: 460, records: 620 } as const;

/** Every message a widget posts carries this, so a host can tell ours from any other frame's. */
export const EMBED_MESSAGE_SOURCE = 'bstocks-launchpad';

export type EmbedMessage =
  | { type: 'ready'; widget: EmbedWidget }
  | { type: 'resize'; height: number }
  | { type: 'swap'; token: string; side: TradeSide; txHash: string }
  | { type: 'launch'; token: string; txHash: string };

export function embedMessage(message: EmbedMessage): EmbedMessage & { source: typeof EMBED_MESSAGE_SOURCE } {
  return { source: EMBED_MESSAGE_SOURCE, ...message };
}

export function parseEmbedTheme(value: string | null | undefined): EmbedTheme {
  return value === 'light' || value === 'dark' ? value : 'auto';
}

export function parseEmbedSide(value: string | null | undefined): TradeSide {
  return value === 'sell' ? 'sell' : 'buy';
}

export function parseEmbedEligibility(value: string | null | undefined): EmbedEligibility {
  return value === 'always' ? 'always' : 'region';
}

export function parseEmbedPicker(value: string | null | undefined): EmbedPicker {
  return value === 'select' ? 'select' : 'grid';
}

/** `?show=chart,holders`: the known modules, once each, in a fixed order; anything else is dropped. */
export function parseEmbedShow(value: string | null | undefined): EmbedModule[] {
  const asked = new Set((value ?? '').split(',').map((part) => part.trim().toLowerCase()));
  return EMBED_MODULES.filter((module) => asked.has(module));
}

/**
 * Parts of a widget a host may leave out, so it fits the host's page. What a hidden part controls
 * falls back to its safe default: no buy at launch, a profile that cannot be edited onchain, no
 * links. Hiding the stock picker fixes the stock the host named with `stock`, and does nothing
 * without one: a launch always needs a stock, so the picker comes back rather than a dead form.
 * The price, the fee, the minimum received and the eligibility question are never optional.
 */
export const EMBED_SECTIONS = {
  trade: ['header', 'presets', 'notes'],
  create: ['header', 'stocks', 'links', 'buy', 'profile', 'steps'],
} as const satisfies Record<EmbedWidget, readonly string[]>;
export type EmbedSection = (typeof EMBED_SECTIONS)[EmbedWidget][number];
const ALL_SECTIONS = new Set<string>([...EMBED_SECTIONS.trade, ...EMBED_SECTIONS.create]);

export const EMBED_SECTION_LABELS: Record<EmbedSection, string> = {
  header: 'Title',
  stocks: 'Stock picker',
  presets: 'Balance presets',
  notes: 'Pool notes',
  links: 'Website and socials',
  buy: 'Buy at launch',
  profile: 'Editable profile',
  steps: 'What happens',
};

/** `?hide=steps,buy`: the known sections, once each, in a fixed order; anything else is dropped. */
export function parseEmbedHide(value: string | null | undefined): EmbedSection[] {
  const asked = new Set((value ?? '').split(',').map((part) => part.trim().toLowerCase()));
  return [...ALL_SECTIONS].filter((section) => asked.has(section)) as EmbedSection[];
}

/** `?accent=0052ff` (the `#` optional): a six-digit hex colour, lowercased with its `#`, or null. */
export function parseEmbedAccent(value: string | null | undefined): string | null {
  const hex = (value ?? '').trim().replace(/^#/u, '').toLowerCase();
  return /^[0-9a-f]{6}$/u.test(hex) ? `#${hex}` : null;
}

type Rgb = [number, number, number];
const toRgb = (hex: string): Rgb => [0, 2, 4].map((i) => parseInt(hex.slice(1 + i, 3 + i), 16)) as Rgb;
const toHex = (rgb: Rgb) => `#${rgb.map((c) => Math.round(Math.min(255, Math.max(0, c))).toString(16).padStart(2, '0')).join('')}`;
const mix = (rgb: Rgb, toward: number, amount: number): Rgb => rgb.map((c) => c + (toward - c) * amount) as Rgb;

function luminance([r, g, b]: Rgb): number {
  const [lr, lg, lb] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  }) as Rgb;
  return 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
}

/** WCAG contrast ratio between two hex colours, 1 to 21. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [luminance(toRgb(a)), luminance(toRgb(b))];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

const INK = '#0a0b0d';

/**
 * The site's four primary tokens, derived from one host colour for each theme the way the site's
 * own blue is: a darker pressed shade on light, a lighter one on dark, a faint tint, and whichever
 * of white or ink reads better on the colour for button text.
 */
export function accentTokens(accent: string): { light: Record<string, string>; dark: Record<string, string> } {
  const rgb = toRgb(accent);
  const contrast = contrastRatio(accent, '#ffffff') >= contrastRatio(accent, INK) ? '#ffffff' : INK;
  const soft = (alpha: number) => `rgba(${rgb.join(', ')}, ${alpha})`;
  return {
    light: { '--primary': accent, '--primary-strong': toHex(mix(rgb, 0, 0.2)), '--primary-soft': soft(0.08), '--primary-contrast': contrast },
    dark: { '--primary': accent, '--primary-strong': toHex(mix(rgb, 255, 0.25)), '--primary-soft': soft(0.16), '--primary-contrast': contrast },
  };
}

/**
 * The stylesheet a widget page carries for a host colour. `:root:root` outranks the site's
 * `:root` and `html[data-theme]` token blocks whatever order they load in, so every primary use in
 * the frame follows, the wallet sheet included. Only a parsed hex ever reaches this string.
 */
export function accentStylesheet(accent: string | null): string {
  if (!accent || parseEmbedAccent(accent) !== accent) return '';
  const { light, dark } = accentTokens(accent);
  const block = (tokens: Record<string, string>) => Object.entries(tokens).map(([k, v]) => `${k}:${v};`).join('');
  return `:root:root{${block(light)}}:root:root[data-theme="dark"]{${block(dark)}}@media (prefers-color-scheme: dark){:root:root:not([data-theme="light"]){${block(dark)}}}`;
}

/**
 * The root layout's pre-paint theme script. The visitor's stored choice applies everywhere, except
 * that on a widget page a host that names a theme with `?theme=` wins inside its frame. The query
 * is read first: a framed page may be refused storage, and that must not cost the host its theme.
 */
export const THEME_SCRIPT = `(function(){var t=null;try{if(/^\\/embed(\\/|$)/.test(location.pathname))t=new URLSearchParams(location.search).get('theme');}catch(e){}if(t!=='dark'&&t!=='light'){try{t=localStorage.getItem('stockpair:theme');}catch(e){}}if(t==='dark'||t==='light')document.documentElement.setAttribute('data-theme',t);})();`;

export type EmbedOptions = {
  widget: EmbedWidget;
  /** Trade widget: the token. */
  token?: string;
  /** Trade widget: the side it opens on. */
  side?: TradeSide;
  /** Trade widget: the chart and lists added under the panel. */
  show?: readonly EmbedModule[];
  /** Create widget: the stock it opens with, or the only one it offers with `hide: ['stocks']`. */
  stock?: string;
  /** Create widget: tiles or a dropdown. */
  picker?: EmbedPicker;
  theme?: EmbedTheme;
  eligibility?: EmbedEligibility;
  /** Sections to leave out; any that do not belong to this widget are ignored. */
  hide?: readonly EmbedSection[];
  /** Primary colour, `#rrggbb`. */
  accent?: string | null;
};

const ADDRESS = /^0x[0-9a-fA-F]{40}$/u;

/** The widget's path on this site, with only the parameters that differ from the defaults. */
export function embedPath(options: EmbedOptions): string {
  const params = new URLSearchParams();
  let path: string;
  if (options.widget === 'trade') {
    if (!options.token || !ADDRESS.test(options.token)) throw new Error('The trade widget needs a token address.');
    path = `/embed/trade/${options.token.toLowerCase()}`;
    if (options.side === 'sell') params.set('side', 'sell');
    const show = parseEmbedShow((options.show ?? []).join(','));
    if (show.length > 0) params.set('show', show.join(','));
  } else {
    path = '/embed/create';
    if (options.stock && ADDRESS.test(options.stock)) params.set('stock', options.stock.toLowerCase());
    if (options.picker === 'select') params.set('picker', 'select');
  }
  if (options.theme === 'light' || options.theme === 'dark') params.set('theme', options.theme);
  if (options.eligibility === 'always') params.set('eligibility', 'always');
  const own: readonly string[] = EMBED_SECTIONS[options.widget];
  const fixedStock = options.widget === 'create' && !!options.stock && ADDRESS.test(options.stock);
  const hide = parseEmbedHide((options.hide ?? []).join(','))
    .filter((section) => own.includes(section))
    .filter((section) => section !== 'stocks' || fixedStock);
  if (hide.length > 0) params.set('hide', hide.join(','));
  const accent = parseEmbedAccent(options.accent);
  if (accent) params.set('accent', accent.slice(1));
  // Commas are legal in a query; left unescaped, `hide=steps,buy` stays readable in the host's code.
  const query = params.toString().replaceAll('%2C', ',');
  return query ? `${path}?${query}` : path;
}

/** The frame height the code starts with: the trade widget grows by what `show` adds under it. */
export function embedHeight(options: Pick<EmbedOptions, 'widget' | 'show'>): number {
  if (options.widget === 'create') return EMBED_HEIGHT.create;
  const show = parseEmbedShow((options.show ?? []).join(','));
  const chart = show.includes('chart') ? MODULE_HEIGHT.chart : 0;
  const records = show.some((module) => module !== 'chart') ? MODULE_HEIGHT.records : 0;
  return EMBED_HEIGHT.trade + chart + records;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** The iframe a host pastes. Not sandboxed: wallets open popups and extensions inject into the frame. */
export function embedSnippet(appUrl: string, options: EmbedOptions): string {
  const src = `${appUrl.replace(/\/+$/u, '')}${embedPath(options)}`;
  const title = options.widget === 'trade' ? 'Trade on BStocks Launchpad' : 'Create a token on BStocks Launchpad';
  return [
    '<iframe',
    `  src="${escapeAttribute(src)}"`,
    `  title="${title}"`,
    `  width="100%" height="${embedHeight(options)}"`,
    '  style="border:0;max-width:480px;border-radius:8px"',
    '  allow="clipboard-write"',
    '  loading="lazy"',
    '></iframe>',
  ].join('\n');
}

/**
 * Optional host script: grows each widget frame to its content. It trusts only messages from this
 * site's origin, and only resizes the frame that sent them.
 */
export function embedResizeScript(appUrl: string): string {
  const origin = new URL(appUrl).origin;
  return [
    '<script>',
    "window.addEventListener('message', function (e) {",
    `  if (e.origin !== '${origin}' || !e.data || e.data.source !== '${EMBED_MESSAGE_SOURCE}' || e.data.type !== 'resize') return;`,
    "  document.querySelectorAll('iframe').forEach(function (f) {",
    "    if (f.contentWindow === e.source) f.style.height = e.data.height + 'px';",
    '  });',
    '});',
    '</script>',
  ].join('\n');
}

/**
 * What a click on a link inside a widget should do. Only widget pages stay in the frame: any other
 * page of this site would show the full site squeezed into the host's box, and other sites mostly
 * refuse to be framed at all, so both open in a new tab. Links that already choose their own
 * target, and anything that is not http(s), are left alone.
 */
export function embedLinkAction(href: string | null, pageUrl: string, target: string | null = null): 'frame' | 'new-tab' | 'default' {
  if (!href || href.startsWith('#')) return 'default';
  if (target && target !== '_self') return 'default';
  let url: URL;
  let page: URL;
  try {
    page = new URL(pageUrl);
    url = new URL(href, page);
  } catch {
    return 'default';
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'default';
  if (url.origin === page.origin && (url.pathname === '/embed' || url.pathname.startsWith('/embed/'))) return 'frame';
  return 'new-tab';
}

/**
 * Keeps the host's look and choices (`theme`, `eligibility`, `accent`, `hide`) when the widget
 * moves from create to trade inside the frame. `hide` goes along whole: the trade widget ignores the
 * create form's sections, and a host that hid the title in one wants it gone in the other too.
 */
export function withEmbedParams(path: string, search: string): string {
  const current = new URLSearchParams(search);
  const params = new URLSearchParams();
  const theme = parseEmbedTheme(current.get('theme'));
  if (theme !== 'auto') params.set('theme', theme);
  if (parseEmbedEligibility(current.get('eligibility')) === 'always') params.set('eligibility', 'always');
  const accent = parseEmbedAccent(current.get('accent'));
  if (accent) params.set('accent', accent.slice(1));
  const hide = parseEmbedHide(current.get('hide'));
  if (hide.length > 0) params.set('hide', hide.join(','));
  // Commas are legal in a query; left unescaped, `hide=steps,buy` stays readable in the host's code.
  const query = params.toString().replaceAll('%2C', ',');
  if (!query) return path;
  return `${path}${path.includes('?') ? '&' : '?'}${query}`;
}
