#!/usr/bin/env node
/**
 * After `forge script ... --broadcast`, adds the new deployment to STOCKPAIR_DEPLOYMENTS (and
 * NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS) in both local env files. Paths are from the repository root:
 *   node scripts/apply-deployment.mjs [packages/contracts/deployments/base-<block>.json]
 * Without a path it takes the record with the highest block in packages/contracts/deployments.
 *
 * Append-only. Every earlier factory and hook stays live -- their tokens keep trading, earning and
 * claiming -- so the list keeps every deployment ever made, oldest first, and the newest entry is
 * where new launches go. The list is built from every committed record in
 * packages/contracts/deployments (base.json is the first deployment, the one STOCK launched on),
 * plus the list each file already holds and the deployment its single keys describe. Placeholders
 * add nothing, and no file is written with a list that lacks the first deployment.
 *
 * A deployment is only added once it is known to exist onchain: the broadcast that created it left
 * a successful receipt for every transaction, or, failing that (an interrupted broadcast leaves its
 * record behind all the same), eth_getCode through BASE_RPC_URL finds code at its factory, hook and
 * router. The check is read-only.
 *
 * The single *_FACTORY, *_HOOK, *_ROUTER and *_DEPLOY_BLOCK keys are left exactly as they are. The
 * release running in production today reads only those keys, so they must keep describing the
 * first deployment until that release is replaced; code that reads the list ignores them.
 *
 * It edits local files only. The production indexer (Railway) and web app (Vercel) read their own
 * environment: set the printed list there as well.
 *
 * `--root <dir>` runs against another checkout; the tests use it on a scratch directory.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';

const PREFIXES = ['STOCKPAIR_', 'NEXT_PUBLIC_STOCKPAIR_'];
const ENV_FILES = ['apps/web/.env.local', 'apps/indexer/.env'];
const ZERO = '0x0000000000000000000000000000000000000000';
/**
 * The deployment STOCK launched on. It is live, and every list must keep it. base.json records the
 * block its script simulated against; its broadcast receipts all landed in 50932769.
 */
const FIRST = {
  factory: '0x888BC129704A4158C07614C234bb7EB8126aAD47',
  hook: '0xC81a728c6F4034e9249bB905f30E3013CA95E0Cc',
  router: '0x7Cb00fACE8a634FC0A2A953a562C15f3F67F96a8',
  deployBlock: 50_932_769,
};

const isAddress = (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/u.test(value) && value !== ZERO;
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : resolve(import.meta.dirname, '..'));
const recordArg = args.find((arg, i) => !arg.startsWith('--') && args[i - 1] !== '--root');
const recordsDir = resolve(root, 'packages/contracts/deployments');

/** Every committed deployment record, as list entries, oldest first. */
function readRecords() {
  const files = existsSync(recordsDir) ? readdirSync(recordsDir).filter((f) => /^base(?:-\d+)?\.json$/u.test(f)) : [];
  const records = files.map((f) => readRecord(resolve(recordsDir, f)));
  return records.sort((a, b) => a.deployBlock - b.deployBlock);
}

