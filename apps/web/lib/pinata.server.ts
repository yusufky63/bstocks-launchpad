import 'server-only';

const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files';
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/webp', 'image/jpeg', 'image/gif']);

export type MetadataInput = {
  name: string;
  symbol: string;
  description: string;
  website: string | null;
  twitter?: string | null;
  image?: { bytes: ArrayBuffer; type: string; fileName: string } | null;
};

export class PinError extends Error {
  constructor(
    readonly code: 'NOT_CONFIGURED' | 'IMAGE_INVALID' | 'UPLOAD_FAILED',
    message: string,
  ) {
    super(message);
  }
}

async function pinFile(jwt: string, blob: Blob, fileName: string, fetchImpl: typeof fetch): Promise<string> {
  const form = new FormData();
  form.set('file', blob, fileName);
  form.set('network', 'public');
  const response = await fetchImpl(PINATA_UPLOAD_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${jwt}` },
    body: form,
  });
  if (!response.ok) throw new PinError('UPLOAD_FAILED', `Pinata upload failed (${response.status}).`);
  const body = (await response.json()) as { data?: { cid?: string } };
  const cid = body.data?.cid;
  if (!cid || !/^[a-zA-Z0-9]{46,}$/u.test(cid)) throw new PinError('UPLOAD_FAILED', 'Pinata returned no CID.');
  return cid;
}

/** Pins one image (validated the same way as at launch) and returns its ipfs:// URI. */
export async function pinImage(image: { bytes: ArrayBuffer; type: string; fileName: string }, env: Readonly<Record<string, string | undefined>> = process.env, fetchImpl: typeof fetch = fetch): Promise<string> {
  const jwt = env.PINATA_JWT?.trim();
  if (!jwt) throw new PinError('NOT_CONFIGURED', 'PINATA_JWT is not configured.');
  if (!ALLOWED_IMAGE_TYPES.has(image.type)) throw new PinError('IMAGE_INVALID', 'Use PNG, WebP, JPEG or GIF.');
  if (image.bytes.byteLength > MAX_IMAGE_BYTES) throw new PinError('IMAGE_INVALID', 'Keep the image at or below 2 MB.');
  const cid = await pinFile(jwt, new Blob([image.bytes], { type: image.type }), image.fileName, fetchImpl);
  return `ipfs://${cid}`;
}

/**
 * Pins the optional image and then the ERC-7572 metadata JSON.
 * Returns the contractURI (ipfs://CID) the launch transaction embeds.
 */
export async function pinMetadata(
  input: MetadataInput,
  env: Readonly<Record<string, string | undefined>> = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<{ contractURI: string; imageUri: string | null; metadata: Record<string, unknown> }> {
  const jwt = env.PINATA_JWT?.trim();
  if (!jwt) throw new PinError('NOT_CONFIGURED', 'PINATA_JWT is not configured.');

  let imageUri: string | null = null;
  if (input.image) {
    if (!ALLOWED_IMAGE_TYPES.has(input.image.type)) throw new PinError('IMAGE_INVALID', 'Use PNG, WebP, JPEG or GIF.');
    if (input.image.bytes.byteLength > MAX_IMAGE_BYTES) throw new PinError('IMAGE_INVALID', 'Keep the image at or below 2 MB.');
    const cid = await pinFile(jwt, new Blob([input.image.bytes], { type: input.image.type }), input.image.fileName, fetchImpl);
    imageUri = `ipfs://${cid}`;
  }

  const metadata: Record<string, unknown> = {
    name: input.name,
    symbol: input.symbol,
    description: input.description,
    ...(imageUri ? { image: imageUri } : {}),
    ...(input.website ? { external_link: input.website } : {}),
    ...(input.twitter ? { twitter: input.twitter } : {}),
  };
  const cid = await pinFile(
    jwt,
    new Blob([JSON.stringify(metadata)], { type: 'application/json' }),
    `${input.symbol.toLowerCase()}-metadata.json`,
    fetchImpl,
  );
  return { contractURI: `ipfs://${cid}`, imageUri, metadata };
}
