'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Lock, Pencil } from 'lucide-react';
import { useState } from 'react';
import type { Address, Hash } from 'viem';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';

import { stockPairFactoryAbi } from '@stockpair/core';

import { TokenLogo } from '@/components/stock/stock-coin';
import { Input, TextArea } from '@/components/ui/controls';
import { Banner, TxLink } from '@/components/ui/display';
import { Button } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { builderDataSuffix } from '@/lib/attribution';
import { normalizeTelegram } from '@/lib/profile';
import { qk } from '@/lib/queries';
import { revertErrorName } from '@/lib/revert';
import { describeTradeError } from '@/lib/trade';
import { normalizeTwitter } from '@/lib/twitter';
import type { MarketView } from '@/lib/types';

const PROFILE_ERRORS: Record<string, string> = {
  NotCreator: 'Only the wallet that created this token can change its profile.',
  MetadataNotEditable: 'This profile is locked and can no longer change.',
  InvalidText: 'The profile link was rejected: it must be ipfs:// and a bare CID, with no path.',
};

export function describeProfileError(err: unknown): string {
  const name = revertErrorName(err);
  if (name && PROFILE_ERRORS[name]) return PROFILE_ERRORS[name];
  return describeTradeError(err);
}

/**
 * Creator controls for a token launched with an editable profile. The new profile is pinned to
 * IPFS by the server (name and symbol taken from the launch, never from this form), then the
 * creator's own wallet points the token at it through the launch factory. Locking gives that up
 * for good. Nothing here signs anything off-chain: the chain is the only editing path.
 */
