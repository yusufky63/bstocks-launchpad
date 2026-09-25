import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DeploymentListError, findDeployment, parseDeployments, readDeployment, readDeployments } from '../src/chain';
import * as db from '../src/db';

// Real addresses of the deployment STOCK launched on, and made-up later ones.
const FIRST = {
  factory: '0x888BC129704A4158C07614C234bb7EB8126aAD47',
  hook: '0xC81a728c6F4034e9249bB905f30E3013CA95E0Cc',
  router: '0x7Cb00fACE8a634FC0A2A953a562C15f3F67F96a8',
  deployBlock: 50_932_769,
};
const SECOND = {
  factory: '0x1000000000000000000000000000000000000001',
  hook: '0x20000000000000000000000000000000000000c8',
  router: '0x3000000000000000000000000000000000000003',
  deployBlock: 51_200_000,
};
const THIRD = {
  factory: '0x1000000000000000000000000000000000000004',
  hook: '0x20000000000000000000000000000000000004c8',
  router: '0x3000000000000000000000000000000000000006',
  deployBlock: 52_000_000,
};
const ZERO = '0x0000000000000000000000000000000000000000';

const list = (...entries: object[]) => ({ STOCKPAIR_DEPLOYMENTS: JSON.stringify(entries) });

describe('readDeployments', () => {
  it('falls back to the single keys when there is no list', () => {
    const env = { STOCKPAIR_FACTORY: FIRST.factory, STOCKPAIR_HOOK: FIRST.hook, STOCKPAIR_ROUTER: FIRST.router, STOCKPAIR_DEPLOY_BLOCK: ' 50932769 ' };
    expect(readDeployments(env)).toEqual([{ ...FIRST, deployBlock: 50_932_769n }]);
    expect(readDeployments({ ...env, STOCKPAIR_DEPLOYMENTS: '   ' })).toHaveLength(1);
    expect(readDeployments({ ...env, STOCKPAIR_DEPLOY_BLOCK: 'soon' })[0]?.deployBlock).toBe(0n);
    expect(readDeployments({ ...env, STOCKPAIR_HOOK: ZERO })).toEqual([]);
    expect(readDeployments({ ...env, STOCKPAIR_ROUTER: '0x1234' })).toEqual([]);
    expect(readDeployments({})).toEqual([]);
  });

  it('reads the browser prefix, borrowing the server deploy block as before', () => {
    const env = {
      NEXT_PUBLIC_STOCKPAIR_FACTORY: FIRST.factory,
      NEXT_PUBLIC_STOCKPAIR_HOOK: FIRST.hook,
      NEXT_PUBLIC_STOCKPAIR_ROUTER: FIRST.router,
      STOCKPAIR_DEPLOY_BLOCK: '50932769',
    };
    expect(readDeployments(env, 'NEXT_PUBLIC_STOCKPAIR')).toEqual([{ ...FIRST, deployBlock: 50_932_769n }]);
    expect(readDeployments({ NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS: JSON.stringify([FIRST, SECOND]) }, 'NEXT_PUBLIC_STOCKPAIR')).toHaveLength(2);
    expect(readDeployments({ NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS: JSON.stringify([FIRST]) })).toEqual([]);
  });

  it('reads the list oldest first and prefers it to the single keys', () => {
    const env = { ...list(FIRST, { ...SECOND, deployBlock: '51200000' }), STOCKPAIR_FACTORY: THIRD.factory, STOCKPAIR_HOOK: THIRD.hook, STOCKPAIR_ROUTER: THIRD.router };
    const deployments = readDeployments(env);
    expect(deployments).toEqual([
      { ...FIRST, deployBlock: 50_932_769n },
      { ...SECOND, deployBlock: 51_200_000n },
    ]);
    expect(Object.isFrozen(deployments)).toBe(true);
    expect(Object.isFrozen(deployments[0])).toBe(true);
  });

  it('voids the whole list on any bad entry rather than silently dropping a deployment', () => {
    const bad: Record<string, string>[] = [
      { STOCKPAIR_DEPLOYMENTS: '[{"factory":' },
      { STOCKPAIR_DEPLOYMENTS: JSON.stringify(FIRST) },
      list(FIRST, { ...SECOND, hook: '0xnothex' }),
      list(FIRST, { ...SECOND, router: ZERO }),
      list(FIRST, { ...SECOND, deployBlock: undefined }),
      list(FIRST, { ...SECOND, deployBlock: -1 }),
      list(FIRST, { ...SECOND, deployBlock: 1.5 }),
      list(FIRST, { ...SECOND, factory: FIRST.factory.toLowerCase() }),
      list(FIRST, { ...SECOND, hook: FIRST.hook.toUpperCase().replace('0X', '0x') }),
      list(FIRST, { ...SECOND, factory: FIRST.hook }),
      list(SECOND, FIRST),
      list(FIRST, null as unknown as object),
    ];
    for (const env of bad) {
      const withSingle = { ...env, STOCKPAIR_FACTORY: FIRST.factory, STOCKPAIR_HOOK: FIRST.hook, STOCKPAIR_ROUTER: FIRST.router };
      expect(readDeployments(withSingle), env.STOCKPAIR_DEPLOYMENTS).toEqual([]);
      expect(() => parseDeployments(withSingle), env.STOCKPAIR_DEPLOYMENTS).toThrow(DeploymentListError);
    }
    expect(readDeployments(list())).toEqual([]);
  });

  it('says which entry of a refused list is wrong, for the indexer to stop with', () => {
    expect(() => parseDeployments({ STOCKPAIR_DEPLOYMENTS: '[{' })).toThrow('STOCKPAIR_DEPLOYMENTS is not valid JSON.');
    expect(() => parseDeployments(list(SECOND, FIRST))).toThrow(/STOCKPAIR_DEPLOYMENTS\[1\] has deployBlock 50932769, before the entry above it/u);
    expect(() => parseDeployments(list(FIRST, { ...SECOND, hook: FIRST.hook }))).toThrow(`STOCKPAIR_DEPLOYMENTS[1] repeats ${FIRST.hook}`);
    expect(() => parseDeployments(list(FIRST, { ...SECOND, router: ZERO }))).toThrow('STOCKPAIR_DEPLOYMENTS[1] needs factory, hook and router');
    expect(parseDeployments(list(FIRST, SECOND))).toHaveLength(2);
  });

  it('readDeployment is the newest entry, the create target', () => {
    expect(readDeployment(list(FIRST, SECOND, THIRD))).toEqual({ ...THIRD, deployBlock: 52_000_000n });
    expect(readDeployment(list())).toBeNull();
    expect(readDeployment({})).toBeNull();
  });

  it('finds the deployment a factory, hook or router belongs to, in any case', () => {
    const all = readDeployments(list(FIRST, SECOND));
    expect(findDeployment(all, FIRST.factory.toLowerCase())?.hook).toBe(FIRST.hook);
    expect(findDeployment(all, SECOND.hook.toUpperCase().replace('0X', '0x'))?.factory).toBe(SECOND.factory);
    expect(findDeployment(all, SECOND.router)?.factory).toBe(SECOND.factory);
    expect(findDeployment(all, THIRD.factory)).toBeNull();
    expect(findDeployment(all, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// scripts/apply-deployment.mjs, run for real against a scratch checkout. It must add, never replace.
// ---------------------------------------------------------------------------------------------

const inRepo = (path: string) => fileURLToPath(new URL(`../../../${path}`, import.meta.url));
const SCRIPT = inRepo('scripts/apply-deployment.mjs');
const SECRET = 'postgresql://user:do-not-print@db.example:5432/postgres';
const RPC_KEY = 'rpc-key-do-not-print';
const CODE = '0x6080604052';

let root: string;

const indexerEnv = () => join(root, 'apps/indexer/.env');
const webEnv = () => join(root, 'apps/web/.env.local');
const recordsDir = () => join(root, 'packages/contracts/deployments');

/**
 * A record as packages/contracts/script/Deploy.s.sol writes it. It is written before anything is
 * sent, so it always says `confirmed: false`; the receipts or the chain have to confirm it.
 */
function deployRecord(d: typeof SECOND, simulatedBlock: number) {
  return { block: simulatedBlock, chainId: 8453, confirmed: false, factory: d.factory, hook: d.hook, owner: d.router, router: d.router, treasury: d.router };
}

function writeRecord(d: typeof SECOND, simulatedBlock = d.deployBlock) {
  mkdirSync(recordsDir(), { recursive: true });
  writeFileSync(join(recordsDir(), `base-${simulatedBlock}.json`), JSON.stringify(deployRecord(d, simulatedBlock)));
}

/** The committed record of the first deployment, byte for byte: it predates `confirmed`. */
function copyFirstRecord() {
  mkdirSync(recordsDir(), { recursive: true });
  writeFileSync(join(recordsDir(), 'base.json'), readFileSync(inRepo('packages/contracts/deployments/base.json')));
}

/** The run-latest.json forge leaves after broadcasting `d`: one receipt per transaction unless told otherwise. */
function writeRun(d: typeof SECOND, options: { receipts?: object[]; transactions?: number } = {}) {
  const dir = join(root, 'packages/contracts/broadcast/Deploy.s.sol/8453');
  mkdirSync(dir, { recursive: true });
  const block = `0x${d.deployBlock.toString(16)}`;
  const receipts = options.receipts ?? [
    { status: '0x1', blockNumber: block, contractAddress: d.factory.toLowerCase() },
    { status: '0x1', blockNumber: block, contractAddress: null },
    { status: '0x1', blockNumber: block, contractAddress: d.router.toLowerCase() },
  ];
  const transactions = Array.from({ length: options.transactions ?? receipts.length }, () => ({ transactionType: 'CREATE' }));
  writeFileSync(join(dir, 'run-latest.json'), JSON.stringify({ transactions, receipts, pending: [] }));
}

/** A JSON-RPC endpoint answering eth_getCode from `code`, and '0x' for anything else. */
async function startRpc(code: Record<string, string>) {
  const calls: string[] = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { id, method, params } = JSON.parse(body) as { id: number; method: string; params: string[] };
      const address = String(params[0]).toLowerCase();
      calls.push(`${method} ${address}`);
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: code[address] ?? '0x' }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v2/${RPC_KEY}`,
    calls,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const codeAt = (...deployments: (typeof SECOND)[]) =>
  Object.fromEntries(deployments.flatMap((d) => [d.factory, d.hook, d.router]).map((a) => [a.toLowerCase(), CODE]));

/** Runs the script as the owner would. BASE_RPC_URL is only what the test passes, never the shell's. */
function apply(options: { rpc?: string } = {}, ...args: string[]): Promise<{ status: number | null; out: string }> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  delete env.BASE_RPC_URL;
  if (options.rpc) env.BASE_RPC_URL = options.rpc;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [SCRIPT, '--root', root, ...args], { env });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (status) => resolve({ status, out }));
  });
}

const envOf = (path: string) => parseEnv(readFileSync(path, 'utf8')) as Record<string, string | undefined>;
const factoriesIn = (path: string, prefix?: 'NEXT_PUBLIC_STOCKPAIR') => readDeployments(envOf(path), prefix).map((d) => d.factory);

describe('apply-deployment', () => {
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'apply-deployment-'));
    mkdirSync(join(root, 'apps/indexer'), { recursive: true });
    mkdirSync(join(root, 'apps/web'), { recursive: true });
    // The committed record of the first deployment, with the block its script simulated against.
    copyFirstRecord();
    // Today's files: one deployment in the single keys, no list.
    writeFileSync(
      indexerEnv(),
      [`DATABASE_URL=${SECRET}`, `STOCKPAIR_FACTORY=${FIRST.factory}`, `STOCKPAIR_HOOK=${FIRST.hook}`, `STOCKPAIR_ROUTER=${FIRST.router}`, `STOCKPAIR_DEPLOY_BLOCK=${FIRST.deployBlock}`, 'INDEXER_POLL_MS=2000', ''].join('\n'),
    );
    writeFileSync(
      webEnv(),
      [`DATABASE_URL=${SECRET}`, `STOCKPAIR_FACTORY=${FIRST.factory}`, `STOCKPAIR_HOOK=${FIRST.hook}`, `STOCKPAIR_ROUTER=${FIRST.router}`, `STOCKPAIR_DEPLOY_BLOCK=${FIRST.deployBlock}`,
        `NEXT_PUBLIC_STOCKPAIR_FACTORY=${FIRST.factory}`, `NEXT_PUBLIC_STOCKPAIR_HOOK=${FIRST.hook}`, `NEXT_PUBLIC_STOCKPAIR_ROUTER=${FIRST.router}`, 'NEXT_PUBLIC_APP_URL=http://localhost:3000', ''].join('\r\n'),
    );
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('keeps the deployment the files pointed at, adds the new one after it and leaves the single keys alone', async () => {
    writeRecord(SECOND);
    writeRun(SECOND);
    const { status, out } = await apply();
    expect(status, out).toBe(0);

    const indexer = envOf(indexerEnv());
    expect(readDeployments(indexer)).toEqual([
      { ...FIRST, deployBlock: 50_932_769n },
      { ...SECOND, deployBlock: 51_200_000n },
    ]);
    // The release running in production reads only the single keys: they still name the first deployment.
    expect(indexer).toMatchObject({ STOCKPAIR_FACTORY: FIRST.factory, STOCKPAIR_HOOK: FIRST.hook, STOCKPAIR_ROUTER: FIRST.router, STOCKPAIR_DEPLOY_BLOCK: '50932769', DATABASE_URL: SECRET, INDEXER_POLL_MS: '2000' });
    expect(indexer.NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS).toBeUndefined();

    const web = envOf(webEnv());
    expect(factoriesIn(webEnv(), 'NEXT_PUBLIC_STOCKPAIR')).toEqual([FIRST.factory, SECOND.factory]);
    expect(factoriesIn(webEnv())).toEqual([FIRST.factory, SECOND.factory]);
    expect(readDeployment(web, 'NEXT_PUBLIC_STOCKPAIR')?.factory).toBe(SECOND.factory);
    expect(web.NEXT_PUBLIC_STOCKPAIR_FACTORY).toBe(FIRST.factory);
    expect(readFileSync(webEnv(), 'utf8')).not.toMatch(/[^\r]\n/u); // CRLF kept

    expect(out).toContain('Railway');
    expect(out).toContain('Vercel');
    expect(out).toContain('left as they are');
    expect(out).not.toContain('do-not-print');
  });

  it('reads records in the shape the Deploy script writes them, and lets the receipts confirm one', async () => {
    // The fixture above is only worth something while it matches what forge really writes.
    const source = readFileSync(inRepo('packages/contracts/script/Deploy.s.sol'), 'utf8');
    const keys = [...source.matchAll(/vm\.serialize\w+\(json, "(\w+)"/gu)].map((m) => m[1]).sort();
    expect(keys).toEqual(Object.keys(deployRecord(SECOND, 1)).sort());
    expect(source).toContain('vm.serializeBool(json, "confirmed", false)');
    expect(JSON.parse(readFileSync(join(recordsDir(), 'base.json'), 'utf8'))).not.toHaveProperty('confirmed');

    // `confirmed: false` is in every record the script writes, so it cannot be what stops one:
    // a broadcast whose every transaction has a successful receipt needs no RPC to be listed.
    writeRecord(SECOND);
    writeRun(SECOND);
    const { status, out } = await apply();
    expect(status, out).toBe(0);
    expect(factoriesIn(indexerEnv())).toEqual([FIRST.factory, SECOND.factory]);
    expect(out).not.toContain('checked onchain');
  });

  it('is append-only: a re-run changes nothing and a later deployment goes last', async () => {
    writeRecord(SECOND);
    writeRun(SECOND);
    expect((await apply()).status).toBe(0);
    const once = readFileSync(indexerEnv(), 'utf8');
    expect((await apply()).status).toBe(0);
    expect(readFileSync(indexerEnv(), 'utf8')).toBe(once);

    writeRecord(THIRD);
    writeRun(THIRD);
    expect((await apply()).status).toBe(0);
    expect(factoriesIn(indexerEnv())).toEqual([FIRST.factory, SECOND.factory, THIRD.factory]);
    // Naming an older record explicitly does not reorder or duplicate anything.
    expect((await apply({}, `packages/contracts/deployments/base-${SECOND.deployBlock}.json`)).status).toBe(0);
    expect(factoriesIn(indexerEnv())).toEqual([FIRST.factory, SECOND.factory, THIRD.factory]);
    expect(envOf(indexerEnv()).STOCKPAIR_FACTORY).toBe(FIRST.factory);
  });

  it('takes the block from the broadcast receipts of the run that created the factory', async () => {
    writeRecord(SECOND, 51_199_990);
    writeRun(SECOND, {
      receipts: [
        { status: '0x1', blockNumber: `0x${(51_200_003).toString(16)}`, contractAddress: SECOND.factory.toLowerCase() },
        { status: '0x1', blockNumber: `0x${(51_200_004).toString(16)}`, contractAddress: null },
      ],
    });
    expect((await apply()).status).toBe(0);
    expect(readDeployment(envOf(indexerEnv()))?.deployBlock).toBe(51_200_003n);
  });

  it('checks the chain for a record no receipts confirm, and ignores receipts from a different run', async () => {
    writeRecord(SECOND, 51_199_990);
    writeRun(THIRD);
    const rpc = await startRpc(codeAt(SECOND));
    try {
      const { status, out } = await apply({ rpc: rpc.url });
      expect(status, out).toBe(0);
      expect(readDeployment(envOf(indexerEnv()))?.deployBlock).toBe(51_199_990n);
      expect(rpc.calls.sort()).toEqual([SECOND.factory, SECOND.hook, SECOND.router].map((a) => `eth_getCode ${a.toLowerCase()}`).sort());
      expect(out).not.toContain(RPC_KEY);
    } finally {
      await rpc.close();
    }
  });

  it('refuses a record whose broadcast did not land, and writes nothing', async () => {
    const before = { indexer: readFileSync(indexerEnv(), 'utf8'), web: readFileSync(webEnv(), 'utf8') };
    writeRecord(SECOND);
    // Simulated and recorded, but the run stopped after the factory: one receipt for three transactions.
    writeRun(SECOND, { receipts: [{ status: '0x1', blockNumber: `0x${SECOND.deployBlock.toString(16)}`, contractAddress: SECOND.factory.toLowerCase() }], transactions: 3 });

    // Without an RPC to check against, it stops and says what it needs.
    let result = await apply();
    expect(result.status).toBe(1);
    expect(result.out).toContain('BASE_RPC_URL');

    // The factory landed, the hook did not.
    const rpc = await startRpc({ [SECOND.factory.toLowerCase()]: CODE, [SECOND.router.toLowerCase()]: CODE });
    try {
      result = await apply({ rpc: rpc.url });
    } finally {
      await rpc.close();
    }
    expect(result.status).toBe(1);
    expect(result.out).toContain(`hook ${SECOND.hook}`);
    expect(result.out).toContain('has no code');
    expect(result.out).not.toContain(RPC_KEY);
    expect(readFileSync(indexerEnv(), 'utf8')).toBe(before.indexer);
    expect(readFileSync(webEnv(), 'utf8')).toBe(before.web);
  });

  it('extends an existing list, and refuses to touch one it cannot read', async () => {
    writeFileSync(indexerEnv(), `STOCKPAIR_DEPLOYMENTS=${JSON.stringify([FIRST, SECOND])}\nSTOCKPAIR_FACTORY=${FIRST.factory}\n`);
    writeRecord(THIRD);
    writeRun(THIRD);
    expect((await apply()).status).toBe(0);
    expect(factoriesIn(indexerEnv())).toEqual([FIRST.factory, SECOND.factory, THIRD.factory]);

    // A list the apps would reject is left for a human, and the other file is not half-updated.
    const webBefore = readFileSync(webEnv(), 'utf8');
    const conflicting = [{ ...FIRST, hook: SECOND.hook }];
    for (const broken of ['STOCKPAIR_DEPLOYMENTS=[{"factory":\n', `STOCKPAIR_DEPLOYMENTS=${JSON.stringify([SECOND, FIRST])}\n`, `STOCKPAIR_DEPLOYMENTS=${JSON.stringify(conflicting)}\n`]) {
      writeFileSync(indexerEnv(), broken);
      const { status, out } = await apply();
      expect(status, broken).toBe(1);
      expect(out).toContain('fix it by hand');
      expect(readFileSync(indexerEnv(), 'utf8')).toBe(broken);
      expect(readFileSync(webEnv(), 'utf8')).toBe(webBefore);
    }
  });

  it('seeds a file with no deployment yet from the committed records, never from its placeholders', async () => {
    writeFileSync(indexerEnv(), `STOCKPAIR_FACTORY=${ZERO}\nSTOCKPAIR_HOOK=${ZERO}\nSTOCKPAIR_ROUTER=${ZERO}\n`);
    rmSync(webEnv());
    writeRecord(SECOND); // committed by an earlier redeploy on another machine
    writeRecord(THIRD);
    writeRun(THIRD);
    const rpc = await startRpc(codeAt(SECOND));
    try {
      const { status, out } = await apply({ rpc: rpc.url });
      expect(status, out).toBe(0);
      expect(out).toContain('apps/web/.env.local: not found, skipped');
    } finally {
      await rpc.close();
    }
    expect(readDeployments(envOf(indexerEnv()))).toEqual([
      { ...FIRST, deployBlock: 50_932_769n },
      { ...SECOND, deployBlock: 51_200_000n },
      { ...THIRD, deployBlock: 52_000_000n },
    ]);
    expect(envOf(indexerEnv()).STOCKPAIR_FACTORY).toBe(ZERO);
  });

  it('refuses to write a list without the first deployment', async () => {
    rmSync(join(recordsDir(), 'base.json'));
    writeFileSync(indexerEnv(), `STOCKPAIR_FACTORY=${ZERO}\nSTOCKPAIR_HOOK=${ZERO}\nSTOCKPAIR_ROUTER=${ZERO}\n`);
    const before = readFileSync(webEnv(), 'utf8');
    writeRecord(SECOND);
    writeRun(SECOND);
    const { status, out } = await apply();
    expect(status).toBe(1);
    expect(out).toContain(FIRST.factory);
    expect(out).toContain('base.json');
    expect(readFileSync(indexerEnv(), 'utf8')).not.toContain('DEPLOYMENTS');
    expect(readFileSync(webEnv(), 'utf8')).toBe(before);
  });

  it('fails without a record to apply', async () => {
    rmSync(join(recordsDir(), 'base.json'));
    const { status, out } = await apply();
    expect(status).toBe(1);
    expect(out).toContain('No deployment record');
  });
});


describe('nothing drops the production database by habit', () => {
  const repo = inRepo;

  it('has no reset script or export', () => {
    for (const file of ['package.json', 'packages/core/package.json']) {
      const scripts = JSON.parse(readFileSync(repo(file), 'utf8')).scripts as Record<string, string>;
      for (const [name, command] of Object.entries(scripts)) {
        expect(`${name} ${command}`, file).not.toMatch(/reset|drop/iu);
      }
    }
    expect(Object.keys(db)).not.toContain('reset');
    expect(readFileSync(repo('packages/core/src/db/cli.ts'), 'utf8')).not.toMatch(/DROP SCHEMA|reset\(/u);
  });

  it('redeploy says what it really does and where production runs', () => {
    const text = readFileSync(repo('scripts/redeploy.mjs'), 'utf8');
    expect(text).not.toContain('STOCKPAIR_PREVIOUS');
    expect(text).toContain('STOCKPAIR_DEPLOYMENTS');
    expect(text).toContain('Railway');
    expect(text).toContain('Vercel');
    expect(text).toContain('Never run a local indexer against the production database');
    expect(text).not.toMatch(/pnpm dev:indexer|pnpm dev\b/u);
  });
});
