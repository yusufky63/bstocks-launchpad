import { error, json, parseAddressParam } from '@/lib/api.server';
import { getDb } from '@/lib/db.server';
import { readWalletSummary } from '@/lib/wallet.server';

export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ address: string }> };

export async function GET(_request: Request, { params }: Context): Promise<Response> {
  const { address } = await params;
  const wallet = parseAddressParam(address);
  if (!wallet) return error(400, 'INVALID_ADDRESS', 'Wallet address is malformed.');
  const db = await getDb();
  return json(await readWalletSummary(db, wallet));
}