export function OnchainProfile({ market, factory, contentAddressed }: { market: MarketView; factory: string; contentAddressed: boolean }) {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient({ chainId: base.id });
  const { writeContractAsync } = useWriteContract();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lockOpen, setLockOpen] = useState(false);
  // Only fields the creator has touched are local. Metadata can arrive after the launch row,
  // or after an onchain edit, while this component is already mounted.
  const [draft, setDraft] = useState<Partial<Record<'description' | 'website' | 'twitter' | 'telegram', string>>>({});
  const description = draft.description ?? market.description ?? '';
  const website = draft.website ?? market.website ?? '';
  const twitter = draft.twitter ?? market.twitter ?? '';
  const telegram = draft.telegram ?? market.telegram ?? '';
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ message: string; hash: Hash } | null>(null);

  const isCreator = !!address && address.toLowerCase() === market.creator.toLowerCase();
  if (!isCreator) return null;
  const onBase = chainId === base.id;
  const token = market.token as Address;
  const factoryAddress = factory as Address;

  /** Simulate, send from the creator's wallet, and wait for the receipt before saying anything happened. */
  const sendFactoryCall = async (call: { kind: 'update'; uri: string } | { kind: 'lock' }): Promise<Hash> => {
    if (!address || !publicClient) throw new Error('Connect the creator wallet on Base first.');
    const target = { address: factoryAddress, abi: stockPairFactoryAbi } as const;
    if (call.kind === 'update') await publicClient.simulateContract({ ...target, account: address, functionName: 'updateContractURI', args: [token, call.uri] });
    else await publicClient.simulateContract({ ...target, account: address, functionName: 'lockMetadata', args: [token] });
    setBusy('Confirm in your wallet…');
    const hash =
      call.kind === 'update'
        ? await writeContractAsync({ ...target, functionName: 'updateContractURI', args: [token, call.uri], chainId: base.id, dataSuffix: builderDataSuffix() })
        : await writeContractAsync({ ...target, functionName: 'lockMetadata', args: [token], chainId: base.id, dataSuffix: builderDataSuffix() });
    setBusy('Waiting for Base to confirm…');
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction reverted. Nothing changed.');
    return hash;
  };

  const update = async () => {
    setError(null);
    setDone(null);
    if (website && !/^https:\/\/[^\s]+$/u.test(website)) return setError('Use a full https:// link.');
    if (twitter && !normalizeTwitter(twitter)) return setError('Use an X handle like @name or an x.com profile link.');
    if (telegram && !normalizeTelegram(telegram)) return setError('Use a Telegram handle like @name or a t.me link.');
    if (image && image.size > 2 * 1024 * 1024) return setError('Keep the image at or below 2 MB.');
    try {
      setBusy('Pinning the profile to IPFS…');
      const form = new FormData();
      form.set('token', token);
      if (draft.description !== undefined) form.set('description', draft.description.trim());
      if (draft.website !== undefined) form.set('website', draft.website.trim());
      if (draft.twitter !== undefined) form.set('twitter', draft.twitter.trim());
      if (draft.telegram !== undefined) form.set('telegram', draft.telegram.trim());
      if (image) form.set('image', image);
      const response = await fetch('/api/metadata', { method: 'POST', body: form });
      const body = (await response.json()) as { contractURI?: string; error?: { message: string } };
      if (!response.ok || !body.contractURI) throw new Error(body.error?.message ?? 'The profile could not be pinned.');
      const hash = await sendFactoryCall({ kind: 'update', uri: body.contractURI });
      setDone({ message: 'Updated. It shows here as soon as the indexer reads it (a few seconds).', hash });
      void qc.invalidateQueries({ queryKey: qk.token(market.token) });
    } catch (err) {
      setError(describeProfileError(err));
    } finally {
      setBusy(null);
    }
  };

  const lock = async () => {
    setError(null);
    setDone(null);
    try {
      const hash = await sendFactoryCall({ kind: 'lock' });
      setDone({ message: 'Locked. The token can never point at a different profile again.', hash });
      setLockOpen(false);
      void qc.invalidateQueries({ queryKey: qk.token(market.token) });
    } catch (err) {
      setError(describeProfileError(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => {
        setDraft({});
        setImage(null);
        if (preview) URL.revokeObjectURL(preview);
        setPreview(null);
        setError(null);
        setDone(null);
        setOpen(true);
      }}>
        <Pencil size={13} strokeWidth={1.75} /> Edit profile
      </Button>
      <Sheet
        open={open}
        onClose={() => !busy && setOpen(false)}
        title="Edit token profile"
        locked={!!busy}
        footer={
          <div className="flex flex-col gap-2">
            {!onBase && <Banner tone="warning">Switch your wallet to Base first.</Banner>}
            <Button full size="lg" loading={!!busy && !lockOpen} disabled={!onBase || !!busy} onClick={() => void update()}>
              {busy && !lockOpen ? busy : 'Pin and update onchain'}
            </Button>
            <Button full variant="danger" disabled={!onBase || !!busy} onClick={() => { setConfirmText(''); setError(null); setLockOpen(true); }}>
              <Lock size={14} strokeWidth={1.75} /> Lock profile forever
            </Button>
          </div>
        }
      >
        <div className="flex flex-col gap-4">
          <Banner tone="info">This profile lives onchain. Saving pins it to IPFS and sends one transaction from this wallet through the launch factory. Name, symbol and supply never change.</Banner>
          <div className="flex items-center gap-4">
            {preview ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={preview} alt="" className="h-16 w-16 rounded-[6px] border border-line object-cover" />
            ) : (
              <TokenLogo src={market.imageUrl} symbol={market.symbol} size={64} />
            )}
            <label className="flex-1 flex items-center gap-3 rounded-[6px] border border-dashed border-line-strong px-4 py-3 cursor-pointer hover:border-primary transition-fast">
              <ImagePlus size={18} strokeWidth={1.75} className="text-ink-muted" />
              <span className="min-w-0">
                <span className="block text-[14px] font-medium">{image ? image.name : 'Replace image'}</span>
                <span className="block text-[12px] text-ink-muted">PNG, WebP, JPEG or GIF up to 2 MB. Keeps the image the token names onchain now if left empty.</span>
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
          </div>
          <TextArea label="Description" maxLength={1_000} value={description} onChange={(e) => setDraft((current) => ({ ...current, description: e.target.value }))} hint={`${description.length}/1000`} />
          <Input label="Website" type="url" value={website} onChange={(e) => setDraft((current) => ({ ...current, website: e.target.value }))} placeholder="https://" autoComplete="off" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="X" value={twitter} onChange={(e) => setDraft((current) => ({ ...current, twitter: e.target.value }))} placeholder="@handle or x.com/handle" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <Input label="Telegram" value={telegram} onChange={(e) => setDraft((current) => ({ ...current, telegram: e.target.value }))} placeholder="@group or t.me/group" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          {error && !lockOpen && <Banner tone="danger">{error}</Banner>}
          {done && (
            <Banner tone="positive">
              {done.message} <TxLink hash={done.hash} className="text-[12px]">Transaction</TxLink>
            </Banner>
          )}
        </div>
      </Sheet>

      <Sheet
        open={lockOpen}
        onClose={() => !busy && setLockOpen(false)}
        title="Lock profile forever"
        locked={!!busy}
        footer={
          <Button full size="lg" variant="danger" loading={!!busy} disabled={!onBase || confirmText.trim() !== market.symbol} onClick={() => void lock()}>
            {busy ?? 'Lock forever'}
          </Button>
        }
      >
        <div className="flex flex-col gap-4">
          <p className="text-[14px] text-ink-secondary">
            Lock this profile forever? The launch factory gives up its metadata permission on this token. Nobody, including you and BStocks, can ever point it at a different profile again.
            {contentAddressed
              ? ' Its image, description and links are all pinned by content hash, so they can never change either.'
              : ' Part of the current profile is served from an address whose content can still change, and locking does not stop that.'}
          </p>
          <Input label={`Type ${market.symbol} to confirm`} value={confirmText} onChange={(e) => setConfirmText(e.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} />
          {error && <Banner tone="danger">{error}</Banner>}
        </div>
      </Sheet>
    </>
  );
}