function readRecord(path) {
  let record;
  try {
    record = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${path} is not a readable deployment record.`);
  }
  if (![record.factory, record.hook, record.router].every(isAddress)) fail(`${path} does not hold three contract addresses.`);
  const block = Number(record.block);
  if (!Number.isSafeInteger(block) || block < 0) fail(`${path} has no usable block.`);
  const isFirst = same(record.factory, FIRST.factory) && same(record.hook, FIRST.hook) && same(record.router, FIRST.router);
  return {
    factory: record.factory,
    hook: record.hook,
    router: record.router,
    deployBlock: isFirst ? FIRST.deployBlock : block,
    source: basename(path),
  };
}

const records = readRecords();
/** The record to apply: the one named, or the one with the highest block. */
const applied = recordArg ? readRecord(resolve(root, recordArg)) : records.at(-1);
if (!applied) fail(`No deployment record in ${recordsDir}. Run the Deploy script with --broadcast first.`);

// The record's block is the one the script simulated against; the broadcast receipts say when the
// contracts really landed, and whether every transaction of that run did land. Only receipts from
// the run that created this factory count. The record's own `"confirmed": false` settles nothing:
// the Deploy script writes it into every record, before a single transaction is sent.
let broadcastConfirmed = false;
try {
  const run = JSON.parse(readFileSync(resolve(root, 'packages/contracts/broadcast/Deploy.s.sol/8453/run-latest.json'), 'utf8'));
  const receipts = run.receipts ?? [];
  if (receipts.some((r) => typeof r.contractAddress === 'string' && same(r.contractAddress, applied.factory))) {
    const blocks = receipts.map((r) => parseInt(r.blockNumber, 16)).filter(Number.isFinite);
    if (blocks.length) applied.deployBlock = Math.min(...blocks);
    broadcastConfirmed =
      (run.pending ?? []).length === 0 &&
      receipts.length >= (run.transactions ?? []).length &&
      receipts.every((r) => r.status === '0x1' || r.status === 1 || r.status === '1');
  }
} catch {
  // no broadcast receipts here: keep the block the script recorded, and check the chain instead
}

/** KEY=value lines as a map, without interpreting anything but a surrounding pair of quotes. */
function readKeys(text) {
  const keys = new Map();
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (/^(['"]).*\1$/u.test(value)) value = value.slice(1, -1);
    keys.set(match[1], value);
  }
  return keys;
}

/** The same rules readDeployments applies: oldest first, every factory and hook once. */
function validList(list) {
  const addresses = list.flatMap((d) => [d.factory.toLowerCase(), d.hook.toLowerCase()]);
  return (
    list.every((d) => isAddress(d?.factory) && isAddress(d?.hook) && isAddress(d?.router) && /^\d+$/u.test(String(d.deployBlock))) &&
    list.every((d, i) => i === 0 || Number(d.deployBlock) >= Number(list[i - 1].deployBlock)) &&
    new Set(addresses).size === addresses.length
  );
}

/** The list a file holds for one prefix, or [] when it has none yet. */
function listInFile(keys, prefix) {
  const raw = keys.get(`${prefix}DEPLOYMENTS`);
  if (!raw) return [];
  let list;
  try {
    list = JSON.parse(raw);
  } catch {
    fail(`${prefix}DEPLOYMENTS is not valid JSON; fix it by hand rather than lose an entry.`);
  }
  // A list the apps would reject must not be extended.
  if (!Array.isArray(list) || !validList(list)) fail(`${prefix}DEPLOYMENTS is not a valid list, oldest first; fix it by hand.`);
  return list.map((d) => ({ ...d, deployBlock: Number(d.deployBlock), source: `${prefix}DEPLOYMENTS` }));
}

/** The deployment a file's single keys describe; null for placeholders or missing keys. */
function singleKeys(keys, prefix) {
  const [factory, hook, router] = ['FACTORY', 'HOOK', 'ROUTER'].map((k) => keys.get(`${prefix}${k}`));
  if (![factory, hook, router].every(isAddress)) return null;
  const block = keys.get(`${prefix}DEPLOY_BLOCK`) ?? keys.get('STOCKPAIR_DEPLOY_BLOCK') ?? '0';
  return { factory, hook, router, deployBlock: /^\d+$/u.test(block) ? Number(block) : 0, source: `${prefix}FACTORY/HOOK/ROUTER` };
}

/**
 * One entry per factory, the first source that names it winning its deploy block. Two sources that
 * give one factory a different hook or router are a mistake a human has to settle.
 */
function merge(entries, where) {
  const byFactory = new Map();
  for (const entry of entries) {
    const known = byFactory.get(entry.factory.toLowerCase());
    if (!known) {
      byFactory.set(entry.factory.toLowerCase(), entry);
      continue;
    }
    if (!same(known.hook, entry.hook) || !same(known.router, entry.router)) {
      fail(`${where}: factory ${entry.factory} has a different hook or router in ${known.source} and ${entry.source}; fix it by hand.`);
    }
  }
  // Stable, so entries with one deploy block keep the order the file already had.
  return [...byFactory.values()].sort((a, b) => a.deployBlock - b.deployBlock);
}

/** Replaces KEY's line, or adds it after the last line of the same prefix. */
function setKey(text, eol, key, value, prefix) {
  const line = `${key}=${value}`;
  // [ \t], not \s: in multiline mode \s would run across a CRLF and swallow the line break.
  const re = new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key}[ \\t]*=.*$`, 'mu');
  if (re.test(text)) return text.replace(re, () => line);
  const lines = text.split(/\r?\n/u);
  let last = -1;
  lines.forEach((l, i) => {
    if (new RegExp(`^[ \\t]*(?:export[ \\t]+)?${prefix}[A-Z_]+[ \\t]*=`, 'u').test(l)) last = i;
  });
  if (last < 0) return `${text}${text === '' || text.endsWith('\n') ? '' : eol}${line}${eol}`;
  lines.splice(last + 1, 0, line);
  return lines.join(eol);
}

/** Contract code at an address, read through JSON-RPC. The URL carries an API key: never printed. */
async function getCode(rpc, address) {
  const response = await fetch(rpc, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_getCode', params: [address, 'latest'] }),
    signal: AbortSignal.timeout(15_000),
  });
  const body = response.ok ? await response.json() : null;
  if (typeof body?.result !== 'string') throw new Error(`eth_getCode for ${address} got no answer (HTTP ${response.status})`);
  return body.result;
}

function rpcUrl() {
  const fromEnv = process.env.BASE_RPC_URL?.trim();
  if (fromEnv) return fromEnv;
  for (const file of ['apps/indexer/.env', 'apps/web/.env.local']) {
    const path = resolve(root, file);
    const value = existsSync(path) ? readKeys(readFileSync(path, 'utf8')).get('BASE_RPC_URL')?.trim() : undefined;
    if (value) return value;
  }
  return null;
}

