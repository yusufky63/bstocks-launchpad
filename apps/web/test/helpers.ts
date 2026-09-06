export { formatRatio, formatUsd } from '@/lib/format';

export async function parse(response: Response): Promise<{ status: number; body: any }> {
  return { status: response.status, body: await response.json() };
}
