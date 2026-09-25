#!/usr/bin/env node
/**
 * One command for a fresh contract deployment, from the repository root, in any shell:
 *   node scripts/redeploy.mjs
 * Reads PRIVATE_KEY from .env and the RPC from apps/indexer/.env, broadcasts the Foundry deploy
 * script to Base, which records the new addresses in packages/contracts/deployments/base-<block>.json,
 * then appends that deployment to STOCKPAIR_DEPLOYMENTS in both local env files
 * (scripts/apply-deployment.mjs). Every earlier deployment stays in that list, oldest first: their
 * factories and hooks stay live, so the indexer keeps following them and old tokens keep quoting
 * and claiming. The newest entry is where new launches go.
 *
 * It does not reset the database. It used to, so the indexer could start clean from the new deploy
 * block — right for a deployment nobody has used, and catastrophic for one people have: it would
 * take every launch, trade, chart and holder list on the old contracts with it. The indexer follows
 * the old addresses alongside the new ones instead, so the history stays where it is and new
 * launches simply arrive on the newer factory.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
for (const file of ['.env', 'apps/indexer/.env']) {
  const path = resolve(root, file);
  if (existsSync(path)) process.loadEnvFile(path);
}
const key = process.env.PRIVATE_KEY;
const rpc = process.env.BASE_RPC_URL;
if (!key || !rpc) {
  console.error('PRIVATE_KEY (root .env) and BASE_RPC_URL (apps/indexer/.env) are required.');
  process.exit(1);
}

const run = (cmd, args, opts = {}) => {
  // Neither the key nor the RPC URL (which carries an API key) is ever echoed.
  console.log(`\n$ ${cmd} ${args.map((a) => (a === key || a === rpc ? '<redacted>' : a)).join(' ')}`);
  const result = spawnSync(cmd, args, { stdio: 'inherit', shell: process.platform === 'win32', ...opts });
  if (result.status !== 0) {
    console.error(`\n${cmd} exited with ${result.status}`);
    process.exit(result.status ?? 1);
  }
};

const contracts = resolve(root, 'packages/contracts');
const records = () => {
  const dir = resolve(contracts, 'deployments');
  return existsSync(dir) ? readdirSync(dir).filter((f) => /^base-\d+\.json$/u.test(f)) : [];
};
const before = new Set(records());
run('forge', ['script', 'script/Deploy.s.sol:Deploy', '--rpc-url', rpc, '--private-key', key, '--broadcast'], { cwd: contracts });
// Apply exactly the record this broadcast wrote, never an older one lying around.
const created = records().filter((f) => !before.has(f));
if (created.length !== 1) {
  console.error(`\nExpected the deploy to write one new deployments/base-<block>.json, found ${created.length}. Nothing applied.`);
  process.exit(1);
}
run('node', [resolve(root, 'scripts/apply-deployment.mjs'), `packages/contracts/deployments/${created[0]}`], { cwd: root });
run('pnpm', ['exec', 'tsx', 'src/db/cli.ts', 'migrate'], { cwd: resolve(root, 'packages/core') });
console.log(
  '\nDone. The local env files now list every deployment, the new one last.' +
    '\nProduction does not read them: set STOCKPAIR_DEPLOYMENTS on the Railway indexer and restart it there,' +
    '\nthen set NEXT_PUBLIC_STOCKPAIR_DEPLOYMENTS and STOCKPAIR_DEPLOYMENTS on Vercel and redeploy the web app.' +
    '\nLeave the single STOCKPAIR_FACTORY/HOOK/ROUTER/DEPLOY_BLOCK keys as they are, there and here: a release' +
    '\nthat predates the list reads only those, and they must keep naming the first deployment.' +
    '\nNever run a local indexer against the production database: only the one Railway instance may write to it.',
);
