import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { limitCaller } from '@/lib/rate-limit.server';
import { readWalletSummary } from '@/lib/wallet.server';

export const dynamic = 'force-dynamic';
// The database is in another region; a cold instance needs room for the handshake and the reads.
export const maxDuration = 15;

type Context = { params: Promise<{ address: string }> };

export async function GET(request: Request, { params }: Context): Promise<Response> {
  const limited = limitCaller(request, 'wallet');
  if (limited) return limited;
  const { address } = await params;
  const wallet = parseAddressParam(address);
  if (!wallet) return error(400, 'INVALID_ADDRESS', 'Wallet address is malformed.');
  const db = await getDb();
  const summary = await readWalletSummary(db, wallet);
  if (!summary) return error(503, 'WALLET_UNAVAILABLE', 'Wallet could not be read in time.');
  return json(summary);
}
