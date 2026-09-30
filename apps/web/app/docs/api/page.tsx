import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { EndpointCard } from '@/components/api/endpoint-card';
import { LinkButton, Module, ModuleHeader, PageTitle } from '@/components/ui/primitives';
import { CodeBlock } from '@/components/widgets/code-block';
import { apiLaunchExample, apiRules, apiSwapExample } from '@/lib/api-guide';
import { API_ENDPOINTS, API_GROUPS, endpointsIn } from '@/lib/api-reference';
import { publicEnv } from '@/lib/env';
import { API_LIMITS } from '@/lib/rate-limit.server';

export const metadata: Metadata = {
  title: 'API reference',
  description: 'Every launchpad endpoint with parameters, errors, curl and a live Try it, plus the OpenAPI spec and llms.txt for tools and AI agents.',
};

/** The rail and the section numbers come from here, as on the docs page. */
const INTRO = [
  ['overview', 'Overview'],
  ['quick-start', 'Quick start'],
  ['resources', 'For AI and tools'],
] as const;

function Section({ id, index, title, children }: { id: string; index: string; title: string; children: ReactNode }) {
  return (
    <Module id={id} className="scroll-mt-24">
      <ModuleHeader index={index} title={title} />
      <div className="p-4 md:p-5 flex flex-col gap-4 text-[14px] text-ink-secondary leading-relaxed [&_code]:font-mono [&_code]:text-[12px] [&_code]:text-ink">{children}</div>
    </Module>
  );
}

const RESOURCES = [
  { path: '/llms.txt', title: 'llms.txt', text: 'The short index for language models: what the launchpad is and where everything lives.' },
  { path: '/llms-full.txt', title: 'llms-full.txt', text: 'This whole reference in one plain-text file: conventions, every endpoint, examples, contracts, widget options. Paste it into a model\'s context.' },
  { path: '/api/openapi.json', title: 'OpenAPI 3.1', text: 'Import the URL into Swagger, Postman or a code generator, or give it to an agent as its tool definitions.' },
] as const;

