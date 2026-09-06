'use client';

import { useMutation } from '@tanstack/react-query';
import { ArrowUpRight, ImagePlus } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Address, Hex } from 'viem';
import { useAccount, usePublicClient, useReadContracts, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';

import { stockPairFactoryAbi } from '@stockpair/core';

import { ConnectButton } from '@/components/layout/connect-button';
import { StockCoin } from '@/components/stock/stock-coin';
import { Input, TextArea } from '@/components/ui/controls';
import { Banner, TxLink } from '@/components/ui/display';
import { Button, KeyValue, Module, ModuleHeader, cx } from '@/components/ui/primitives';
import { publicEnv } from '@/lib/env';
import { formatNumber, formatUsd } from '@/lib/format';
import { normalizeTwitter } from '@/lib/twitter';
import { useStocks } from '@/lib/queries';
import { describeTradeError } from '@/lib/trade';
import type { StocksResponse } from '@/lib/types';

type Errors = Partial<Record<'name' | 'symbol' | 'description' | 'website' | 'twitter' | 'image' | 'stock', string>>;
type Step = { label: string; txHash?: Hex };

function randomSalt(): Hex {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export function CreateForm({ initialStocks }: { initialStocks: StocksResponse }) {
  const router = useRouter();
  const { address, isConnected, chainId } = useAccount();
  const client = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const deployment = publicEnv.deployment;

  const [name, setName] = useState('');
  const [symbol, setSymbol] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [twitter, setTwitter] = useState('');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [stock, setStock] = useState<string | null>(null);
  const [errors, setErrors] = useState<Errors>({});
  const [step, setStep] = useState<Step | null>(null);

  const { data: stocksData } = useStocks(initialStocks);
  const stocks = (stocksData?.stocks ?? []).filter((s) => s.enabled);
  const factoryReads = useReadContracts({
    contracts: [
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'creationFee' },
      { address: deployment?.factory, abi: stockPairFactoryAbi, functionName: 'openingFdvUsd8' },
    ],
    query: { enabled: Boolean(deployment) },
  });
  const creationFee = factoryReads.data?.[0]?.result as bigint | undefined;
  const openingFdv = factoryReads.data?.[1]?.result as bigint | undefined;
  const feeEth = creationFee === undefined ? null : Number(creationFee) / 1e18;
  const fdvUsd = openingFdv === undefined ? 5_000 : Number(openingFdv) / 1e8;

  const selected = stocks.find((s) => s.address === stock) ?? null;
  const onBase = isConnected && !!address && chainId === base.id;

  function validate(): Errors {
    const next: Errors = {};
    if (name.trim().length < 1 || name.trim().length > 64) next.name = 'Use 1 to 64 characters.';
    if (!/^[A-Z0-9]{1,16}$/u.test(symbol)) next.symbol = 'Use 1 to 16 uppercase letters or digits.';
    if (description.length > 1_000) next.description = 'Keep the description under 1,000 characters.';
    if (website && !/^https:\/\/[^\s]+$/u.test(website)) next.website = 'Use a full https:// link.';
    if (twitter && !normalizeTwitter(twitter)) next.twitter = 'Use an X handle like @name or an x.com profile link.';
    if (image && image.size > 2 * 1024 * 1024) next.image = 'Keep the image at or below 2 MB.';
    if (image && !['image/png', 'image/webp', 'image/jpeg', 'image/gif'].includes(image.type)) next.image = 'Use PNG, WebP, JPEG or GIF.';
    if (!stock) next.stock = 'Pick the stock your token trades against.';
    return next;
  }

  const launch = useMutation({
    mutationFn: async () => {
      if (!deployment || !client || !address || !stock) throw new Error('Connect a wallet on Base first.');
      if (creationFee === undefined) throw new Error('The creation fee is still loading; try again in a second.');

      setStep({ label: 'Pinning metadata to IPFS…' });
      const form = new FormData();
      form.set('name', name.trim());
      form.set('symbol', symbol);
      form.set('description', description.trim());
      form.set('website', website.trim());
      form.set('twitter', twitter.trim());
      if (image) form.set('image', image);
      const pin = await fetch('/api/metadata', { method: 'POST', body: form });
      const pinned = (await pin.json()) as { contractURI: string } | { error: { message: string } };
      if (!pin.ok || 'error' in pinned) throw new Error('error' in pinned ? pinned.error.message : 'Metadata could not be pinned.');

      // The token address is deterministic (CREATE2 from creator + salt), so the page can open the
      // moment the wallet returns a hash; the token page waits for the block itself.
      const salt = randomSalt();
      const predicted = await client.readContract({ address: deployment.factory, abi: stockPairFactoryAbi, functionName: 'predictToken', args: [address, salt] });
      setStep({ label: 'Confirm the launch in your wallet…' });
      const hash = await writeContractAsync({
        address: deployment.factory,
        abi: stockPairFactoryAbi,
        functionName: 'launch',
        args: [{ name: name.trim(), symbol, contractURI: pinned.contractURI, stock: stock as Address, salt }],
        value: creationFee,
        chainId: base.id,
      });
      return { token: predicted, hash };
    },
    onSuccess: ({ token, hash }) => {
      setStep({ label: 'Submitted. Opening the token page…', txHash: hash });
      router.push(`/token/${token.toLowerCase()}?tx=${hash}`);
    },
    onError: () => setStep(null),
  });

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const next = validate();
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    launch.mutate();
  }

  const openingTokensPerStock = selected && selected.priceUsd !== null ? (selected.priceUsd * 1e9) / fdvUsd : null;

  return (
    <form className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_380px] gap-5 items-start" onSubmit={submit}>
      <div className="flex flex-col gap-5 min-w-0">
        <Module ticks>
          <ModuleHeader index="01" title="Token" />
          <div className="p-4 md:p-5 flex flex-col gap-4">
            <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_200px] gap-4">
              <Input label="Name" maxLength={64} value={name} onChange={(e) => setName(e.target.value)} placeholder="Nvidia Dog" error={errors.name} autoComplete="off" />
              <Input label="Symbol" maxLength={16} value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase().replace(/[^A-Z0-9]/gu, ''))} placeholder="NDOG" error={errors.symbol} autoComplete="off" autoCapitalize="characters" />
            </div>
            <TextArea label="Description" maxLength={1_000} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What is this token about?" hint={`${description.length}/1000 · stored in the token's ERC-7572 metadata`} error={errors.description} />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <Input label="Website (optional)" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" error={errors.website} autoComplete="off" />
              <Input label="X (optional)" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or x.com/handle" error={errors.twitter} autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </div>
            <div>
              <span className="block mb-1.5 text-[12px] font-mono uppercase tracking-[0.08em] text-ink-muted">Image (optional)</span>
              <label className={cx('flex items-center gap-4 rounded-[6px] border border-dashed px-4 py-3 cursor-pointer transition-fast hover:border-line-strong', errors.image ? 'border-danger' : 'border-line-strong')}>
                {preview ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={preview} alt="" className="h-14 w-14 rounded-[6px] border border-line object-cover" />
                ) : (
                  <span className="h-14 w-14 rounded-[6px] border border-line bg-surface inline-flex items-center justify-center text-ink-muted">
                    <ImagePlus size={20} strokeWidth={1.75} />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block text-[14px] font-medium">{image ? image.name : 'Choose an image'}</span>
                  <span className="block text-[12px] text-ink-muted">PNG, WebP, JPEG or GIF up to 2 MB. Pinned to IPFS.</span>
                </span>
                <input
                  type="file"
                  accept="image/png,image/webp,image/jpeg,image/gif"
                  className="sr-only"
                  onChange={(e) => {
                    const file = e.target.files?.[0] ?? null;
                    setImage(file);
                    if (preview) URL.revokeObjectURL(preview);
                    setPreview(file ? URL.createObjectURL(file) : null);
                  }}
                />
              </label>
              {errors.image && <span className="block mt-1.5 text-[13px] text-danger-fg">{errors.image}</span>}
            </div>
          </div>
        </Module>

        <Module ticks>
          <ModuleHeader index="02" title="Paired stock" action={<span className="font-mono text-[11px] text-ink-muted">{stocks.length} available</span>} />
          <div className="grid grid-cols-2 md:grid-cols-3 gap-px bg-line" role="radiogroup" aria-label="Paired stock">
            {stocks.map((s) => {
              const active = stock === s.address;
              return (
                <button
                  key={s.address}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => setStock(s.address)}
                  className={cx('rail flex items-center gap-3 px-4 py-3 text-left transition-fast bg-canvas hover:bg-surface min-h-[72px]', active && 'bg-primary-soft hover:bg-primary-soft')}
                >
                  <StockCoin ticker={s.ticker} size={36} tilt={false} />
                  <span className="min-w-0">
                    <span className={cx('block font-medium text-[15px] leading-tight', active && 'text-primary')}>{s.symbol}</span>
                    <span className="block text-[12px] text-ink-secondary truncate">{s.name}</span>
                    <span className="block font-mono num text-[11px] text-ink-muted">
                      {formatUsd(s.priceUsd)}
                      {s.feedStatus === 'paused' ? ' · last close' : ''} · {s.launches} paired
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          {errors.stock && <p className="px-4 py-2 text-[13px] text-danger-fg border-t border-line">{errors.stock}</p>}
        </Module>
      </div>

      <div className="flex flex-col gap-5 lg:sticky lg:top-[72px]">
        <Module ticks>
          <ModuleHeader index="03" title="What happens" />
          <ol className="px-4 pt-3 flex flex-col gap-2 text-[13px] text-ink-secondary">
            {[
              'A zero-admin B20 token with exactly 1,000,000,000 supply is created.',
              `A Uniswap v4 pool opens against ${selected ? selected.symbol : 'the stock you pick'} at a ${formatUsd(fdvUsd, { compact: true })} valuation, priced from the live Chainlink feed.`,
              'The whole supply is locked as liquidity forever. You keep none, and nobody can withdraw it.',
              `Every swap pays 1% in ${selected ? selected.symbol : 'the stock'}; you claim 70% of it any time from your wallet page.`,
            ].map((text, i) => (
              <li key={text} className="flex gap-3">
                <span className="font-mono text-[11px] text-primary shrink-0 w-5">0{i + 1}</span>
                <span>{text}</span>
              </li>
            ))}
          </ol>
          <div className="px-4 pt-3 pb-2">
            <KeyValue k="Creation fee" v={feeEth === null ? '…' : `${feeEth} ETH + gas`} />
            <KeyValue k="Opening valuation" v={formatUsd(fdvUsd, { compact: true })} />
            <KeyValue k="Opening price" v={openingTokensPerStock === null ? '—' : `1 ${selected!.symbol} ≈ ${formatNumber(openingTokensPerStock, 0)} ${symbol || 'tokens'}`} />
            <KeyValue k="Anti-snipe" v="99% → 1% over 20 s" />
            <KeyValue k="Creator share" v="70% of every fee" />
          </div>
          <div className="p-4 border-t border-line flex flex-col gap-3">
            {!deployment && <Banner tone="danger">Contracts are not configured on this server.</Banner>}
            {launch.isError && <Banner tone="danger">{describeTradeError(launch.error)}</Banner>}
            {step && (
              <Banner tone={launch.isSuccess ? 'positive' : 'info'}>
                {step.label}
                {step.txHash && (
                  <>
                    {' '}
                    <TxLink hash={step.txHash} className="text-[12px]">
                      View transaction
                    </TxLink>
                  </>
                )}
              </Banner>
            )}
            {!onBase ? (
              <ConnectButton full size="lg" />
            ) : (
              <Button type="submit" full size="lg" loading={launch.isPending} disabled={!deployment}>
                Create token {feeEth !== null ? `· ${feeEth} ETH` : ''} <ArrowUpRight size={16} strokeWidth={1.75} />
              </Button>
            )}
            <p className="text-[12px] text-ink-muted">One transaction. No account, no approval step: the fee is sent with the launch. The token page opens as soon as your wallet returns a hash.</p>
          </div>
        </Module>
      </div>
    </form>
  );
}
