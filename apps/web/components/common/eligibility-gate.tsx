'use client'

import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/primitives'
import { Sheet } from '@/components/ui/sheet'

import { EligibilityCheck, onAskEligibility, useEligibility } from './eligibility'

export { askEligibility } from './eligibility'

/**
 * The eligibility question, asked on arrival on the site itself.
 *
 * Every pool here is quoted in a Coinbase tokenized stock, so using this launchpad means holding
 * one, and the issuer offers them only to eligible persons outside the United States. The edge
 * proxy refuses the routes that build a trade for a blocked country until the visitor confirms they
 * are not a US person (lib/region.ts); this asks before they fill in a form and find out. The trade
 * panel and the create form ask the same question again at the button, so closing this with "just
 * browsing" costs nothing.
 *
 * Only the site shows it. A widget asks at the button alone: a dialog is centred in its frame, and a
 * frame grown to the create form's full height would put it out of the host page's view.
 *
 * Confirming keeps the answer for 30 days and the question stops. "Just browsing" closes it for this
 * page only: the shell keys this component by pathname, so the next page asks again. Reading stays
 * open either way: prices, charts, holders and the market list are public.
 */
export function EligibilityGate() {
  const eligibility = useEligibility()
  const [dismissed, setDismissed] = useState(false)
  useEffect(() => onAskEligibility(() => setDismissed(false)), [])

  const region = eligibility.region
  const close = () => setDismissed(true)
  const attest = region?.mode === 'attest'

  return (
    <Sheet open={!!region?.restricted && !dismissed} onClose={close} title={attest ? 'Before you trade' : 'Not available in your region'}>
      <div className="flex flex-col gap-4 text-[14px]">
        <p className="text-ink-secondary leading-relaxed">
          Every token on this launchpad is paired with a Coinbase tokenized stock, so creating or trading one means holding a tokenized stock. Those are offered only to eligible persons outside the
          United States.
          {region?.country ? ` This connection looks like it comes from ${region.country}.` : ''}
        </p>

        {attest ? (
          <EligibilityCheck
            eligibility={eligibility}
            secondary={
              <Button size="sm" variant="secondary" onClick={close}>
                I&apos;m just browsing
              </Button>
            }
          />
        ) : (
          <>
            <p className="text-ink-secondary leading-relaxed">You can still browse markets, prices, charts and holders. Creating a token and building a swap are closed from your location.</p>
            <Button variant="secondary" onClick={close} className="self-start">
              Continue browsing
            </Button>
          </>
        )}
      </div>
    </Sheet>
  )
}
