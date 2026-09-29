'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';

import { Checkbox } from '@/components/ui/controls';
import { Banner } from '@/components/ui/display';
import { Button, cx } from '@/components/ui/primitives';
import { eligibilityHeaders, storeAttestation, storedAttestation, subscribeAttestation } from '@/lib/eligibility';
import type { RegionState } from '@/lib/region';

/**
 * When the "not a US person" question is asked before a trade or a launch.
 *
 * `region` (the default): only when the server refuses this visitor until they answer, which is a
 * connection from a blocked country (lib/region.ts). `always`: every visitor answers once before
 * their first trade, whatever their country; a site embedding a widget chooses this with
 * `?eligibility=always`. The server enforces `region`; `always` is the host's own extra step.
 */
export type EligibilityPolicy = 'region' | 'always';

const PolicyContext = createContext<EligibilityPolicy>('region');

export function EligibilityPolicyProvider({ policy, children }: { policy: EligibilityPolicy; children: ReactNode }) {
  return <PolicyContext.Provider value={policy}>{children}</PolicyContext.Provider>;
}

const REGION_KEY = ['region'] as const;
const ASK_EVENT = 'eligibility:ask';

/**
 * Something the server refused on eligibility grounds although the page thought it would not (the
 * cookie expired, the answer was withdrawn elsewhere): read the region again and ask again.
 */
export function askEligibility() {
  window.dispatchEvent(new Event(ASK_EVENT));
}

export function onAskEligibility(handler: () => void): () => void {
  window.addEventListener(ASK_EVENT, handler);
  return () => window.removeEventListener(ASK_EVENT, handler);
}

async function fetchRegion(init?: RequestInit): Promise<RegionState> {
  const res = await fetch('/api/region', { cache: 'no-store', ...init, headers: { ...(init?.headers as Record<string, string> | undefined), ...eligibilityHeaders() } });
  if (!res.ok) throw new Error(`Region request failed (${res.status}).`);
  return (await res.json()) as RegionState;
}

export type Eligibility = {
  region: RegionState | undefined;
  policy: EligibilityPolicy;
  /** This visitor said they are not a US person, and the answer is still on this device. */
  attested: boolean;
  /** The server refuses this visitor whatever they say (`GEOBLOCK_MODE=block`). */
  blocked: boolean;
  /** Ask before the next trade or launch. */
  needsCheck: boolean;
  confirm: () => Promise<boolean>;
  confirming: boolean;
  confirmFailed: boolean;
};

export function useEligibility(): Eligibility {
  const policy = useContext(PolicyContext);
  const qc = useQueryClient();
  const region = useQuery<RegionState>({ queryKey: REGION_KEY, queryFn: () => fetchRegion(), staleTime: 5 * 60_000, retry: 1 });
  const stored = useSyncExternalStore(subscribeAttestation, () => storedAttestation(), () => false);
  const [confirming, setConfirming] = useState(false);
  const [confirmFailed, setConfirmFailed] = useState(false);

  useEffect(() => onAskEligibility(() => void qc.invalidateQueries({ queryKey: REGION_KEY })), [qc]);

  const confirm = useCallback(async () => {
    setConfirming(true);
    setConfirmFailed(false);
    try {
      const next = await fetchRegion({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) });
      storeAttestation(true);
      qc.setQueryData(REGION_KEY, next);
      // A quote refused a moment ago is asked again now rather than on its next tick.
      void qc.invalidateQueries({ queryKey: ['quote'] });
      return true;
    } catch {
      setConfirmFailed(true);
      return false;
    } finally {
      setConfirming(false);
    }
  }, [qc]);

  const data = region.data;
  const attested = !!data?.attested || stored;
  const blocked = !!data?.restricted && data.mode === 'block';
  const needsCheck = !blocked && (!!data?.restricted || (policy === 'always' && !attested));
  return { region: data, policy, attested, blocked, needsCheck, confirm, confirming, confirmFailed };
}

export const ATTESTATION_TEXT =
  'I confirm that I am not a US person: I do not live in the United States and I am not a US citizen or resident. I am eligible to hold and trade Coinbase tokenized stocks under the issuer’s terms.';

/**
 * The question itself, where the action is. Shown in place of nothing: the trade or launch button
 * below it stays disabled until it is answered.
 */
export function EligibilityCheck({ eligibility, action = 'trade', secondary, className }: { eligibility: Eligibility; action?: 'trade' | 'launch'; secondary?: ReactNode; className?: string }) {
  const [checked, setChecked] = useState(false);
  const { region } = eligibility;
  return (
    <div role="group" aria-label="Eligibility" className={cx('border border-line rounded-[8px] p-3 flex flex-col gap-3', className)}>
      <div>
        <div className="text-[13px] font-medium">Before you {action === 'launch' ? 'launch' : 'trade'}{region?.restricted && region.country ? ` · connection from ${region.country}` : ''}</div>
        <p className="text-[12px] text-ink-secondary mt-0.5 leading-relaxed">Every token here is paired with a Coinbase tokenized stock, offered only to eligible persons outside the United States.</p>
      </div>
      <Checkbox checked={checked} onChange={setChecked}>
        <span className="text-ink leading-relaxed">{ATTESTATION_TEXT}</span>
      </Checkbox>
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" disabled={!checked} loading={eligibility.confirming} onClick={() => void eligibility.confirm()}>
          Confirm and continue
        </Button>
        {secondary}
      </div>
      {eligibility.confirmFailed && <p className="text-[12px] text-danger-fg">Could not save your confirmation. Please try again.</p>}
      <p className="text-[11px] text-ink-muted leading-relaxed">Kept on this device for 30 days. Nothing about you is recorded.</p>
    </div>
  );
}

/** The refusal where the action would be, for a deployment that does not take the visitor's word. */
export function RegionBlocked({ action = 'trade' }: { action?: 'trade' | 'launch' }) {
  return (
    <Banner tone="warning">
      {action === 'launch' ? 'Launching' : 'Trading'} is not available from your region. Every token here is paired with a Coinbase tokenized stock, offered only to eligible persons outside the
      United States.
    </Banner>
  );
}
