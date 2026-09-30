import { LinkButton, Module, ModuleHeader } from '@/components/ui/primitives';

const FACTS = [
  ['No key', 'Every route is public. Nothing to sign up for.'],
  ['Your user signs', 'The API returns the calls; the visitor\'s own wallet sends them. Nothing is held for anyone.'],
  ['Same as this site', 'The same code builds the trade and the launch, with the same fees: 1%, 70% to the creator.'],
] as const;

/**
 * The Widgets page's pointer to the API, for a site that wants its own interface instead of a frame.
 * The reference itself lives on /docs/api.
 */
export function ApiGuide() {
  return (
    <Module ticks id="api" className="scroll-mt-24">
      <ModuleHeader index="API" title="Your own interface instead of a widget" />
      <div className="p-4 md:p-5 flex flex-col gap-4">
        <p className="text-[14px] text-ink-secondary leading-relaxed max-w-[80ch]">
          Everything a widget does is one API call away: quotes, token data, and ready-to-sign transactions for a trade or a launch. The reference has every route with its parameters, a curl line and a live Try it; the spec and the plain-text versions are there for tools and AI agents.
        </p>
        <ul className="grid grid-cols-1 md:grid-cols-3 gap-px bg-line border border-line rounded-[8px] overflow-hidden">
          {FACTS.map(([title, text]) => (
            <li key={title} className="bg-canvas p-4 flex flex-col gap-1">
              <span className="text-[15px] text-ink font-medium">{title}</span>
              <span className="text-[13px] text-ink-secondary">{text}</span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap gap-2">
          <LinkButton href="/docs/api" variant="primary" size="sm">
            API reference
          </LinkButton>
          <LinkButton href="/docs/api#quick-start" size="sm">
            Quick start
          </LinkButton>
          <LinkButton href="/api/openapi.json" external size="sm">
            OpenAPI spec
          </LinkButton>
          <LinkButton href="/llms.txt" external size="sm">
            llms.txt
          </LinkButton>
        </div>
      </div>
    </Module>
  );
}