// Every file is worked out, and every new deployment checked, before any file is written, so a
// list that has to be fixed by hand stops the run without leaving the other file already changed.
const lists = new Set();
const writes = [];
const unconfirmed = new Map();
for (const file of ENV_FILES) {
  const path = resolve(root, file);
  if (!existsSync(path)) {
    writes.push({ file, path: null, changes: [] });
    continue;
  }
  let text = readFileSync(path, 'utf8');
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const keys = readKeys(text);
  const changes = [];
  for (const prefix of PREFIXES) {
    // Only the prefixes a file already uses: the indexer has no business with NEXT_PUBLIC_ keys.
    if (![...keys.keys()].some((k) => k.startsWith(prefix))) continue;
    const held = [...listInFile(keys, prefix), singleKeys(keys, prefix)].filter(Boolean);
    // The applied record before the others: it may carry the block from its broadcast receipts.
    const list = merge([...held, applied, ...records], `${file} ${prefix}DEPLOYMENTS`);
    if (!validList(list)) fail(`${file}: the merged ${prefix}DEPLOYMENTS would not be a valid list, oldest first; fix it by hand.`);
    if (!list.some((d) => same(d.factory, FIRST.factory))) {
      fail(
        `${file}: ${prefix}DEPLOYMENTS would not list the first deployment (factory ${FIRST.factory}), which STOCK and ` +
          'every early token run on. Restore packages/contracts/deployments/base.json; nothing was written.',
      );
    }
    for (const d of list) {
      const known = held.some((h) => same(h.factory, d.factory));
      const isFirst = same(d.factory, FIRST.factory) && same(d.hook, FIRST.hook) && same(d.router, FIRST.router);
      const confirmedByRun = broadcastConfirmed && same(d.factory, applied.factory);
      if (!known && !isFirst && !confirmedByRun) unconfirmed.set(d.factory.toLowerCase(), d);
    }
    const value = JSON.stringify(list.map((d) => ({ factory: d.factory, hook: d.hook, router: d.router, deployBlock: Number(d.deployBlock) })));
    text = setKey(text, eol, `${prefix}DEPLOYMENTS`, value, prefix);
    changes.push(`${prefix}DEPLOYMENTS (${list.length})`);
    lists.add(value);
  }
  writes.push({ file, path, text, changes });
}

if (unconfirmed.size > 0) {
  const rpc = rpcUrl();
  if (!rpc) {
    fail(
      `No successful broadcast receipts confirm ${[...unconfirmed.values()].map((d) => d.factory).join(', ')}. Set ` +
        'BASE_RPC_URL (here or in apps/indexer/.env) so the script can check onchain that its contracts exist; nothing was written.',
    );
  }
  for (const d of unconfirmed.values()) {
    for (const [role, address] of [['factory', d.factory], ['hook', d.hook], ['router', d.router]]) {
      let code;
      try {
        code = await getCode(rpc, address);
      } catch (error) {
        fail(`Could not read the ${role} ${address} through BASE_RPC_URL (${error instanceof Error ? error.message : 'unknown error'}); nothing was written.`);
      }
      if (!/^0x[0-9a-fA-F]+$/u.test(code) || /^0x0*$/u.test(code)) {
        fail(
          `The ${role} ${address} of ${d.source} has no code on Base: its broadcast did not land. Remove that record ` +
            '(or deploy again); nothing was written.',
        );
      }
    }
    console.log(`checked onchain: ${d.factory} (${d.source}) has factory, hook and router code`);
  }
}

for (const { file, path, text, changes } of writes) {
  if (path === null) {
    console.log(`${file}: not found, skipped`);
    continue;
  }
  if (changes.length) writeFileSync(path, text);
  console.log(`${file}: ${changes.length ? changes.join(', ') : 'no StockPair keys, nothing changed'}`);
}

console.log(`\nadded   ${applied.factory} (factory)\n        ${applied.hook} (hook)\n        ${applied.router} (router)\n        block ${applied.deployBlock}`);
for (const value of lists) console.log(`\nSTOCKPAIR_DEPLOYMENTS=${value}`);
if (lists.size > 1) {
  console.log('\nThe env files list different deployments. Production must list every one: reconcile them by hand.');
} else if (lists.size === 1) {
  console.log('Set that value, oldest first and nothing removed, on the Railway indexer (STOCKPAIR_DEPLOYMENTS)');
  console.log('and on Vercel (NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS and STOCKPAIR_DEPLOYMENTS). These files are local only.');
}
console.log(
  '\nThe single *_FACTORY, *_HOOK, *_ROUTER and *_DEPLOY_BLOCK keys were left as they are. Leave them as they are in' +
    '\nproduction too: the release running there before the multi-deployment code reads only those, and they must' +
    '\nkeep describing the first deployment until that release is replaced.',
);
