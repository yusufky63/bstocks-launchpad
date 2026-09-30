'use client';

import { Play, RotateCcw, Wallet } from 'lucide-react';
import { useId, useMemo, useState } from 'react';
import { useAccount } from 'wagmi';

import { Badge, Button, cx } from '@/components/ui/primitives';
import { CodeBlock } from '@/components/widgets/code-block';
import { buildApiRequest, curlOf, exampleValues, type ApiEndpoint, type ApiParam } from '@/lib/api-reference';
import { eligibilityHeaders } from '@/lib/eligibility';

type Result = { status: number; ms: number; body: string } | { error: string };

/** The fields a form shows: every parameter, with an object's fields flattened as `parent.field`. */
function formFields(endpoint: ApiEndpoint): Array<{ key: string; param: ApiParam }> {
  return endpoint.params.flatMap((param) =>
    param.type === 'object' ? (param.fields ?? []).map((field) => ({ key: `${param.name}.${field.name}`, param: field })) : [{ key: param.name, param }],
  );
}

function statusTone(status: number): 'positive' | 'warning' | 'danger' {
  if (status < 300) return 'positive';
  return status < 500 ? 'warning' : 'danger';
}

/**
 * Runs one endpoint from the reference page against this site, with the example values filled in.
 * The request is exactly what the curl line beside it says; the answer is shown as the API sent it.
 */
export function TryIt({ endpoint }: { endpoint: ApiEndpoint }) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => exampleValues(endpoint));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const { address } = useAccount();
  const fields = formFields(endpoint);
  const request = useMemo(() => buildApiRequest(endpoint, values), [endpoint, values]);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const missing = fields.some(({ key, param }) => param.required && !key.includes('.') && !(values[key] ?? '').trim());

  const send = async () => {
    setBusy(true);
    setResult(null);
    const started = performance.now();
    try {
      // The answer this browser gave the eligibility question counts here as it does on the site.
      const res = await fetch(request.url, { method: request.method, headers: { ...request.headers, ...eligibilityHeaders() }, ...(request.body ? { body: request.body } : {}), cache: 'no-store' });
      const text = await res.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        /* not JSON: shown as sent */
      }
      setResult({ status: res.status, ms: Math.round(performance.now() - started), body });
    } catch (err) {
      setResult({ error: err instanceof Error ? err.message : 'The request did not complete.' });
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-expanded={false} aria-controls={id}>
        <Play size={14} strokeWidth={1.75} /> Try it
      </Button>
    );
  }

  return (
    <div id={id} className="flex flex-col gap-3 border border-line rounded-[8px] p-3 md:p-4 bg-surface">
      <div className="flex items-center justify-between gap-2">
        <span className="eyebrow">Try it</span>
        <button type="button" onClick={() => setOpen(false)} className="text-[12px] text-ink-secondary hover:text-ink transition-fast">
          Close
        </button>
      </div>

      {fields.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {fields.map(({ key, param }) => (
            <label key={key} className="flex flex-col gap-1 min-w-0">
              <span className="flex items-center gap-1.5 font-mono text-[12px] text-ink">
                {key}
                {param.required && <span className="text-danger-fg" aria-label="required">*</span>}
                <span className="text-ink-muted">{param.in} · {param.type}</span>
              </span>
              {param.type === 'enum' || param.type === 'boolean' ? (
                <select
                  value={values[key] ?? ''}
                  onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                  className="h-10 min-w-0 rounded-[6px] border border-line-strong bg-canvas px-2.5 font-mono text-[13px] text-ink outline-none focus:border-primary"
                >
                  <option value="">{param.required ? 'choose' : 'not set'}</option>
                  {(param.type === 'boolean' ? ['true', 'false'] : (param.enum ?? [])).map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="flex items-center gap-1.5 min-w-0">
                  <input
                    value={values[key] ?? ''}
                    onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
                    placeholder={param.default ? `default ${param.default}` : param.type}
                    spellCheck={false}
                    autoComplete="off"
                    className="h-10 min-w-0 flex-1 rounded-[6px] border border-line-strong bg-canvas px-2.5 font-mono text-[13px] text-ink outline-none placeholder:text-ink-muted focus:border-primary"
                  />
                  {param.type === 'address' && address && (
                    <button
                      type="button"
                      title="Use the connected wallet"
                      aria-label={`Use the connected wallet for ${key}`}
                      onClick={() => setValues((v) => ({ ...v, [key]: address.toLowerCase() }))}
                      className="h-10 w-10 shrink-0 inline-flex items-center justify-center rounded-[6px] border border-line text-ink-secondary hover:text-ink hover:border-line-strong transition-fast"
                    >
                      <Wallet size={14} strokeWidth={1.75} />
                    </button>
                  )}
                </span>
              )}
            </label>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={() => void send()} loading={busy} disabled={missing}>
          <Play size={14} strokeWidth={1.75} /> Send request
        </Button>
        <Button size="sm" variant="ghost" onClick={() => { setValues(exampleValues(endpoint)); setResult(null); }}>
          <RotateCcw size={14} strokeWidth={1.75} /> Reset
        </Button>
        {missing && <span className="text-[12px] text-ink-muted">Fill in the fields marked *.</span>}
      </div>

      <CodeBlock label="Request" code={curlOf({ ...request, url: `${origin}${request.url}` })} />

      {result && (
        <div className="flex flex-col gap-2" aria-live="polite">
          {'error' in result ? (
            <p className="text-[13px] text-danger-fg">{result.error}</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <Badge tone={statusTone(result.status)}>{result.status}</Badge>
                <span className="font-mono text-[12px] text-ink-muted">{result.ms} ms</span>
              </div>
              <pre className={cx('max-h-[360px] overflow-auto rounded-[6px] border border-line bg-canvas p-3 font-mono text-[12px] leading-relaxed text-ink')}>
                <code>{result.body}</code>
              </pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
