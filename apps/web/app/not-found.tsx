import { LinkButton } from '@/components/ui/primitives';

export default function NotFound() {
  return (
    <div className="border border-line rounded-[8px] p-8 md:p-12 flex flex-col gap-4 items-start ticks">
      <div className="eyebrow">404</div>
      <h1 className="display text-[32px] md:text-[40px] leading-none">Not found.</h1>
      <p className="text-ink-secondary max-w-[48ch]">Nothing lives at this address. Only tokens launched through the StockPair factory are listed, identified by contract address.</p>
      <LinkButton href="/markets" variant="primary">
        Browse markets
      </LinkButton>
    </div>
  );
}
