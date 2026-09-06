#!/usr/bin/env node
/**
 * After `forge script ... --broadcast`, copies the new addresses and the first receipt's block
 * from packages/contracts into both env files. Run from the repository root:
 *   node scripts/apply-deployment.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs';

const deployment = JSON.parse(readFileSync('packages/contracts/deployments/base.json', 'utf8'));
let block = Number(deployment.block);
try {
  const run = JSON.parse(readFileSync('packages/contracts/broadcast/Deploy.s.sol/8453/run-latest.json', 'utf8'));
  const blocks = run.receipts.map((r) => parseInt(r.blockNumber, 16)).filter(Number.isFinite);
  if (blocks.length) block = Math.min(...blocks);
} catch {
  // no broadcast receipts: keep the block the script recorded
}

const values = { FACTORY: deployment.factory, HOOK: deployment.hook, ROUTER: deployment.router, DEPLOY_BLOCK: String(block) };
for (const file of ['apps/web/.env.local', 'apps/indexer/.env']) {
  let text = readFileSync(file, 'utf8');
  let changed = 0;
  for (const prefix of ['STOCKPAIR_', 'NEXT_PUBLIC_STOCKPAIR_']) {
    for (const [key, value] of Object.entries(values)) {
      const re = new RegExp(`^${prefix}${key}=.*$`, 'm');
      if (re.test(text)) {
        text = text.replace(re, `${prefix}${key}=${value}`);
        changed += 1;
      }
    }
  }
  writeFileSync(file, text);
  console.log(`${file}: ${changed} keys updated`);
}
console.log(`factory ${deployment.factory}\nhook    ${deployment.hook}\nrouter  ${deployment.router}\nblock   ${block}`);
