'use client';

import { useQueryClient } from '@tanstack/react-query';
import { ImagePlus, Pencil } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import type { Address, Hex } from 'viem';
import { useAccount, useSignTypedData } from 'wagmi';
import { base } from 'wagmi/chains';

import { TokenLogo } from '@/components/stock/stock-coin';
import { Input, TextArea } from '@/components/ui/controls';
import { Banner } from '@/components/ui/display';
import { Button } from '@/components/ui/primitives';
import { Sheet } from '@/components/ui/sheet';
import { EMPTY_IMAGE_HASH, PROFILE_DOMAIN, PROFILE_TYPES, buildProfileMessage, imageHashOf } from '@/lib/profile';
import { qk } from '@/lib/queries';
import { describeTradeError } from '@/lib/trade';
import type { MarketView } from '@/lib/types';

/**
 * Creator-only profile editor. The wallet signs the exact fields (EIP-712); the server verifies the
 * signer is the launch creator and stores the update. Name, symbol and supply cannot change.
 */
export function EditProfile({ market }: { market: MarketView }) {
  const { address, chainId } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();
  const qc = useQueryClient();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [description, setDescription] = useState(market.description ?? '');
  const [website, setWebsite] = useState(market.website ?? '');
  const [twitter, setTwitter] = useState(market.twitter ?? '');
  const [telegram, setTelegram] = useState(market.telegram ?? '');
  const [image, setImage] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const isCreator = !!address && address.toLowerCase() === market.creator.toLowerCase();
  if (!isCreator) return null;
  const onBase = chainId === base.id;

  const submit = async () => {
    if (!address) return;
    setError(null);
    setDone(false);
    if (image && image.size > 2 * 1024 * 1024) {
      setError('Keep the image at or below 2 MB.');
      return;
    }
    try {
      setBusy('Preparing…');
      const bytes = image ? await image.arrayBuffer() : null;
      const imageHash: Hex = bytes ? imageHashOf(bytes) : EMPTY_IMAGE_HASH;
      const issuedAt = BigInt(Math.floor(Date.now() / 1000));
      const built = buildProfileMessage({ token: market.token as Address, description, website, twitter, telegram, imageHash, issuedAt });
      if (built.error) {
        setError(built.error);
        setBusy(null);
        return;
      }
      setBusy('Sign the update in your wallet…');
      const signature = await signTypedDataAsync({ domain: PROFILE_DOMAIN, types: PROFILE_TYPES, primaryType: 'TokenProfile', message: built.message });
      setBusy('Saving…');
      const form = new FormData();
      form.set('payload', JSON.stringify({ signer: address, signature, description: built.message.description, website: built.message.website, twitter: built.message.twitter, telegram: built.message.telegram, imageHash, issuedAt: Number(issuedAt) }));
      if (image) form.set('image', image);
      const response = await fetch(`/api/tokens/${market.token}/profile`, { method: 'POST', body: form });
      const body = (await response.json()) as { ok?: boolean; error?: { message: string } };
      if (!response.ok || body.error) throw new Error(body.error?.message ?? 'The profile could not be saved.');
      setDone(true);
      setBusy(null);
      void qc.invalidateQueries({ queryKey: qk.token(market.token) });
      router.refresh();
      setTimeout(() => setOpen(false), 900);
    } catch (err) {
      setBusy(null);
      setError(describeTradeError(err));
    }
  };

  return (
    <>
      <Button variant="secondary" size="sm" onClick={() => setOpen(true)}>
        <Pencil size={13} strokeWidth={1.75} /> Edit profile
      </Button>
      <Sheet open={open} onClose={() => !busy && setOpen(false)} title="Edit token profile" locked={!!busy} footer={
        <div className="flex flex-col gap-2">
          {!onBase && <Banner tone="warning">Switch your wallet to Base to sign.</Banner>}
          <Button full size="lg" loading={!!busy} disabled={!onBase} onClick={() => void submit()}>
            {busy ?? 'Sign and save'}
          </Button>
        </div>
      }>
        <div className="flex flex-col gap-4">
          <Banner tone="info">You sign a message, not a transaction: no gas. Name, symbol and supply stay as they are onchain; the page shows the update as made by the creator.</Banner>
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
                <span className="block text-[12px] text-ink-muted">PNG, WebP, JPEG or GIF up to 2 MB</span>
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
          <TextArea label="Description" maxLength={1_000} value={description} onChange={(e) => setDescription(e.target.value)} hint={`${description.length}/1000`} />
          <Input label="Website" type="url" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="https://" autoComplete="off" />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="X" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="@handle or x.com/handle" autoComplete="off" autoCapitalize="none" spellCheck={false} />
            <Input label="Telegram" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@group or t.me/group" autoComplete="off" autoCapitalize="none" spellCheck={false} />
          </div>
          {error && <Banner tone="danger">{error}</Banner>}
          {done && <Banner tone="positive">Saved. The token page updates in a moment.</Banner>}
        </div>
      </Sheet>
    </>
  );
}
