'use client';

import { ChevronDown, Wallet } from 'lucide-react';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';

import { Button, cx } from '@/components/ui/primitives';
import { AddressLabel } from '@/components/ui/display';
import { Sheet } from '@/components/ui/sheet';
import { shortAddress } from '@/lib/format';

/**
 * Wallet entry point: a minimal picker over the Wagmi connectors (Base Account first, then
 * injected wallets). No signature is requested on connect; nothing here gates create or trade.
 */
export function ConnectButton({ size = 'md', full, compact }: { size?: 'sm' | 'md' | 'lg'; full?: boolean; compact?: boolean }) {
  const { address, isConnected, chainId, status, connector } = useAccount();
  const [open, setOpen] = useState(false);
  const { switchChainAsync, isPending: switching } = useSwitchChain();
  const [switchError, setSwitchError] = useState<string | null>(null);
  const { disconnect } = useDisconnect();

  // A locked extension can answer eth_accounts with an empty list while Wagmi still says "connected".
  useEffect(() => {
    if (status === 'connected' && !address) disconnect();
  }, [status, address, disconnect]);

  if (isConnected && address) {
    if (status === 'connected' && chainId !== undefined && chainId !== base.id) {
      const switchToBase = async () => {
        setSwitchError(null);
        try {
          await switchChainAsync({ chainId: base.id, connector });
        } catch (err) {
          const msg = err instanceof Error ? (err.message.split(/\r?\n/u)[0] ?? '') : '';
          setSwitchError(/rejected|denied/iu.test(msg) ? 'Switch request declined in the wallet.' : `This wallet did not switch. Choose the Base network in ${connector?.name ?? 'the wallet'}, then come back.`);
        }
      };
      return (
        <span className={cx('inline-flex flex-col items-end gap-1', full && 'w-full')}>
          <Button size={size} full={full} variant="danger" loading={switching} onClick={() => void switchToBase()} title={`Connected to chain ${chainId}; the launchpad runs on Base (8453)`}>
            Switch to Base
          </Button>
          {switchError && (
            <span role="alert" className="text-[12px] text-danger-fg text-right max-w-[260px]">
              {switchError}
            </span>
          )}
        </span>
      );
    }
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="Wallet menu"
          className={cx('inline-flex items-center gap-2 rounded-[6px] border border-line bg-canvas hover:border-line-strong transition-fast', compact ? 'h-9 px-2.5' : 'h-11 px-3', full && 'w-full justify-between')}
        >
          <Wallet size={14} strokeWidth={1.75} className="text-ink-secondary" aria-hidden />
          <span className={cx('font-mono num', compact ? 'text-[12px]' : 'text-[13px]')}>{shortAddress(address, 4)}</span>
          <ChevronDown size={14} strokeWidth={1.75} className="text-ink-muted" />
        </button>
        <WalletSheet open={open} onClose={() => setOpen(false)} />
      </>
    );
  }

  return (
    <>
      <Button size={size} full={full} onClick={() => setOpen(true)} className={cx(compact && 'h-9 min-h-[36px] px-3')}>
        <Wallet size={16} strokeWidth={1.75} /> {compact ? 'Connect' : 'Connect wallet'}
      </Button>
      <WalletSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}

function rank(id: string): number {
  if (id === 'baseAccount') return 0;
  if (id === 'walletConnect') return 1;
  if (id === 'coinbaseWalletSDK') return 2;
  if (id === 'injected') return 9;
  return 5;
}

function friendlyName(id: string, name: string): string {
  if (id === 'baseAccount') return 'Base Account';
  if (id === 'walletConnect') return 'Mobile wallet (WalletConnect)';
  if (id === 'injected') return 'Browser wallet';
  return name;
}

function subtitle(id: string): string | null {
  if (id === 'baseAccount') return 'Passkey · works on phone and desktop';
  if (id === 'walletConnect') return 'MetaMask, Trust, Rainbow and more';
  return null;
}

function WalletSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { connectors, connectAsync, isPending, error } = useConnect();
  const { isConnected, address } = useAccount();
  const { disconnect } = useDisconnect();

  // A browser extension is only usable when window.ethereum exists; on a phone browser it does not,
  // so the generic "Browser wallet" option is hidden there and Base Account / WalletConnect are used.
  const [hasExtension, setHasExtension] = useState(false);
  useEffect(() => {
    setHasExtension(typeof window !== 'undefined' && !!(window as { ethereum?: unknown }).ethereum);
  }, []);

  // With several extensions installed, EIP-6963 announces each one; the generic "injected" entry is then redundant.
  const discovered = connectors.some((c) => c.type === 'injected' && c.id !== 'injected');
  const ordered = connectors
    .filter((c) => (c.id === 'injected' ? hasExtension && !discovered : true))
    .sort((a, b) => rank(a.id) - rank(b.id));

  return (
    <Sheet open={open} onClose={onClose} title={isConnected ? 'Wallet' : 'Connect a wallet'}>
      {isConnected && address ? (
        <div className="flex flex-col gap-4">
          <AddressLabel address={address} explorer chars={8} />
          <p className="text-[14px] text-ink-secondary">Your tokens and stocks stay in your wallet. BStocks never holds keys or funds.</p>
          <div className="flex gap-2">
            <Link href={`/wallet/${address}`} onClick={onClose} className="inline-flex items-center justify-center h-11 px-4 rounded-[6px] border border-line-strong border-b-[3px] text-[15px] font-medium hover:bg-surface transition-fast flex-1">
              Open wallet page
            </Link>
            <Button
              variant="secondary"
              onClick={() => {
                disconnect();
                onClose();
              }}
            >
              Disconnect
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          {ordered.map((c) => (
            <button
              key={c.uid}
              type="button"
              disabled={isPending}
              onClick={async () => {
                try {
                  await connectAsync({ connector: c, chainId: base.id });
                  onClose();
                } catch {
                  /* surfaced via error below */
                }
              }}
              className="rail flex items-center justify-between gap-3 min-h-[52px] px-4 rounded-[6px] border border-line hover:border-line-strong text-left transition-fast disabled:opacity-50"
            >
              <span className="min-w-0">
                <span className="block font-medium">{friendlyName(c.id, c.name)}</span>
                {subtitle(c.id) && <span className="block text-[12px] text-ink-muted">{subtitle(c.id)}</span>}
              </span>
              {c.id === 'baseAccount' && <span className="eyebrow text-primary shrink-0">Recommended</span>}
            </button>
          ))}
          {ordered.length === 0 && <p className="text-[13px] text-ink-secondary">No wallet found. On a phone, open this site inside your wallet's browser, or use Base Account.</p>}
          {error && <p className="text-[13px] text-danger-fg">{error.message.split('\n')[0]}</p>}
          <p className="text-[12px] text-ink-muted mt-2">On a phone, use Base Account (a passkey, no app needed) or WalletConnect to reach MetaMask, Trust and others. No signature is requested on connect.</p>
        </div>
      )}
    </Sheet>
  );
}