export default function ApiReferencePage() {
  const appUrl = publicEnv.appUrl;
  const limits = API_LIMITS;
  const partnerRoutes = API_ENDPOINTS.filter((e) => e.partner && e.id !== 'openapi');
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        index="08 — API"
        title="API reference"
        lead="Read the launchpad and build ready-to-sign transactions for a trade or a launch. No key and no login: the user's own wallet signs every transaction, and the fees are the same as on this site."
        action={<LinkButton href="/docs">Technical docs</LinkButton>}
      />

      <div className="grid grid-cols-1 lg:grid-cols-[240px_minmax(0,1fr)] gap-5 items-start">
        <nav aria-label="API sections" className="lg:sticky lg:top-[72px] lg:max-h-[calc(100dvh-96px)] lg:overflow-y-auto border border-line rounded-[8px] bg-canvas p-2 flex flex-col gap-0.5">
          {INTRO.map(([id, label], i) => (
            <a key={id} href={`#${id}`} className="rail flex items-center gap-2 px-3 py-2 rounded-[6px] text-[13px] text-ink-secondary hover:text-ink hover:bg-surface transition-fast">
              <span className="font-mono text-[10px] text-primary">{String(i + 1).padStart(2, '0')}</span>
              {label}
            </a>
          ))}
          {API_GROUPS.map((group, g) => (
            <div key={group.id} className="flex flex-col gap-0.5 pt-2">
              <a href={`#group-${group.id}`} className="rail flex items-center gap-2 px-3 py-2 rounded-[6px] text-[13px] text-ink hover:bg-surface transition-fast">
                <span className="font-mono text-[10px] text-primary">{String(INTRO.length + g + 1).padStart(2, '0')}</span>
                {group.title}
              </a>
              <div className="hidden lg:flex flex-col">
                {endpointsIn(group.id).map((e) => (
                  <a key={e.id} href={`#${e.id}`} className="flex items-center gap-2 pl-8 pr-3 py-1 rounded-[6px] font-mono text-[11px] text-ink-muted hover:text-ink hover:bg-surface transition-fast min-w-0">
                    <span className={e.method === 'POST' ? 'text-primary w-8 shrink-0' : 'w-8 shrink-0'}>{e.method}</span>
                    <span className="truncate">{e.path.replace('/api', '')}</span>
                  </a>
                ))}
              </div>
            </div>
          ))}
        </nav>

        <div className="flex flex-col gap-5 min-w-0">
          <Section id="overview" index="01" title="Overview">
            <p className="max-w-[80ch]">
              Every route answers JSON over HTTPS at <code>{appUrl}/api</code>. Reads come from the indexer and live pool reads; the transaction routes return the calls a wallet sends and never sign anything. The same code serves this site, so what works here works for you.
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[520px] border-collapse">
                <tbody className="divide-y divide-line border-y border-line">
                  {apiRules(appUrl).map((rule) => (
                    <tr key={rule.label} className="align-top">
                      <th scope="row" className="py-2.5 pr-4 w-[150px] text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted font-normal">
                        {rule.label}
                      </th>
                      <td className="py-2.5 text-[14px] text-ink">{rule.text}</td>
                    </tr>
                  ))}
                  <tr className="align-top">
                    <th scope="row" className="py-2.5 pr-4 text-left font-mono text-[11px] uppercase tracking-[0.12em] text-ink-muted font-normal">
                      Limits
                    </th>
                    <td className="py-2.5 text-[14px] text-ink">
                      per caller, a minute: {limits.quote} quotes, {limits.tx} transaction builds, {limits.token} token reads, {limits.wallet} wallet reads · over it, <code>429</code> with <code>retry-after</code>
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p className="max-w-[80ch]">
              <strong className="text-ink">Partner sites.</strong> A listed site may call these from its visitors&apos; browsers, so the limits and the eligibility question apply to each visitor:{' '}
              {partnerRoutes.map((e, i) => (
                <span key={e.id}>
                  <a href={`#${e.id}`} className="text-primary">
                    <code>
                      {e.method} {e.path}
                    </code>
                  </a>
                  {i < partnerRoutes.length - 1 ? ', ' : '.'}
                </span>
              ))}
            </p>
          </Section>

          <Section id="quick-start" index="02" title="Quick start">
            <ol className="grid grid-cols-1 md:grid-cols-3 gap-px bg-line border border-line rounded-[8px] overflow-hidden">
              {[
                ['Ask for the calls', 'POST /api/tx/swap or /api/tx/launch with the account that will send them.'],
                ['Send them in order', 'Hand each call to that wallet: the approval first, when there is one.'],
                ['Wait for the receipt', 'The deadline is ten minutes. If an approval took longer, ask again.'],
              ].map(([title, text], i) => (
                <li key={title} className="bg-canvas p-4 flex flex-col gap-1">
                  <span className="font-mono text-[11px] text-primary">0{i + 1}</span>
                  <span className="text-[15px] text-ink font-medium">{title}</span>
                  <span className="text-[13px] text-ink-secondary">{text}</span>
                </li>
              ))}
            </ol>
            <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
              <CodeBlock label="A trade" code={apiSwapExample(appUrl)} />
              <CodeBlock label="A launch" code={apiLaunchExample(appUrl)} />
            </div>
          </Section>

          <Section id="resources" index="03" title="For AI and tools">
            <p className="max-w-[80ch]">Machine-readable versions of this page, built from the same list, so a model or a tool reads exactly what you read here.</p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-px bg-line border border-line rounded-[8px] overflow-hidden">
              {RESOURCES.map((r) => (
                <div key={r.path} className="bg-canvas p-4 flex flex-col gap-2 min-w-0">
                  <span className="text-[15px] text-ink font-medium">{r.title}</span>
                  <span className="text-[13px] text-ink-secondary flex-1">{r.text}</span>
                  <code className="block truncate">{`${appUrl}${r.path}`}</code>
                  <LinkButton href={r.path} external size="sm">
                    Open
                  </LinkButton>
                </div>
              ))}
            </div>
          </Section>

          {API_GROUPS.map((group, g) => (
            <section key={group.id} id={`group-${group.id}`} className="scroll-mt-24 flex flex-col gap-3">
              <div className="px-1">
                <div className="eyebrow">
                  <span className="text-primary">{String(INTRO.length + g + 1).padStart(2, '0')}</span> {group.title}
                </div>
                <p className="mt-1 text-[14px] text-ink-secondary max-w-[80ch]">{group.intro}</p>
              </div>
              {endpointsIn(group.id).map((endpoint) => (
                <EndpointCard key={endpoint.id} endpoint={endpoint} appUrl={appUrl} limitPerMinute={endpoint.limit ? limits[endpoint.limit] : undefined} />
              ))}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}
