'use client'

import { useEffect, useState } from 'react'
import { Sheet } from '@/components/ui/sheet'

/**
 * The eligibility question, asked on arrival.
 *
 * Every pool here is quoted in a Coinbase tokenized stock, so using this launchpad means holding
 * one, and the issuer offers them only to eligible persons outside the United States. The edge
 * middleware already refuses the routes that build a trade; this tells the visitor why, before they
 * fill in a form and find out.
 *
 * Reading stays open either way: prices, charts, holders and the market list are public.
 */
export function EligibilityGate() {
  const [restricted, setRestricted] = useState(false)
  const [country, setCountry] = useState<string | null>(null)
  // Not remembered across pages. The shell keys this component by pathname, so closing it clears
  // the current page and the next one asks again: somebody being refused should be told on every
  // page they land on, not once and then silently.
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    let live = true
    fetch('/api/region')
      .then((r) => r.json() as Promise<{ restricted?: boolean; country?: string | null }>)
      .then((d) => {
        if (!live) return
        setRestricted(!!d.restricted)
        setCountry(d.country ?? null)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [])

  const close = () => setDismissed(true)

  return (
    <Sheet open={restricted && !dismissed} onClose={close} title="Not available in your region">
      <div className="flex flex-col gap-4 text-[14px]">
        <p className="text-ink-secondary leading-relaxed">
          Every token on this launchpad is paired with a Coinbase tokenized stock, so creating or trading one means holding a tokenized stock. Those are offered only to eligible persons outside the
          United States.
          {country ? ` This connection looks like it comes from ${country}.` : ''}
        </p>
        <p className="text-ink-secondary leading-relaxed">You can still browse markets, prices, charts and holders. Creating a token and building a swap are closed from your location.</p>
        <button
          type="button"
          onClick={close}
          className="self-start inline-flex items-center h-10 px-4 rounded-[6px] border border-line text-[13px] font-medium text-ink-secondary transition-fast hover:border-line-strong hover:text-ink"
        >
          Continue browsing
        </button>
      </div>
    </Sheet>
  )
}
