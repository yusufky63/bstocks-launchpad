import { Badge, Module } from '@/components/ui/primitives';
import { CodeBlock } from '@/components/widgets/code-block';
import { curlExample, type ApiEndpoint, type ApiParam } from '@/lib/api-reference';

import { TryIt } from './try-it';

/** `integer 1–200 · default 50`, `enum: buy | sell`: what a value may be, in one cell. */
function typeText(p: ApiParam): string {
  const parts = [p.type === 'enum' ? (p.enum ?? []).join(' | ') : p.type];
  if (p.min !== undefined || p.max !== undefined) parts.push(`${p.min ?? '…'}–${p.max ?? '…'}`);
  if (p.default !== undefined) parts.push(`default ${p.default}`);
  return parts.join(' · ');
}

function ParamRows({ params, prefix = '' }: { params: readonly ApiParam[]; prefix?: string }) {
  return (
    <>
      {params.map((p) => (
        <FragmentRow key={`${prefix}${p.name}`} p={p} prefix={prefix} />
      ))}
    </>
  );
}

function FragmentRow({ p, prefix }: { p: ApiParam; prefix: string }) {
  return (
    <>
      <tr className="align-top">
        <td className="py-2 pr-3 font-mono text-[12px] text-ink whitespace-nowrap">
          {prefix}
          {p.name}
          {p.required && <span className="text-danger-fg" title="required"> *</span>}
        </td>
        <td className="py-2 pr-3 font-mono text-[12px] text-ink-muted whitespace-nowrap">{p.in}</td>
        <td className="py-2 pr-3 font-mono text-[12px] text-ink-secondary">{typeText(p)}</td>
        <td className="py-2 text-[13px] text-ink-secondary">{p.description}</td>
      </tr>
      {p.fields && <ParamRows params={p.fields} prefix={`${prefix}${p.name}.`} />}
    </>
  );
}

/** One endpoint: what it does, what it takes, what it answers, and a live request. */
export function EndpointCard({ endpoint, appUrl, limitPerMinute }: { endpoint: ApiEndpoint; appUrl: string; limitPerMinute?: number }) {
  return (
    <Module id={endpoint.id} className="scroll-mt-24">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 border-b border-line">
        <Badge tone={endpoint.method === 'POST' ? 'primary' : 'neutral'} className="font-mono">
          {endpoint.method}
        </Badge>
        <code className="font-mono text-[14px] text-ink break-all">{endpoint.path}</code>
        <span className="flex flex-wrap items-center gap-1.5 md:ml-auto">
          {endpoint.partner && <Badge title="Listed partner sites may call it from a browser">partner CORS</Badge>}
          {limitPerMinute !== undefined && <Badge title="Requests a minute per caller">{limitPerMinute}/min</Badge>}
          {endpoint.eligibility && (
            <Badge tone="warning" title="Answers 451 from a restricted country until the visitor confirms eligibility">
              eligibility
            </Badge>
          )}
          {endpoint.body && <Badge>{endpoint.body === 'json' ? 'JSON body' : 'multipart'}</Badge>}
        </span>
      </div>

      <div className="p-4 md:p-5 flex flex-col gap-4 min-w-0">
        <div>
          <h3 className="display-medium text-[18px] text-ink">{endpoint.summary}</h3>
          <p className="mt-1 text-[14px] text-ink-secondary leading-relaxed max-w-[80ch]">{endpoint.description}</p>
        </div>

        {endpoint.params.length > 0 && (
          <div className="overflow-x-auto -mx-4 md:mx-0 px-4 md:px-0">
            <table className="w-full min-w-[560px] border-collapse">
              <thead>
                <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted border-b border-line">
                  <th className="py-2 pr-3 font-normal">Name</th>
                  <th className="py-2 pr-3 font-normal">In</th>
                  <th className="py-2 pr-3 font-normal">Type</th>
                  <th className="py-2 font-normal">Description</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                <ParamRows params={endpoint.params} />
              </tbody>
            </table>
          </div>
        )}

        <dl className="grid grid-cols-1 md:grid-cols-[120px_minmax(0,1fr)] gap-x-4 gap-y-2 text-[13px]">
          <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted pt-0.5">Returns</dt>
          <dd className="font-mono text-[12px] text-ink break-words">{endpoint.returns}</dd>
          {endpoint.errors.length > 0 && (
            <>
              <dt className="font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted pt-0.5">Errors</dt>
              <dd className="flex flex-wrap gap-1.5">
                {endpoint.errors.map((e) => (
                  <code key={e} className="font-mono text-[11px] text-ink-secondary border border-line rounded-[4px] px-1.5 py-0.5">
                    {e}
                  </code>
                ))}
              </dd>
            </>
          )}
        </dl>

        <CodeBlock label="curl" code={curlExample(endpoint, appUrl)} />
        {endpoint.tryable ? (
          <div className="self-start w-full">
            <TryIt endpoint={endpoint} />
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">Not runnable from this page: it {endpoint.body === 'multipart' ? 'uploads to IPFS or stores a write' : endpoint.id === 'image' ? 'answers with image bytes' : endpoint.id === 'openapi' ? 'is the spec itself; open it from Resources above' : 'sets a cookie'}.</p>
        )}
      </div>
    </Module>
  );
}
